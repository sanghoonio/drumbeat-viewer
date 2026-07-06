/** View state: what the scatter plots and colors by. */
import { create } from "zustand";
import { defaultScale } from "../lib/fields";

export type ScaleType = "linear" | "sqrt" | "log";
export type PlotMode = "embedding" | "correlation";

interface ViewState {
  plotMode: PlotMode;
  xCol: string | null; // embedding axes
  yCol: string | null;
  corrX: string | null; // correlation-view axes
  corrY: string | null;
  corrXScale: ScaleType;
  corrYScale: ScaleType;
  colorBy: string | null;
  scaleType: ScaleType;
  setPlotMode: (m: PlotMode) => void;
  setXY: (x: string | null, y: string | null) => void;
  /** Picking an axis column also resets its scale to the column's sensible default. */
  setCorrX: (c: string | null) => void;
  setCorrY: (c: string | null) => void;
  setCorrXScale: (s: ScaleType) => void;
  setCorrYScale: (s: ScaleType) => void;
  setColorBy: (c: string | null) => void;
  setScaleType: (s: ScaleType) => void;
}

export const useView = create<ViewState>((set) => ({
  plotMode: "embedding",
  xCol: null,
  yCol: null,
  corrX: null,
  corrY: null,
  corrXScale: "linear",
  corrYScale: "linear",
  colorBy: null,
  scaleType: "linear",
  setPlotMode: (plotMode) => set({ plotMode }),
  setXY: (xCol, yCol) => set({ xCol, yCol }),
  setCorrX: (corrX) => set({ corrX, corrXScale: corrX ? defaultScale(corrX) : "linear" }),
  setCorrY: (corrY) => set({ corrY, corrYScale: corrY ? defaultScale(corrY) : "linear" }),
  setCorrXScale: (corrXScale) => set({ corrXScale }),
  setCorrYScale: (corrYScale) => set({ corrYScale }),
  setColorBy: (colorBy) => set({ colorBy }),
  setScaleType: (scaleType) => set({ scaleType }),
}));
