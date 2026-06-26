// Bedrock backend: model IDs must be prefixed with "anthropic." and the client
// reports enabled when a region is set. (Direct-API behavior — bare IDs — is the
// default exercised by every other AI test; it needs a different config, so a
// separate process would be required to assert it here.)
process.env.LLM_BACKEND = "bedrock";
process.env.AWS_REGION = "us-east-1";

import { test } from "node:test";
import assert from "node:assert/strict";

const client = await import("../src/ai/client.js");

test("bedrock prefixes bare model IDs", () => {
  assert.equal(client.modelId("claude-opus-4-8"), "anthropic.claude-opus-4-8");
  assert.equal(client.modelId("claude-haiku-4-5"), "anthropic.claude-haiku-4-5");
});

test("bedrock does not double-prefix already-qualified IDs", () => {
  assert.equal(client.modelId("anthropic.claude-opus-4-8"), "anthropic.claude-opus-4-8");
});

test("ai is enabled when a region is configured", () => {
  assert.equal(client.aiEnabled, true);
});
