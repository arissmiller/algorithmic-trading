import {
  BaselineSeries,
  ColorType,
  createChart,
  IChartApi,
  ISeriesApi,
  Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

export interface EquityCurvePoint {
  t: string;
  equity: number;
}

interface Props {
  data: EquityCurvePoint[];
  baselineValue: number;
}

const toTime = (t: string) => Math.floor(new Date(t).getTime() / 1000) as Time;

export default function EquityCurveChart({ data, baselineValue }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);

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

    const series = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: baselineValue },
      topLineColor: "#22c55e",
      topFillColor1: "rgba(34, 197, 94, 0.18)",
      topFillColor2: "rgba(34, 197, 94, 0.02)",
      bottomLineColor: "#ef4444",
      bottomFillColor1: "rgba(239, 68, 68, 0.02)",
      bottomFillColor2: "rgba(239, 68, 68, 0.18)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Update baseline when capital changes
  useEffect(() => {
    seriesRef.current?.applyOptions({
      baseValue: { type: "price", price: baselineValue },
    });
  }, [baselineValue]);

  // Update data
  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return;
    const points = data
      .filter((pt) => Number.isFinite(pt.equity))
      .map((pt) => ({ time: toTime(pt.t), value: pt.equity }));
    if (points.length === 0) return;
    seriesRef.current.setData(points);
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  return <div ref={containerRef} className="w-full h-full" />;
}
