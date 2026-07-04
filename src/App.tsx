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
import { Scatter } from "./components/Scatter";
import { Sidebar } from "./components/Sidebar";
import { FilterPanel } from "./components/FilterPanel";
import { DistPlots } from "./components/DistPlots";
import { ProfileStrip } from "./components/ProfileStrip";
import { DropZone } from "./components/DropZone";

export function App() {
  const { ready, columns, rowCount, fileName, loading, loadFile, clear, coordinator, error } = useCoordinator();
  const { xCol, yCol, colorBy, scaleType, setXY, setColorBy } = useView();
  const selections = useMemo(() => (ready ? createSelections() : null), [ready]);
  const legendRef = useRef<HTMLDivElement>(null);
  const themeMode = useTheme((s) => s.mode);
  useEffect(() => applyTheme(themeMode), [themeMode]);

  useEffect(() => {
    if (columns.length === 0) return;
    const { x, y } = defaultXY(columns);
    setXY(x, y);
    setColorBy(defaultColorBy(columns));
  }, [columns, setXY, setColorBy]);

  const hasData = rowCount > 0 && !!xCol && !!yCol;

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
              xCol={xCol!}
              yCol={yCol!}
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
