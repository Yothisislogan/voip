# Secure AI Architecture & HIPAA/PCI Migration Plan

**Status:** Proposed · **Date:** 2026-06-26 · **Owner:** WIT Connect
**Decision:** Build to a **HIPAA-aligned security baseline** (Section 2.1) —
strong PII protection modeled on HIPAA controls, without necessarily pursuing a
full formal HIPAA program. Move regulated workloads off Hetzner to a
HIPAA-eligible **AWS** account; upgrade transcription to **Deepgram** (accuracy +
redaction); keep **Claude** for coaching/recap, run it via **Amazon Bedrock**;
de-scope card data via **Twilio `<Pay>`**.

> ⚠️ **Not legal advice.** This is an engineering plan. Confirm regulatory
> applicability and every BAA/control with qualified compliance counsel before
> processing real customer data.

---

## 1. Context & requirements

- **Goal that started this:** better transcription *accuracy*, with **security
  and PII protection as the top priority**.
- **Lines of business:** **all types of insurance** (incl. health). The agency
  wants a **HIPAA-aligned security baseline** — "something close to HIPAA" — not
  necessarily a full certified HIPAA program.
- **Compliance reality:** even absent a formal HIPAA program, an insurance
  agency is already legally obligated to protect customer PII under the **GLBA
  Safeguards Rule** and most states' **NAIC Insurance Data Security Model Law**
  (written security program + breach notification). HIPAA may additionally and
  *mandatorily* bind the **health-insurance subset** of records — counsel scopes
  which records get the formal treatment. The controls in Section 2.1 satisfy all
  three regimes at once, so we build them regardless. **PCI** also applies
  (customers read card data aloud on calls).
- **Today:** Node/Twilio app on a **Hetzner** server; Claude (direct API) for
  coaching + recap; Twilio built-in real-time transcription; ERPNext planned.

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

## 2.1 PII protection baseline (the practical "close to HIPAA")

This is the concrete control set. It satisfies a HIPAA-aligned bar **and** the
GLBA Safeguards Rule / NAIC insurance data-security expectations at the same
time. Build these regardless of whether a formal HIPAA program is pursued.

| # | Control | What it means here |
|---|---|---|
| 1 | **Data minimization** | Don't capture what you don't need: Twilio `<Pay>` for cards (never recorded), pause transcription during sensitive segments, redact PII/PHI at the STT layer before text is stored or sent to the LLM. |
| 2 | **Encryption everywhere** | TLS 1.2+ in transit; AES-256 at rest via AWS KMS (RDS, S3, EBS); ERPNext DB on encrypted RDS. |
| 3 | **Least-privilege access + MFA** | IAM least-privilege; **SSO + MFA** for agents/admins; role-based record access in ERPNext; no shared logins. ✅ **Implemented** for the app: Google OAuth + Twilio Verify 2FA, an agent allowlist, and signed httpOnly session cookies now gate the agent page, the Twilio token endpoint, and the WebSocket — identity comes from the session, not a URL param (see README → Authentication). Still to do at the cloud layer: IAM least-privilege + ERPNext role-based access. |
| 4 | **Audit logging** | CloudTrail (infra) + ERPNext access logs: who accessed which customer record, when. Retain logs per policy. |
| 5 | **Retention minimization** | Transcripts are in-memory only and dropped after recap (already true); set a recording-retention policy (PCI recordings default to 1 year); Claude via Bedrock keeps data in-account / Anthropic direct = 30-day. |
| 6 | **Network isolation** | Private subnets, security groups, VPC endpoints/PrivateLink for Bedrock/S3; public ingress only for Twilio webhooks/Media Streams, behind WAF + TLS. |
| 7 | **Secrets management** | AWS Secrets Manager; no secrets in the repo or plaintext env on disk. (`.env` is gitignored — keep it that way.) |
| 8 | **Vendor due diligence** | Sign the **free** BAAs with Twilio, Deepgram, Anthropic, and AWS — no cost, large risk reduction, and they double as GLBA/NAIC vendor-oversight evidence. |
| 9 | **Backups** | Encrypted, access-controlled, tested restores (RDS automated backups + KMS). |
| 10 | **Incident response + breach notification** | A written IR plan and breach-notification process — required by GLBA and state insurance law for **all** insurers, HIPAA or not. |
| 11 | **Consent / disclosure** | Recording + transcription disclosure (done on inbound; **extend to outbound**), and honor state two-party-consent rules. |

> The only things a *formal* HIPAA program adds on top of this list are
> paperwork and process: a risk analysis, written policies, workforce training,
> and periodic audits. The technical controls are the same — so this baseline is
> the bulk of the work either way.

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
  ERPNext on EC2 + RDS for MariaDB (PII/PHI lives here, in-VPC, KMS-encrypted)
