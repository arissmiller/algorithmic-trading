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
import { Bar, EarningsEvent } from "../lib/signals";

interface Props {
  bars: Bar[];
  scaleInTrades: BacktestTrade[];
  scaleOutTrades: BacktestTrade[];
  earningsEvents: EarningsEvent[];
}

const toTime = (t: string) => Math.floor(new Date(t).getTime() / 1000) as Time;

export default function BacktestChart({
  bars,
  scaleInTrades,
  scaleOutTrades,
  earningsEvents,
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
    if (scaleInTrades.length === 0 && scaleOutTrades.length === 0 && earningsEvents.length === 0) {
      markersRef.current.setMarkers([]);
      return;
    }

    const resolveEarningsTime = buildEarningsTimeResolver(bars);
    const markers = [
      ...scaleInTrades.map(
        (t) =>
          ({
            time: toTime(t.date),
            position: "belowBar" as SeriesMarker<Time>["position"],
            color: "#26a69a",
            shape: "arrowUp" as SeriesMarker<Time>["shape"],
            size: 0.7,
          }) as SeriesMarker<Time>
      ),
      ...scaleOutTrades.map(
        (t) =>
          ({
            time: toTime(t.date),
            position: "aboveBar" as SeriesMarker<Time>["position"],
            color: "#ef5350",
            shape: "arrowDown" as SeriesMarker<Time>["shape"],
            size: 0.7,
          }) as SeriesMarker<Time>
      ),
      ...earningsEvents.map(
        (event) =>
          ({
            time: resolveEarningsTime(event.date),
            position: "inBar" as SeriesMarker<Time>["position"],
            color: "#f59e0b",
            shape: "circle" as SeriesMarker<Time>["shape"],
            size: 0.65,
            text: formatEarningsMarkerText(event),
          }) as SeriesMarker<Time>
      ),
    ]
      .sort((a, b) => (a.time as number) - (b.time as number));

    markersRef.current.setMarkers(markers);
    chartRef.current?.timeScale().fitContent();
  }, [bars, scaleInTrades, scaleOutTrades, earningsEvents]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function formatEarningsMarkerText(event: EarningsEvent): string {
  const surprisePct = event.surprisePercentage;
  if (typeof surprisePct === "number" && Number.isFinite(surprisePct)) {
    const sign = surprisePct >= 0 ? "+" : "";
    return `E ${sign}${surprisePct.toFixed(1)}%`;
  }
  return "E";
}

function buildEarningsTimeResolver(bars: Bar[]): (earningsDate: string) => Time {
  const firstBarTimeByDay = new Map<string, Time>();
  const sortedBarTimes: number[] = [];

  for (const bar of bars) {
    const barTs = toTime(bar.t) as number;
    sortedBarTimes.push(barTs);
    const dayKey = new Date(bar.t).toISOString().slice(0, 10);
    if (!firstBarTimeByDay.has(dayKey)) {
      firstBarTimeByDay.set(dayKey, barTs as Time);
    }
  }

  sortedBarTimes.sort((a, b) => a - b);

  return (earningsDate: string): Time => {
    const direct = firstBarTimeByDay.get(earningsDate);
    if (direct) return direct;

    const eventTs = toTime(earningsDate) as number;
    const nextTradingBarTs = sortedBarTimes.find((barTs) => barTs >= eventTs);
    if (typeof nextTradingBarTs === "number") {
      return nextTradingBarTs as Time;
    }

    const fallbackBarTs = sortedBarTimes[sortedBarTimes.length - 1];
    if (typeof fallbackBarTs === "number") {
      return fallbackBarTs as Time;
    }

    return eventTs as Time;
  };
}
