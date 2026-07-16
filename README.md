# Drumbeat Viewer

A self-contained web app for exploring **Drumbeat Atlas** analysis exports. Drop an export
(Parquet / CSV / JSON) — or open one straight from the atlas **Exports** page — and explore it
as an interactive embedding map, entirely in the browser via **DuckDB-wasm** + **Mosaic /
vgplot**. No API server; all queries run against DuckDB in the page, so nothing leaves your machine.

Deployed at **[drumbeat-viewer.pages.dev](https://drumbeat-viewer.pages.dev)** (Cloudflare Pages).

## Run

```bash
npm install
npm run dev
```

Then drop an atlas analysis export. The ideal input is the combined **`analysis`** export
(`topic ⋈ embeddings ⋈ affect`, one row per post with `umap_x` / `umap_y`, `cluster`,
`cluster_keywords`, engagement counts, and affect/sentiment metrics). Any flat post-level
export works — the UI discovers columns generically and adapts.

**Deep-link ingest.** The atlas Exports page can open a published parquet directly here via a
`#src=<presigned R2 url>` fragment: the viewer captures the URL, scrubs the fragment immediately
(it's a short-lived, single-use capability — kept out of history/address bar), and `fetch`es the
parquet straight from R2 into the same DuckDB pipeline. No download-and-re-drop. (Requires the R2
bucket's CORS policy to allow this origin — see the atlas `docs/worker.md`.)

## Features

- **Embedding scatter** — the UMAP projection, coloured by any field. Continuous colour uses
  native `linear` / `sqrt` / `log` (falls back to `symlog` for zero/negative domains);
  categorical uses a Tableau-20 palette. Colouring by `cluster` labels the legend with each
  cluster's top c-TF-IDF keywords, all from DuckDB.
- **Curated tooltip + detail card** — hover for a compact tooltip; click a point to open a
  draggable card with the caption, engagement, cluster, and a link to the post. The selected
  point is ringed until the card is closed.
- **Distribution cards** — add a density (KDE) card for any continuous field (`linear` / `sqrt`
  / `log`), with min/max clamps that hard-filter + rescale the map, and an interval brush that
  highlights it. A pinned post-date card is always shown.
- **Categorical count bars** — add a count-bar card for any categorical field (cluster,
  platform, region, …). Real-time crossfilter: brushing anything updates the counts live via a
  Mosaic pre-aggregation cube; click a bar to highlight that category on the map.
- **Correlation strip** — a thin heatmap to the right of the map showing each continuous field's
  live **Pearson correlation** with the current colour-by variable, over the current selection.
- **Search filters** — include posts by substring (author / caption / all-text / hashtags) or by
  exact value (platform), saved as chips.

Selections are linked: interval brushes and the correlation strip highlight in place; density
clamps and the search hard-filter the whole view.

## Deploy

Static build → Cloudflare Pages. The GitHub Action (`.github/workflows/deploy.yml`) deploys on
push to `main` via `wrangler pages deploy` (direct upload — no dashboard Git integration).

One-time setup: add repo secrets `CLOUDFLARE_API_TOKEN` (scoped to **Account → Cloudflare Pages
→ Edit**) and `CLOUDFLARE_ACCOUNT_ID`. Locally, `npm run deploy` does the same after
`wrangler login`. Project name + output dir live in `wrangler.jsonc`.

> DuckDB-wasm loads its `.wasm` from the jsDelivr CDN at runtime, so the deployed page needs
> network access (it is not a single offline bundle).

## Stack

Vite 7 · React 19 · TypeScript · `@uwdata/vgplot` + `@uwdata/mosaic-core` · `@duckdb/duckdb-wasm`
· zustand · Tailwind 4 + daisyUI · lucide-react. Scatter patterns adapted from the pure-vgplot
era of `tessera`; count-bar layout from `bedbase-ui`.
