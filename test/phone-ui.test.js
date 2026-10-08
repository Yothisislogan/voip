import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

async function workspace(t, role = 'agent') {
  const html = await readFile(new URL('../public/phone.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://phone.test/phone.html', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const calls = [], errors = [];
  let record = { twilio_call_sid: 'tn_test', agent_identity: 'alice', assigned_to: 'alice', tags: ['Commercial Auto'],
    organization_version: 0, direction: 'inbound', status: 'completed', ended_at: new Date().toISOString(), customer_number: '+12025550100', created_at: new Date().toISOString() };
  let conflict = false;
  const w = dom.window;
  w.addEventListener('error', event => errors.push(event.message));
  w.WebSocket = class { close() {} };
  w.fetch = async (path, options = {}) => {
    calls.push({ path: String(path), options });
    let data = {}, status = 200;
    if (path === '/api/phone/config') data = { identity: 'alice', role, provider: 'telnyx', calling: false, dispositions: ['follow_up'], agents: [{ identity: 'alice', name: 'Alice' }, { identity: 'bob', name: 'Bob' }] };
    else if (String(path).startsWith('/api/phone/calls?')) data = { calls: [record] };
    else if (path === '/api/phone/calls/tn_test/organization') {
      if (conflict) { status = 409; data = { error: 'Another user changed this call. Reload it before saving.' }; }
      else { const body = JSON.parse(options.body); record = { ...record, assigned_to: body.assignedTo, tags: body.tags, organization_version: record.organization_version + 1 }; data = { call: record }; }
    } else if (path === '/api/phone/calls/tn_test') data = { call: record, recordings: [], segments: [] };
    return { ok: status === 200, status, json: async () => data };
  };
  w.eval(await readFile(new URL('../public/phone.js', import.meta.url), 'utf8'));
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
  await settle();
  w.document.querySelector('.call-row').click(); await settle();
  return { w, calls, errors, settle, conflict: value => { conflict = value; }, get record() { return record; } };
}
test('phone UI saves owner and multiple tags, removes tags, filters and handles conflicting edits', async t => {
  const ui = await workspace(t); const { w, settle } = ui; const $ = id => w.document.getElementById(id);
  $('callOwner').value = 'bob'; $('callOwner').dispatchEvent(new w.Event('change'));
  $('tagInput').value = 'Follow-up'; $('addTag').click();
  assert.equal($('callTags').children.length, 2);
  $('organizationForm').dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  assert.equal(ui.record.assigned_to, 'bob'); assert.deepEqual(ui.record.tags, ['Commercial Auto','Follow-up']);
  assert.equal(ui.record.agent_identity, 'alice'); assert.equal($('organizationStatus').textContent, 'Saved.');
  $('callTags').querySelector('[aria-label="Remove tag Commercial Auto"]').click();
  $('organizationForm').dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  assert.deepEqual(ui.record.tags, ['Follow-up']);
  $('ownerFilter').value = 'bob'; $('tagFilter').value = 'Follow-up'; $('refresh').click(); await settle();
  const query = ui.calls.filter(c => c.path.startsWith('/api/phone/calls?')).at(-1).path;
  assert.match(query, /owner=bob/); assert.match(query, /tag=Follow-up/);
  ui.conflict(true); $('tagInput').value = 'Review'; $('addTag').click();
  $('organizationForm').dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  assert.match($('organizationStatus').textContent, /Another user/);
  $('reloadOrganization').click(); await settle();
  assert.equal($('callTags').children.length, 1); assert.deepEqual(ui.errors, []);
});
test('viewer cannot edit call owner or tags in the phone UI', async t => {
  const { w, errors } = await workspace(t, 'viewer');
  for (const id of ['callOwner','tagInput','addTag','saveOrganization']) assert.equal(w.document.getElementById(id).disabled, true);
  assert.equal(w.document.querySelector('#callTags button').disabled, true); assert.deepEqual(errors, []);
});
