# Local AI Backends for WIT Connect

WIT Connect now supports pluggable AI backends for live coaching and call recap.

## Recommended default

For testing and production-safe fallback:

```env
LLM_BACKEND=rules
COACHING_ENABLED=true
RECAP_ENABLED=true
COACHING_THROTTLE_MS=6000
```

`rules` is deterministic and runs inside Node. It does not need an API key, GPU, model download, or external service.

## Coaching vs recap are separate backends

Claude is optional and **never powers live coaching by default**. Backends are
resolved per task:

- **Coaching (real-time):** local-first. Uses `rules`, or the tiny local model
  when `LLM_BACKEND=ollama`. It does **not** use Claude unless you explicitly set
  `LLM_COACHING_BACKEND`.
- **Recap (post-call):** follows `LLM_BACKEND`, so Claude/Bedrock can produce
  higher-quality recaps while live tips stay local and fast.

There are **three** per-task backends: coaching (real-time), recap (which also
drives CRM extraction), and automation (heavy, on-demand only).

| `LLM_BACKEND` | coaching | recap + extraction | automation |
|---|---|---|---|
| `rules` (default) | rules | rules | rules |
| `ollama` | ollama (rules fallback) | ollama (rules fallback) | rules |
| `groq` | **rules** | groq (rules fallback) | groq |
| `anthropic` | **rules** | anthropic (Claude) | rules |
| `bedrock` | **rules** | bedrock (Claude) | rules |

Override any side with `LLM_COACHING_BACKEND` / `LLM_RECAP_BACKEND` /
`LLM_AUTOMATION_BACKEND`. Example — tiny local model for live cues, Claude for the recap:

```env
LLM_COACHING_BACKEND=ollama
LLM_RECAP_BACKEND=anthropic
ANTHROPIC_API_KEY=your_key
```

## Local Ollama option

Install Ollama on the server or on a nearby private machine, then pull a tiny CPU-friendly model:

```bash
ollama pull qwen2.5:0.5b
```

Use:

```env
LLM_BACKEND=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:0.5b
OLLAMA_COACHING_MODEL=qwen2.5:0.5b
OLLAMA_RECAP_MODEL=qwen2.5:0.5b
LOCAL_LLM_TIMEOUT_MS=1200
OLLAMA_RECAP_TIMEOUT_MS=8000
OLLAMA_CONTEXT_TOKENS=2048
COACHING_THROTTLE_MS=6000
```

If Ollama is slow, unavailable, or returns invalid JSON, WIT Connect falls back to the local rules coach.

## Groq option (recommended cloud split)

Groq serves fast hosted Llama models over an OpenAI-compatible API. The intended
split keeps Twilio transcription and the local rules fallback, puts recap + CRM
extraction on 70B, keeps live coaching local, and reserves GPT-OSS 120B for
heavy on-demand automation only:

```env
LLM_BACKEND=groq
LLM_RECAP_BACKEND=groq          # recap + CRM extraction
LLM_COACHING_BACKEND=rules      # keep coaching local (or set groq for 8B)
LLM_AUTOMATION_BACKEND=groq     # on-demand automation only

GROQ_API_KEY=your_key
GROQ_RECAP_MODEL=llama-3.3-70b-versatile
GROQ_COACHING_MODEL=llama-3.1-8b-instant
GROQ_AUTOMATION_MODEL=openai/gpt-oss-120b
GROQ_TIMEOUT_MS=10000
```

**Per-task model routing** (by schema): `call_recap` and `lead_extraction` →
70B; `coaching_cues` → 8B; `automation_*` → 120B. Any failure (missing key,
HTTP error, timeout, non-JSON, wrong shape) falls back — recap/coaching to the
rules engine, extraction/automation to null so the deterministic extractor or a
skip takes over. **The live phone path never throws.**

### CRM extraction with confidence ("AI found these updates. Apply?")

After each call, Groq 70B also extracts structured lead fields with a per-field
confidence score. Deterministic regex extraction remains the guaranteed
baseline; AI fields **at or above** `AI_EXTRACT_AUTOAPPLY_CONFIDENCE` (default
0.85) are auto-applied, and the rest are surfaced on the recap card for the
agent to confirm. Example model output:

```json
{
  "summary": "...", "customer_need": "...",
  "policy_type": "Auto", "carrier": "Progressive", "premium": 214.00,
  "address": "...", "drivers": [], "vehicles": [], "objections": [],
  "next_action": "Send quote and follow up tomorrow",
  "confidence": { "policy_type": 0.94, "carrier": 0.81, "premium": 0.77 }
}
```

### On-demand automation (GPT-OSS 120B — never per-call)

Heavy reasoning runs only when an agent asks for it, via
`POST /ai/automate { callSid, kind }` (agent role + CSRF). It rebuilds the
transcript from the persistent store, so it works after the call ended. Kinds:
`followup_plan`, `task_creation`, `email_draft`, `sms_draft`, `coverage_gap`,
`manager_summary`. Returns `409` if the automation backend is local rules.

## Claude options

Claude remains optional:

```env
LLM_BACKEND=anthropic
ANTHROPIC_API_KEY=your_key
ANTHROPIC_MODEL=claude-opus-4-8
```

or through Bedrock:

```env
LLM_BACKEND=bedrock
AWS_REGION=us-east-1
ANTHROPIC_MODEL=claude-opus-4-8
```

## Smoke test without a call

When signed in, or when `AUTH_REQUIRED=false` is set for development, test coaching with:

```bash
curl -X POST https://YOUR_RENDER_URL/ai/test-coaching \
  -H "Content-Type: application/json" \
  -d '{"transcript":"Agent: What are you paying now?\nCustomer: This quote is too expensive.\nAgent: I understand."}'
```

Expected response:

```json
{
  "ok": true,
  "coaching": {
    "cues": [
      {
        "lens": "objection",
        "priority": "high",
        "text": "Ask what part feels high: down payment, monthly price, or coverage."
      }
    ],
    "customerSentiment": "negative"
  },
  "recap": null
}
```

## Architecture

Live call transcript path:

```text
Twilio real-time transcription
  -> POST /voice/transcription
  -> realtime/orchestrator.js
  -> ai/coach.js
  -> ai/client.js
  -> provider: rules | ollama | groq | anthropic | bedrock
  -> WebSocket /ws/agent
  -> agent screen coaching card
```

Keep live coaching fast. Use tiny local models for live cues and larger/slower models only for post-call recap.
