/**
 * Profile strip: a thin labeled 1-column heatmap to the right of the umap. One cell per
 * continuous field (grouped by category), colored by a selectable statistic computed over the
 * live selection (brush / region / legend / search) — or the whole corpus when nothing is
 * selected. A popover (▾ button at the top) picks the statistic and the color scaling.
 *
 * Statistics ("zmean" is the initial pick — it works with any color-by, so the strip never
 * switches statistic on its own; correlations activate only when chosen in the picker):
 * - "spearman": correlation of the precomputed `<name>__rank` columns (from ingest)
 *   with the color-by's ranks → Spearman (Pearson-on-ranks). The ranks are dataset-wide, so this
 *   is an APPROXIMATION of the true within-selection Spearman (very close; drifts only where a
 *   selection has little spread, where the correlation is ~0 anyway). Falls back per-column to
 *   the raw values when ranks are absent. Label: `ρ ≈` (or `r` when fully fallen back).
 * - "pearson": plain Pearson correlation of the raw columns with the color-by.
 * - "zmean": how the selection sits vs the corpus, per field — a z-score of the selection's
 *   mean on the field's default scale (log for heavy-tailed counts):
 *     (avg(t(x)) over selection − avg(t(x)) over all) / stddev_pop(t(x))
 *   Needs no color-by (works even with categorical/no coloring); no selection → z = 0.
 *   The corpus terms are constant, so they are fetched ONCE (per field set) before the client
 *   connects; the live query is just a filtered avg per field — the same cheap shape as the
 *   correlations. (Folding the selection predicate into a CASE per aggregate instead was
 *   catastrophically slow: the region brush's predicate is a `post_id IN (…)` list that would
 *   be copied into all ~100 aggregates and re-planned on every brush frame.)
 *
 * Live via a MosaicClient filtered by the `catFilter` crossfilter: it re-runs a single
 * multi-aggregate query on each selection change (fast — one pass over the rows for all fields).
 * Pre-aggregation is deliberately OFF
 * (`filterStable = false`): a cube over ~100 agg columns blows out wasm memory, and the region
 * brush's post_id dimension made it OOM. A plain reactive query handles every selection type
 * (density/region/legend/search) cheaply instead.
 *
 * Correlation statistics require a continuous color-by; for categorical (cluster/platform) or
 * none, those options gray out in the picker and the strip falls back to "zmean" (the chosen
 * metric is kept, so it comes back when a continuous color-by returns).
 */
import * as vg from "@uwdata/vgplot";
import { MosaicClient } from "@uwdata/mosaic-core";
import { Fragment, useEffect, useMemo, useState } from "react";
import { colorByGroups, defaultScale, fieldDescription, fieldLabel, isContinuous } from "../lib/fields";
import type { ColumnInfo } from "../lib/columns";
import type { Selections } from "../selections";
import type { ScaleType } from "../stores/view";

type Metric = "spearman" | "pearson" | "zmean";

interface Field {
  name: string;
  label: string;
  group: string;
  scale: ScaleType;
  firstOfGroup: boolean;
}

// Scale transform matching the density cards (guards zero/negative for log/sqrt), for "zmean":
// comparing means on the transformed scale keeps heavy-tailed counts from being outlier-driven.
const tExpr = (col: string, scale: ScaleType) =>
  scale === "log"
    ? `ln(greatest("${col}", 0) + 1)`
    : scale === "sqrt"
      ? `sqrt(greatest("${col}", 0))`
      : `"${col}"`;

// Corpus-wide mean/std of t(x) per field, fetched once per field set for "zmean".
type Globals = Record<string, { mean: number; std: number }>;

/**
 * Live per-field statistic vs the selection, as a MosaicClient. One row, one aggregate column per
 * field. For the correlation metrics it correlates against the color-by (`__rank` columns for
 * "spearman" where available, raw for "pearson"); for "zmean" it queries the selection's avg(t(x))
 * per field and standardizes against the pre-fetched corpus stats in `globals`.
 */
