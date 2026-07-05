import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Run validateEnv in a child process under a given env; capture fatal/warn counts.
function run(env) {
  const script =
    "import('./src/validate-env.js').then(m=>{const r=m.validateEnv({exitOnFatal:false});" +
    "process.stdout.write(JSON.stringify({fatal:r.fatal.length,warn:r.warn.length}))})";
  const out = execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("bad config produces fatal errors", () => {
  const r = run({ NODE_ENV: "test", AUTH_REQUIRED: "true", SESSION_SECRET: "", PUBLIC_BASE_URL: "", GOOGLE_CLIENT_ID: "", AGENT_DIRECTORY: "" });
  assert.ok(r.fatal >= 3, `expected fatal errors, got ${r.fatal}`);
});

test("dev bypass flags are fatal", () => {
  const r = run({ AUTH_REQUIRED: "false", DEV_LOGIN_ENABLED: "true", SESSION_SECRET: "x", PUBLIC_BASE_URL: "https://x.com" });
  assert.ok(r.fatal >= 2);
});

test("complete secure config has no fatal errors", () => {
  const r = run({
    AUTH_REQUIRED: "true",
    DEV_LOGIN_ENABLED: "false",
    SESSION_SECRET: "a-long-secret",
    PUBLIC_BASE_URL: "https://connect.example.com",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    AGENT_DIRECTORY: '[{"email":"a@wit.com","identity":"a"}]',
  });
  assert.equal(r.fatal, 0);
});
