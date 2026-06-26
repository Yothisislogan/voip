# Secure AI Architecture & HIPAA/PCI Migration Plan

**Status:** Proposed · **Date:** 2026-06-26 · **Owner:** WIT Connect
**Decision:** Move regulated workloads off Hetzner to a HIPAA-eligible **AWS**
account; upgrade transcription to **Deepgram** (accuracy + redaction); keep
**Claude** for coaching/recap, run it via **Amazon Bedrock**; de-scope card
data via **Twilio `<Pay>`**.

> ⚠️ **Not legal advice.** This is an engineering plan. Confirm HIPAA
> applicability and every BAA/control with qualified compliance counsel before
> processing real PHI/PCI data.

---

## 1. Context & requirements

- **Goal that started this:** better transcription *accuracy*, with **security
  as the top priority**.
- **Compliance:** treat **HIPAA** as in-scope (lines of business are "mixed/not
  sure" — confirm with counsel; P&C generally isn't HIPAA-covered, health is)
  **and PCI** (customers read card data aloud on calls).
- **Today:** Node/Twilio app on a **Hetzner** server; Claude (direct API) for
  coaching + recap; Twilio built-in real-time transcription; SuiteCRM planned.

### The blocking conflict (why we're moving)

Hetzner does **not** offer a HIPAA Business Associate Agreement (BAA). Under
[HHS cloud guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html),
a hosting provider that merely *stores* PHI is itself a business associate and
**must** sign a BAA — even "no-view" providers. No BAA ⇒ non-compliant,
regardless of how well the box is hardened.

**Key correction to a common intuition:** self-hosting everything on Hetzner is
the *least* compliant option, not the most secure. Compliance for regulated data
comes from **BAAs + controls + scope reduction**, not from owning the server.

---

## 2. Guiding principles

1. **Don't have the data you don't need.** De-scope PCI by never capturing card
   data into recordings/transcripts. Redact PII/PHI before it reaches the LLM or
   CRM.
2. **Keep regulated data inside a BAA-covered boundary** (AWS account + signed
   BAAs with every vendor that touches it).
3. **Defense in depth:** encryption in transit + at rest (KMS), least-privilege
   IAM, audit logging (CloudTrail), minimal retention.
4. **Don't regress functionality:** the existing transcript-buffer → coaching →
   recap pipeline stays; we swap the *edges* (STT engine, LLM transport, payment
   capture).

---

## 3. Target architecture (AWS, HIPAA-eligible)

```
Twilio Voice (BAA + PCI DSS L1)
  • <Pay> in PCI mode for card capture — recording/transcription PAUSED during payment
  • Media Streams (raw audio over wss) for everything else
        │
        ▼  (your AWS VPC)
  Deepgram  ── self-hosted on EKS/EC2 (audio stays in-VPC)  OR  managed + BAA
        │     redact=pii, redact=phi, card numbers  → REDACTED transcript
        ▼
  Node app (ECS/EC2)  ── transcript buffer → coaching/recap (unchanged logic)
        │                         │
        │                         ▼
        │                   Claude via Amazon Bedrock (BAA, in-region, IAM/VPC)
        ▼
  SuiteCRM on EC2 + RDS for MySQL (PII/PHI lives here, in-VPC, KMS-encrypted)
```

---

## 4. Component decisions & BAAs

| Concern | Choice | Compliance basis |
|---|---|---|
| **Telephony** | Twilio (Security or Enterprise Edition) | [Twilio signs a BAA](https://www.twilio.com/en-us/hipaa); [PCI DSS Level 1](https://www.twilio.com/en-us/pci-compliance) |
| **Card capture** | Twilio [`<Pay>` in PCI mode](https://www.twilio.com/docs/voice/pci-workflows) | Card data captured compliantly + **redacted from recordings/logs**; pause recording+transcription during the payment segment |
| **Transcription (STT)** | **Deepgram** — self-hosted on AWS or managed + BAA | [Deepgram signs a BAA, supports self-host, and offers PII/PHI redaction](https://www.accountablehq.com/post/is-deepgram-hipaa-compliant-baas-phi-and-security-explained) (`redact=pii`/`redact=phi`, [redaction docs](https://developers.deepgram.com/docs/redaction)) |
| **LLM (coaching/recap)** | **Claude via Amazon Bedrock** (or direct Anthropic API with BAA) | [Anthropic signs a BAA for the Claude API](https://privacy.claude.com/en/articles/8114513-business-associate-agreements-baa-for-commercial-customers); Bedrock runs in-account under AWS BAA |
| **CRM** | SuiteCRM on EC2 + RDS for MySQL | HIPAA-eligible AWS services under AWS BAA; KMS encryption |
| **Hosting** | AWS account with signed BAA | Hetzner cannot sign a BAA → unsuitable for PHI |

### Retention nuance (important)

The Claude **HIPAA path uses 30-day retention, not Zero-Data-Retention** —
[Anthropic states you don't also need ZDR if you have HIPAA readiness](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention).
HIPAA readiness relies on safeguards (encryption, access control, audit logging)
rather than immediate deletion. Don't request ZDR *and* HIPAA — they conflict.

### Redaction caveat

Automated redaction reduces exposure but **does not by itself satisfy full HIPAA
de-identification** (all 18 identifiers). Treat redaction as a strong control,
not a compliance silver bullet; keep PHI inside the BAA boundary regardless.

---

## 5. Data flow & lifecycle

| Data | Where it lives | Controls |
|---|---|---|
| **Card numbers** | Nowhere in our systems | Captured by Twilio `<Pay>`; recording/transcription paused; redacted from Twilio logs |
| **Raw call audio** | Twilio → (in-VPC) Deepgram | TLS in transit; self-hosted Deepgram keeps audio in-VPC |
| **Transcripts** | Process memory only, dropped after recap (today); | Redacted at STT layer before LLM/CRM; not persisted by the app |
| **Recap (PII/PHI)** | SuiteCRM (RDS), in-VPC | KMS at rest, IAM, CloudTrail; BAA-covered |
| **LLM prompts/outputs** | Bedrock in-account (or Anthropic, 30-day) | In-region, IAM/VPC; BAA-covered |

---

## 6. AWS service mapping (all HIPAA-eligible)

- **Compute:** ECS Fargate or EC2 (Node app); EKS/EC2 for self-hosted Deepgram.
- **LLM:** Amazon Bedrock (Anthropic Claude), same region.
- **Data:** RDS for MySQL (SuiteCRM), S3 (if recordings retained — KMS + lifecycle).
- **Network:** private subnets, security groups, PrivateLink/VPC endpoints for
  Bedrock/S3; public ingress only for Twilio webhooks/Media Streams (WAF + TLS).
- **Crypto/keys:** KMS (CMKs) for RDS/S3/EBS.
- **Identity/audit:** IAM least-privilege, CloudTrail, GuardDuty, AWS Config.
- **Secrets:** AWS Secrets Manager (Twilio/Deepgram/SuiteCRM credentials).

---

## 7. Migration sequence

1. **Counsel confirms HIPAA scope** (parallel; don't block). Mixed lines may mean
   partial scope.
2. **AWS account + BAAs**: enable AWS BAA (AWS Artifact), sign BAAs with Twilio
   (Security/Enterprise Edition), Deepgram, Anthropic. Enable Bedrock + Claude
   model access in-region.
3. **Stand up VPC + baseline** (KMS, CloudTrail, IAM, Secrets Manager).
4. **Move SuiteCRM** to EC2/RDS (coordinated with the CRM chat — see
   `docs/suitecrm-integration-contract.md`).
5. **Deploy the Node app** to ECS/EC2; point `PUBLIC_BASE_URL` at the new domain.
6. **In-repo code changes (Section 8).**
7. **Cut over** Twilio webhooks; decommission Hetzner for any regulated component.

---

## 8. In-repo code changes (this repo)

These can begin once BAAs are in place (Deepgram-managed + Bedrock work before
the full migration finishes):

1. **STT swap — Twilio native → Deepgram via Media Streams.**
   - Replace `<Start><Transcription>` with `<Start><Stream url="wss://…/ws/media">`.
   - Add a Media Streams WebSocket endpoint that decodes Twilio's audio frames
     and forwards them to Deepgram streaming with `redact=pii&redact=phi`.
   - Feed Deepgram's finalized utterances into the **existing** `transcripts`
     buffer + `onUtterance` path (unchanged downstream).
   - Files: new `src/realtime/media.js` (audio bridge) + `src/stt/deepgram.js`;
     edit `src/routes/voice.js` (TwiML), retire `/voice/transcription`.
2. **Claude via Bedrock — switchable by config.**
   - Add `LLM_BACKEND=bedrock|anthropic`; when `bedrock`, construct
     `AnthropicBedrockMantle({ awsRegion })` and use `anthropic.claude-…`
     model IDs; otherwise the current direct client.
   - Files: `src/ai/client.js`, `src/config.js`, `.env.example`.
3. **PCI de-scope hook.**
   - Wrap payment capture in Twilio `<Pay>`; **pause** Media Streams/transcription
     for that segment so card data never enters the AI pipeline.
   - Files: `src/routes/voice.js` (+ a `/voice/pay-*` flow).

The transcript buffer, coaching, recap, screen-pop, WebSocket push, and agent UI
**do not change** — only the audio source, the LLM transport, and payment
handling.

---

## 9. Open items to confirm with counsel / vendors

- [ ] Does HIPAA actually apply given the mix of lines? (P&C vs health/life)
- [ ] Twilio edition that includes the BAA (Security vs Enterprise) + enable PCI mode.
- [ ] Deepgram: self-hosted vs managed-with-BAA decision (cost vs ops).
- [ ] Bedrock vs direct Anthropic API for the LLM (both BAA-capable).
- [ ] Recording retention policy (PCI recordings default to 1-year retention).
- [ ] State two-party-consent disclosures (already in the inbound greeting; extend to outbound).

---

## 10. Sources

- HHS — [Guidance on HIPAA & Cloud Computing](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html)
- Anthropic — [BAA for Commercial Customers](https://privacy.claude.com/en/articles/8114513-business-associate-agreements-baa-for-commercial-customers), [API & data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
- Deepgram — [HIPAA/BAA/self-host overview](https://www.accountablehq.com/post/is-deepgram-hipaa-compliant-baas-phi-and-security-explained), [Redaction docs](https://developers.deepgram.com/docs/redaction)
- Twilio — [HIPAA](https://www.twilio.com/en-us/hipaa), [PCI compliance](https://www.twilio.com/en-us/pci-compliance), [PCI voice workflows / `<Pay>`](https://www.twilio.com/docs/voice/pci-workflows)
