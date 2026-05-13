/**
 * Unit tests for /api/bot/start request parsing.
 * Tests `buildBotStartConfigs` which is the validation boundary for bot-start payloads.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBotStartConfigs } from "../routes/botRoutes.ts";

// ---------------------------------------------------------------------------
// Body shape validation
// ---------------------------------------------------------------------------

describe("buildBotStartConfigs — body shape", () => {
  it("throws for non-object body (null)", () => {
    assert.throws(() => buildBotStartConfigs(null), /Request body must be a JSON object/);
  });

  it("throws for non-object body (array)", () => {
    assert.throws(() => buildBotStartConfigs([]), /Request body must be a JSON object/);
  });

  it("throws for non-object body (string)", () => {
    assert.throws(() => buildBotStartConfigs("AAPL"), /Request body must be a JSON object/);
  });

  it("throws when no symbols provided", () => {
    assert.throws(
      () => buildBotStartConfigs({}),
      /Provide at least one symbol/
    );
  });
});

// ---------------------------------------------------------------------------
// Symbol parsing
// ---------------------------------------------------------------------------

describe("buildBotStartConfigs — symbol field", () => {
  it("accepts a single symbol string", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL" });
    assert.equal(result.length, 1);
    assert.equal(result[0].symbol, "AAPL");
  });

  it("normalises symbol to uppercase", () => {
    const result = buildBotStartConfigs({ symbol: "aapl" });
    assert.equal(result[0].symbol, "AAPL");
  });

  it("throws for non-string symbol field", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: 123 }),
      /symbol must be a string/
    );
  });

  it("throws for a symbol with illegal characters", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AA PL" }),
      /Invalid symbol/
    );
  });
});

describe("buildBotStartConfigs — symbols array", () => {
  it("accepts a symbols array", () => {
    const result = buildBotStartConfigs({ symbols: ["AAPL", "MSFT"] });
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((r) => r.symbol).sort(),
      ["AAPL", "MSFT"]
    );
  });

  it("deduplicates symbols across symbol + symbols", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL", symbols: ["AAPL", "MSFT"] });
    assert.equal(result.length, 2);
  });

  it("throws when symbols array contains a non-string", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbols: ["AAPL", 42] }),
      /symbols must be an array of strings/
    );
  });

  it("accepts symbols as comma-separated string", () => {
    const result = buildBotStartConfigs({ symbols: "AAPL,MSFT" });
    assert.equal(result.length, 2);
  });

  it("throws for symbols with wrong type (number)", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbols: 999 }),
      /symbols must be either a string or array/
    );
  });
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

describe("buildBotStartConfigs — profile", () => {
  it("accepts a valid profile key", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL", profile: "long_term_scale_in" });
    assert.equal(result[0].profile, "long_term_scale_in");
  });

  it("uses default profile when omitted", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL" });
    assert.ok(typeof result[0].profile === "string" && result[0].profile.length > 0);
  });

  it("throws for an unknown profile", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", profile: "nonexistent_profile" }),
      /Unknown profile/
    );
  });

  it("throws when profile is a non-string", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", profile: 42 }),
      /profile must be a string/
    );
  });
});

// ---------------------------------------------------------------------------
// Date / duration
// ---------------------------------------------------------------------------

describe("buildBotStartConfigs — startDate", () => {
  it("accepts a valid ISO date", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL", startDate: "2024-01-15" });
    assert.equal(result[0].startDate, "2024-01-15");
  });

  it("accepts null/omitted startDate", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL" });
    assert.equal(result[0].startDate, undefined);
  });

  it("throws for wrong date format", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", startDate: "15-01-2024" }),
      /YYYY-MM-DD format/
    );
  });

  it("throws for non-string startDate", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", startDate: 20240115 }),
      /YYYY-MM-DD string/
    );
  });
});

describe("buildBotStartConfigs — durationDays", () => {
  it("accepts a positive integer", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL", durationDays: 30 });
    assert.equal(result[0].durationDays, 30);
  });

  it("throws for zero", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", durationDays: 0 }),
      /must be a positive integer/
    );
  });

  it("throws for negative", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", durationDays: -5 }),
      /must be a positive integer/
    );
  });

  it("throws for fractional", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", durationDays: 1.5 }),
      /must be a positive integer/
    );
  });

  it("accepts duration as numeric string", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL", durationDays: "20" });
    assert.equal(result[0].durationDays, 20);
  });
});

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

describe("buildBotStartConfigs — allocationMode", () => {
  it('accepts "fixed_usd"', () => {
    const result = buildBotStartConfigs({ symbol: "AAPL", allocationMode: "fixed_usd" });
    assert.equal(result[0].allocationMode, "fixed_usd");
  });

  it('accepts "pct_of_cash"', () => {
    const result = buildBotStartConfigs({ symbol: "AAPL", allocationMode: "pct_of_cash" });
    assert.equal(result[0].allocationMode, "pct_of_cash");
  });

  it("throws for an unrecognised mode", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", allocationMode: "all_in" }),
      /allocationMode must be/
    );
  });

  it('defaults to "pct_of_cash" when omitted', () => {
    const result = buildBotStartConfigs({ symbol: "AAPL" });
    assert.equal(result[0].allocationMode, "pct_of_cash");
  });
});

describe("buildBotStartConfigs — allocationPct boundaries", () => {
  it("accepts 0", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL", allocationPct: 0 });
    assert.equal(result[0].allocationPct, 0);
  });

  it("accepts 100", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL", allocationPct: 100 });
    assert.equal(result[0].allocationPct, 100);
  });

  it("throws for > 100", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", allocationPct: 101 }),
      /must be between 0 and 100/
    );
  });

  it("throws for negative", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", allocationPct: -1 }),
      /must be between 0 and 100/
    );
  });
});

describe("buildBotStartConfigs — allocationFixed", () => {
  it("accepts 0", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL", allocationFixed: 0 });
    assert.equal(result[0].allocationFixed, 0);
  });

  it("throws for negative", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", allocationFixed: -1 }),
      /must be >= 0/
    );
  });
});

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

describe("buildBotStartConfigs — label", () => {
  it("passes label through", () => {
    const result = buildBotStartConfigs({ symbol: "AAPL", label: "My Bot" });
    assert.equal(result[0].label, "My Bot");
  });

  it("appends symbol to label when multiple symbols provided", () => {
    const result = buildBotStartConfigs({ symbols: ["AAPL", "MSFT"], label: "Test" });
    for (const r of result) {
      assert.match(r.label, /Test \(/);
    }
  });

  it("throws for label longer than 120 chars", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", label: "x".repeat(121) }),
      /120 characters or fewer/
    );
  });

  it("throws for non-string label", () => {
    assert.throws(
      () => buildBotStartConfigs({ symbol: "AAPL", label: 99 }),
      /label must be a string/
    );
  });
});
