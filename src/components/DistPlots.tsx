/**
 * Customizable density (KDE) cards below the sidebar.
 *  - Post date is pinned at the top (temporal axis + date-range clamp).
 *  - Below it: a user-managed list of variable cards (starts with views). Each has a
 *    scale dropdown (linear / sqrt / log), min/max clamp inputs, and a trash icon.
 *  - An "add plot" picker appends a card for any continuous variable.
 *
 * Filtering: interval BRUSH (intervalX → cross, highlights the map) + hard CLAMP inputs
 * (→ clamp, filters the whole view). Densities filter by `histFilter` (clamp ∩ region ∩
 * legend). A clamp also pins the card's xDomain, and densityY recomputes its extent per
 * query, so the curve re-resolves finely within the clamp window (no fixed bin grid).
 */
import * as vg from "@uwdata/vgplot";
import { MosaicClient } from "@uwdata/mosaic-core";
import { Fragment, useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { ColumnInfo } from "../lib/columns";
import { colorByGroups, defaultScale, fieldLabel, isCategorical } from "../lib/fields";
import type { Selections } from "../selections";
import type { ScaleType } from "../stores/view";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const monthYear = new Intl.DateTimeFormat("en", { month: "short", year: "numeric" });

/** Parse a clamp-input bound to the column's RAW value (dates → epoch seconds). */
function parseBound(kind: "date" | "cont", s: string, isHi: boolean): number | null {
  if (s.trim() === "") return null;
  if (kind === "date") return Math.floor(Date.parse(`${s}T${isHi ? "23:59:59" : "00:00:00"}Z`) / 1000);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Map a raw column value into the plot's x-space (matches xConfig's expression). */
function toXDomainValue(kind: "date" | "cont", scale: ScaleType, raw: number): number {
  if (kind === "date") return raw * 1000; // numeric epoch-ms (NOT a Date / TIMESTAMP)
  if (scale === "log") return Math.log(Math.max(raw, 0) + 1);
  if (scale === "sqrt") return Math.sqrt(Math.max(raw, 0));
  return raw;
}

/** x binning expression + tick format for a kind/scale. */
function xConfig(col: string, kind: "date" | "cont", scale: ScaleType) {
  // Dates go in as plain numeric epoch-ms (a linear scale), formatted to month/year by
  // `fmt`. We deliberately do NOT build a TIMESTAMP here: densityY's time-scale handling
  // would wrap the expression in epoch_ms() a second time and the BETWEEN would mix
  // BIGINT and TIMESTAMP. Keeping it numeric sidesteps that.
  if (kind === "date")
    return {
      x: vg.sql`${vg.column(col)} * 1000`,
      fmt: (d: any) => monthYear.format(new Date(Number(d))),
    };
  if (scale === "log")
    return { x: vg.sql`ln(greatest(${vg.column(col)}, 0) + 1)`, fmt: (d: number) => compact.format(Math.expm1(Number(d))) };
  if (scale === "sqrt")
    return { x: vg.sql`sqrt(greatest(${vg.column(col)}, 0))`, fmt: (d: number) => compact.format(Number(d) ** 2) };
  return { x: vg.column(col), fmt: (d: number) => compact.format(Number(d)) };
}

function HistCard({ coordinator, sel, col, kind, scale, onScale, onRemove }: {
  coordinator: any;
  sel: Selections;
  col: string;
  kind: "date" | "cont";
  scale: ScaleType;
  onScale?: (s: ScaleType) => void;
  onRemove?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const clampSrc = useRef({}).current;
  const [lo, setLo] = useState("");
  const [hi, setHi] = useState("");
  // Raw [min, max] of the column, for xDomain fallback when only one bound is clamped.
  const [range, setRange] = useState<[number, number] | null>(null);

  const loRaw = parseBound(kind, lo, false);
  const hiRaw = parseBound(kind, hi, true);

  // Hard min/max bounds → shared `clamp` filter (raw column value; dates → epoch seconds).
  useEffect(() => {
    const parts: any[] = [];
    if (loRaw !== null) parts.push(vg.sql`${vg.column(col)} >= ${loRaw}`);
    if (hiRaw !== null) parts.push(vg.sql`${vg.column(col)} <= ${hiRaw}`);
    const predicate = parts.length === 2 ? vg.and(...parts) : parts.length === 1 ? parts[0] : null;
    sel.clamp.update({ source: clampSrc, value: predicate ? [loRaw, hiRaw] : null, predicate });
    return () => sel.clamp.update({ source: clampSrc, value: null, predicate: null });
  }, [loRaw, hiRaw, col, sel, clampSrc]);

  // Fetch the column's raw extent once (per col) so a one-sided clamp can still
  // fix the other end of the histogram's domain.
  useEffect(() => {
    if (!coordinator) return;
    let alive = true;
    coordinator
      .query(`SELECT min(${vg.column(col)}) AS lo, max(${vg.column(col)}) AS hi FROM data`, {
        type: "json",
      })
      .then((rows: any[]) => {
        const r = rows?.[0];
        if (alive && r && r.lo != null && r.hi != null) setRange([Number(r.lo), Number(r.hi)]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [coordinator, col]);

  // When a clamp is set, pin the histogram's x-domain to [lo, hi] so binning
  // recomputes finely WITHIN the clamp (bins otherwise span the full column extent).
  const clamped = loRaw !== null || hiRaw !== null;
  const dLo = loRaw ?? range?.[0];
  const dHi = hiRaw ?? range?.[1];
  const xDomain =
    clamped && dLo != null && dHi != null && dLo < dHi
      ? [toXDomainValue(kind, scale, dLo), toXDomainValue(kind, scale, dHi)]
      : null;

  // Build the histogram (rebuild on scale/col change, clamp-domain change, or resize).
  useEffect(() => {
    if (!coordinator || !ref.current) return;
    const el = ref.current;
    let disposed = false;
    let plotInst: any = null;
    // Removing a plot's SVG orphans its interval-brush clause in `cross` (the brush vanishes
    // but keeps dimming the umap). Clear THIS plot's interactor clauses before replacing it.
    const clearInteractors = () => {
      for (const it of plotInst?.interactors ?? []) {
        try {
          it.selection?.update({ source: it, value: null, predicate: null });
        } catch {
          /* ignore */
        }
      }
      plotInst = null;
    };
    const build = () => {
      if (disposed) return;
      const w = el.clientWidth;
      if (!w) return;
      clearInteractors();
      const api = vg.createAPIContext({ coordinator });
      const { x, fmt } = xConfig(col, kind, scale);
      const plotEl = api.plot(
        api.densityY(api.from("data", { filterBy: sel.histFilter }), {
          x,
          fill: "currentColor",
          fillOpacity: 0.18,
          stroke: "currentColor",
          strokeWidth: 1.25,
        }),
        api.intervalX({ as: sel.cross }),
        api.xLabel(null),
        api.yLabel(null),
        api.yTicks(0),
        api.xTickFormat(fmt),
        ...(xDomain ? [api.xDomain(xDomain)] : []),
        api.marginLeft(10),
        api.marginRight(8),
        api.marginTop(4),
        api.marginBottom(18),
        api.width(w),
        api.height(92),
      );
      plotInst = (plotEl as any).value; // mosaic Plot instance (holds interactors)
      el.replaceChildren(plotEl);
    };
    const ro = new ResizeObserver(build);
    ro.observe(el);
    return () => {
      disposed = true;
      ro.disconnect();
      clearInteractors();
      el.replaceChildren();
    };
  }, [coordinator, sel, col, kind, scale, clamped, dLo, dHi]);

  return (
    <div className="rounded-box border border-base-300 bg-base-100 p-2">
      {kind === "date" ? (
        <div className="mb-1 flex items-center justify-between gap-1 px-1">
          <span className="truncate text-xs font-medium text-base-content/70">{fieldLabel(col)}</span>
          <span className="flex shrink-0 items-center gap-1">
            <input type="date" value={lo} onChange={(e) => setLo(e.target.value)}
                   className="input input-xs h-5 w-[7.5rem] px-1 text-xs" />
            <input type="date" value={hi} onChange={(e) => setHi(e.target.value)}
                   className="input input-xs h-5 w-[7.5rem] px-1 text-xs" />
          </span>
        </div>
      ) : (
        <div className="mb-1 flex items-center gap-1 px-1">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-base-content/70">{fieldLabel(col)}</span>
          <span className="flex shrink-0 items-center gap-1">
            {onScale && (
              <select
                value={scale}
                onChange={(e) => onScale(e.target.value as ScaleType)}
                className="select select-xs h-5 min-h-0 px-1 text-xs"
              >
                <option value="linear">lin</option>
                <option value="sqrt">sqrt</option>
                <option value="log">log</option>
              </select>
            )}
            <input type="number" placeholder="min" value={lo} onChange={(e) => setLo(e.target.value)}
                   className="input input-xs h-5 w-12 px-1 text-xs" />
            <input type="number" placeholder="max" value={hi} onChange={(e) => setHi(e.target.value)}
                   className="input input-xs h-5 w-12 px-1 text-xs" />
          </span>
          {onRemove && (
            <button className="shrink-0 pl-2 text-base-content/40 transition-colors hover:text-error"
                    onClick={onRemove}>
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      )}
      <div ref={ref} className="h-[92px] w-full text-base-content/70" />
    </div>
  );
}

/**
 * Live per-category counts as a proper MosaicClient: its GROUP BY query is pre-aggregation
 * compatible, so when it filters by the `catFilter` crossfilter the coordinator builds a
 * materialized cube on brush-activate → every drag frame reads the cube = real-time (this is
 * how mosaic crossfilters stay instant). Results are pushed to React and rendered as HTML.
 */
class CatCountClient extends MosaicClient {
  col: string;
  onData: (m: Map<string, number>) => void;
  constructor(filterSel: any, col: string, onData: (m: Map<string, number>) => void) {
    super(filterSel);
    this.col = col;
    this.onData = onData;
  }
  // Groupby domain (the categories) doesn't change with the filter → pre-agg applies.
  get filterStable() {
    return true;
  }
  query(filter: any = []) {
    return vg.Query.from("data")
      .select({ cat: vg.column(this.col), n: vg.count() })
      .groupby(vg.column(this.col))
      .where(filter);
  }
  queryResult(data: any) {
    const cat = data.getChild("cat");
    const n = data.getChild("n");
    const m = new Map<string, number>();
    for (let i = 0; i < data.numRows; i++) {
      const c = cat.get(i);
      if (c != null) m.set(String(c), Number(n.get(i)));
    }
    this.onData(m);
    return this;
  }
}

/**
 * Categorical count bars (à la bedbase): a faint total bar + a solid live-count bar per
 * category. The live counts come from a real MosaicClient (cube-accelerated crossfilter, above),
 * NOT hand-rolled queries. Click a row to toggle that category into `cross` — the same highlight
 * channel as the density brushes — with the clause tagged to this client so it self-excludes.
 */
function CatCard({ coordinator, sel, col, onRemove }: {
  coordinator: any;
  sel: Selections;
  col: string;
  onRemove: () => void;
}) {
  const clientRef = useRef<CatCountClient | null>(null);
  // Stable clause source for this card's `cross` toggle. Must NOT be tied to `clientRef.current`:
  // on unmount React runs effect cleanups top-to-bottom, so the client-connect cleanup nulls
  // clientRef BEFORE the clear-on-unmount cleanup runs — a `clientRef.current ?? col` source would
  // then fall back to `col` and fail to match the clause (whose source was the client), leaving the
  // map highlighted after the card is deleted. A dedicated ref is stable across that lifecycle.
  const crossSrc = useRef({}).current;
  const [totals, setTotals] = useState<{ cat: string; n: number }[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Total counts per category, once (background bars). All categories, count-desc; the list
  // scrolls if long (a hard top-N would hide small categories the color legend still shows).
  useEffect(() => {
    if (!coordinator) return;
    let alive = true;
    coordinator
      .query(
        `SELECT ${vg.column(col)} AS cat, count(*) AS n FROM data ` +
          `WHERE ${vg.column(col)} IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 100`,
        { type: "json" },
      )
      .then((rows: any[]) => alive && setTotals(rows.map((r) => ({ cat: String(r.cat), n: Number(r.n) }))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [coordinator, col]);

  // Live in-filter counts via the pre-aggregated MosaicClient.
  useEffect(() => {
    if (!coordinator) return;
    const client = new CatCountClient(sel.catFilter, col, setCounts);
    clientRef.current = client;
    coordinator.connect(client);
    return () => {
      coordinator.disconnect(client);
      clientRef.current = null;
    };
  }, [coordinator, col, sel]);

  // Toggled categories → `cross` (drives the map highlight + other cards). The clause is tagged
  // with this client in `clients` so the crossfilter self-excludes it from THIS card's counts.
  // CAST to VARCHAR so numeric/boolean categories match their string keys. We do NOT clear on
  // each change — `update` replaces the prior clause by `source`, so a pre-clear would flash the
  // map to "all points" between updates. The clause is cleared once on unmount below.
  useEffect(() => {
    const client = clientRef.current;
    // `clients` (self-exclusion in the crossfilter) rides the client; `source` is the stable ref.
    const clients = client ? new Set([client]) : undefined;
    const cats = [...selected];
    if (cats.length === 0) {
      sel.cross.update({ source: crossSrc, clients, value: null, predicate: null });
    } else {
      const inList = cats.map((c) => `'${c.replace(/'/g, "''")}'`).join(", ");
      sel.cross.update({
        source: crossSrc,
        clients,
        value: cats,
        predicate: vg.sql`CAST(${vg.column(col)} AS VARCHAR) IN (${inList})`,
      });
    }
  }, [selected, sel, col, crossSrc]);

  // Clear this card's toggle clause from `cross` on unmount only.
  useEffect(() => {
    return () => sel.cross.update({ source: crossSrc, value: null, predicate: null });
  }, [sel, crossSrc]);

  const toggle = (cat: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });

  const maxTotal = Math.max(1, ...totals.map((t) => t.n));

  return (
    <div className="rounded-box border border-base-300 bg-base-100 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-1 px-1">
        <span className="truncate text-xs font-medium text-base-content/70">{fieldLabel(col)}</span>
        <button className="shrink-0 text-base-content/40 transition-colors hover:text-error" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
        {totals.map((t) => {
          const sc = counts.get(t.cat) ?? 0;
          const isSel = selected.has(t.cat);
          return (
            <button
              key={t.cat}
              onClick={() => toggle(t.cat)}
              title={`${t.cat} · ${sc.toLocaleString()} / ${t.n.toLocaleString()}`}
              className={`flex items-center gap-1 rounded px-1 text-left transition-colors ${
                isSel ? "bg-primary/5" : "hover:bg-base-200/50"
              }`}
              style={{ height: 14 }}
            >
              <span
                className={`shrink-0 truncate text-right leading-none ${
                  isSel ? "font-semibold text-primary" : "text-base-content/60"
                }`}
                style={{ width: 32, fontSize: 9 }}
              >
                {t.cat}
              </span>
              <span className="relative h-2.5 flex-1">
                <span
                  className="absolute inset-y-0 left-0 rounded-[2px] bg-base-content/10"
                  style={{ width: `${(t.n / maxTotal) * 100}%` }}
                />
                <span
                  className={`absolute inset-y-0 left-0 rounded-[2px] ${isSel ? "bg-primary" : "bg-primary/60"}`}
                  style={{ width: `${(sc / maxTotal) * 100}%` }}
                />
              </span>
              <span className="shrink-0 text-right leading-none tabular-nums text-base-content/45" style={{ fontSize: 8 }}>
                {compact.format(sc)} / {compact.format(t.n)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AddPlot({ options, onAdd }: {
  options: { group: string; items: { name: string; label: string }[] }[];
  onAdd: (col: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="dropdown dropdown-top w-full">
      <div
        tabIndex={0}
        role="button"
        className="flex w-full cursor-pointer items-center justify-center rounded-box border border-dashed border-base-300 py-2.5 text-sm text-base-content/50 transition-colors hover:border-base-content/30 hover:text-base-content/80"
      >
        + add plot
      </div>
      <ul
        tabIndex={0}
        className="menu dropdown-content z-30 mb-1 max-h-72 w-full flex-nowrap overflow-y-auto rounded-lg border border-base-300 bg-base-100 p-1 shadow-lg"
      >
        {options.map((g) => (
          <Fragment key={g.group}>
            <li className="menu-title px-2 pt-1 text-xs">{g.group}</li>
            {g.items.map((it) => (
              <li key={it.name}>
                <button
                  onClick={() => {
                    onAdd(it.name);
                    (document.activeElement as HTMLElement)?.blur();
                  }}
                >
                  {it.label}
                </button>
              </li>
            ))}
          </Fragment>
        ))}
      </ul>
    </div>
  );
}

export function DistPlots({ coordinator, columns, selections }: {
  coordinator: any;
  columns: ColumnInfo[];
  selections: Selections;
}) {
  const present = new Set(columns.map((c) => c.name));
  const hasDate = present.has("create_time");
  const idRef = useRef(1);
  const [cards, setCards] = useState<{ id: number; col: string; scale: ScaleType; kind: "cont" | "cat" }[]>([]);

  const catOf = (col: string) => {
    const c = columns.find((x) => x.name === col);
    return c ? isCategorical(c) : false;
  };

  const used = new Set(cards.map((c) => c.col));
  // Variables available to add: continuous → density, categorical → count bars.
  // Exclude the pinned date card and anything already added.
  const options = colorByGroups(columns)
    .map((g) => ({
      group: g.group,
      items: g.items.filter((it) => it.name !== "create_time" && !used.has(it.name)),
    }))
    .filter((g) => g.items.length > 0);

  const add = (col: string) =>
    setCards((cs) => {
      const cat = catOf(col);
      return [...cs, { id: idRef.current++, col, kind: cat ? "cat" : "cont", scale: cat ? "linear" : defaultScale(col) }];
    });
  const remove = (id: number) => setCards((cs) => cs.filter((c) => c.id !== id));
  const setScale = (id: number, scale: ScaleType) =>
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, scale } : c)));

  return (
    <>
      {hasDate && (
        <HistCard coordinator={coordinator} sel={selections} col="create_time" kind="date" scale="linear" />
      )}
      {cards.map((c) =>
        c.kind === "cat" ? (
          <CatCard key={c.id} coordinator={coordinator} sel={selections} col={c.col} onRemove={() => remove(c.id)} />
        ) : (
          <HistCard
            key={c.id}
            coordinator={coordinator}
            sel={selections}
            col={c.col}
            kind={c.kind}
            scale={c.scale}
            onScale={(s) => setScale(c.id, s)}
            onRemove={() => remove(c.id)}
          />
        ),
      )}
      <AddPlot options={options} onAdd={add} />
    </>
  );
}
