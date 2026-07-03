/**
 * Correlation strip: a thin labeled 1-column heatmap to the right of the umap. One cell per
 * continuous field (grouped by category), colored by its PEARSON correlation with the current
 * color-by variable over the live selection (brush / region / legend / search) — or the whole
 * corpus when nothing is selected.
 *
 * Live via a MosaicClient filtered by the `catFilter` crossfilter: it re-runs a single
 * multi-`corr()` query on each selection change (fast — one pass over the rows for all fields).
 * Pre-aggregation is deliberately OFF (`filterStable = false`): a cube over ~100 corr columns
 * blows out wasm memory, and the region brush's post_id dimension made it OOM. A plain reactive
 * query handles every selection type (density/region/legend/search) cheaply instead.
 *
 * Requires a continuous color-by; for categorical (cluster/platform) or none the card grays out.
 */
import * as vg from "@uwdata/vgplot";
import { MosaicClient } from "@uwdata/mosaic-core";
import { Fragment, useEffect, useMemo, useState } from "react";
import { colorByGroups, fieldDescription, fieldLabel, isContinuous } from "../lib/fields";
import type { ColumnInfo } from "../lib/columns";
import type { Selections } from "../selections";

interface Field {
  name: string;
  label: string;
  group: string;
  firstOfGroup: boolean;
}

/**
 * Live per-field Pearson correlation with the color-by, as a pre-aggregatable MosaicClient.
 * One row, one `corr()` column per field; `filterStable` since the field set is fixed.
 */
