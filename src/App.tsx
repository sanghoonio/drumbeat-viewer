/**
 * Layout: a slim atlas wordmark bar, then a two-column body — a sticky control card
 * on the left, the embedding plot filling the right.
 * See plans/2026-07-02-analysis-viewer-duckdb-vgplot.md.
 */
import { useEffect, useMemo, useRef } from "react";
import { useCoordinator } from "./duckdb/coordinator";
import { useView } from "./stores/view";
import { applyTheme, useTheme } from "./stores/theme";
import { createSelections } from "./selections";
import { defaultColorBy, defaultXY } from "./lib/columns";
import { axisGroups } from "./lib/fields";
import { Scatter } from "./components/Scatter";
import { Sidebar } from "./components/Sidebar";
import { FilterPanel } from "./components/FilterPanel";
import { DistPlots } from "./components/DistPlots";
import { ProfileStrip } from "./components/ProfileStrip";
import { DropZone } from "./components/DropZone";

export function App() {
  const { ready, columns, rowCount, fileName, loading, loadFile, loadUrl, clear, coordinator, error } = useCoordinator();
  const {
    xCol, yCol, colorBy, scaleType, setXY, setColorBy,
    plotMode, setPlotMode, corrX, corrY, corrXScale, corrYScale, setCorrX, setCorrY,
  } = useView();
  const selections = useMemo(() => (ready ? createSelections() : null), [ready]);
  const legendRef = useRef<HTMLDivElement>(null);
  const themeMode = useTheme((s) => s.mode);
  useEffect(() => applyTheme(themeMode), [themeMode]);

  // Deep-link ingest: atlas "Open in viewer" opens us at `#src=<presigned R2 url>`. Capture it,
  // SCRUB the fragment immediately (history.replaceState — the URL is a short-lived capability, so
  // keep it out of the address bar / history / copy-paste), then fetch straight from R2. Runs once.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (!ready || bootedRef.current) return;
    bootedRef.current = true;
    const m = window.location.hash.match(/[#&]src=([^&]+)/);
    if (!m) return;
    const url = decodeURIComponent(m[1]);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    let name = "export.parquet";
    try {
      name = new URL(url).pathname.split("/").pop() || name; // keep the .parquet ext for the reader
    } catch { /* keep default */ }
    void loadUrl(url, name);
  }, [ready, loadUrl]);

  useEffect(() => {
    if (columns.length === 0) return;
    const { x, y } = defaultXY(columns);
    setXY(x, y);
    setColorBy(defaultColorBy(columns));
    // Fresh upload → back to the embedding, with the first two continuous fields (display
    // order, so engagement leads) as the correlation view's starting pair.
    setPlotMode("embedding");
    const axes = axisGroups(columns).flatMap((g) => g.items);
    setCorrX(axes[0]?.name ?? null);
    setCorrY(axes[1]?.name ?? null);
  }, [columns, setXY, setColorBy, setPlotMode, setCorrX, setCorrY]);

  const hasData = rowCount > 0 && !!xCol && !!yCol;
  // Fall back to the embedding axes if correlation mode somehow lacks a pair.
  const corrMode = plotMode === "correlation" && !!corrX && !!corrY;

  return (
    <div className="flex h-full min-h-0 bg-base-100 text-base-content">
      {!ready && (
        <div className="flex flex-1 items-center justify-center text-sm text-base-content/50">
          starting DuckDB…
        </div>
      )}

      {ready && hasData && selections && (
        <div className="flex min-h-0 flex-1 gap-3 px-3">
          {/* py lives INSIDE the scroll container so it scrolls to the viewport edge, not clipped
              at an inset padding line; the bordered cards use my-3 to stay inset instead. */}
          <div className="flex w-88 shrink-0 flex-col gap-3 overflow-y-auto py-3">
            <Sidebar
              columns={columns}
              rowCount={rowCount}
              fileName={fileName}
              onRemove={clear}
              legendRef={legendRef}
            />
            <FilterPanel coordinator={coordinator} columns={columns} selections={selections} />
            <DistPlots coordinator={coordinator} columns={columns} selections={selections} />
          </div>
          <div className="relative my-3 min-w-0 flex-1 rounded-box border border-base-300 p-2">
            <Scatter
              coordinator={coordinator}
              columns={columns}
              xCol={corrMode ? corrX! : xCol!}
              yCol={corrMode ? corrY! : yCol!}
              xScale={corrMode ? corrXScale : undefined}
              yScale={corrMode ? corrYScale : undefined}
              tipAxes={corrMode}
              colorBy={colorBy}
              scaleType={scaleType}
              selections={selections}
              legendRef={legendRef}
            />
          </div>
          <ProfileStrip coordinator={coordinator} columns={columns} colorBy={colorBy} selections={selections} />
        </div>
      )}

      {ready && !hasData && <DropZone onFile={loadFile} error={error} />}

      {/* Ingest overlay (parse + derived fields + rank precompute) — style matches pegasus'
          database-download screen: blurred full-screen veil, thin phase-weighted bar, caption. */}
      {loading && (
        <div className="fixed inset-0 z-[99999] flex flex-col items-center justify-center gap-4 bg-base-100/95 backdrop-blur-sm">
          <span className="max-w-md truncate text-sm font-medium text-base-content/80">
            loading {loading.name}…
          </span>
          <div className="flex w-72 flex-col items-center gap-1">
            <div className="h-1 w-full overflow-hidden rounded-full bg-base-200">
              <div
                className="h-full bg-primary transition-[width] duration-300"
                style={{ width: `${Math.round(loading.frac * 100)}%` }}
              />
            </div>
            <span className="text-xs tabular-nums text-base-content/50">{loading.label}</span>
          </div>
        </div>
      )}
    </div>
  );
}
