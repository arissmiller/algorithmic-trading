import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseBooleanEnv, parseCsvEnv } from "../config.ts";

describe("parseBooleanEnv", () => {
  const ENV_KEY = "__TEST_BOOL_ENV__";

  after(() => {
    delete process.env[ENV_KEY];
  });

  it("returns fallback when env var is absent", () => {
    delete process.env[ENV_KEY];
    assert.equal(parseBooleanEnv(ENV_KEY, true), true);
    assert.equal(parseBooleanEnv(ENV_KEY, false), false);
  });

  for (const truthy of ["1", "true", "True", "TRUE", "yes", "y", "on", "YES"]) {
    it(`treats "${truthy}" as true`, () => {
      process.env[ENV_KEY] = truthy;
      assert.equal(parseBooleanEnv(ENV_KEY, false), true);
    });
  }

  for (const falsy of ["0", "false", "False", "FALSE", "no", "n", "off", "NO"]) {
    it(`treats "${falsy}" as false`, () => {
      process.env[ENV_KEY] = falsy;
      assert.equal(parseBooleanEnv(ENV_KEY, true), false);
    });
  }

  it("returns fallback for unrecognised values", () => {
    process.env[ENV_KEY] = "maybe";
    assert.equal(parseBooleanEnv(ENV_KEY, true), true);
    assert.equal(parseBooleanEnv(ENV_KEY, false), false);
  });

  it("handles leading/trailing whitespace", () => {
    process.env[ENV_KEY] = "  true  ";
    assert.equal(parseBooleanEnv(ENV_KEY, false), true);
  });
});

describe("parseCsvEnv", () => {
  const ENV_KEY = "__TEST_CSV_ENV__";

  after(() => {
    delete process.env[ENV_KEY];
  });

  it("returns empty array when env var is absent", () => {
    delete process.env[ENV_KEY];
    assert.deepEqual(parseCsvEnv(ENV_KEY), []);
  });

  it("returns empty array for blank value", () => {
    process.env[ENV_KEY] = "   ";
    assert.deepEqual(parseCsvEnv(ENV_KEY), []);
  });

  it("splits comma-separated values and trims whitespace", () => {
    process.env[ENV_KEY] = " http://a.com , http://b.com ";
    assert.deepEqual(parseCsvEnv(ENV_KEY), ["http://a.com", "http://b.com"]);
  });

  it("filters out empty segments", () => {
    process.env[ENV_KEY] = "a,,b,";
    assert.deepEqual(parseCsvEnv(ENV_KEY), ["a", "b"]);
  });

  it("returns a single-element array for one value", () => {
    process.env[ENV_KEY] = "https://example.com";
    assert.deepEqual(parseCsvEnv(ENV_KEY), ["https://example.com"]);
  });
});
