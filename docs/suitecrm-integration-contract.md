# SuiteCRM Integration Contract & Insurance Customization Handoff

This document is the bridge between the **Node telephony/AI integration** (already
built, in `src/`) and the **SuiteCRM build-out** (to be done in a separate chat,
focused on insurance customization). Build SuiteCRM *to this contract* so the
integration keeps working, then extend it for insurance.

---

## 1. What the Node app already expects from SuiteCRM

The integration talks to SuiteCRM **7.10+ V8 JSON:API** (`/Api/V8`) over OAuth2.
Code of record: `src/crm/suitecrm.js`.

### Auth
- **OAuth2 password grant** against `POST {BASE}/Api/access_token`.
- Set up in SuiteCRM: **Admin → OAuth2 Clients and Tokens → New Password Client**.
  Use a dedicated service user (e.g. `wit-connect-bot`) with rights to read
  Contacts and create Notes/Calls.
- Env the app reads (see `.env.example`): `SUITECRM_BASE_URL`,
  `SUITECRM_CLIENT_ID`, `SUITECRM_CLIENT_SECRET`, `SUITECRM_USERNAME`,
  `SUITECRM_PASSWORD`, `SUITECRM_UI_URL`.
- Falls back to `client_credentials` grant if username/password are omitted.

### Reads — screen-pop (`findContactByPhone`)
- Queries `GET /Api/V8/module/Contacts` filtering on
  `phone_work`, `phone_mobile`, `phone_home` (CONTAINS, OR).
- Matches by the **last 7 digits, then last 10, then full** digit string, so
  stored format (`(480) 555-0100` vs `+14805550100`) doesn't matter — but the
  number must be in one of those three phone fields.
- Renders: `first_name`, `last_name`, `account_name`, `title`, `email1`, phone,
  and a deep link `{UI}/index.php?module=Contacts&action=DetailView&record={id}`.

**Customization requirement:** keep customer phone numbers in the standard
`phone_*` Contact fields (or tell the next chat to update the lookup field list
in `findContactByPhone` if you move them to a custom field).

### Writes — end-of-call recap (`writeRecapNote`, `logCallActivity`)
- Creates a **Note** (`POST /Api/V8/module`, type `Notes`): `name` (subject),
  `description` (body), linked via `parent_type=Contacts` + `parent_id` +
  `contact_id`.
- Also creates a **Call** activity (type `Calls`): `name`, `description`,
  `status=Held`, `direction`, `duration_minutes/seconds`, same parent link.
- The structured recap the LLM produces (see `src/ai/recap.js`):
  `summary`, `outcome`, `productsDiscussed[]`, `objections[]`, `nextSteps[]`,
  `followUpDate`, `customerSentiment`.

---

## 2. Insurance customization to build (the actual ask)

Do this in SuiteCRM **Studio** (custom fields/layouts) and/or **Module Builder**
(custom modules). Suggested scope — confirm with the business:

### Contact / custom "Policy" fields
Likely custom fields (on Contacts, or a new **Policies** module related to
Contacts — a related module is cleaner for multi-policy customers):
- `policy_type` (dropdown: Auto, Home, Life, Umbrella, Commercial, Bundle…)
- `carrier` (dropdown of carriers you represent)
- `premium` (currency)
- `policy_number` (text)
- `effective_date` / `renewal_date` (date) — drives renewal pipelines
- `coverage_status` (dropdown: Quoted, Active, Lapsed, Cancelled)

### Pipeline / stages
- Lead/Opportunity stages tuned for insurance sales (New → Quoted → Follow-up →
  Bound → Renewal). Decide Leads vs Opportunities vs a custom sales module.

### Dropdowns
- Define dropdown lists (Studio → Dropdown Editor) for policy type, carrier,
  status — keep the **values stable**, the integration may map to them.

---

## 3. The coupling that matters: recap → insurance fields

This is the high-value forward hook. Today the recap writes a free-text Note.
Once insurance custom fields exist, the recap can **populate them directly**:

1. Decide which custom fields the LLM should fill from a call (e.g.
   `policy_type`, `premium` discussed, `renewal_date` mentioned).
2. Extend the recap JSON schema in `src/ai/recap.js` to extract those fields.
3. Extend `writeRecapNote` / add a `updateContactFields` call in
   `src/crm/suitecrm.js` to PATCH those fields onto the Contact/Policy.

**Action for the CRM chat:** once custom field **API names** are finalized
(Studio appends `_c`, e.g. `policy_type_c`), record them here so the integration
chat can wire them up. Leave a table:

| Purpose | SuiteCRM module | API field name | Type / dropdown |
| --- | --- | --- | --- |
| Policy type | (Contacts / Policies) | `policy_type_c` | dropdown `policy_type_list` |
| Premium | | `premium_c` | currency |
| Renewal date | | `renewal_date_c` | date |
| … | | | |

---

## 4. Suggested split of work

- **CRM chat (new):** deploy/confirm SuiteCRM, enable V8 API, create the OAuth2
  password client + service user, build the insurance fields/module/pipeline,
  fill in the field-name table above.
- **Integration chat (here / follow-up):** once field names exist, extend the
  recap schema + `suitecrm.js` writer to populate them, and adjust the phone
  lookup if phone fields moved.

Hand the CRM chat **this file** plus `src/crm/suitecrm.js` and `src/ai/recap.js`
as the source of truth for the interface.
