import { create } from "zustand";
import { Bar } from "./lib/signals";
import { BacktestResult } from "./lib/backtest";

interface Store {
  bars: Bar[];
  barsLoading: boolean;
  barsError: string | null;

  result: BacktestResult | null;
  running: boolean;
  runError: string | null;

  serverOnline: boolean;

  setBars: (b: Bar[]) => void;
  setBarsLoading: (v: boolean) => void;
  setBarsError: (e: string | null) => void;
  setResult: (r: BacktestResult | null) => void;
  setRunning: (v: boolean) => void;
  setRunError: (e: string | null) => void;
  setServerOnline: (v: boolean) => void;
}

export const useStore = create<Store>((set) => ({
  bars: [],
  barsLoading: false,
  barsError: null,
  result: null,
  running: false,
  runError: null,
  serverOnline: false,

  setBars: (bars) => set({ bars }),
  setBarsLoading: (v) => set({ barsLoading: v }),
  setBarsError: (e) => set({ barsError: e }),
  setResult: (r) => set({ result: r }),
  setRunning: (v) => set({ running: v }),
  setRunError: (e) => set({ runError: e }),
  setServerOnline: (v) => set({ serverOnline: v }),
}));
