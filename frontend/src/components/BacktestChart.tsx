import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  LineSeries,
  SeriesMarker,
  Time,
} from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";
import { BacktestTrade } from "../lib/backtest";
import { Bar, EarningsEvent } from "../lib/signals";

export type BacktestChartEventMarker = {
  date: string;
  position?: "aboveBar" | "belowBar" | "inBar";
  color?: string;
  shape?: "arrowUp" | "arrowDown" | "circle" | "square";
  size?: number;
  text?: string;
};

export type BacktestChartHorizontalSegment = {
  startDate: string;
  endDate: string;
  price: number;
  color?: string;
  lineWidth?: 1 | 2 | 3 | 4;
};

interface Props {
  bars: Bar[];
  scaleInTrades: BacktestTrade[];
  scaleOutTrades: BacktestTrade[];
  earningsEvents: EarningsEvent[];
  eventMarkers?: BacktestChartEventMarker[];
  horizontalSegments?: BacktestChartHorizontalSegment[];
  movingAverageDays?: number[];
}

const toTime = (t: string) => Math.floor(new Date(t).getTime() / 1000) as Time;
const MOVING_AVERAGE_COLORS = ["#f59e0b", "#60a5fa", "#a78bfa"];

export default function BacktestChart({
  bars,
  scaleInTrades,
  scaleOutTrades,
  earningsEvents,
  eventMarkers = [],
  horizontalSegments = [],
  movingAverageDays = [],
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const movingAverageSeriesRef = useRef<Array<{ days: number; series: ISeriesApi<"Line"> }>>([]);
  const horizontalSegmentSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const normalizedMovingAverageDays = useMemo(
    () => normalizeMovingAverageDays(movingAverageDays),
    [movingAverageDays]
  );
  const movingAverageDaysKey = normalizedMovingAverageDays.join(",");

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
      movingAverageSeriesRef.current = [];
      horizontalSegmentSeriesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const line of movingAverageSeriesRef.current) {
      chart.removeSeries(line.series);
    }
    movingAverageSeriesRef.current = normalizedMovingAverageDays.map((days, index) => ({
      days,
      series: chart.addSeries(LineSeries, {
        color: MOVING_AVERAGE_COLORS[index % MOVING_AVERAGE_COLORS.length],
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      }),
    }));
  }, [movingAverageDaysKey]);

  // Load bars
  useEffect(() => {
    if (!seriesRef.current || bars.length === 0) return;
    seriesRef.current.setData(
      bars.map((b) => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c }))
    );
    if (movingAverageSeriesRef.current.length > 0) {
      const barsPerDay = inferBarsPerDay(bars);
      for (const line of movingAverageSeriesRef.current) {
        const periodBars = Math.max(1, Math.round(line.days * barsPerDay));
        line.series.setData(buildExponentialMovingAverageData(bars, periodBars));
      }
    }
    chartRef.current?.timeScale().fitContent();
  }, [bars, movingAverageDaysKey]);

  // Update horizontal overlay segments
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const line of horizontalSegmentSeriesRef.current) {
      chart.removeSeries(line);
    }
    horizontalSegmentSeriesRef.current = [];

    if (horizontalSegments.length === 0 || bars.length === 0) return;

    const resolveBarTime = buildBarTimeResolver(bars);
    for (const segment of horizontalSegments) {
      if (!Number.isFinite(segment.price)) continue;
      const startTs = resolveBarTime(segment.startDate) as number;
      const endTsRaw = resolveBarTime(segment.endDate) as number;
      const endTs = Math.max(startTs, endTsRaw);
      const line = chart.addSeries(LineSeries, {
        color: segment.color ?? "#ef4444",
        lineWidth: segment.lineWidth ?? 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData([
        { time: startTs as Time, value: segment.price },
        { time: endTs as Time, value: segment.price },
      ]);
      horizontalSegmentSeriesRef.current.push(line);
    }
  }, [bars, horizontalSegments]);

  // Update markers
  useEffect(() => {
    if (!markersRef.current) return;
    if (
      scaleInTrades.length === 0 &&
      scaleOutTrades.length === 0 &&
      earningsEvents.length === 0 &&
      eventMarkers.length === 0
    ) {
      markersRef.current.setMarkers([]);
      return;
    }

    const resolveEarningsTime = buildEarningsTimeResolver(bars);
    const resolveEventTime = buildBarTimeResolver(bars);
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
      ...eventMarkers.map(
        (event) =>
          ({
            time: resolveEventTime(event.date),
            position: event.position ?? ("inBar" as SeriesMarker<Time>["position"]),
            color: event.color ?? "#38bdf8",
            shape: event.shape ?? ("circle" as SeriesMarker<Time>["shape"]),
            size: event.size ?? 0.65,
            text: event.text,
          }) as SeriesMarker<Time>
      ),
    ]
      .sort((a, b) => (a.time as number) - (b.time as number));

    markersRef.current.setMarkers(markers);
  }, [bars, scaleInTrades, scaleOutTrades, earningsEvents, eventMarkers]);

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
  const resolveBarTime = buildBarTimeResolver(bars);
  const firstBarTimeByDay = buildFirstBarTimeByDay(bars);

  return (earningsDate: string): Time => {
    const direct = firstBarTimeByDay.get(earningsDate);
    if (direct) return direct;
    return resolveBarTime(earningsDate);
  };
}

