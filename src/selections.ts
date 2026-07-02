/**
 * Selections:
 *  - `cross`   — the density interval brushes (drives the map HIGHLIGHT only).
 *  - `region`  — the umap rectangle brush.
 *  - `legend`  — color-legend clicks.
 *  - `clamp`   — hard min/max bounds from the density-card inputs.
 *
 *  - `filter`  — predicate filters (e.g. text search: include/exclude by string). On the map
 *    it only HIGHLIGHTS (dims non-matches, no rescale); it DOES hard-filter the density plots.
 *
 * Consumers:
 *  - scatter HIGHLIGHTS by `umapHighlight` (cross ∩ region ∩ legend ∩ filter) and FILTERS
 *    (hard, may rescale) only by `clamp` — so the search never moves the umap coords.
 *  - histograms FILTER by `histFilter` (clamp ∩ region ∩ legend ∩ filter) — deliberately NOT by
 *    the interval brushes (so a histogram never self-filters on its own brush); the predicate
 *    filter is safe here since it targets unrelated (text) columns.
 */
import * as vg from "@uwdata/vgplot";

export interface Selections {
  cross: any;
  region: any;
  legend: any;
  clamp: any;
  filter: any;
  umapHighlight: any;
  histFilter: any;
  catFilter: any;
  reset: () => void;
}

export function createSelections(): Selections {
  const cross = vg.Selection.crossfilter();
  const region = vg.Selection.intersect();
  const legend = vg.Selection.intersect();
  const clamp = vg.Selection.intersect();
  const filter = vg.Selection.intersect();
  const umapHighlight = vg.Selection.intersect({ include: [cross, region, legend, filter] });
  const histFilter = vg.Selection.intersect({ include: [clamp, region, legend, filter] });
  // A CROSSFILTER combining every narrowing selection — used by the categorical count-bar
  // MosaicClients so they ride mosaic's pre-aggregation cube (real-time crossfilter) and
  // self-exclude their own category toggle (whose clause tags this client in `clients`).
  const catFilter = vg.Selection.crossfilter({ include: [clamp, region, legend, filter, cross] });
  return {
    cross,
    region,
    legend,
    clamp,
    filter,
    umapHighlight,
    histFilter,
    catFilter,
    reset: () => {
      cross.reset();
      region.reset();
      legend.reset();
      clamp.reset();
      filter.reset();
    },
  };
}
