import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  SeriesMarker,
  Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { BacktestTrade } from "../lib/backtest";
import { Bar } from "../lib/signals";

interface Props {
  bars: Bar[];
  scaleInTrades: BacktestTrade[];
  scaleOutTrades: BacktestTrade[];
}

const toTime = (t: string) => Math.floor(new Date(t).getTime() / 1000) as Time;
const toDateKey = (t: string) => t.split("T")[0];

export default function BacktestChart({
  bars,
  scaleInTrades,
  scaleOutTrades,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#111111" },
        textColor: "#666666",
      },
      grid: { vertLines: { color: "#1a1a1a" }, horzLines: { color: "#1a1a1a" } },
      crosshair: {
        vertLine: { color: "#5b8dee", labelBackgroundColor: "#5b8dee" },
        horzLine: { color: "#5b8dee", labelBackgroundColor: "#5b8dee" },
      },
      rightPriceScale: { borderColor: "#2a2a2a" },
      timeScale: { borderColor: "#2a2a2a", timeVisible: true, secondsVisible: false },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);

    const ro = new ResizeObserver(() =>
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
    );
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
    };
  }, []);

  // Load bars
  useEffect(() => {
    if (!seriesRef.current || bars.length === 0) return;
    seriesRef.current.setData(
      bars.map((b) => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c }))
    );
    chartRef.current?.timeScale().fitContent();
  }, [bars]);

  // Update markers
  useEffect(() => {
    if (!markersRef.current) return;
    if (scaleInTrades.length === 0 && scaleOutTrades.length === 0) {
      markersRef.current.setMarkers([]);
      return;
    }

    // Build a lookup from YYYY-MM-DD → actual bar Unix timestamp so that
    // markers align with bars even when bar timestamps carry an intraday
    // offset (e.g. crypto bars are often timestamped at 08:00 UTC rather
    // than midnight, while trade dates are stored as date-only strings).
    const barTimeByDate = new Map<string, Time>();
    for (const b of bars) {
      const dateKey = toDateKey(b.t);
      if (!barTimeByDate.has(dateKey)) {
        barTimeByDate.set(dateKey, toTime(b.t));
      }
    }
    const resolveTime = (date: string): Time =>
      barTimeByDate.get(toDateKey(date)) ?? toTime(date);

    const markers = [
      ...scaleInTrades.map(
        (t) =>
          ({
            time: resolveTime(t.date),
            position: "belowBar" as SeriesMarker<Time>["position"],
            color: "#26a69a",
            shape: "arrowUp" as SeriesMarker<Time>["shape"],
            size: 0.7,
          }) as SeriesMarker<Time>
      ),
      ...scaleOutTrades.map(
        (t) =>
          ({
            time: resolveTime(t.date),
            position: "aboveBar" as SeriesMarker<Time>["position"],
            color: "#ef5350",
            shape: "arrowDown" as SeriesMarker<Time>["shape"],
            size: 0.7,
          }) as SeriesMarker<Time>
      ),
    ]
      .sort((a, b) => (a.time as number) - (b.time as number));

    markersRef.current.setMarkers(markers);
    chartRef.current?.timeScale().fitContent();
  }, [scaleInTrades, scaleOutTrades, bars]);

  return <div ref={containerRef} className="h-full w-full" />;
}
