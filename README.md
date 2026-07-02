# Atlas Viewer

Self-contained analysis viewer for atlas exports. Drop a topic export (Parquet / CSV / JSON)
and explore it as an interactive embedding, entirely in the browser via **DuckDB-wasm** +
**Mosaic / vgplot**. No API server — all computation runs against DuckDB in the page.

Design + roadmap: `../plans/2026-07-02-analysis-viewer-duckdb-vgplot.md`.

## Run

```bash
cd viewer
npm install
npm run dev
```

Then drop an atlas analysis export. The ideal input is the combined `analysis` export
(`topic ⋈ embeddings ⋈ affect`, one row per post with `umap_x/umap_y`, `cluster`, engagement,
and affect metrics) produced by the pipeline plan; any flat post-level export works.

## Status: scaffold

Implemented: DuckDB-wasm + Mosaic coordinator, file-drop → `data` table (parquet/csv/json),
generic column discovery, a pure-vgplot embedding scatter (continuous / categorical color,
rectangle brush), and a floating brand sidebar.

Not yet (see plan): modular resizable widgets, linked histograms, detail table, interactive
legend in the sidebar, multi-file drop + join, SQL polygon lasso, on-demand cross-plot analysis.

## Stack

Vite 7 · React 19 · TypeScript · `@uwdata/vgplot` · `@duckdb/duckdb-wasm` · `react-rnd` ·
zustand · tailwind 4 + daisyui. Patterns lifted from the user's `tessera` (pure-vgplot era,
commit `665d9a0`) and `bedbase-ui` projects.
