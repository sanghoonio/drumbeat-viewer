/** View state: what the scatter plots and colors by. */
import { create } from "zustand";

export type ScaleType = "linear" | "sqrt" | "log";

interface ViewState {
  xCol: string | null;
  yCol: string | null;
  colorBy: string | null;
  scaleType: ScaleType;
  setXY: (x: string | null, y: string | null) => void;
  setColorBy: (c: string | null) => void;
  setScaleType: (s: ScaleType) => void;
}

export const useView = create<ViewState>((set) => ({
  xCol: null,
  yCol: null,
  colorBy: null,
  scaleType: "linear",
  setXY: (xCol, yCol) => set({ xCol, yCol }),
  setColorBy: (colorBy) => set({ colorBy }),
  setScaleType: (scaleType) => set({ scaleType }),
}));
