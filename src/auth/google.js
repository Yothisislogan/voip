import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";

/**
 * Google OAuth (OpenID Connect) — authorization-code flow. We only use it to
 * obtain a *verified* email, which is then checked against the agent allowlist.
 */

const g = config.auth.google;

export function googleConfigured() {
  return Boolean(g.clientId && g.clientSecret);
}

const client = googleConfigured()
  ? new OAuth2Client(g.clientId, g.clientSecret, g.redirectUri)
  : null;

/** Build the Google consent URL. `state` is the CSRF token we'll verify on callback. */
export function authUrl(state) {
  return client.generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
    ...(g.hostedDomain ? { hd: g.hostedDomain } : {}),
  });
}

/**
 * Exchange the auth code for a verified identity.
 * Returns { email, name } or throws if the token is invalid / email unverified /
 * outside the allowed hosted domain.
 */
export async function exchangeCodeForProfile(code) {
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error("no id_token returned by Google");

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: g.clientId,
  });
  const p = ticket.getPayload();

  if (!p?.email || p.email_verified !== true) {
    throw new Error("Google account email is not verified");
  }
  if (g.hostedDomain && p.hd !== g.hostedDomain) {
    throw new Error(`email is not in the allowed domain ${g.hostedDomain}`);
  }
  return { email: p.email, name: p.name || "" };
}
