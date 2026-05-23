import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "smart-scale-ai-audit-v1";

type QueryLimitPerDay = 1 | 2;

type GoalConfig = {
  objective: string;
  startingCapital: number;
  targetCapital: number;
  targetYears: number;
  queryLimitPerDay: QueryLimitPerDay;
};

type QueryRecord = {
  id: string;
  at: string;
  strategyId: string;
  model: string;
  promptSummary: string;
};

type DecisionAction = "watch" | "buy" | "sell" | "hold";

type DecisionRecord = {
  id: string;
  at: string;
  strategyId: string;
  symbol: string;
  action: DecisionAction;
  confidencePct: number;
  rationale: string;
  queryId: string;
};

type TradeSide = "buy" | "sell";
type TradeStatus = "paper" | "proposed" | "skipped";

type TradeRecord = {
  id: string;
  at: string;
  strategyId: string;
  decisionId: string;
  symbol: string;
  side: TradeSide;
  qty: number;
  priceUsd: number;
  status: TradeStatus;
  notes: string;
};

type AuditState = {
  goal: GoalConfig;
  queries: QueryRecord[];
  decisions: DecisionRecord[];
  trades: TradeRecord[];
};

interface Props {
  suggestedStrategyId: string;
  suggestedStrategySummary: string;
}

const defaultGoal: GoalConfig = {
  objective: "Turn $100,000 into $1,000,000 in under 5 years.",
  startingCapital: 100_000,
  targetCapital: 1_000_000,
  targetYears: 5,
  queryLimitPerDay: 2,
};

const defaultState: AuditState = {
  goal: defaultGoal,
  queries: [],
  decisions: [],
  trades: [],
};

