/** Sticky control card on the left: dataset info, plot mode, color-by, scale, legend, reload. */
import { useEffect, type RefObject } from "react";
import { Trash2 } from "lucide-react";
import type { ColumnInfo } from "../lib/columns";
import { axisGroups, colorByGroups, isContinuous, type FieldGroup } from "../lib/fields";
import { useView, type PlotMode, type ScaleType } from "../stores/view";

interface Props {
  columns: ColumnInfo[];
  rowCount: number;
  fileName: string | null;
  onRemove: () => void;
  legendRef: RefObject<HTMLDivElement | null>;
}

/** One correlation axis: variable picker + a compact per-axis scale picker. */
function AxisPicker({ label, groups, value, scale, onColumn, onScale }: {
  label: string;
  groups: FieldGroup[];
  value: string | null;
  scale: ScaleType;
  onColumn: (c: string | null) => void;
  onScale: (s: ScaleType) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-base-content/70">{label}</span>
      <div className="flex gap-1.5">
        <select
          className="select select-bordered select-sm min-w-0 flex-1"
          value={value ?? ""}
          onChange={(e) => onColumn(e.target.value || null)}
        >
          {groups.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((it) => (
                <option key={it.name} value={it.name}>
                  {it.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select
          className="select select-bordered select-sm w-20 shrink-0"
          value={scale}
          onChange={(e) => onScale(e.target.value as ScaleType)}
          title={`${label} scale`}
          aria-label={`${label} scale`}
        >
          <option value="linear">linear</option>
          <option value="sqrt">sqrt</option>
          <option value="log">log</option>
        </select>
      </div>
    </label>
  );
}

export function Sidebar({ columns, rowCount, fileName, onRemove, legendRef }: Props) {
  const {
    plotMode, setPlotMode, colorBy, setColorBy, scaleType, setScaleType,
    corrX, corrY, setCorrX, setCorrY,
    corrXScale, corrYScale, setCorrXScale, setCorrYScale,
  } = useView();
  const groups = colorByGroups(columns);
  const axGroups = axisGroups(columns);
  // The correlation view needs two continuous variables to scatter.
  const canCorrelate = axGroups.reduce((n, g) => n + g.items.length, 0) >= 2;
  const col = columns.find((c) => c.name === colorBy);
  const continuous = !!col && isContinuous(col); // semantic (cluster etc. are categorical)

  // Fall back to linear if a non-continuous column is selected while log is active.
  useEffect(() => {
    if (scaleType === "log" && !continuous) setScaleType("linear");
  }, [continuous, scaleType, setScaleType]);

  return (
    <aside className="flex shrink-0 flex-col gap-4 rounded-box border border-base-300 bg-base-100 px-4 pb-2 pt-2.5">
      <div>
        <div className="text-xl font-thin tracking-wide">
          <span className="font-normal text-primary">atlas</span> viewer
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-base-content/50">
          <span className="truncate font-mono">{fileName ?? "export"}</span>
          <button
            className="shrink-0 text-base-content/30 transition-colors hover:text-error"
            onClick={onRemove}
            title="remove export"
            aria-label="remove export"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
        <div className="mt-0.5 text-xs text-base-content/50">
          {rowCount.toLocaleString()} rows · {columns.length} columns
        </div>
      </div>

      {canCorrelate && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-base-content/70">Plot</span>
          <select
            className="select select-bordered select-sm w-full"
            value={plotMode}
            onChange={(e) => setPlotMode(e.target.value as PlotMode)}
          >
            <option value="embedding">Embedding</option>
            <option value="correlation">Correlation</option>
          </select>
        </label>
      )}

      {plotMode === "correlation" && (
        <>
          <AxisPicker label="X axis" groups={axGroups} value={corrX} scale={corrXScale}
                      onColumn={setCorrX} onScale={setCorrXScale} />
          <AxisPicker label="Y axis" groups={axGroups} value={corrY} scale={corrYScale}
                      onColumn={setCorrY} onScale={setCorrYScale} />
        </>
      )}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-base-content/70">Color by</span>
        <select
          className="select select-bordered select-sm w-full"
          value={colorBy ?? ""}
          onChange={(e) => setColorBy(e.target.value || null)}
        >
          <option value="">(none)</option>
          {groups.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((it) => (
                <option key={it.name} value={it.name}>
                  {it.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {continuous && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-base-content/70">Scale</span>
          <select
            className="select select-bordered select-sm w-full"
            value={scaleType}
            onChange={(e) => setScaleType(e.target.value as ScaleType)}
          >
            <option value="linear">linear</option>
            <option value="sqrt">sqrt</option>
            <option value="log">log</option>
          </select>
        </label>
      )}

      <div>
        <span className="mb-1 block text-xs font-medium text-base-content/70">Legend</span>
        <div ref={legendRef} className="text-sm" />
      </div>
    </aside>
  );
}
