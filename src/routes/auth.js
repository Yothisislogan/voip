import { Router } from "express";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { googleConfigured, authUrl, exchangeCodeForProfile } from "../auth/google.js";
import { findAgentByEmail } from "../auth/agents.js";
import { twoFactorEnforced, startVerification, checkVerification } from "../auth/twofactor.js";
import {
  signToken,
  verifyToken,
  issueSession,
  cookieHeader,
  clearCookieHeader,
  readCookie,
  cookieName,
} from "../auth/session.js";

export const authRouter = Router();

const STATE_COOKIE = "wit_oauth_state";

// ── Login-page capabilities (public) — lets login.html adapt the UI ──
authRouter.get("/auth/config", (_req, res) => {
  res.json({
    google: googleConfigured(),
    devLogin: config.auth.devLoginEnabled,
    twoFactor: twoFactorEnforced(),
  });
});

// ── Developer login (temporary, flag-gated) ──
// Issues a full session for a chosen identity, skipping Google + 2FA.
// Enabled only when DEV_LOGIN_ENABLED=true. Remove before production.
authRouter.post("/auth/dev", (req, res) => {
  if (!config.auth.devLoginEnabled) {
    return res.redirect("/login?error=dev_disabled");
  }
  const identity = (req.body.identity || config.auth.devIdentity || "").trim();
  if (!identity) return res.redirect("/login?error=dev_no_identity");

  // Use the allowlisted display name if this identity matches an agent.
  const agent = (config.auth.agents || []).find((a) => a.identity === identity);
  const { token, ttl } = issueSession({
    email: agent?.email || `${identity}@dev.local`,
    identity,
    name: agent?.name || `${identity} (dev login)`,
    level: "full",
  });
  console.warn(`⚠️  DEV LOGIN used for identity "${identity}" — disable DEV_LOGIN_ENABLED in production.`);
  res.setHeader("Set-Cookie", cookieHeader(cookieName, token, ttl));
  res.redirect("/agent.html");
});

// ── Start Google OAuth ──
authRouter.get("/auth/google", (req, res) => {
  if (!googleConfigured()) {
    return res.redirect("/login?error=google_not_configured");
  }
  const state = randomUUID();
  // Bind the state to a short signed cookie to defend against CSRF on callback.
  res.setHeader("Set-Cookie", cookieHeader(STATE_COOKIE, signToken({ state, typ: "oauth_state" }, 600), 600));
  res.redirect(authUrl(state));
});

// ── OAuth callback ──
authRouter.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const stateToken = verifyToken(readCookie(req, STATE_COOKIE));
    if (!code || !state || !stateToken || stateToken.typ !== "oauth_state" || stateToken.state !== state) {
      return res.redirect("/login?error=bad_state");
    }

    const { email, name } = await exchangeCodeForProfile(code);
    const agent = findAgentByEmail(email);
    if (!agent) return res.redirect("/login?error=not_authorized");

    const clearState = clearCookieHeader(STATE_COOKIE);

    // Second factor required → issue a short pending session and send the code.
    if (twoFactorEnforced()) {
      const { token, ttl } = issueSession({
        email,
        identity: agent.identity,
        name: name || agent.name,
        level: "pending-2fa",
      });
      const sent = await startVerification(agent);
      res.setHeader("Set-Cookie", [clearState, cookieHeader(cookieName, token, ttl)]);
      return res.redirect(sent ? "/2fa" : "/login?error=2fa_send_failed");
    }

    // No 2FA enforced → full session immediately.
    const { token, ttl } = issueSession({
      email,
      identity: agent.identity,
      name: name || agent.name,
      level: "full",
    });
    res.setHeader("Set-Cookie", [clearState, cookieHeader(cookieName, token, ttl)]);
    res.redirect("/agent.html");
  } catch (err) {
    console.error("OAuth callback failed:", err.message);
    res.redirect("/login?error=auth_failed");
  }
});

// ── Submit the second factor ──
authRouter.post("/2fa", async (req, res) => {
  const pending = verifyToken(readCookie(req, cookieName));
  if (!pending || pending.typ !== "session" || pending.level !== "pending-2fa") {
    return res.redirect("/login?error=session_expired");
  }
  const agent = findAgentByEmail(pending.email);
  if (!agent) return res.redirect("/login?error=not_authorized");

  const ok = await checkVerification(agent, req.body.code);
  if (!ok) return res.redirect("/2fa?error=invalid_code");

  const { token, ttl } = issueSession({
    email: pending.email,
    identity: agent.identity,
    name: pending.name,
    level: "full",
  });
  res.setHeader("Set-Cookie", cookieHeader(cookieName, token, ttl));
  res.redirect("/agent.html");
});

// ── Resend the second factor ──
authRouter.post("/2fa/resend", async (req, res) => {
  const pending = verifyToken(readCookie(req, cookieName));
  if (!pending || pending.level !== "pending-2fa") {
    return res.redirect("/login?error=session_expired");
  }
  const agent = findAgentByEmail(pending.email);
  if (agent) await startVerification(agent);
  res.redirect("/2fa?resent=1");
});

// ── Logout ──
authRouter.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", clearCookieHeader(cookieName));
  res.redirect("/login");
});

// ── Who am I (for the agent UI) ──
authRouter.get("/auth/me", (req, res) => {
  if (!config.auth.required) {
    return res.json({ identity: config.auth.devIdentity, name: "Dev", email: "dev@local", authDisabled: true });
  }
  const s = verifyToken(readCookie(req, cookieName));
  if (!s || s.typ !== "session" || s.level !== "full") {
    return res.status(401).json({ error: "not authenticated" });
  }
  res.json({ identity: s.identity, name: s.name, email: s.email });
});