export default function AIControlCenter({
  suggestedStrategyId,
  suggestedStrategySummary,
}: Props) {
  const [state, setState] = useState<AuditState>(() => readInitialState());
  const [queryInput, setQueryInput] = useState({
    model: "gpt-5",
    strategyId: suggestedStrategyId,
    promptSummary: "",
  });
  const [decisionInput, setDecisionInput] = useState({
    strategyId: suggestedStrategyId,
    symbol: "",
    action: "watch" as DecisionAction,
    confidencePct: 60,
    rationale: "",
    queryId: "",
  });
  const [tradeInput, setTradeInput] = useState({
    strategyId: suggestedStrategyId,
    decisionId: "",
    symbol: "",
    side: "buy" as TradeSide,
    qty: 0,
    priceUsd: 0,
    status: "paper" as TradeStatus,
    notes: "",
  });

  useEffect(() => {
    writeState(state);
  }, [state]);

  useEffect(() => {
    if (!suggestedStrategyId) return;
    setQueryInput((prev) => ({ ...prev, strategyId: prev.strategyId || suggestedStrategyId }));
    setDecisionInput((prev) => ({
      ...prev,
      strategyId: prev.strategyId || suggestedStrategyId,
    }));
    setTradeInput((prev) => ({ ...prev, strategyId: prev.strategyId || suggestedStrategyId }));
  }, [suggestedStrategyId]);

  const todayKey = getLocalDateKey(new Date());
  const usedToday = state.queries.filter((q) => getLocalDateKey(new Date(q.at)) === todayKey).length;
  const remainingToday = Math.max(0, state.goal.queryLimitPerDay - usedToday);
  const queryLimitReached = remainingToday <= 0;

  const decisionById = useMemo(() => {
    return new Map(state.decisions.map((d) => [d.id, d]));
  }, [state.decisions]);

  function updateGoal<K extends keyof GoalConfig>(key: K, value: GoalConfig[K]) {
    setState((prev) => ({
      ...prev,
      goal: { ...prev.goal, [key]: value },
    }));
  }

  function handleAddQuery(e: React.FormEvent) {
    e.preventDefault();
    if (queryLimitReached) return;
    if (!queryInput.promptSummary.trim()) return;
    if (!queryInput.strategyId.trim()) return;

    const record: QueryRecord = {
      id: makeId("q"),
      at: new Date().toISOString(),
      strategyId: queryInput.strategyId.trim(),
      model: queryInput.model.trim(),
      promptSummary: queryInput.promptSummary.trim(),
    };
    setState((prev) => ({ ...prev, queries: [record, ...prev.queries] }));
    setQueryInput((prev) => ({ ...prev, promptSummary: "" }));
  }

  function handleAddDecision(e: React.FormEvent) {
    e.preventDefault();
    if (!decisionInput.strategyId.trim()) return;
    if (!decisionInput.symbol.trim()) return;
    if (!decisionInput.rationale.trim()) return;

    const record: DecisionRecord = {
      id: makeId("d"),
      at: new Date().toISOString(),
      strategyId: decisionInput.strategyId.trim(),
      symbol: decisionInput.symbol.trim().toUpperCase(),
      action: decisionInput.action,
      confidencePct: Math.max(0, Math.min(100, Number(decisionInput.confidencePct))),
      rationale: decisionInput.rationale.trim(),
      queryId: decisionInput.queryId.trim(),
    };
    setState((prev) => ({ ...prev, decisions: [record, ...prev.decisions] }));
    setDecisionInput((prev) => ({ ...prev, rationale: "", queryId: "" }));
  }

  function handleAddTrade(e: React.FormEvent) {
    e.preventDefault();
    if (!tradeInput.strategyId.trim()) return;
    if (!tradeInput.symbol.trim()) return;
    if (Number(tradeInput.qty) <= 0 || Number(tradeInput.priceUsd) <= 0) return;

    const record: TradeRecord = {
      id: makeId("t"),
      at: new Date().toISOString(),
      strategyId: tradeInput.strategyId.trim(),
      decisionId: tradeInput.decisionId.trim(),
      symbol: tradeInput.symbol.trim().toUpperCase(),
      side: tradeInput.side,
      qty: Number(tradeInput.qty),
      priceUsd: Number(tradeInput.priceUsd),
      status: tradeInput.status,
      notes: tradeInput.notes.trim(),
    };
    setState((prev) => ({ ...prev, trades: [record, ...prev.trades] }));
    setTradeInput((prev) => ({ ...prev, decisionId: "", notes: "", qty: 0, priceUsd: 0 }));
  }

  function downloadAuditJson() {
    const payload = JSON.stringify(state, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ai-audit-${todayKey}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearAuditLog() {
    if (!window.confirm("Clear all AI query, decision, and trade records?")) return;
    setState((prev) => ({ ...prev, queries: [], decisions: [], trades: [] }));
  }

  return (
    <section className="rounded border border-border bg-surface-1">
      <div className="px-4 py-2 border-b border-border text-[12px] uppercase tracking-widest text-text-secondary font-semibold">
        AI Oversight
      </div>
      <div className="p-4 space-y-4 text-xs">
        <div className="rounded border border-border bg-surface-2 p-3">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <p className="text-[12px] text-text-secondary mb-1">Objective</p>
              <textarea
                className={inputClass}
                rows={2}
                value={state.goal.objective}
                onChange={(e) => updateGoal("objective", e.target.value)}
              />
              <p className="mt-1 text-[11px] text-text-secondary">
                Watch-only mode is enforced. The app records AI decisions but does not send orders.
              </p>
            </div>
            <div className="w-60 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <label>
                  <span className={fieldLabel}>Start</span>
                  <input
                    type="number"
                    className={inputClass}
                    value={state.goal.startingCapital}
                    min={1}
                    onChange={(e) =>
                      updateGoal("startingCapital", Math.max(1, Number(e.target.value) || 1))
                    }
                  />
                </label>
                <label>
                  <span className={fieldLabel}>Target</span>
                  <input
                    type="number"
                    className={inputClass}
                    value={state.goal.targetCapital}
                    min={1}
                    onChange={(e) =>
                      updateGoal("targetCapital", Math.max(1, Number(e.target.value) || 1))
                    }
                  />
                </label>
              </div>
              <label>
                <span className={fieldLabel}>Target Years</span>
                <input
                  type="number"
                  className={inputClass}
                  value={state.goal.targetYears}
                  min={1}
                  max={20}
                  onChange={(e) =>
                    updateGoal("targetYears", Math.max(1, Math.min(20, Number(e.target.value) || 1)))
                  }
                />
              </label>
              <div>
                <p className={fieldLabel}>LLM Query Limit Per Day</p>
                <div className="mt-1 flex gap-2">
                  <LimitBtn
                    active={state.goal.queryLimitPerDay === 1}
                    onClick={() => updateGoal("queryLimitPerDay", 1)}
                  >
                    1 / day
                  </LimitBtn>
                  <LimitBtn
                    active={state.goal.queryLimitPerDay === 2}
                    onClick={() => updateGoal("queryLimitPerDay", 2)}
                  >
                    2 / day
                  </LimitBtn>
                </div>
              </div>
            </div>
          </div>
          {suggestedStrategyId && (
            <p className="mt-2 text-[11px] text-text-secondary">
              Suggested strategy: <span className="text-text-primary">{suggestedStrategyId}</span>
              {suggestedStrategySummary ? ` | ${suggestedStrategySummary}` : ""}
            </p>
          )}
        </div>

        <div className="rounded border border-border bg-surface-2 p-3">
          <div className="flex items-center gap-3">
            <p className="text-[12px] uppercase tracking-wide text-text-secondary font-semibold">
              Daily LLM Budget
            </p>
            <span
              className={`rounded px-2 py-0.5 tabular-nums ${
                queryLimitReached ? "bg-sell/20 text-sell" : "bg-buy/20 text-buy"
              }`}
            >
              {usedToday}/{state.goal.queryLimitPerDay} used today
            </span>
            <span className="text-[11px] text-text-secondary">Remaining: {remainingToday}</span>
            <span className="ml-auto text-[11px] text-text-secondary">{todayKey}</span>
          </div>
          <form className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-4" onSubmit={handleAddQuery}>
            <input
              className={inputClass}
              placeholder="Model (e.g. gpt-5)"
              value={queryInput.model}
              onChange={(e) => setQueryInput((prev) => ({ ...prev, model: e.target.value }))}
            />
            <input
              className={inputClass}
              placeholder="Strategy ID"
              value={queryInput.strategyId}
              onChange={(e) => setQueryInput((prev) => ({ ...prev, strategyId: e.target.value }))}
            />
            <input
              className={inputClass}
              placeholder="Prompt / query summary"
              value={queryInput.promptSummary}
              onChange={(e) =>
                setQueryInput((prev) => ({ ...prev, promptSummary: e.target.value }))
              }
            />
            <button
              type="submit"
              disabled={queryLimitReached}
              className="rounded border border-border bg-surface-3 px-3 py-1.5 text-text-primary disabled:opacity-50"
            >
              {queryLimitReached ? "Limit Reached" : "Record Query"}
            </button>
          </form>
        </div>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <section className="rounded border border-border bg-surface-2">
            <div className="px-3 py-2 border-b border-border text-[12px] uppercase tracking-wide text-text-secondary font-semibold">
              Decision Log
            </div>
            <form className="p-3 grid grid-cols-1 gap-2" onSubmit={handleAddDecision}>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <input
                  className={inputClass}
                  placeholder="Strategy ID"
                  value={decisionInput.strategyId}
                  onChange={(e) =>
                    setDecisionInput((prev) => ({ ...prev, strategyId: e.target.value }))
                  }
                />
                <input
                  className={inputClass}
                  placeholder="Symbol"
                  value={decisionInput.symbol}
                  onChange={(e) =>
                    setDecisionInput((prev) => ({ ...prev, symbol: e.target.value.toUpperCase() }))
                  }
                />
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                <select
                  className={inputClass}
                  value={decisionInput.action}
                  onChange={(e) =>
                    setDecisionInput((prev) => ({
                      ...prev,
                      action: e.target.value as DecisionAction,
                    }))
                  }
                >
                  <option value="watch">Watch</option>
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                  <option value="hold">Hold</option>
                </select>
                <input
                  type="number"
                  min={0}
                  max={100}
                  className={inputClass}
                  placeholder="Confidence %"
                  value={decisionInput.confidencePct}
                  onChange={(e) =>
                    setDecisionInput((prev) => ({
                      ...prev,
                      confidencePct: Number(e.target.value),
                    }))
                  }
                />
                <input
                  className={inputClass}
                  placeholder="Related query id (optional)"
                  value={decisionInput.queryId}
                  onChange={(e) =>
                    setDecisionInput((prev) => ({ ...prev, queryId: e.target.value }))
                  }
                />
              </div>
              <textarea
                className={inputClass}
                rows={2}
                placeholder="Rationale"
                value={decisionInput.rationale}
                onChange={(e) =>
                  setDecisionInput((prev) => ({ ...prev, rationale: e.target.value }))
                }
              />
              <button type="submit" className="rounded border border-border bg-surface-3 px-3 py-1.5">
                Add Decision
              </button>
            </form>
            <div className="max-h-72 overflow-auto border-t border-border">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-surface-2 text-text-secondary">
                  <tr>
                    <th className="px-2 py-1 text-left">When</th>
                    <th className="px-2 py-1 text-left">Strategy</th>
                    <th className="px-2 py-1 text-left">Symbol</th>
                    <th className="px-2 py-1 text-left">Action</th>
                    <th className="px-2 py-1 text-right">Conf</th>
                    <th className="px-2 py-1 text-left">Query</th>
                    <th className="px-2 py-1 text-left">Rationale</th>
                  </tr>
                </thead>
                <tbody>
                  {state.decisions.map((d) => (
                    <tr key={d.id} className="border-t border-border/50">
                      <td className="px-2 py-1 text-text-secondary">{fmtTime(d.at)}</td>
                      <td className="px-2 py-1 text-text-primary">{d.strategyId}</td>
                      <td className="px-2 py-1 text-text-primary">{d.symbol}</td>
                      <td className="px-2 py-1 text-text-primary uppercase">{d.action}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-text-primary">
                        {d.confidencePct}%
                      </td>
                      <td className="px-2 py-1 text-text-secondary">{d.queryId || "-"}</td>
                      <td className="px-2 py-1 text-text-secondary max-w-64 truncate" title={d.rationale}>
                        {d.rationale}
                      </td>
                    </tr>
                  ))}
                  {state.decisions.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-2 py-3 text-text-secondary">
                        No decisions logged yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded border border-border bg-surface-2">
            <div className="px-3 py-2 border-b border-border text-[12px] uppercase tracking-wide text-text-secondary font-semibold">
              Trade Log
            </div>
            <form className="p-3 grid grid-cols-1 gap-2" onSubmit={handleAddTrade}>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <input
                  className={inputClass}
                  placeholder="Strategy ID"
                  value={tradeInput.strategyId}
                  onChange={(e) => setTradeInput((prev) => ({ ...prev, strategyId: e.target.value }))}
                />
                <input
                  className={inputClass}
                  placeholder="Decision ID (optional)"
                  value={tradeInput.decisionId}
                  onChange={(e) => setTradeInput((prev) => ({ ...prev, decisionId: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                <input
                  className={inputClass}
                  placeholder="Symbol"
                  value={tradeInput.symbol}
                  onChange={(e) =>
                    setTradeInput((prev) => ({ ...prev, symbol: e.target.value.toUpperCase() }))
                  }
                />
                <select
                  className={inputClass}
                  value={tradeInput.side}
                  onChange={(e) =>
                    setTradeInput((prev) => ({ ...prev, side: e.target.value as TradeSide }))
                  }
                >
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
                <input
                  type="number"
                  min={0}
                  step="0.0001"
                  className={inputClass}
                  placeholder="Qty"
                  value={tradeInput.qty}
                  onChange={(e) => setTradeInput((prev) => ({ ...prev, qty: Number(e.target.value) }))}
                />
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  className={inputClass}
                  placeholder="Price USD"
                  value={tradeInput.priceUsd}
                  onChange={(e) =>
                    setTradeInput((prev) => ({ ...prev, priceUsd: Number(e.target.value) }))
                  }
                />
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <select
                  className={inputClass}
                  value={tradeInput.status}
                  onChange={(e) =>
                    setTradeInput((prev) => ({ ...prev, status: e.target.value as TradeStatus }))
                  }
                >
                  <option value="paper">Paper</option>
                  <option value="proposed">Proposed</option>
                  <option value="skipped">Skipped</option>
                </select>
                <input
                  className={inputClass}
                  placeholder="Notes"
                  value={tradeInput.notes}
                  onChange={(e) => setTradeInput((prev) => ({ ...prev, notes: e.target.value }))}
                />
              </div>
              <button type="submit" className="rounded border border-border bg-surface-3 px-3 py-1.5">
                Add Trade Record
              </button>
            </form>
            <div className="max-h-72 overflow-auto border-t border-border">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-surface-2 text-text-secondary">
                  <tr>
                    <th className="px-2 py-1 text-left">When</th>
                    <th className="px-2 py-1 text-left">Strategy</th>
                    <th className="px-2 py-1 text-left">Symbol</th>
                    <th className="px-2 py-1 text-left">Side</th>
                    <th className="px-2 py-1 text-right">Notional</th>
                    <th className="px-2 py-1 text-left">Decision</th>
                    <th className="px-2 py-1 text-left">Status</th>
                    <th className="px-2 py-1 text-left">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {state.trades.map((t) => {
                    const hasDecision = t.decisionId ? decisionById.has(t.decisionId) : true;
                    return (
                      <tr key={t.id} className="border-t border-border/50">
                        <td className="px-2 py-1 text-text-secondary">{fmtTime(t.at)}</td>
                        <td className="px-2 py-1 text-text-primary">{t.strategyId}</td>
                        <td className="px-2 py-1 text-text-primary">{t.symbol}</td>
                        <td className={`px-2 py-1 uppercase ${t.side === "buy" ? "text-buy" : "text-sell"}`}>
                          {t.side}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-text-primary">
                          {fmtUsd(t.qty * t.priceUsd)}
                        </td>
                        <td className="px-2 py-1 text-text-secondary">
                          {t.decisionId || "-"}
                          {t.decisionId && !hasDecision ? " (missing)" : ""}
                        </td>
                        <td className="px-2 py-1 text-text-secondary">{t.status}</td>
                        <td className="px-2 py-1 text-text-secondary max-w-64 truncate" title={t.notes}>
                          {t.notes || "-"}
                        </td>
                      </tr>
                    );
                  })}
                  {state.trades.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-2 py-3 text-text-secondary">
                        No trade records logged yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={downloadAuditJson}
            className="rounded border border-border bg-surface-2 px-3 py-1.5 text-text-primary"
          >
            Export Audit JSON
          </button>
          <button
            type="button"
            onClick={clearAuditLog}
            className="rounded border border-sell/40 bg-sell/10 px-3 py-1.5 text-sell"
          >
            Clear Logs
          </button>
        </div>
      </div>
    </section>
  );
}

function LimitBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-1 text-[12px] ${
        active
          ? "border-accent/50 bg-accent/15 text-accent"
          : "border-border bg-surface-3 text-text-secondary"
      }`}
    >
      {children}
    </button>
  );
}

function readInitialState(): AuditState {
  if (typeof window === "undefined") return defaultState;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState;
    const parsed = JSON.parse(raw) as Partial<AuditState>;
    return {
      goal: { ...defaultGoal, ...(parsed.goal ?? {}) },
      queries: Array.isArray(parsed.queries) ? parsed.queries : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      trades: Array.isArray(parsed.trades) ? parsed.trades : [],
    };
  } catch {
    return defaultState;
  }
}

function writeState(state: AuditState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function fmtUsd(n: number): string {
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
}

const fieldLabel = "text-[11px] text-text-secondary";
const inputClass =
  "w-full rounded border border-border bg-surface-3 px-2 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none";
