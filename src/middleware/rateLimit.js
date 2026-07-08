import { config } from "../config.js";

/**
 * In-memory fixed-window rate limiter — no dependency, no Redis. Adequate for a
 * single instance (the current deploy). NOTE: counters are per-process, so
 * behind multiple instances each gets its own budget — move to a shared store
 * (Redis) if you scale horizontally. A background sweep evicts stale buckets so
 * memory stays bounded.
 */

const { windowMs, trustProxy, trustHops } = config.security.rateLimit;

/**
 * Client IP for bucketing. SECURITY: X-Forwarded-For is client-forgeable except
 * for the entries appended by our own proxies — a client can send a fake XFF
 * header and the proxy appends the REAL connection IP after it. So we count
 * `trustHops` entries from the RIGHT (1 = directly behind Caddy/Render,
 * 2 = Cloudflare in front of Caddy), never the attacker-controlled first entry.
 * Taking the first entry would let an attacker rotate fake IPs and bypass the
 * auth/OTP brute-force limits entirely.
 */
function clientIp(req) {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const chain = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
      if (chain.length) return chain[Math.max(0, chain.length - trustHops)];
    }
  }
  return req.socket?.remoteAddress || req.ip || "unknown";
}

// One shared map keyed by `${bucket}:${ip}` → { count, resetAt }.
const buckets = new Map();

// Evict expired entries every windowMs so the map can't grow unbounded.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
}, windowMs);
if (typeof sweep.unref === "function") sweep.unref(); // don't keep the process alive

/**
 * rateLimit(bucketName, max) → Express middleware. `bucketName` isolates
 * counters per surface (auth vs api vs webhook) so a burst on one doesn't
 * starve another.
 */
export function rateLimit(bucketName, max) {
  return (req, res, next) => {
    if (!max || max <= 0) return next(); // disabled
    const now = Date.now();
    const key = `${bucketName}:${clientIp(req)}`;
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    const remaining = Math.max(0, max - b.count);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil((b.resetAt - now) / 1000)));
    if (b.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: "too many requests" });
    }
    next();
  };
}

// Convenience limiters preconfigured from config.
const rl = config.security.rateLimit;
export const authLimiter = rateLimit("auth", rl.authMax);
export const apiLimiter = rateLimit("api", rl.apiMax);
export const webhookLimiter = rateLimit("webhook", rl.webhookMax);
