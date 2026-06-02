import twilio from "twilio";
import { config } from "./config.js";

const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;

// REST client (used for outbound REST calls, number lookups, etc.)
export const client =
  config.twilio.accountSid && config.twilio.apiKeySid
    ? twilio(config.twilio.apiKeySid, config.twilio.apiKeySecret, {
        accountSid: config.twilio.accountSid,
      })
    : null;

/**
 * Mint a short-lived Voice access token for the browser SDK.
 * The identity is how Twilio addresses this client for inbound calls
 * (e.g. <Client>marisol.vega</Client>).
 */
export function generateVoiceToken(identity) {
  const token = new AccessToken(
    config.twilio.accountSid,
    config.twilio.apiKeySid,
    config.twilio.apiKeySecret,
    { identity, ttl: 3600 }
  );

  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: config.twilio.twimlAppSid, // -> /voice/outbound
      incomingAllow: true,
    })
  );

  return token.toJwt();
}
