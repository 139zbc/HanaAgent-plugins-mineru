import assert from "node:assert/strict";
import test from "node:test";
import {
  PARSE_MODES, DEFAULT_PARSE_MODE, CHANNELS, AGENT_LIMITS, AGENT_MODE_ID,
  normalizeParseMode, parseModeLabel, resolveConfiguredMode, modeById, modeFor,
  modeRequiresToken, modeProvidesJson,
} from "../parse-options.v2.js";

test("exposes three parse modes across two channels", () => {
  assert.deepEqual(PARSE_MODES.map((mode) => mode.id), ["vlm", "pipeline", "agent"]);
  assert.equal(DEFAULT_PARSE_MODE, "vlm");
  assert.equal(AGENT_MODE_ID, "agent");
  assert.ok(PARSE_MODES.every((mode) => mode.label && mode.hint));
  assert.deepEqual([...new Set(PARSE_MODES.map((mode) => mode.channel))].sort(), [CHANNELS.AGENT, CHANNELS.PRECISION]);
});

test("only the agent mode is token-free and Markdown-only", () => {
  assert.equal(modeRequiresToken("vlm"), true);
  assert.equal(modeRequiresToken("pipeline"), true);
  assert.equal(modeRequiresToken("agent"), false);
  assert.equal(modeProvidesJson("agent"), false);
  assert.equal(modeProvidesJson("vlm"), true);
  assert.deepEqual(modeById("agent").limits, AGENT_LIMITS);
});

test("maps each precision mode to the MinerU model_version it sends", () => {
  assert.equal(modeById("vlm").modelVersion, "vlm");
  assert.equal(modeById("pipeline").modelVersion, "pipeline");
  // The lightweight channel is not a MinerU model_version at all.
  assert.equal(modeById("agent").modelVersion, null);
});

test("labels stay distinguishable in the UI", () => {
  assert.equal(parseModeLabel("vlm"), "VLM");
  assert.equal(parseModeLabel("pipeline"), "MinerU");
  assert.equal(parseModeLabel("agent"), "Agent");
  assert.equal(parseModeLabel("MinerU-HTML"), null);
  assert.equal(parseModeLabel(null), null);
});

test("normalizes canonical ids and aliases, and rejects anything else", () => {
  assert.equal(normalizeParseMode(" VLM "), "vlm");
  assert.equal(normalizeParseMode("pipeline"), "pipeline");
  assert.equal(normalizeParseMode("mineru"), "pipeline");
  assert.equal(normalizeParseMode("vision"), "vlm");
  // agent aliases
  for (const alias of ["agent", "AGENT", "agent-api", "lightweight", "lite", "nokey", "no-key", "no-token"]) {
    assert.equal(normalizeParseMode(alias), "agent", `expected ${alias} -> agent`);
  }
  for (const bad of ["", "   ", "html", "MinerU-HTML", "gpt", null, undefined, 42, {}, []]) {
    assert.equal(normalizeParseMode(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("falls back to the default for missing or invalid stored configuration", () => {
  assert.equal(resolveConfiguredMode("pipeline"), "pipeline");
  assert.equal(resolveConfiguredMode("agent"), "agent");
  assert.equal(resolveConfiguredMode(undefined), "vlm");
  assert.equal(resolveConfiguredMode("nonsense"), "vlm");
  assert.equal(resolveConfiguredMode(null), "vlm");
});

test("modeFor never returns null", () => {
  assert.equal(modeFor("agent").id, "agent");
  assert.equal(modeFor("garbage").id, DEFAULT_PARSE_MODE);
  assert.equal(modeFor(undefined).id, DEFAULT_PARSE_MODE);
});
