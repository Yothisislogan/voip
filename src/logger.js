import { randomUUID } from "node:crypto";

/**
 * Minimal structured logger — no dependency. Emits one JSON object per line
 * (easy to ship to Loki/CloudWatch/Datadog) at or above LOG_LEVEL. In
 * development (LOG_PRETTY=true or NODE_ENV!=production) it prints a compact
 * human line instead.
 *
 *   log.info("call.recorded", { callSid, contactId })
 *   log.error("recap.failed", { callSid, err: e.message })
 *
 * A per-request id is attached by requestId() below and surfaced as `reqId`.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] || LEVELS.info;
const PRETTY = process.env.LOG_PRETTY === "true" || process.env.NODE_ENV !== "production";

// Never log these keys' values in full — redact obvious secrets/PII toggles.
const REDACT = new Set(["password", "authorization", "cookie", "token", "secret", "ssn"]);

function scrub(fields) {
  if (!fields || typeof fields !== "object") return fields;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = REDACT.has(k.toLowerCase()) ? "[redacted]" : v;
  }
  return out;
}

function emit(level, msg, fields) {
  if (LEVELS[level] < THRESHOLD) return;
  const rec = { level, msg, ...scrub(fields) };
  if (PRETTY) {
    const extra = Object.keys(rec).filter((k) => k !== "level" && k !== "msg");
    const tail = extra.length ? " " + extra.map((k) => `${k}=${fmt(rec[k])}`).join(" ") : "";
    const line = `${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  } else {
    // ISO timestamp added here (not in workflow-restricted contexts — this is the app).
    (level === "error" ? console.error : console.log)(JSON.stringify({ t: new Date().toISOString(), ...rec }));
  }
}

function fmt(v) {
  if (v == null) return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export const log = {
  debug: (msg, fields) => emit("debug", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
  /** Return a child logger that merges `base` fields into every call. */
  child(base) {
    return {
      debug: (msg, f) => emit("debug", msg, { ...base, ...f }),
      info: (msg, f) => emit("info", msg, { ...base, ...f }),
      warn: (msg, f) => emit("warn", msg, { ...base, ...f }),
      error: (msg, f) => emit("error", msg, { ...base, ...f }),
    };
  },
};

/**
 * Express middleware: assign each request a correlation id (honoring an
 * inbound X-Request-Id), expose it on req/res, and log one access line on
 * finish with method, path, status, and duration.
 */
export function requestId(req, res, next) {
  const id = req.headers["x-request-id"] || randomUUID();
  req.reqId = id;
  req.log = log.child({ reqId: id });
  res.setHeader("X-Request-Id", id);
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // Skip health/readiness noise unless something went wrong.
    if ((req.path === "/health" || req.path === "/ready") && res.statusCode < 400) return;
    emit(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "http.request", {
      reqId: id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms),
    });
  });
  next();
}