```

---

## 4. Component decisions & BAAs

| Concern | Choice | Compliance basis |
|---|---|---|
| **Telephony** | Twilio (Security or Enterprise Edition) | [Twilio signs a BAA](https://www.twilio.com/en-us/hipaa); [PCI DSS Level 1](https://www.twilio.com/en-us/pci-compliance) |
| **Card capture** | Twilio [`<Pay>` in PCI mode](https://www.twilio.com/docs/voice/pci-workflows) | Card data captured compliantly + **redacted from recordings/logs**; pause recording+transcription during the payment segment |
| **Transcription (STT)** | **Deepgram** — self-hosted on AWS or managed + BAA | [Deepgram signs a BAA, supports self-host, and offers PII/PHI redaction](https://www.accountablehq.com/post/is-deepgram-hipaa-compliant-baas-phi-and-security-explained) (`redact=pii`/`redact=phi`, [redaction docs](https://developers.deepgram.com/docs/redaction)) |
| **LLM (coaching/recap)** | **Claude via Amazon Bedrock** (or direct Anthropic API with BAA) | [Anthropic signs a BAA for the Claude API](https://privacy.claude.com/en/articles/8114513-business-associate-agreements-baa-for-commercial-customers); Bedrock runs in-account under AWS BAA |
| **CRM** | ERPNext on EC2 + RDS for MariaDB | HIPAA-eligible AWS services under AWS BAA; KMS encryption |
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
| **Recap (PII/PHI)** | ERPNext (RDS), in-VPC | KMS at rest, IAM, CloudTrail; BAA-covered |
| **LLM prompts/outputs** | Bedrock in-account (or Anthropic, 30-day) | In-region, IAM/VPC; BAA-covered |

---

## 6. AWS service mapping (all HIPAA-eligible)

- **Compute:** ECS Fargate or EC2 (Node app); EKS/EC2 for self-hosted Deepgram.
- **LLM:** Amazon Bedrock (Anthropic Claude), same region.
- **Data:** RDS for MariaDB (ERPNext), S3 (if recordings retained — KMS + lifecycle).
- **Network:** private subnets, security groups, PrivateLink/VPC endpoints for
  Bedrock/S3; public ingress only for Twilio webhooks/Media Streams (WAF + TLS).
- **Crypto/keys:** KMS (CMKs) for RDS/S3/EBS.
- **Identity/audit:** IAM least-privilege, CloudTrail, GuardDuty, AWS Config.
- **Secrets:** AWS Secrets Manager (Twilio/Deepgram/ERPNext credentials).

---

## 7. Migration sequence

1. **Counsel confirms HIPAA scope** (parallel; don't block). Mixed lines may mean
   partial scope.
2. **AWS account + BAAs**: enable AWS BAA (AWS Artifact), sign BAAs with Twilio
   (Security/Enterprise Edition), Deepgram, Anthropic. Enable Bedrock + Claude
   model access in-region.
3. **Stand up VPC + baseline** (KMS, CloudTrail, IAM, Secrets Manager).
4. **Move ERPNext** to EC2/RDS (coordinated with the CRM chat — see
   `docs/erpnext-integration-contract.md`).
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
2. ✅ **Claude via Bedrock — switchable by config (DONE).**
   - `LLM_BACKEND=bedrock|anthropic`; when `bedrock`, constructs
     `AnthropicBedrockMantle({ awsRegion })` and auto-prefixes model IDs with
     `anthropic.`; otherwise the direct client. Coaching/recap code unchanged.
   - Files: `src/ai/client.js`, `src/config.js`, `.env.example`.
   - Remaining: provision Bedrock model access + AWS creds/IAM in the account.
3. **PCI de-scope hook.**
   - Wrap payment capture in Twilio `<Pay>`; **pause** Media Streams/transcription
     for that segment so card data never enters the AI pipeline.
   - Files: `src/routes/voice.js` (+ a `/voice/pay-*` flow).

The transcript buffer, coaching, recap, screen-pop, WebSocket push, and agent UI
**do not change** — only the audio source, the LLM transport, and payment
handling.

---

## 9. Open items to confirm with counsel / vendors

- [ ] Scope the **formal HIPAA** treatment to the health-insurance subset of
      records (counsel) — the baseline controls in Section 2.1 are built for all
      records regardless.
- [ ] Confirm GLBA Safeguards Rule + applicable state NAIC data-security
      obligations (written security program, IR plan, vendor oversight).
- [x] Replace the softphone `identity` query param with authenticated SSO + MFA
      (Control #3) — done: Google OAuth + Twilio Verify 2FA + session cookies.
- [ ] Provision the Google OAuth client, Twilio Verify service, `SESSION_SECRET`,
      and `AGENT_DIRECTORY` for each environment.
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