class StatClient extends MosaicClient {
  metric: Metric;
  cb: string | null;
  fields: Field[];
  ranked: Set<string>;
  globals: Globals | null;
  onData: (m: Record<string, number | null>) => void;
  constructor(
    filterSel: any,
    metric: Metric,
    cb: string | null,
    fields: Field[],
    ranked: Set<string>,
    globals: Globals | null,
    onData: (m: Record<string, number | null>) => void,
  ) {
    super(filterSel);
    this.metric = metric;
    this.cb = cb;
    this.fields = fields;
    this.ranked = ranked;
    this.globals = globals;
    this.onData = onData;
  }
  // The physical column to correlate: the rank sentinel for "spearman" when present, else raw.
  private col(name: string) {
    return this.metric === "spearman" && this.ranked.has(name) ? `${name}__rank` : name;
  }
  // Disable pre-aggregation: a materialized cube over ~100 agg columns (esp. keyed by the
  // region brush's post_id dimension) exhausts wasm memory. Fall back to a plain reactive query.
  get filterStable() {
    return false;
  }
  query(filter: any = []) {
    const sel: Record<string, any> = {};
    if (this.metric === "zmean") {
      // Selection mean of the transformed field; the corpus terms come from `globals`.
      // No selection → unfiltered avg == corpus mean → z = 0 (neutral strip).
      this.fields.forEach((f, i) => {
        sel[`c${i}`] = vg.sql`avg(${tExpr(f.name, f.scale)})`;
      });
    } else {
      const cbCol = this.col(this.cb!);
      this.fields.forEach((f, i) => {
        sel[`c${i}`] = vg.corr(vg.column(this.col(f.name)), vg.column(cbCol));
      });
    }
    return vg.Query.from("data").select(sel).where(filter);
  }
  queryResult(data: any) {
    const next: Record<string, number | null> = {};
    this.fields.forEach((f, i) => {
      const v = data.getChild(`c${i}`)?.get(0);
      let n = v == null ? null : Number(v);
      if (this.metric === "zmean" && n != null) {
        const g = this.globals?.[f.name];
        n = g && Number.isFinite(g.mean) && g.std > 0 ? (n - g.mean) / g.std : null;
      }
      next[f.name] = n;
    });
    this.onData(next);
    return this;
  }
}

// What each category's rows are, for the subtitle tooltips.
const GROUP_INFO: Record<string, string> = {
  Engagement: "Views, likes, comments, shares, saves, reposts, followers.",
  Sentiment: "Polarity / valence from VADER, NRC-VAD (valence-arousal-dominance), TextBlob and RoBERTa.",
  Emotion: "GoEmotions transformer probabilities (anger, joy, gratitude, fear, …).",
  Text: "Readability & lexical stats: word count, lexical diversity, reading ease.",
  Metadata: "Post-level attributes (duration, confidences, flags, …).",
  Embedding: "Embedding / cluster-derived fields.",
};

const METRIC_INFO: { key: Metric; label: string; desc: string }[] = [
  { key: "spearman", label: "Spearman ρ", desc: "Rank correlation (approximate) vs the color-by" },
  { key: "pearson", label: "Pearson r", desc: "Linear correlation vs the color-by" },
  { key: "zmean", label: "Mean Δ (σ)", desc: "Selection mean vs corpus, in SDs on each field's scale" },
];

// Diverging color for a signed statistic: red (negative / below corpus) → neutral → blue
// (positive / above corpus). Positive = cool/blue reads more naturally than red-positive; also
// colorblind-friendlier than green/red (ColorBrewer RdBu endpoints).
const NEG = [178, 24, 43]; // red
const MID = [237, 237, 237];
const POS = [33, 102, 172]; // blue
const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// Each section (group) normalizes its cell colors to its OWN strongest |value| (`scale`),
// so a section of weak-but-real values shows full contrast instead of washing out next to a
// strong section. `scale` is the per-group max |v| (see `groupMax` below); the group's own
// strongest cell always saturates. In "fixed" mode `scale` is the metric's natural range
// (1 for correlations, 2σ for the mean profile).
function statColor(c: number | null, scale = 1): string {
  if (c == null || !Number.isFinite(c)) return "var(--color-base-200)";
  const t = Math.max(-1, Math.min(1, c / (scale > 0 ? scale : 1)));
  const col = t < 0 ? lerp(MID, NEG, -t) : lerp(MID, POS, t);
  return `rgb(${col[0]}, ${col[1]}, ${col[2]})`;
}

