import { config } from '../src/config.js';
import { validateEnv } from '../src/validate-env.js';
import { db } from '../src/db.js';
import { mfaTarget } from '../src/auth/agents.js';
import { AssemblyTrack } from '../src/realtime/assemblyai.js';
import { telnyxRequest } from '../src/providers/telnyx.js';
import { client } from '../src/twilio.js';

const required = ['ASSEMBLYAI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'PUBLIC_BASE_URL', 'DATABASE_URL',
  ...(config.voiceProvider === 'telnyx' ? ['TELNYX_API_KEY','TELNYX_PUBLIC_KEY','TELNYX_CONNECTION_ID','TELNYX_CALLER_ID','TELNYX_MEDIA_SECRET','TELNYX_PILOT_NUMBER_ID'] :
    ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_API_KEY_SID','TWILIO_API_KEY_SECRET','TWILIO_TWIML_APP_SID','TWILIO_CALLER_ID','TWILIO_PILOT_NUMBER_SID'])];
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++; };
const result = validateEnv({ exitOnFatal: false });
check('production configuration', process.env.NODE_ENV === 'production' && !result.fatal.length);
for (const key of required) check(`${key} configured`, Boolean(process.env[key]?.trim()));
check('AssemblyAI selected', config.transcription.provider === 'assemblyai');
check('long session secret', (config.auth.sessionSecret?.length || 0) >= 32);
check('pilot agent exists', config.auth.agents.some(a => a.identity === config.defaultAgentIdentity && a.role !== 'viewer'));
check('MFA configured', config.auth.twoFactor.enabled && !!config.auth.twoFactor.verifyServiceSid && !!config.twilio.accountSid && !!config.twilio.apiKeySid && !!config.twilio.apiKeySecret && config.auth.agents.every(a => mfaTarget(a)));
check('pilot has no automatic SMS surveys', !config.survey.enabled);

if (process.argv.includes('--providers') && !failures) {
  // Read-only Twilio checks. AssemblyAI opens two short, billable test sessions;
  // it sends silence only and does not place a phone call.
  if (config.voiceProvider === 'telnyx') {
    try {
      const app = await telnyxRequest(`/call_control_applications/${encodeURIComponent(config.telnyx.connectionId)}`);
      check('Telnyx Voice API webhook configured', app.webhook_event_url === `${config.publicBaseUrl}/telnyx/voice` && app.webhook_api_version === '2');
      const number = await telnyxRequest(`/phone_numbers/${encodeURIComponent(process.env.TELNYX_PILOT_NUMBER_ID)}`);
      check('Telnyx pilot number assigned to Voice API app', number.phone_number === config.telnyx.callerId && number.connection_id === config.telnyx.connectionId);
      for (const agent of config.auth.agents.filter(a => a.role !== 'viewer')) {
        const credential = await telnyxRequest(`/telephony_credentials/${encodeURIComponent(agent.telnyxCredentialId)}`);
        check(`Telnyx credential mapping for ${agent.identity}`, credential.sip_username === agent.telnyxSipUsername);
      }
    } catch { check('Telnyx read-only provider checks', false); }
  } else try {
    const number = await client.incomingPhoneNumbers(process.env.TWILIO_PILOT_NUMBER_SID).fetch();
    check('pilot number matches caller ID', number.phoneNumber === config.twilio.callerId);
    check('inbound webhook configured', number.voiceUrl === `${config.publicBaseUrl}/voice/inbound` && number.voiceMethod === 'POST' && !number.voiceApplicationSid && !number.trunkSid);
    check('root status webhook configured', number.statusCallback === `${config.publicBaseUrl}/voice/status` && number.statusCallbackMethod === 'POST');
    const app = await client.applications(config.twilio.twimlAppSid).fetch();
    check('outbound TwiML app configured', app.voiceUrl === `${config.publicBaseUrl}/voice/outbound` && app.voiceMethod === 'POST');
    check('outbound root status configured', app.statusCallback === `${config.publicBaseUrl}/voice/status` && app.statusCallbackMethod === 'POST');
  } catch { check('Twilio read-only provider checks', false); }
  const tracks = [0, 1].map(() => {
    let failed = false;
    const track = new AssemblyTrack({ ...config.transcription, onTurn: () => {}, onFailure: () => { failed = true; } });
    track.audio(Buffer.alloc(800, 0xff), 0);
    return { track, failed: () => failed };
  });
  await Promise.all(tracks.map(async ({ track, failed }) => {
    const deadline = Date.now() + 11_000;
    while (!track.ready && !track.closed && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    await track.finish();
    check('AssemblyAI authenticated streaming session', track.ready && !failed());
  }));
  try { const response = await fetch(`${config.publicBaseUrl}/ready`, { signal: AbortSignal.timeout(10_000) }); check('public HTTPS readiness', response.ok); }
  catch { check('public HTTPS readiness', false); }
}
await db.close();
console.log(failures ? `${failures} checks need attention. No phone call was placed.` : 'Checks passed. Real inbound/outbound calls still need to be tested.');
process.exitCode = failures ? 1 : 0;
