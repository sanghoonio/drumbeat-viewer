/**
 * The embedding scatter — pure vgplot, native continuous color.
 * Template: tessera pre-embedding-atlas impl (commit 665d9a0 UmapPlot.tsx).
 * Fills its parent; the interactive color legend renders into the sidebar slot.
 */
import * as vg from "@uwdata/vgplot";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ColumnInfo } from "../lib/columns";
import { fieldLabel, isCategorical, isContinuous } from "../lib/fields";
import { TABLEAU20 } from "../lib/palette";
import type { Selections } from "../selections";
import type { ScaleType } from "../stores/view";
import { PostCard } from "./PostCard";

// Ramp-legend tick formatters: compact numbers (so log/symlog ticks don't overlap) and
// month/year for the date legend.
const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const monthYearFmt = new Intl.DateTimeFormat("en", { month: "short", year: "2-digit" });

// Legend tick label: compact for |v| >= 1 (1K, 1M) but a couple of significant digits for sub-1
// values — compact's 1-fraction-digit rounding otherwise collapses e.g. 0.02 → "0" and 0.05 → "0.1"
// (relevant for probability color-by fields like RoBERTa pos/neg).
const numTickFmt = (d: any) => {
  const n = Number(d);
  if (!Number.isFinite(n)) return "";
  if (n === 0 || Math.abs(n) >= 1) return compactFmt.format(n);
  return n.toLocaleString("en", { maximumSignificantDigits: 2 });
};

// A small, clean set of log-nice tick VALUES for a log/symlog color legend, or null to let Plot
// pick its own. Two regimes:
//  - Positive domain (true `log` scale): adaptive mantissa density within [lo, hi] so we get ~3-7
//    ticks — pure powers of ten when wide, 1-2-5 when medium, all integer mantissas when narrow.
//    The previous version looped from 10**0, so a domain entirely below 1 (probabilities like
//    RoBERTa pos/neg) produced an EMPTY array and a blank legend; walking the real exponent range
//    covers sub-1 magnitudes too.
//  - Domain touching/crossing 0 (`symlog` scale, e.g. counts with 0-view posts): 0 plus powers of
//    ten (|v| >= 1) on each present side — symlog's own ticks are linearly spaced and bunch at the
//    high end, so we must supply these explicitly.
// Pathologically narrow domains (no nice tick lands inside) return null → Plot's default ticks.
function logTicks(lo: number, hi: number): number[] | null {
  if (!(hi > lo)) return null;
  if (lo > 0) {
    const within = (mantissas: number[]): number[] => {
      const out: number[] = [];
      const eStart = Math.floor(Math.log10(lo));
      const eEnd = Math.ceil(Math.log10(hi));
      for (let e = eStart; e <= eEnd; e++)
        for (const m of mantissas) {
          const v = m * 10 ** e;
          if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) out.push(v);
        }
      return out;
    };
    const decades = Math.log10(hi / lo);
    const ticks =
      decades >= 2 ? within([1]) // wide: powers of ten
      : decades >= 0.7 ? within([1, 2, 5]) // medium: 1-2-5 per decade
      : within([1, 2, 3, 4, 5, 6, 7, 8, 9]); // narrow: all mantissas
    return ticks.length ? ticks.sort((a, b) => a - b) : null;
  }
  // symlog: 0 plus powers of ten with magnitude >= 1 on each present side.
  const t: number[] = [0];
  for (let e = 0; 10 ** e <= hi; e++) t.push(10 ** e);
  if (lo < 0) for (let e = 0; 10 ** e <= -lo; e++) t.push(-(10 ** e));
  return t.length > 1 ? t.sort((a, b) => a - b) : null;
}

interface Props {
  coordinator: any;
  columns: ColumnInfo[];
  xCol: string;
  yCol: string;
  colorBy: string | null;
  scaleType: ScaleType;
  selections: Selections;
  legendRef: RefObject<HTMLDivElement | null>;
}

