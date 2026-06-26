// Configure ERPNext before importing the module under test.
process.env.ERPNEXT_BASE_URL = "https://erp.example.com";
process.env.ERPNEXT_API_KEY = "k";
process.env.ERPNEXT_API_SECRET = "s";

import { test } from "node:test";
import assert from "node:assert/strict";

const crm = await import("../src/crm/erpnext.js");

test("crm is enabled when base URL + key + secret are set", () => {
  assert.equal(crm.crmEnabled, true);
});

test("recordUrl builds an ERPNext desk deep link with a doctype slug", () => {
  assert.equal(crm.recordUrl("Contact", "CRM-CONTACT-0001"), "https://erp.example.com/app/contact/CRM-CONTACT-0001");
  assert.equal(crm.recordUrl("Lead", "CRM-LEAD-9"), "https://erp.example.com/app/lead/CRM-LEAD-9");
  // multi-word doctypes are hyphenated
  assert.equal(crm.recordUrl("Call Log", "abc"), "https://erp.example.com/app/call-log/abc");
});

test("shapeRecord normalizes a Contact row", () => {
  const c = crm.shapeRecord(
    {
      name: "CRM-CONTACT-0001",
      first_name: "Jane",
      last_name: "Doe",
      email_id: "jane@x.com",
      mobile_no: "(480) 555-0100",
      company_name: "Acme",
      designation: "Owner",
    },
    "Contact",
    "+14805550100"
  );
  assert.equal(c.doctype, "Contact");
  assert.equal(c.id, "CRM-CONTACT-0001");
  assert.equal(c.fullName, "Jane Doe");
  assert.equal(c.accountName, "Acme");
  assert.equal(c.title, "Owner");
  assert.equal(c.email, "jane@x.com");
  assert.equal(c.phone, "(480) 555-0100");
  assert.equal(c.matchedPhone, "+14805550100");
  assert.equal(c.url, "https://erp.example.com/app/contact/CRM-CONTACT-0001");
});

test("shapeRecord falls back to lead_name when first/last are absent", () => {
  const l = crm.shapeRecord({ name: "CRM-LEAD-9", lead_name: "Bob Roe", company_name: "Roe LLC" }, "Lead", "+14805550111");
  assert.equal(l.doctype, "Lead");
  assert.equal(l.fullName, "Bob Roe");
  assert.equal(l.accountName, "Roe LLC");
  assert.equal(l.url, "https://erp.example.com/app/lead/CRM-LEAD-9");
});
