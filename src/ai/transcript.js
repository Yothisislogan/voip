/**
 * In-memory transcript buffer, keyed by Twilio CallSid.
 *
 * Twilio real-time transcription POSTs utterances to /voice/transcription as
 * they finalize; we accumulate them here so the coaching pass has rolling
 * context and the end-of-call recap has the full conversation. Buffers are
 * dropped when the call completes (after the recap runs).
 *
 * This is process-local: it assumes a single server instance. For a
 * horizontally-scaled deployment, back this with Redis keyed the same way.
 */

const MAX_UTTERANCES = 400; // safety cap so a marathon call can't grow unbounded

export class TranscriptStore {
  constructor() {
    /** @type {Map<string, {speaker: string, text: string, at: number}[]>} */
    this.byCall = new Map();
  }

  /**
   * Append a finalized utterance. `speaker` is "agent" or "customer".
   * Blank/whitespace text is ignored. `at` is an injectable timestamp (ms)
   * so the logic stays deterministic under test.
   */
  append(callSid, speaker, text, at = 0) {
    if (!callSid) return;
    const clean = (text || "").trim();
    if (!clean) return;

    let utterances = this.byCall.get(callSid);
    if (!utterances) {
      utterances = [];
      this.byCall.set(callSid, utterances);
    }
    utterances.push({ speaker, text: clean, at });
    if (utterances.length > MAX_UTTERANCES) utterances.shift();
  }

  /** Raw utterance array for a call (empty if none). */
  get(callSid) {
    return this.byCall.get(callSid) || [];
  }

  /** True if we have any transcript for this call. */
  has(callSid) {
    return (this.byCall.get(callSid)?.length || 0) > 0;
  }

  /**
   * Render the whole conversation as labelled lines, e.g.
   *   Agent: hi there
   *   Customer: i'm calling about my policy
   */
  format(callSid) {
    return this.get(callSid)
      .map((u) => `${label(u.speaker)}: ${u.text}`)
      .join("\n");
  }

  /** Render only the last N utterances — the rolling window for coaching. */
  formatRecent(callSid, n = 12) {
    const all = this.get(callSid);
    return all
      .slice(-n)
      .map((u) => `${label(u.speaker)}: ${u.text}`)
      .join("\n");
  }

  /** Drop a call's transcript (call completed / recap done). */
  clear(callSid) {
    this.byCall.delete(callSid);
  }
}

function label(speaker) {
  return speaker === "agent" ? "Agent" : "Customer";
}

// Shared singleton for the running server.
export const transcripts = new TranscriptStore();