export function Scatter({
  coordinator, columns, xCol, yCol, colorBy, scaleType, selections, legendRef,
}: Props) {
  const plotRef = useRef<HTMLDivElement>(null);
  // `nearest` tracks the post under the pointer into `clickSel`; we read its active
  // clause synchronously on click (the 'value' event fires async, one flush late).
  const clickSel = useMemo(() => vg.Selection.single(), []);
  // Pins the selected post so an overlay mark can ring it. `empty: true` → shows nothing
  // when unset (a default-empty selection would otherwise match ALL rows).
  const pinSel = useMemo(() => vg.Selection.single({ empty: true }), []);
  const pinSrc = useRef({}).current;
  // The clicked row plus the click's viewport coords, so the card can open beside the cursor.
  const [selected, setSelected] = useState<{
    row: Record<string, any>;
    at: { x: number; y: number };
  } | null>(null);

  // Keep the pin in sync with the open card: ring the selected point until it closes.
  useEffect(() => {
    const id = selected?.row.post_id;
    if (id == null) {
      pinSel.update({ source: pinSrc, value: null, predicate: null });
    } else {
      // vg.sql inserts interpolated STRINGS raw, so quote/escape the id ourselves.
      const lit = `'${String(id).replace(/'/g, "''")}'`;
      pinSel.update({ source: pinSrc, value: String(id), predicate: vg.sql`post_id = ${lit}` });
    }
  }, [selected, pinSel, pinSrc]);

  // Reset the legend selection when the color-by (legend column) changes — the legend is a
  // separate element, so its clause would otherwise linger and keep dimming the map on the
  // old column, just like a stale umap brush.
  useEffect(() => {
    selections.legend.reset();
  }, [colorBy, selections]);

  const openAt = async (x: number, y: number) => {
    const v = clickSel.value;
    // Click with no point in `nearest` range (empty area) → deselect: close the card (which
    // also clears the pin ring via the effect above) instead of leaving a stale one open.
    if (v == null) {
      setSelected(null);
      return;
    }
    if (!coordinator) return;
    const id = String(v);
    try {
      const rows = (await coordinator.query(
        `SELECT * FROM data WHERE post_id = '${id.replace(/'/g, "''")}' LIMIT 1`,
        { type: "json" },
      )) as Record<string, any>[];
      if (rows?.[0]) setSelected({ row: rows[0], at: { x, y } });
    } catch {
      /* ignore */
    }
  };
  // Keep the latest openAt reachable from the (once-attached) capture listeners below.
  const openRef = useRef(openAt);
  openRef.current = openAt;

  // Click detection in the CAPTURE phase: mosaic's region uses d3-brush, whose overlay
  // stops event propagation, so a bubbling React onClick is eaten. Capture-phase
  // pointerdown/up on the container fire before the brush; a small move budget separates
  // a click (open card) from a brush drag.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    let dn: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (dn = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (dn && Math.hypot(e.clientX - dn.x, e.clientY - dn.y) <= 6) openRef.current(e.clientX, e.clientY);
      dn = null;
    };
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointerup", onUp, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointerup", onUp, true);
    };
  }, []);

  useEffect(() => {
    if (!coordinator || !plotRef.current) return;
    const el = plotRef.current;
    let disposed = false;
    let plotInst: any = null;
    // Rebuilding the plot (e.g. on color-by change) orphans the region/nearest brush clauses
    // in their selections — the rubber-band vanishes but keeps dimming the map. Clear THIS
    // plot's interactor clauses before replacing it, so the umap brush resets on rebuild.
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

    // For clusters, color by "id: top-3 keywords" so the ordinal legend labels are the
    // c-TF-IDF terms (already stored in cluster_keywords) — all from DuckDB, no server.
    const KW_EXPR =
      `"cluster" || ': ' || array_to_string(list_slice(str_split("cluster_keywords", ' | '), 1, 3), ', ')`;

    const render = async () => {
      if (disposed) return;
      clearInteractors();
      const w = el.clientWidth || 800;
      const h = el.clientHeight || 600;
      const api = vg.createAPIContext({ coordinator });
      const col = columns.find((c) => c.name === colorBy);
      const categorical = col ? isCategorical(col) : false;
      const hasKw = columns.some((c) => c.name === "cluster_keywords");
      const isCluster = colorBy === "cluster" && hasKw;
      const dateCol = colorBy === "create_time"; // color as a timestamp → date-formatted legend
      // Color by the REAL column (not an expression) so legend clicks produce a filter
      // clause on a field. Cluster shows keyword labels via the legend tickFormat below.
      const fill = dateCol ? vg.sql`epoch_ms("create_time" * 1000)` : (colorBy ?? "currentColor");

      // Cluster id order (numeric) + id→keywords labels for the legend.
      let clusterIds: number[] | null = null;
      let labelMap: Map<number, string> | null = null;
      if (isCluster) {
        try {
          const rows = (await coordinator.query(
            `SELECT cluster, any_value(${KW_EXPR}) AS label FROM data ` +
              `WHERE cluster IS NOT NULL GROUP BY cluster ORDER BY cluster`,
            { type: "json" },
          )) as { cluster: number; label: string }[];
          if (disposed) return;
          clusterIds = rows.map((r) => Number(r.cluster));
          labelMap = new Map(rows.map((r) => [Number(r.cluster), r.label]));
        } catch {
          clusterIds = null;
          labelMap = null;
        }
      }

      // Curated tooltip: friendly labels, only fields that exist, x/y/fill hidden.
      // Author + platform lead; post_id is appended last (region/nearest read it) but hidden.
      const present = new Set(columns.map((c) => c.name));
      const tipChannels: Record<string, string> = {};
      const addCols = new Set<string>();
      const addCh = (label: string, name: string) => {
        if (present.has(name) && !(label in tipChannels)) {
          tipChannels[label] = name;
          addCols.add(name);
        }
      };
      addCh("Author", "author_handle");
      addCh("Platform", "platform");
      addCh("Post date", "create_time");
      addCh("Cluster", "cluster");
      addCh("Views", "view_count");
      addCh("Likes", "like_count");
      addCh("Comments", "comment_count");
      const fmtStr = (d: any) => (d == null ? "" : String(d));
      const fmtInt = (d: any) => (d == null || Number(d) === -1 ? "—" : Number(d).toLocaleString());
      const fmtDate = (d: any) =>
        d == null ? "" : new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(Number(d) * 1000));
      const fmtNum = (d: any) => {
        if (d == null) return "";
        const n = Number(d);
        return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(3);
      };
      // Plot orders tip rows by format-key order (formatted channels first), so list EVERY
      // visible channel here in the order we want; the `false` entries stay hidden.
      const tipFormat: Record<string, any> = {
        x: false, y: false, fill: false, post_id: false,
        Author: fmtStr, Platform: fmtStr, "Post date": fmtDate, Cluster: fmtStr,
        Views: fmtInt, Likes: fmtInt, Comments: fmtInt,
      };
      // Also surface the active color-by value if it isn't already listed.
      if (colorBy && present.has(colorBy) && !addCols.has(colorBy)) {
        const lbl = fieldLabel(colorBy);
        if (!(lbl in tipChannels)) {
          tipChannels[lbl] = colorBy;
          const c = columns.find((x) => x.name === colorBy);
          if (!(lbl in tipFormat)) tipFormat[lbl] = c && isContinuous(c) ? fmtNum : fmtStr;
        }
      }
      tipChannels.post_id = "post_id"; // needed by region/nearest; hidden via tipFormat

      const args: any[] = [
        // filterBy `clamp` (hard min/max bounds) → clamps remove points and may rescale.
        // Brushing highlights in place via `highlight({ by: cross })` (no rescale).
        api.dot(api.from("data", { filterBy: selections.clamp }), {
          x: xCol,
          y: yCol,
          fill,
          r: 2.2,
          fillOpacity: 0.62,
          channels: tipChannels,
          tip: { format: tipFormat },
        }),
        api.name("umap"),
        // Interactors bind to the last-added mark, so they must precede the ring below.
        api.region({ channels: ["post_id"], as: selections.region,
                     brush: { fill: "none", stroke: "currentColor" } }),
        api.nearest({ as: clickSel, channels: ["post_id"], maxRadius: 30 }),
        api.highlight({ by: selections.umapHighlight, fillOpacity: 0.025 }),
        // Ring the selected post (drawn on top, unaffected by highlight) until its card closes.
        api.dot(api.from("data", { filterBy: pinSel }), {
          x: xCol,
          y: yCol,
          r: 4.5,
          fill: "none",
          stroke: "var(--color-base-content)",
          strokeWidth: 2.5,
        }),
        api.xLabel(xCol),
        api.yLabel(yCol),
        api.width(w),
        api.height(h),
        api.margin(36),
      ];
      if (colorBy && !categorical) {
        // True log needs a strictly positive domain; when the column has 0/negatives
        // (col.signed) fall back to symlog, which is log-like but defined at/below 0.
        const colorType =
          dateCol ? "linear"
          : scaleType === "log" ? (col?.signed ? "symlog" : "log")
          : scaleType;
        args.push(api.colorScale(colorType), api.colorScheme("viridis"));
      } else if (colorBy) {
        args.push(api.colorScale("ordinal"), api.colorRange(TABLEAU20));
        if (clusterIds) args.push(api.colorDomain(clusterIds));
      }

      const plotEl = api.plot(...args);
      plotInst = (plotEl as any).value; // mosaic Plot instance (holds interactors)
      el.replaceChildren(plotEl);

      if (legendRef.current) {
        if (colorBy) {
          // columns:1 → one categorical item per row, so the gap is uniform regardless
          // of label length (a ramp legend ignores it).
          const legendOpts: any = { for: "umap", as: selections.legend };
          if (categorical) {
            legendOpts.columns = 1; // one swatch per row
            if (labelMap) legendOpts.tickFormat = (d: any) => labelMap!.get(Number(d)) ?? String(d);
          } else {
            // Ramp: fill the slot; compact tick labels.
            legendOpts.width = legendRef.current.clientWidth || undefined;
            legendOpts.ticks = 5;
            legendOpts.tickFormat = dateCol
              ? (d: any) => monthYearFmt.format(new Date(Number(d)))
              : numTickFmt;
            // For log/symlog, hand Plot explicit power-of-ten ticks — symlog's default
            // (linear) ticks otherwise bunch against the high end of the ramp.
            if (!dateCol && scaleType === "log") {
              try {
                const r = (await coordinator.query(
                  `SELECT min("${colorBy}") AS lo, max("${colorBy}") AS hi FROM data`,
                  { type: "json" },
                )) as { lo: any; hi: any }[];
                if (r?.[0] && r[0].hi != null) {
                  // Only override Plot's default ticks when we have a good multi-decade set;
                  // otherwise leave `ticks: 5` so Plot/d3 chooses (avoids a blank sub-1 legend).
                  const explicit = logTicks(Number(r[0].lo), Number(r[0].hi));
                  if (explicit) legendOpts.ticks = explicit;
                }
              } catch {
                /* keep default ticks */
              }
            }
          }
          legendRef.current.replaceChildren(api.colorLegend(legendOpts));
        } else {
          legendRef.current.replaceChildren();
        }
      }
    };

    render();
    const ro = new ResizeObserver(() => render());
    ro.observe(el);
    return () => {
      disposed = true;
      ro.disconnect();
      clearInteractors();
      el.replaceChildren();
      if (legendRef.current) legendRef.current.replaceChildren();
    };
  }, [coordinator, columns, xCol, yCol, colorBy, scaleType, selections, legendRef, clickSel, pinSel]);

  return (
    <div className="relative h-full w-full">
      <div ref={plotRef} className="h-full w-full text-base-content/70" />
      {selected && <PostCard row={selected.row} at={selected.at} onClose={() => setSelected(null)} />}
    </div>
  );
}
