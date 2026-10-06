// Keep stdout valid JSON even though existing modules log during import.
console.log = (...args) => console.error(...args);
const { db } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const sid = process.argv[2];
if (!db.enabled || !/^CA[a-fA-F0-9]{32}$/.test(sid || '')) {
  console.error('Usage: npm run pilot:verify-call -- CA... (requires DATABASE_URL)'); process.exitCode = 1;
} else {
  try {
    const call = (await db.query('SELECT * FROM calls WHERE twilio_call_sid=$1', [sid])).rows[0];
    if (!call) throw new Error('Call missing');
    const speakers = (await db.query('SELECT DISTINCT speaker FROM transcript_segments WHERE call_sid=$1', [sid])).rows.map(r => r.speaker);
    const recording = (await db.query("SELECT 1 FROM call_recordings WHERE call_sid=$1 AND status='completed' LIMIT 1", [sid])).rows.length > 0;
    const checks = {
      callCompleted: call.status === 'completed' && !!call.ended_at,
      assemblyaiStreamStoppedCleanly: call.transcription_provider === 'assemblyai' && call.transcription_state === 'stopped',
      agentSpeechSaved: speakers.includes('agent'), customerSpeechSaved: speakers.includes('customer'),
      recordingSaved: !config.voice.recordingEnabled || recording,
      recapReady: !config.recapEnabled || call.recap_state === 'ready',
    };
    const passed = Object.values(checks).every(Boolean);
    process.stdout.write(JSON.stringify({ callSid: sid, direction: call.direction, checkedAt: new Date().toISOString(), checks, passed,
      manualChecksStillRequired: ['two-way audio quality', 'words visible during call', 'speaker labels correct', 'last words preserved', 'recording playback'] }, null, 2) + '\n');
    process.exitCode = passed ? 0 : 1;
  } catch { console.error('Could not verify the selected call. Check the database and call SID.'); process.exitCode = 1; }
}
await db.close();