function buildBarTimeResolver(bars: Bar[]): (date: string) => Time {
  const sortedBarTimes = bars
    .map((bar) => toTime(bar.t) as number)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const exact = new Set(sortedBarTimes);

  return (date: string): Time => {
    const eventTs = toTime(date) as number;
    if (exact.has(eventTs)) return eventTs as Time;
    const nextTradingBarTs = sortedBarTimes.find((barTs) => barTs >= eventTs);
    if (typeof nextTradingBarTs === "number") return nextTradingBarTs as Time;
    const fallbackBarTs = sortedBarTimes[sortedBarTimes.length - 1];
    if (typeof fallbackBarTs === "number") return fallbackBarTs as Time;
    return eventTs as Time;
  };
}

function buildFirstBarTimeByDay(bars: Bar[]): Map<string, Time> {
  const out = new Map<string, Time>();
  for (const bar of bars) {
    const barTs = toTime(bar.t);
    const dayKey = new Date(bar.t).toISOString().slice(0, 10);
    if (!out.has(dayKey)) {
      out.set(dayKey, barTs);
    }
  }
  return out;
}

function normalizeMovingAverageDays(days: number[]): number[] {
  const unique = new Set<number>();
  for (const value of days) {
    if (Number.isFinite(value) && value > 0) {
      unique.add(Math.round(value));
    }
  }
  return Array.from(unique).sort((a, b) => a - b);
}

function inferBarsPerDay(bars: Bar[]): number {
  if (bars.length < 10) return 1;
  const counts = new Map<string, number>();
  for (const bar of bars) {
    const day = bar.t.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const mode = Array.from(counts.values()).sort((a, b) => b - a)[0] ?? 1;
  return Math.max(1, mode);
}

function buildExponentialMovingAverageData(
  bars: Bar[],
  periodBars: number
): Array<{ time: Time; value: number }> {
  if (periodBars <= 1) {
    return bars.map((bar) => ({ time: toTime(bar.t), value: bar.c }));
  }
  if (bars.length < periodBars) return [];

  const smoothing = 2 / (periodBars + 1);
  const out: Array<{ time: Time; value: number }> = [];
  let runningSum = 0;

  for (let i = 0; i < periodBars; i++) {
    runningSum += bars[i].c;
  }
  let ema = runningSum / periodBars;
  out.push({ time: toTime(bars[periodBars - 1].t), value: ema });

  for (let i = periodBars; i < bars.length; i++) {
    const price = bars[i].c;
    ema = price * smoothing + ema * (1 - smoothing);
    out.push({ time: toTime(bars[i].t), value: ema });
  }

  return out;
}
