import { useCallback, useEffect, useState } from "react";
import { SIGNAL_META, SignalType, SignalWeight } from "../lib/signals";
import { STRATEGY_PRESETS, StrategyPresetKey } from "./StrategyBuilder";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const API_PREFIX = API_BASE_URL ? `${API_BASE_URL}/api` : "/api";

// ── Types mirroring data-service/bot.ts ──────────────────────────────────────

interface BotConfig {
  label: string;
  symbol: string;
  timeframe: "1Day" | "1Hour";
  signals: SignalWeight[];
  allocationMode: "fixed_usd" | "pct_of_cash";
  allocationFixed: number;
  allocationPct: number;
  buyThreshold: number;
  sellThreshold: number;
}

interface BotPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  costBasis: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlpc: number | null;
}

interface BotTrade {
  id: string;
  date: string;
  side: "buy" | "sell";
  price: number;
  qty: number | null;
  notional: number | null;
  signalScore: number;
  rationale: string;
  orderId: string;
  status: "submitted" | "error";
  errorMsg?: string;
}

interface BotStatus {
  id: string;
  running: boolean;
  config: BotConfig;
  position: BotPosition | null;
  trades: BotTrade[];
  lastSignalScore: number | null;
  lastSignalRationale: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  availableCash: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type SignalKey = keyof typeof SIGNAL_META;

function makeSignal(type: SignalKey): SignalType {
  if (type === "rsi") return { type: "rsi", period: 14 };
  if (type === "bollinger_band") return { type: "bollinger_band", period: 20, std_dev: 2 };
  if (type === "volume") return { type: "volume", period: 20 };
  if (type === "momentum") return { type: "momentum", period: 10 };
  return { type: "price_vs_sma", period: 20 };
}

function fmtUsd(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString();
}

function timeAgo(iso: string) {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

// ── CSS tokens ────────────────────────────────────────────────────────────────

const input =
  "w-full rounded border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/60";
const fieldLabel =
  "block text-[10px] uppercase tracking-widest text-text-secondary font-semibold mb-1";

// ── Default form ──────────────────────────────────────────────────────────────

function defaultForm(): BotConfig {
  const preset = STRATEGY_PRESETS.find((p) => p.key === "mean_reversion_balanced")!;
  return {
    label: "BTC Mean Reversion",
    symbol: "BTC/USD",
    timeframe: "1Hour",
    signals: preset.config.signals,
    allocationMode: "pct_of_cash",
    allocationFixed: 500,
    allocationPct: 20,
    buyThreshold: 0.65,
    sellThreshold: 0.35,
  };
}

// ── Root component ────────────────────────────────────────────────────────────

export default function PaperTradingBot() {
  const [bots, setBots] = useState<BotStatus[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [expandedTrades, setExpandedTrades] = useState<Set<string>>(new Set());

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(`${API_PREFIX}/bot/list`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setBots((await res.json()) as BotStatus[]);
      setListError(null);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Could not reach bot API");
    }
  }, []);

  useEffect(() => {
    void fetchList();
    const id = setInterval(() => void fetchList(), 10_000);
    return () => clearInterval(id);
  }, [fetchList]);

  function toggleTrades(id: string) {
    setExpandedTrades((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleStop(id: string) {
    await fetch(`${API_PREFIX}/bot/stop/${id}`, { method: "POST" });
    await fetchList();
  }

  async function handleRemove(id: string) {
    await fetch(`${API_PREFIX}/bot/${id}`, { method: "DELETE" });
    await fetchList();
  }

  async function handleStart(cfg: BotConfig) {
    const res = await fetch(`${API_PREFIX}/bot/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    if (res.ok) {
      setShowForm(false);
      await fetchList();
    }
    return res;
  }

  return (
    <div className="h-full overflow-auto p-4 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold">Paper Trading Bots</h2>
          <p className="text-xs text-text-secondary mt-0.5">
            Each bot runs independently on the dev server with its own strategy and position.
          </p>
        </div>
        {listError && (
          <span className="ml-auto text-xs text-sell bg-sell/10 border border-sell/30 rounded px-2 py-1">
            {listError}
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className={`${listError ? "" : "ml-auto"} rounded border px-3 py-1.5 text-xs font-medium transition-colors ${
            showForm
              ? "border-accent/60 bg-accent/15 text-accent"
              : "border-border bg-surface-2 text-text-secondary hover:text-text-primary hover:border-accent/30"
          }`}
        >
          {showForm ? "Cancel" : "+ Add Bot"}
        </button>
      </div>

      {/* Add Bot form */}
      {showForm && (
        <BotForm
          onStart={handleStart}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Bot list */}
      {bots.length === 0 && !showForm ? (
        <div className="rounded border border-border bg-surface-1 p-8 text-center">
          <p className="text-sm text-text-secondary">No bots running.</p>
          <p className="text-xs text-text-secondary mt-1">
            Click <span className="text-accent">+ Add Bot</span> to create one.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {bots.map((bot) => (
            <BotCard
              key={bot.id}
              bot={bot}
              tradesExpanded={expandedTrades.has(bot.id)}
              onToggleTrades={() => toggleTrades(bot.id)}
              onStop={() => void handleStop(bot.id)}
              onRemove={() => void handleRemove(bot.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Bot card ──────────────────────────────────────────────────────────────────

function BotCard({
  bot,
  tradesExpanded,
  onToggleTrades,
  onStop,
  onRemove,
}: {
  bot: BotStatus;
  tradesExpanded: boolean;
  onToggleTrades: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  const cfg = bot.config;
  const score = bot.lastSignalScore;

  return (
    <div className="rounded border border-border bg-surface-1">
      {/* Card header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/60">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate">{cfg.label}</span>
            <span className="text-[10px] text-text-secondary bg-surface-2 border border-border rounded px-1.5 py-0.5 shrink-0">
              {cfg.symbol}
            </span>
            <span className="text-[10px] text-text-secondary bg-surface-2 border border-border rounded px-1.5 py-0.5 shrink-0">
              {cfg.timeframe === "1Hour" ? "Hourly" : "Daily"}
            </span>
          </div>
          {bot.lastTickAt && (
            <p className="text-[10px] text-text-secondary mt-0.5">
              Last checked {timeAgo(bot.lastTickAt)}
            </p>
          )}
        </div>
        <span
          className={`text-xs rounded px-2 py-0.5 border font-medium shrink-0 ${
            bot.running
              ? "text-buy bg-buy/10 border-buy/30"
              : "text-text-secondary bg-surface-2 border-border"
          }`}
        >
          {bot.running ? "● Running" : "○ Stopped"}
        </span>
        {bot.running && (
          <button
            type="button"
            onClick={onStop}
            className="rounded border border-sell/40 bg-sell/10 px-2.5 py-1 text-xs text-sell hover:bg-sell/20 shrink-0"
          >
            Stop
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="rounded border border-border bg-surface-2 px-2.5 py-1 text-xs text-text-secondary hover:text-sell hover:border-sell/40 shrink-0"
        >
          Remove
        </button>
      </div>

      {/* Card body */}
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border/60">
        {/* Signal */}
        <div className="px-4 py-3">
          <p className="text-[10px] uppercase tracking-widest text-text-secondary font-semibold mb-2">
            Signal
          </p>
          {score != null ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      score >= cfg.buyThreshold
                        ? "bg-buy"
                        : score <= cfg.sellThreshold
                        ? "bg-sell"
                        : "bg-accent"
                    }`}
                    style={{ width: `${score * 100}%` }}
                  />
                </div>
                <span className="text-xs font-mono font-semibold w-8 text-right">
                  {(score * 100).toFixed(0)}%
                </span>
              </div>
              {bot.lastSignalRationale && (
                <p className="text-[10px] text-text-secondary leading-relaxed">
                  {bot.lastSignalRationale}
                </p>
              )}
              <p className="text-[10px] text-text-secondary">
                Buy ≥ {(cfg.buyThreshold * 100).toFixed(0)}% · Sell ≤ {(cfg.sellThreshold * 100).toFixed(0)}%
              </p>
            </div>
          ) : (
            <p className="text-xs text-text-secondary">
              {bot.running ? "Waiting for first tick…" : "—"}
            </p>
          )}
          {bot.lastError && (
            <p className="mt-2 text-[10px] text-sell bg-sell/10 border border-sell/20 rounded px-2 py-1">
              {bot.lastError}
            </p>
          )}
        </div>

        {/* Position */}
        <div className="px-4 py-3">
          <p className="text-[10px] uppercase tracking-widest text-text-secondary font-semibold mb-2">
            Position
          </p>
          {bot.position ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
              <span className="text-text-secondary">Qty</span>
              <span className="font-mono text-right">{bot.position.qty.toFixed(6)}</span>
              <span className="text-text-secondary">Avg entry</span>
              <span className="font-mono text-right">{fmtUsd(bot.position.avgEntryPrice)}</span>
              <span className="text-text-secondary">Market value</span>
              <span className="font-mono text-right">{fmtUsd(bot.position.marketValue)}</span>
              <span className="text-text-secondary">P&L</span>
              <span
                className={`font-mono font-semibold text-right ${
                  bot.position.unrealizedPl >= 0 ? "text-buy" : "text-sell"
                }`}
              >
                {fmtUsd(bot.position.unrealizedPl)}
              </span>
            </div>
          ) : (
            <p className="text-xs text-text-secondary">No open position</p>
          )}
        </div>

        {/* Allocation */}
        <div className="px-4 py-3">
          <p className="text-[10px] uppercase tracking-widest text-text-secondary font-semibold mb-2">
            Allocation
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            <span className="text-text-secondary">Mode</span>
            <span className="text-right">
              {cfg.allocationMode === "pct_of_cash" ? `${cfg.allocationPct}% of cash` : "Fixed $"}
            </span>
            {cfg.allocationMode === "fixed_usd" && (
              <>
                <span className="text-text-secondary">Amount</span>
                <span className="font-mono text-right">{fmtUsd(cfg.allocationFixed)}</span>
              </>
            )}
            {bot.availableCash != null && (
              <>
                <span className="text-text-secondary">Cash available</span>
                <span className="font-mono text-right">{fmtUsd(bot.availableCash)}</span>
              </>
            )}
            {cfg.allocationMode === "pct_of_cash" && bot.availableCash != null && (
              <>
                <span className="text-text-secondary">Next trade ≈</span>
                <span className="font-mono text-right">
                  {fmtUsd((cfg.allocationPct / 100) * bot.availableCash)}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Trade history toggle */}
      {bot.trades.length > 0 && (
        <div className="border-t border-border/60">
          <button
            type="button"
            onClick={onToggleTrades}
            className="w-full px-4 py-2 text-xs text-text-secondary hover:text-text-primary flex items-center gap-1.5"
          >
            <span>
              {tradesExpanded ? "▲" : "▼"} {bot.trades.length} trade
              {bot.trades.length !== 1 ? "s" : ""} this session
            </span>
          </button>
          {tradesExpanded && (
            <div className="overflow-x-auto px-4 pb-3">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-left text-text-secondary border-b border-border">
                    <th className="pb-1.5 pr-4 font-medium">Time</th>
                    <th className="pb-1.5 pr-4 font-medium">Side</th>
                    <th className="pb-1.5 pr-4 font-medium">Price</th>
                    <th className="pb-1.5 pr-4 font-medium">Amount / Qty</th>
                    <th className="pb-1.5 pr-4 font-medium">Signal</th>
                    <th className="pb-1.5 pr-4 font-medium">Rationale</th>
                    <th className="pb-1.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bot.trades.map((t) => (
                    <tr key={t.id} className="border-b border-border/40 hover:bg-surface-2/40">
                      <td className="py-1.5 pr-4 font-mono text-text-secondary whitespace-nowrap">
                        {fmtDate(t.date)}
                      </td>
                      <td className="py-1.5 pr-4">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                            t.side === "buy" ? "bg-buy/15 text-buy" : "bg-sell/15 text-sell"
                          }`}
                        >
                          {t.side.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-1.5 pr-4 font-mono">{fmtUsd(t.price)}</td>
                      <td className="py-1.5 pr-4 font-mono">
                        {t.notional != null ? fmtUsd(t.notional) : t.qty != null ? t.qty.toFixed(6) : "—"}
                      </td>
                      <td className="py-1.5 pr-4 font-mono">{(t.signalScore * 100).toFixed(0)}%</td>
                      <td className="py-1.5 pr-4 text-text-secondary max-w-[200px] truncate">
                        {t.rationale}
                      </td>
                      <td className="py-1.5">
                        {t.status === "error" ? (
                          <span className="text-sell text-[10px]" title={t.errorMsg}>Error</span>
                        ) : (
                          <span className="text-buy text-[10px]">Submitted</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Add Bot form ──────────────────────────────────────────────────────────────

function BotForm({
  onStart,
  onCancel,
}: {
  onStart: (cfg: BotConfig) => Promise<Response>;
  onCancel: () => void;
}) {
  const [cfg, setCfg] = useState<BotConfig>(defaultForm);
  const [presetKey, setPresetKey] = useState<StrategyPresetKey>("mean_reversion_balanced");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = <K extends keyof BotConfig>(k: K, v: BotConfig[K]) =>
    setCfg((c) => ({ ...c, [k]: v }));

  const activeTypes = new Set<string>(cfg.signals.map((sw) => sw.signal.type));

  function toggleSignal(type: SignalKey) {
    if (activeTypes.has(type)) {
      const next = cfg.signals.filter((sw) => sw.signal.type !== type);
      if (next.length === 0) return;
      const w = 1 / next.length;
      patch("signals", next.map((sw) => ({ ...sw, weight: w })));
    } else {
      const n = cfg.signals.length + 1;
      const w = 1 / n;
      patch("signals", [
        ...cfg.signals.map((sw) => ({ ...sw, weight: w })),
        { signal: makeSignal(type), weight: w },
      ]);
    }
  }

  function applyPreset(key: StrategyPresetKey) {
    const preset = STRATEGY_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setPresetKey(key);
    const agg = preset.config.aggressiveness;
    setCfg((c) => ({
      ...c,
      signals: preset.config.signals,
      buyThreshold: +(0.70 - agg * 0.15).toFixed(3),
      sellThreshold: +(0.30 + agg * 0.15).toFixed(3),
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await onStart(cfg);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `HTTP ${res.status}`);
    }
    setSubmitting(false);
  }

  const selectedPreset = STRATEGY_PRESETS.find((p) => p.key === presetKey);

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="rounded border border-accent/30 bg-surface-1 p-4 flex flex-col gap-4"
    >
      <p className="text-[10px] uppercase tracking-widest text-accent font-semibold">
        New Bot
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Left column */}
        <div className="flex flex-col gap-4">
          <div>
            <label className={fieldLabel}>Label</label>
            <input
              className={input}
              value={cfg.label}
              onChange={(e) => patch("label", e.target.value)}
              placeholder="My BTC Bot"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={fieldLabel}>Symbol</label>
              <input
                className={input}
                value={cfg.symbol}
                onChange={(e) => patch("symbol", e.target.value.toUpperCase())}
                placeholder="BTC/USD"
                required
              />
            </div>
            <div>
              <label className={fieldLabel}>Candles</label>
              <select
                className={input}
                value={cfg.timeframe}
                onChange={(e) => patch("timeframe", e.target.value as BotConfig["timeframe"])}
              >
                <option value="1Hour">Hourly</option>
                <option value="1Day">Daily</option>
              </select>
            </div>
          </div>

          <div>
            <label className={fieldLabel}>Strategy Preset</label>
            <div className="flex gap-2">
              <select
                className={input}
                value={presetKey}
                onChange={(e) => setPresetKey(e.target.value as StrategyPresetKey)}
              >
                {STRATEGY_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => applyPreset(presetKey)}
                className="whitespace-nowrap rounded border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              >
                Apply
              </button>
            </div>
            {selectedPreset && (
              <p className="mt-1 text-[10px] text-text-secondary">
                {selectedPreset.suitableFor}
              </p>
            )}
          </div>

          <div>
            <label className={fieldLabel}>Signals</label>
            <div className="flex flex-wrap gap-1 mb-2">
              {(Object.keys(SIGNAL_META) as SignalKey[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleSignal(type)}
                  className={`rounded border px-2 py-1 text-[10px] transition-colors ${
                    activeTypes.has(type)
                      ? "border-accent/60 bg-accent/15 text-accent"
                      : "border-border bg-surface-2 text-text-secondary hover:border-accent/30"
                  }`}
                >
                  {SIGNAL_META[type].label}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              {cfg.signals.map((sw, i) => (
                <div key={sw.signal.type} className="flex items-center gap-2 text-xs">
                  <span className="w-32 text-text-secondary truncate">
                    {SIGNAL_META[sw.signal.type]?.label ?? sw.signal.type}
                  </span>
                  <input
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={sw.weight}
                    onChange={(e) => {
                      const next = cfg.signals.map((s, j) =>
                        j === i ? { ...s, weight: +e.target.value } : s
                      );
                      patch("signals", next);
                    }}
                    className="flex-1 accent-accent"
                  />
                  <span className="w-8 text-right text-text-secondary">
                    {Math.round(sw.weight * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={fieldLabel}>Buy Threshold</label>
              <input
                type="number" min={0.5} max={0.95} step={0.01}
                className={input}
                value={cfg.buyThreshold}
                onChange={(e) => patch("buyThreshold", +e.target.value)}
              />
              <p className="mt-0.5 text-[10px] text-text-secondary">Score &gt; this → buy</p>
            </div>
            <div>
              <label className={fieldLabel}>Sell Threshold</label>
              <input
                type="number" min={0.05} max={0.5} step={0.01}
                className={input}
                value={cfg.sellThreshold}
                onChange={(e) => patch("sellThreshold", +e.target.value)}
              />
              <p className="mt-0.5 text-[10px] text-text-secondary">Score &lt; this → sell</p>
            </div>
          </div>

          <div>
            <label className={fieldLabel}>Allocation per Trade</label>
            <div className="flex gap-2 mb-2">
              {(["pct_of_cash", "fixed_usd"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => patch("allocationMode", mode)}
                  className={`rounded border px-2.5 py-1.5 text-xs transition-colors ${
                    cfg.allocationMode === mode
                      ? "border-accent/60 bg-accent/15 text-accent"
                      : "border-border bg-surface-2 text-text-secondary hover:border-accent/30"
                  }`}
                >
                  {mode === "pct_of_cash" ? "% of Cash" : "Fixed $"}
                </button>
              ))}
            </div>
            {cfg.allocationMode === "pct_of_cash" ? (
              <div className="flex items-center gap-2">
                <input
                  type="range" min={1} max={100} step={1}
                  value={cfg.allocationPct}
                  onChange={(e) => patch("allocationPct", +e.target.value)}
                  className="flex-1 accent-accent"
                />
                <span className="w-10 text-right text-xs font-medium">{cfg.allocationPct}%</span>
              </div>
            ) : (
              <input
                type="number" min={1} step={1}
                className={input}
                value={cfg.allocationFixed}
                onChange={(e) => patch("allocationFixed", +e.target.value)}
                placeholder="500"
              />
            )}
          </div>

          <div className="rounded border border-border bg-surface-2 p-3 text-[10px] text-text-secondary leading-relaxed">
            <p className="font-semibold text-text-primary mb-1">Check cadence</p>
            {cfg.timeframe === "1Hour"
              ? "Hourly candles — bot checks every 5 minutes and picks up a new bar within 5 minutes of each hour close."
              : "Daily candles — bot checks every 30 minutes. Bar closes at midnight UTC (7–8 pm ET). Signal updates once per day."}
          </div>
        </div>
      </div>

      {error && (
        <p className="text-xs text-sell bg-sell/10 border border-sell/30 rounded px-2 py-1">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded border border-buy/50 bg-buy/15 px-4 py-2 text-xs font-semibold text-buy hover:bg-buy/25 disabled:opacity-50 transition-colors"
        >
          {submitting ? "Starting…" : "Start Bot"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-border bg-surface-2 px-4 py-2 text-xs text-text-secondary hover:text-text-primary"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
