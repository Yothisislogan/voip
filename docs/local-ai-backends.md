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

| `LLM_BACKEND` | coaching backend | recap backend |
|---|---|---|
| `rules` (default) | rules | rules |
| `ollama` | ollama (rules fallback) | ollama (rules fallback) |
| `anthropic` | **rules** | anthropic (Claude) |
| `bedrock` | **rules** | bedrock (Claude) |

Override either side with `LLM_COACHING_BACKEND` / `LLM_RECAP_BACKEND`. Example —
tiny local model for live cues, Claude for the recap:

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
  -> provider: rules | ollama | anthropic | bedrock
  -> WebSocket /ws/agent
  -> agent screen coaching card
```

Keep live coaching fast. Use tiny local models for live cues and larger/slower models only for post-call recap.
