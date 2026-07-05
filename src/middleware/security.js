import { config } from "../config.js";

/**
 * Security response headers — hand-rolled (no helmet dependency). Applied to
 * every response. HSTS is only sent over HTTPS (detected from PUBLIC_BASE_URL)
 * so we never pin HSTS on a plain-http dev box.
 */
const HTTPS = (config.publicBaseUrl || "").startsWith("https");

export function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "0"); // modern browsers: rely on CSP, disable legacy auditor
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(self), payment=()");
  res.setHeader("Content-Security-Policy", config.security.csp);
  if (HTTPS) {
    res.setHeader("Strict-Transport-Security", `max-age=${config.security.hstsMaxAge}; includeSubDomains`);
  }
  next();
}