class CorrClient extends MosaicClient {
  cb: string;
  fields: Field[];
  onData: (m: Record<string, number | null>) => void;
  constructor(filterSel: any, cb: string, fields: Field[], onData: (m: Record<string, number | null>) => void) {
    super(filterSel);
    this.cb = cb;
    this.fields = fields;
    this.onData = onData;
  }
  // Disable pre-aggregation: a materialized cube over ~100 corr columns (esp. keyed by the
  // region brush's post_id dimension) exhausts wasm memory. Fall back to a plain reactive query.
  get filterStable() {
    return false;
  }
  query(filter: any = []) {
    const sel: Record<string, any> = {};
    this.fields.forEach((f, i) => {
      sel[`c${i}`] = vg.corr(vg.column(f.name), vg.column(this.cb));
    });
    return vg.Query.from("data").select(sel).where(filter);
  }
  queryResult(data: any) {
    const next: Record<string, number | null> = {};
    this.fields.forEach((f, i) => {
      const v = data.getChild(`c${i}`)?.get(0);
      next[f.name] = v == null ? null : Number(v);
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

// Diverging color for a correlation in [-1, 1]: red (negative) → neutral → blue (positive).
// Positive = cool/blue reads more naturally than red-positive; also colorblind-friendlier
// than green/red (ColorBrewer RdBu endpoints).
const NEG = [178, 24, 43]; // red
const MID = [237, 237, 237];
const POS = [33, 102, 172]; // blue
const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// Each section (group) normalizes its cell colors to its OWN strongest |correlation| (`scale`),
// so a section of weak-but-real correlations shows full contrast instead of washing out next to a
// strongly-correlated section. `scale` is the per-group max |r| (see `groupMax` below); the group's
// own strongest cell always saturates. Falls back to the raw [-1, 1] scale if `scale` is 0/absent.
function corrColor(c: number | null, scale = 1): string {
  if (c == null || !Number.isFinite(c)) return "var(--color-base-200)";
  const t = Math.max(-1, Math.min(1, c / (scale > 0 ? scale : 1)));
  const col = t < 0 ? lerp(MID, NEG, -t) : lerp(MID, POS, t);
  return `rgb(${col[0]}, ${col[1]}, ${col[2]})`;
}

// Light tint of the scale color (red neg / blue pos) for the tooltip pill — translucent so it
// reads over the tooltip background; opacity grows with |c|.
function corrTint(c: number | null): string {
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
  const cbCol = columns.find((c) => c.name === colorBy);
  const active = !!cbCol && isContinuous(cbCol); // correlation needs a continuous focal variable

  // Continuous fields to correlate, minus the color-by itself (its self-correlation is 1).
  const fields = useMemo<Field[]>(() => {
    const out: Field[] = [];
    for (const g of colorByGroups(columns)) {
      let first = true;
      for (const it of g.items) {
        if (it.categorical || it.name === colorBy) continue;
        out.push({ name: it.name, label: it.label, group: g.group, firstOfGroup: first });
        first = false;
      }
    }
    return out;
  }, [columns, colorBy]);

  const [corr, setCorr] = useState<Record<string, number | null>>({});
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null);
  const [groupHover, setGroupHover] = useState<{ group: string; x: number; y: number } | null>(null);
  // Hint shown when the card is grayed out (no continuous color-by to correlate against).
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null);
  // Color scaling: "section" normalizes each group to its own strongest |r| (structure within a
  // section); "fixed" uses the raw −1…+1 scale (magnitudes comparable across sections).
  const [colorMode, setColorMode] = useState<"section" | "fixed">("section");

  useEffect(() => {
    if (!coordinator || fields.length === 0 || !active || !colorBy) {
      setCorr({});
      return;
    }
    const client = new CorrClient(selections.catFilter, colorBy, fields, setCorr);
    coordinator.connect(client);
    return () => coordinator.disconnect(client);
  }, [coordinator, fields, selections, colorBy, active]);

  // Per-section color scale: the strongest |correlation| within each group. Each cell's color is
  // normalized against its own group's max, so sections are independently legible.
  const groupMax = useMemo(() => {
    const m = new Map<string, number>();
    if (!active) return m;
    for (const f of fields) {
      const c = corr[f.name];
      if (c == null || !Number.isFinite(c)) continue;
      m.set(f.group, Math.max(m.get(f.group) ?? 0, Math.abs(c)));
    }
    return m;
  }, [corr, fields, active]);

  if (fields.length === 0) return null;

  const fmtC = (c: number | null) => (c == null ? "—" : `${c >= 0 ? "+" : ""}${c.toFixed(2)}`);

  return (
    <div
      className={`my-3 flex min-h-0 w-24 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-box border border-base-300 bg-base-100 px-3 py-2.5 ${
        active ? "" : "opacity-40"
      }`}
      onMouseMove={active ? undefined : (e) => setHint({ x: e.clientX, y: e.clientY })}
      onMouseLeave={active ? undefined : () => setHint(null)}
    >
      {/* Color-scaling toggle, pinned to the top of the strip while the fields scroll under it. */}
      <div className="sticky top-0 z-10 -mx-3 -mt-2.5 mb-1.5 bg-base-100 px-3 pb-1 pt-0.5">
        <div className="flex gap-px rounded bg-base-200 p-0.5 text-[9px] leading-none">
          {([
            ["fixed", "abs", "Absolute scale: −1 to +1 (magnitudes comparable across sections)"],
            ["section", "rel", "Relative: each section scaled to its own strongest correlation"],
          ] as const).map(([m, label, title]) => (
            <button
              key={m}
              title={title}
              onClick={() => setColorMode(m)}
              className={`flex-1 rounded-[3px] px-1 py-0.5 transition-colors ${
                colorMode === m
                  ? "bg-base-100 font-semibold text-base-content/80 shadow-sm"
                  : "text-base-content/40 hover:text-base-content/60"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {fields.map((f) => {
        const c = active ? corr[f.name] ?? null : null;
        return (
          <Fragment key={f.name}>
            {f.firstOfGroup && (
              <div
                className="mt-1.5 cursor-help text-[10px] font-medium uppercase tracking-wide text-base-content/40 first:mt-0"
                onMouseEnter={(e) => {
                  if (!active) return;
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
                if (!active) return;
                const r = e.currentTarget.getBoundingClientRect();
                setHover({ name: f.name, x: r.left, y: r.top + r.height / 2 });
              }}
              onMouseLeave={() => setHover((h) => (h?.name === f.name ? null : h))}
            >
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-sm"
                style={{ background: corrColor(c, colorMode === "fixed" ? 1 : groupMax.get(f.group)) }}
              />
              <span className="text-[10px] tabular-nums text-base-content/50">{fmtC(c)}</span>
            </div>
          </Fragment>
        );
      })}

      {hover &&
        active &&
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
                  style={{ background: corrTint(corr[hover.name] ?? null) }}
                >
                  r = {fmtC(corr[hover.name] ?? null)}
                </span>
              </div>
              {desc && <div className="mt-0.5 text-base-content/55">{desc}</div>}
            </div>
          );
        })()}

      {hint && !active && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-full -translate-y-1/2 whitespace-nowrap rounded-md border border-base-300 bg-base-100 px-2 py-1 text-xs text-base-content/70 shadow-lg"
          style={{ left: hint.x - 8, top: hint.y }}
        >
          Correlation vs the color-by · choose a continuous variable to enable
        </div>
      )}

      {groupHover && active && (
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
            Pearson r vs {colorBy ? fieldLabel(colorBy) : "the color-by"}.{" "}
            {colorMode === "section"
              ? "Colors: each section scaled to its own strongest r."
              : "Colors: fixed −1 to +1 scale."}
          </div>
        </div>
      )}
    </div>
  );
}
