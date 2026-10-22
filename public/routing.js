'use strict';
(() => {
  const $ = id => document.getElementById(id); let version = 0, caller = null, saving = false;
  const option = (text, value) => { const o = document.createElement('option'); o.textContent = text; o.value = value; return o; };
  async function api(path, body) {
    const csrf = decodeURIComponent(document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('wit_csrf='))?.split('=')[1] || '');
    const res = await fetch(`/api/tag-routing${path}`, { credentials:'same-origin', method:body ? 'PUT' : 'GET', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, ...(body ? { body:JSON.stringify(body) } : {}) });
    if (res.status === 401) location.href = '/login';
    const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`); return data;
  }
  function edit(rule) {
    version = rule?.version || 0; $('ruleTag').value = rule?.label || ''; $('ruleTag').readOnly = !!rule;
    $('preferredAgent').value = rule?.preferred_agent || $('preferredAgent').options[0]?.value || '';
    $('rulePriority').value = rule?.priority ?? 100; $('ringSeconds').value = rule?.ring_seconds ?? 15; $('ruleEnabled').checked = rule?.enabled ?? true;
    $('ruleStatus').textContent = rule ? 'Editing this rule. Disable it to stop using it.' : 'Creating a new rule.';
  }
  async function load() {
    const data = await api('');
    $('routingStatus').textContent = data.enabled ? 'Tag routing is enabled.' : 'Tag routing is disabled. You can prepare rules now; they take effect when TAG_ROUTING_ENABLED is enabled on the server.';
    const selected = $('preferredAgent').value;
    $('preferredAgent').replaceChildren(...data.agents.map(a => option(a.name || a.identity,a.identity)));
    if (selected) $('preferredAgent').value = selected;
    $('rules').replaceChildren(...data.rules.map(r => {
      const row = document.createElement('div'); row.className = 'routing-rule'; const label = document.createElement('span');
      label.textContent = `${r.label} → ${data.agents.find(a => a.identity === r.preferred_agent)?.name || r.preferred_agent} · priority ${r.priority} · ${r.ring_seconds}s · ${r.enabled ? 'enabled' : 'disabled'}`;
      const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Edit'; b.onclick = () => edit(r); row.append(label,b); return row;
    }));
  }
  $('newRule').onclick = () => edit(null);
  $('ruleForm').onsubmit = async e => {
    e.preventDefault(); if (saving) return; saving = true;
    try { await api('/rule', { tag:$('ruleTag').value, preferredAgent:$('preferredAgent').value, priority:Number($('rulePriority').value), ringSeconds:Number($('ringSeconds').value), enabled:$('ruleEnabled').checked, version });
      await load(); edit(null); $('ruleStatus').textContent = 'Rule saved.';
    } catch (e) { $('ruleStatus').textContent = `${e.message} Reload the page before retrying a conflict.`; } finally { saving = false; }
  };
  $('lookupForm').onsubmit = async e => {
    e.preventDefault(); caller = null; $('callerForm').hidden = true;
    try { const result = await api(`/caller?phone=${encodeURIComponent($('callerPhone').value)}`); caller = result.caller;
      $('callerPhone').value = caller.phone; $('callerTags').value = caller.tags.join(', '); $('callerForm').hidden = false; $('callerStatus').textContent = 'Caller loaded.';
    } catch(e) { $('routingStatus').textContent = e.message; }
  };
  $('callerPhone').oninput = () => { caller = null; $('callerForm').hidden = true; };
  $('callerForm').onsubmit = async e => {
    e.preventDefault(); if (!caller || saving) return; saving = true;
    try { const result = await api('/caller', { phone:caller.phone, tags:$('callerTags').value.split(',').map(t => t.trim()).filter(Boolean), version:caller.version }); caller = result.caller; $('callerStatus').textContent = 'Routing tags saved for future calls.'; }
    catch(e) { $('callerStatus').textContent = `${e.message} Load the caller again before retrying a conflict.`; } finally { saving = false; }
  };
  load().catch(e => { $('routingStatus').textContent = e.message; });
})();
