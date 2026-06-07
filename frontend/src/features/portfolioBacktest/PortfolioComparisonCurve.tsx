import { ColorType, createChart, type IChartApi, LineSeries, LineStyle, type Time } from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";
import type { BenchmarkComparisonResult, PortfolioEquityPoint } from "./types";

const BENCHMARK_LINE_COLORS = ["#f59e0b", "#22c55e", "#a78bfa", "#f43f5e", "#14b8a6", "#eab308"];

export default function PortfolioComparisonCurve({
  portfolioEquityCurve,
  benchmarks,
  initialValue,
  formatUsd,
}: {
  portfolioEquityCurve: PortfolioEquityPoint[];
  benchmarks: BenchmarkComparisonResult[];
  initialValue: number;
  formatUsd: (value: number) => string;
}) {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineSeriesRef = useRef<Array<ReturnType<IChartApi["addSeries"]>>>([]);

  const chartData = useMemo(() => {
    const toLineTime = (isoDate: string): Time | null => {
      const utcDate = parseIsoDateToUtc(isoDate);
      if (!utcDate) return null;
      return Math.floor(utcDate.getTime() / 1000) as Time;
    };

    const portfolioSeries = portfolioEquityCurve
      .map((point) => {
        const time = toLineTime(point.date);
        if (time === null || !Number.isFinite(point.portfolioValue)) return null;
        return { time, value: point.portfolioValue };
      })
      .filter((point): point is { time: Time; value: number } => point !== null)
      .sort((a, b) => (a.time as number) - (b.time as number));

    const benchmarkSeries = benchmarks
      .map((benchmark, benchmarkIndex) => {
        const points = benchmark.equityCurve
          .map((point) => {
            const time = toLineTime(point.date);
            if (time === null || !Number.isFinite(point.benchmarkValue)) return null;
            return { time, value: point.benchmarkValue };
          })
          .filter((point): point is { time: Time; value: number } => point !== null)
          .sort((a, b) => (a.time as number) - (b.time as number));
        return {
          symbol: benchmark.symbol,
          color: colorForBenchmark(benchmarkIndex),
          points,
        };
      })
      .filter((series) => series.points.length >= 2);

    const firstPortfolioPoint = portfolioSeries[0];
    const lastPortfolioPoint = portfolioSeries[portfolioSeries.length - 1];
    const baselineSeries =
      firstPortfolioPoint && lastPortfolioPoint
        ? [
            { time: firstPortfolioPoint.time, value: initialValue },
            { time: lastPortfolioPoint.time, value: initialValue },
          ]
        : [];

    const values = [
      initialValue,
      ...portfolioSeries.map((point) => point.value),
      ...benchmarkSeries.flatMap((series) => series.points.map((point) => point.value)),
    ].filter((value) => Number.isFinite(value));

    const minValue = values.length > 0 ? Math.min(...values) : initialValue;
    const maxValue = values.length > 0 ? Math.max(...values) : initialValue;
    const hasData = portfolioSeries.length >= 2 && benchmarkSeries.length > 0;

    return {
      portfolioSeries,
      benchmarkSeries,
      baselineSeries,
      minValue,
      maxValue,
      firstDate: portfolioEquityCurve[0]?.date ?? "",
      lastDate: portfolioEquityCurve[portfolioEquityCurve.length - 1]?.date ?? "",
      hasData,
    };
  }, [benchmarks, initialValue, portfolioEquityCurve]);

  useEffect(() => {
    const element = chartContainerRef.current;
    if (!element) return;

    const chart = createChart(element, {
      layout: {
        background: { type: ColorType.Solid, color: "#151515" },
        textColor: "#9ca3af",
      },
      grid: { vertLines: { color: "#24262b" }, horzLines: { color: "#24262b" } },
      rightPriceScale: { borderColor: "#2a2a2a" },
      timeScale: { borderColor: "#2a2a2a", timeVisible: false, secondsVisible: false },
      crosshair: {
        vertLine: { color: "#5b8dee", labelBackgroundColor: "#5b8dee" },
        horzLine: { color: "#5b8dee", labelBackgroundColor: "#5b8dee" },
      },
      width: element.clientWidth,
      height: element.clientHeight,
    });

    chartRef.current = chart;
    const resizeObserver = new ResizeObserver(() => {
      chart.applyOptions({ width: element.clientWidth, height: element.clientHeight });
    });
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      lineSeriesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const series of lineSeriesRef.current) {
      chart.removeSeries(series);
    }
    lineSeriesRef.current = [];

    if (!chartData.hasData) return;

    const baselineSeries = chart.addSeries(LineSeries, {
      color: "#71717a",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    baselineSeries.setData(chartData.baselineSeries);
    lineSeriesRef.current.push(baselineSeries);

    for (const benchmark of chartData.benchmarkSeries) {
      const benchmarkLine = chart.addSeries(LineSeries, {
        color: benchmark.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      benchmarkLine.setData(benchmark.points);
      lineSeriesRef.current.push(benchmarkLine);
    }

    const portfolioLine = chart.addSeries(LineSeries, {
      color: "#5b8dee",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    portfolioLine.setData(chartData.portfolioSeries);
    lineSeriesRef.current.push(portfolioLine);

    chart.timeScale().fitContent();
  }, [chartData]);

  if (!chartData.hasData) return null;

  return (
    <div className="rounded border border-border bg-surface-2 p-2">
      <div ref={chartContainerRef} className="h-56 w-full" />
      <div className="mt-1 flex justify-between text-[11px] text-text-secondary">
        <span>{chartData.firstDate}</span>
        <span>{chartData.lastDate}</span>
      </div>
      <div className="mt-0.5 flex justify-between text-[11px] text-text-secondary">
        <span>Min: {formatUsd(chartData.minValue)}</span>
        <span>Max: {formatUsd(chartData.maxValue)}</span>
      </div>
    </div>
  );
}

function colorForBenchmark(index: number): string {
  return BENCHMARK_LINE_COLORS[index % BENCHMARK_LINE_COLORS.length];
}

function parseIsoDateToUtc(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  return Number.isFinite(date.getTime()) ? date : null;
}