// Light tint of the scale color (red neg / blue pos) for the tooltip pill — translucent so it
// reads over the tooltip background; opacity grows with |c|.
function statTint(c: number | null): string {
  if (c == null || !Number.isFinite(c)) return "var(--color-base-200)";
  const [r, g, b] = c < 0 ? NEG : POS;
  const a = 0.12 + 0.28 * Math.min(1, Math.abs(c));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function ProfileStrip({
  coordinator,
  columns,
  colorBy,
  selections,
}: {
  coordinator: any;
  columns: ColumnInfo[];
  colorBy: string | null;
  selections: Selections;
}) {
  // Statistic + color scaling: "section" normalizes each group to its own strongest |value|
  // (structure within a section); "fixed" uses the metric's natural scale (comparable across
  // sections). Both live in the ▾ popover.
  // "zmean" default matters: the default color-by (cluster) is categorical, so the strip OPENS
  // showing the zmean fallback either way — but if the state defaulted to a correlation metric,
  // merely switching to a continuous color-by would flip the displayed statistic to a metric the
  // user never picked. The statistic must only change via the picker.
  const [metric, setMetric] = useState<Metric>("zmean");
  const [colorMode, setColorMode] = useState<"section" | "fixed">("section");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const cbCol = columns.find((c) => c.name === colorBy);
  // Correlations need a continuous focal variable; the mean profile needs no color-by at all.
  // With a categorical/absent color-by the strip stays live but falls back to "zmean" — the
  // chosen metric is kept so it takes effect again when a continuous color-by returns.
  const corrOk = !!cbCol && isContinuous(cbCol);
  const effMetric: Metric = corrOk ? metric : "zmean";
  const zmean = effMetric === "zmean";

  // Base columns that have a precomputed `<name>__rank` (from ingest). Correlating ranks → Spearman.
  const ranked = useMemo(() => new Set(columns.filter((c) => c.hasRank).map((c) => c.name)), [columns]);
  // Spearman labeling only when the color-by is itself ranked (the field set is the same rankable
  // set, so a ranked color-by implies ranked rows); otherwise the "spearman" metric is effectively
  // Pearson on raw values. Approximate: ranks are dataset-wide, not per selection.
  const spearman = effMetric === "spearman" && !!cbCol?.hasRank;

  // Continuous fields to profile. For correlations, minus the color-by itself (self-corr is 1);
  // the mean profile keeps it (its z is as informative as any other field's).
  const fields = useMemo<Field[]>(() => {
    const out: Field[] = [];
    for (const g of colorByGroups(columns)) {
      let first = true;
      for (const it of g.items) {
        if (it.categorical || (!zmean && it.name === colorBy)) continue;
        out.push({
          name: it.name,
          label: it.label,
          group: g.group,
          scale: defaultScale(it.name),
          firstOfGroup: first,
        });
        first = false;
      }
    }
    return out;
  }, [columns, colorBy, zmean]);

  const [stat, setStat] = useState<Record<string, number | null>>({});
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null);
  const [groupHover, setGroupHover] = useState<{ group: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!coordinator || fields.length === 0 || (!zmean && !colorBy)) {
      setStat({});
      return;
    }
    let disposed = false;
    let client: StatClient | null = null;
    const connect = (globals: Globals | null) => {
      if (disposed) return;
      client = new StatClient(selections.catFilter, effMetric, colorBy, fields, ranked, globals, setStat);
      coordinator.connect(client);
    };
    if (zmean) {
      // One-time corpus stats (constant while brushing) so the live query is a cheap filtered avg.
      const exprs = fields
        .map((f, i) => {
          const t = tExpr(f.name, f.scale);
          return `avg(${t}) AS m${i}, stddev_pop(${t}) AS s${i}`;
        })
        .join(", ");
      coordinator
        .query(`SELECT ${exprs} FROM "data"`, { type: "json" })
        .then((rows: any[]) => {
          const r = rows?.[0] ?? {};
          const globals: Globals = {};
          fields.forEach((f, i) => {
            globals[f.name] = { mean: Number(r[`m${i}`]), std: Number(r[`s${i}`]) };
          });
          connect(globals);
        })
        .catch(() => {});
    } else {
      connect(null);
    }
    return () => {
      disposed = true;
      if (client) coordinator.disconnect(client);
    };
  }, [coordinator, fields, selections, colorBy, ranked, effMetric, zmean]);

  // Per-section color scale: the strongest |value| within each group. Each cell's color is
  // normalized against its own group's max, so sections are independently legible.
  const groupMax = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of fields) {
      const c = stat[f.name];
      if (c == null || !Number.isFinite(c)) continue;
      m.set(f.group, Math.max(m.get(f.group) ?? 0, Math.abs(c)));
    }
    return m;
  }, [stat, fields]);

  if (fields.length === 0) return null;

  // Natural full-scale for "fixed" color mode: correlations live in ±1, the mean profile
  // saturates at ±2σ (matching the original z-strip's clamp).
  const fixedScale = zmean ? 2 : 1;
  const fmtC = (c: number | null) =>
    c == null ? "—" : `${c >= 0 ? "+" : ""}${c.toFixed(2)}${zmean ? "σ" : ""}`;
  const pillPrefix = zmean ? "z = " : spearman ? "ρ ≈ " : "r = ";
  const metricShort = zmean ? "Δσ" : spearman ? "ρ ≈" : "r";

  return (
    <div className="my-3 flex min-h-0 w-24 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-box border border-base-300 bg-base-100 px-3 py-2.5">
      {/* Statistic / color-scale picker at the top of the strip; scrolls with the field list. */}
      <div className="mb-0">
        <button
          title="Choose the statistic and color scaling"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu((m) => (m ? null : { x: r.left, y: r.top }));
          }}
          className="flex w-full items-center justify-between rounded bg-base-200 px-1.5 py-1 text-[9px] leading-none text-base-content/60 hover:text-base-content/80"
        >
          <span className="font-semibold">
            {metricShort} · {colorMode === "fixed" ? "abs" : "rel"}
          </span>
          <span className="text-base-content/40">▾</span>
        </button>
      </div>
      {fields.map((f) => {
        const c = stat[f.name] ?? null;
        return (
          <Fragment key={f.name}>
            {f.firstOfGroup && (
              <div
                className="mt-1.5 cursor-help text-[10px] font-medium uppercase tracking-wide text-base-content/40 first:mt-0"
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setGroupHover({ group: f.group, x: r.left, y: r.top + r.height / 2 });
                }}
                onMouseLeave={() => setGroupHover((g) => (g?.group === f.group ? null : g))}
              >
                {f.group}
              </div>
            )}
            <div
              className="flex items-center gap-1"
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setHover({ name: f.name, x: r.left, y: r.top + r.height / 2 });
              }}
              onMouseLeave={() => setHover((h) => (h?.name === f.name ? null : h))}
            >
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-sm"
                style={{ background: statColor(c, colorMode === "fixed" ? fixedScale : groupMax.get(f.group)) }}
              />
              <span className="text-[10px] tabular-nums text-base-content/50">{fmtC(c)}</span>
            </div>
          </Fragment>
        );
      })}

      {menu && (
        <>
          {/* Click-away backdrop for the picker. */}
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          <div
            className="fixed z-50 w-56 -translate-x-full rounded-md border border-base-300 bg-base-100 p-2 text-xs shadow-lg"
            style={{ left: menu.x - 8, top: menu.y }}
          >
            <div className="mb-1 text-[9px] font-medium uppercase tracking-wide text-base-content/40">
              Statistic
            </div>
            {METRIC_INFO.map((m) => {
              // Correlations need a continuous color-by; gray those options out (and mark the
              // zmean fallback as active) when the color-by is categorical or absent.
              const disabled = m.key !== "zmean" && !corrOk;
              const current = effMetric === m.key;
              return (
                <button
                  key={m.key}
                  disabled={disabled}
                  title={disabled ? "Needs a continuous color-by variable" : undefined}
                  onClick={() => setMetric(m.key)}
                  className={`flex w-full flex-col rounded px-1.5 py-1 text-left transition-colors ${
                    disabled
                      ? "cursor-not-allowed opacity-35"
                      : current
                        ? "bg-base-200 text-base-content/80"
                        : "text-base-content/60 hover:bg-base-200/60"
                  }`}
                >
                  <span className={current ? "font-semibold" : ""}>{m.label}</span>
                  <span className="text-[10px] text-base-content/45">{m.desc}</span>
                </button>
              );
            })}
            <div className="mb-1 mt-2 text-[9px] font-medium uppercase tracking-wide text-base-content/40">
              Color scale
            </div>
            <div className="flex gap-px rounded bg-base-200 p-0.5 text-[10px] leading-none">
              {([
                ["fixed", "absolute", zmean ? "Fixed ±2σ scale" : "Fixed −1 to +1 scale"],
                ["section", "relative", "Each section scaled to its own strongest value"],
              ] as const).map(([mode, label, title]) => (
                <button
                  key={mode}
                  title={title}
                  onClick={() => setColorMode(mode)}
                  className={`flex-1 rounded-[3px] px-1 py-1 transition-colors ${
                    colorMode === mode
                      ? "bg-base-100 font-semibold text-base-content/80 shadow-sm"
                      : "text-base-content/40 hover:text-base-content/60"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {hover &&
        (() => {
          const desc = fieldDescription(hover.name);
          return (
            <div
              className="pointer-events-none fixed z-50 w-max max-w-md -translate-x-full -translate-y-1/2 rounded-md border border-base-300 bg-base-100 px-2.5 py-1.5 text-xs shadow-lg"
              style={{ left: hover.x - 8, top: Math.min(Math.max(hover.y, 44), window.innerHeight - 44) }}
            >
              <div>
                <span className="font-medium text-base-content/80">
                  {fields.find((f) => f.name === hover.name)?.label}
                </span>{" "}
                <span
                  className="inline-block whitespace-nowrap rounded px-1.5 py-0.5 font-mono tabular-nums text-base-content/70"
                  style={{ background: statTint(stat[hover.name] ?? null) }}
                >
                  {pillPrefix}
                  {fmtC(stat[hover.name] ?? null)}
                </span>
              </div>
              {desc && <div className="mt-0.5 whitespace-pre-line text-base-content/55">{desc}</div>}
            </div>
          );
        })()}

      {groupHover && (
        <div
          className="pointer-events-none fixed z-50 w-max max-w-md -translate-x-full -translate-y-1/2 rounded-md border border-base-300 bg-base-100 px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: groupHover.x - 8,
            // Clamp the vertical center so the tooltip stays on-screen near the top/bottom rows.
            top: Math.min(Math.max(groupHover.y, 52), window.innerHeight - 52),
          }}
        >
          <div className="font-medium text-base-content/80">{groupHover.group}</div>
          <div className="text-base-content/60">{GROUP_INFO[groupHover.group] ?? ""}</div>
          <div className="mt-0.5 text-base-content/40">
            {zmean
              ? "Selection mean vs corpus, in SDs (on each field's default scale). No selection → 0. "
              : `${spearman ? "Spearman ρ" : "Pearson r"} vs ${colorBy ? fieldLabel(colorBy) : "the color-by"}. ${
                  spearman ? "Approximated from dataset-wide ranks. " : ""
                }`}
            {colorMode === "section"
              ? "Colors: each section scaled to its own strongest value."
              : zmean
                ? "Colors: fixed ±2σ scale."
                : "Colors: fixed −1 to +1 scale."}
          </div>
        </div>
      )}
    </div>
  );
}
