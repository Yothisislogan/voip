# ERPNext Integration Contract & Insurance Customization Handoff

This document is the bridge between the **Node telephony/AI integration** (built,
in `src/`) and the **ERPNext build-out** (done in a separate chat — the fork
already has a `custom_apps/wit_insurance` app). Build ERPNext *to this contract*
so the integration keeps working, then extend it for insurance.

CRM = **ERPNext v16 on the Frappe framework** (Python / MariaDB). The Node app
talks to it over the **Frappe REST API**. Code of record: `src/crm/erpnext.js`.

---

## 1. What the Node app already expects from ERPNext

### Auth
- **Token auth:** header `Authorization: token <api_key>:<api_secret>`.
- Create in ERPNext: **User → (integration user) → Settings → API Access →
  Generate Keys**. Use a dedicated user with access to Contact, Lead,
  Communication, and Call Log.
- Env the app reads (see `.env.example`): `ERPNEXT_BASE_URL`, `ERPNEXT_API_KEY`,
  `ERPNEXT_API_SECRET`, `ERPNEXT_UI_URL`.

### Reads — screen-pop (`findContactByPhone`)
- `GET /api/resource/Contact?or_filters=[["mobile_no","like","%<digits>%"],["phone","like","%<digits>%"]]`
  then, if no hit, `GET /api/resource/Lead` (also matches `whatsapp_no`).
- Matches by **last 7 digits, then last 10, then full** digit string, so stored
  format doesn't matter — **but the number must be present in Contact/Lead
  `mobile_no` or `phone`** (Lead also `whatsapp_no`).
- Renders: `first_name`, `last_name` (or Lead `lead_name`), `company_name`,
  `designation`, `email_id`, phone, and a desk deep link
  `{UI}/app/{contact|lead}/{name}`.

**Customization requirement:** keep customer phone numbers synced to the
Contact/Lead `mobile_no`/`phone` fields. (Frappe stores phones in a child table
`Contact Phone`; ensure the primary syncs to `mobile_no`/`phone`, which is the
default behavior. If you move numbers to a custom field, update the lookup field
list in `findContactByPhone`.)

### Writes — end-of-call recap
- **Communication** (`POST /api/resource/Communication`) — the recap text on the
  record's timeline: `communication_type="Communication"`,
  `communication_medium="Phone"`, `sent_or_received="Received"`, `subject`,
  `content`, `reference_doctype` + `reference_name` = the matched Contact/Lead.
- **Call Log** (`POST /api/resource/Call Log`) — best-effort telephony record:
  `id` = Twilio CallSid, `from`, `to`, `duration`, `type` (Incoming/Outgoing),
  `status="Completed"`, linked via the `links` child table
  (`[{link_doctype, link_name}]`).
- The structured recap the LLM produces (see `src/ai/recap.js`): `summary`,
  `outcome`, `productsDiscussed[]`, `objections[]`, `nextSteps[]`,
  `followUpDate`, `customerSentiment`.

---

## 2. Insurance customization to build (the actual ask)

The fork already contains `custom_apps/wit_insurance`. Likely scope — confirm
with the business:

### Custom DocType vs custom fields
- A dedicated **"Insurance Policy"** DocType (child/linked to Customer or
  Contact) is cleaner than fields on Contact for customers with multiple
  policies. Fields:
  - `policy_type` (Select: Auto, Home, Life, Health, Umbrella, Commercial, …)
  - `carrier` (Link/Select to carriers represented)
  - `premium` (Currency)
  - `policy_number` (Data)
  - `effective_date` / `renewal_date` (Date) — drives renewal pipelines
  - `coverage_status` (Select: Quoted, Active, Lapsed, Cancelled)
- Or **Custom Fields** on Contact/Customer for a single-policy model.

### Pipeline / stages
- Use **Lead → Opportunity → Customer** with insurance-tuned statuses, or a
  custom workflow. Decide whether sales calls create/advance Leads or
  Opportunities (the screen-pop already resolves Leads).

### Select options
- Define option lists for policy type, carrier, status; **keep the values
  stable** — the integration may map recap fields to them.

---

## 3. The coupling that matters: recap → insurance fields

High-value forward hook. Today the recap writes a Communication. Once insurance
fields exist, the recap can **populate them directly**:

1. Decide which fields the LLM should fill from a call (e.g. `policy_type`,
   `premium` discussed, `renewal_date` mentioned).
2. Extend the recap JSON schema in `src/ai/recap.js` to extract those fields.
3. Add an update call in `src/crm/erpnext.js` —
   `PUT /api/resource/<DocType>/<name>` with the field values — to write them
   onto the Contact/Customer/Policy.

**Action for the CRM chat:** once custom field **fieldnames** are finalized in
Frappe (snake_case, e.g. `policy_type`; conventionally `custom_` prefixed when
added via Customize Form), record them here so the integration chat can wire
them up:

| Purpose | DocType | Frappe fieldname | Type / options |
| --- | --- | --- | --- |
| Policy type | (Contact / Insurance Policy) | `custom_policy_type` | Select `Auto,Home,…` |
| Premium | | `custom_premium` | Currency |
| Renewal date | | `custom_renewal_date` | Date |
| … | | | |

---

## 4. Suggested split of work

- **CRM chat (new):** deploy/confirm ERPNext, create the API integration user +
  keys, build the insurance DocType/fields/pipeline in `wit_insurance`, fill in
  the fieldname table above.
- **Integration chat (here / follow-up):** once fieldnames exist, extend the
  recap schema + add the `erpnext.js` updater to populate them; adjust the phone
  lookup if numbers move off `mobile_no`/`phone`.

Hand the CRM chat **this file** plus `src/crm/erpnext.js` and `src/ai/recap.js`
as the source of truth for the interface.
