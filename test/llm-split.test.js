import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Resolve config under a given env in a child process (config reads env at import).
function resolve(env) {
  const out = execFileSync(
    process.execPath,
    ["-e", "import('./src/config.js').then(m=>process.stdout.write(m.config.llm.coachingBackend+','+m.config.llm.recapBackend))"],
    { env: { ...process.env, ...env }, encoding: "utf8" }
  );
  const [coaching, recap] = out.trim().split(",");
  return { coaching, recap };
}

test("default backend is rules for both tasks", () => {
  assert.deepEqual(resolve({ LLM_BACKEND: "" }), { coaching: "rules", recap: "rules" });
});

test("Claude (anthropic) only powers recap — coaching stays local", () => {
  assert.deepEqual(resolve({ LLM_BACKEND: "anthropic" }), { coaching: "rules", recap: "anthropic" });
});

test("Claude (bedrock) only powers recap — coaching stays local", () => {
  assert.deepEqual(resolve({ LLM_BACKEND: "bedrock" }), { coaching: "rules", recap: "bedrock" });
});

test("ollama drives both coaching (tiny local) and recap", () => {
  assert.deepEqual(resolve({ LLM_BACKEND: "ollama" }), { coaching: "ollama", recap: "ollama" });
});

test("explicit overrides win (tiny local coaching + Claude recap)", () => {
  assert.deepEqual(
    resolve({ LLM_BACKEND: "anthropic", LLM_COACHING_BACKEND: "ollama" }),
    { coaching: "ollama", recap: "anthropic" }
  );
});
