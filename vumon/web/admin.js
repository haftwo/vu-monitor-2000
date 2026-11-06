const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch('api/' + path, {
    headers: { 'Content-Type': 'application/json' }, cache: 'no-store', ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

let streams = [];
let editing = null;

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function render() {
  const rows = $('#rows');
  rows.replaceChildren();
  $('#none').hidden = streams.length > 0;
  streams.forEach((s, i) => {
    const tr = document.createElement('tr');
    if (!s.enabled) tr.className = 'disabled';
    const name = document.createElement('td');
    name.innerHTML = '<strong></strong><div class="muted small"></div>';
    name.querySelector('strong').textContent = s.name;
    name.querySelector('div').textContent = [s.enabled ? '' : 'Disabled', s.proxy ? '' : 'Direct (no proxy)', s.notes]
      .filter(Boolean).join(' · ');
    const url = document.createElement('td');
    url.className = 'url'; url.textContent = s.url;
    const act = document.createElement('td');
    act.className = 'actions';
    const btn = (label, fn, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn ' + cls; b.textContent = label;
      b.addEventListener('click', fn); act.appendChild(b); act.append(' ');
      return b;
    };
    btn('↑', () => move(i, -1)).disabled = i === 0;
    btn('↓', () => move(i, 1)).disabled = i === streams.length - 1;
    btn(s.enabled ? 'Disable' : 'Enable', () => update(s.id, { enabled: !s.enabled }));
    btn('Edit', () => startEdit(s));
    btn('Delete', () => remove(s), 'danger');
    tr.append(name, url, act);
    rows.appendChild(tr);
  });
}

async function load() {
  streams = (await api('streams')).streams;
  render();
}

async function update(id, patch) {
  try { await api('streams/' + id, { method: 'PUT', body: JSON.stringify(patch) }); await load(); }
  catch (e) { toast(e.message); }
}

async function remove(s) {
  if (!confirm(`Delete "${s.name}"?`)) return;
  try { await api('streams/' + s.id, { method: 'DELETE' }); if (editing === s.id) resetForm(); await load(); toast('Deleted'); }
  catch (e) { toast(e.message); }
}

async function move(i, dir) {
  const ids = streams.map((s) => s.id);
  [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
  try { streams = (await api('streams/order', { method: 'PUT', body: JSON.stringify({ ids }) })).streams; render(); }
  catch (e) { toast(e.message); }
}

function startEdit(s) {
  editing = s.id;
  $('#f-name').value = s.name;
  $('#f-url').value = s.url;
  $('#f-notes').value = s.notes || '';
  $('#f-enabled').checked = s.enabled;
  $('#f-proxy').checked = s.proxy;
  $('#form-title').textContent = `Edit "${s.name}"`;
  $('#save').textContent = 'Save changes';
  $('#cancel').hidden = false;
  $('#test-result').hidden = true;
  $('#f-name').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetForm() {
  editing = null;
  $('#form').reset();
  $('#form-title').textContent = 'Add a stream';
  $('#save').textContent = 'Add stream';
  $('#cancel').hidden = true;
  $('#test-result').hidden = true;
}

function showTest(r) {
  const box = $('#test-result');
  box.hidden = false;
  box.className = 'test-result ' + (r.ok ? 'ok' : 'bad');
  if (!r.ok) { box.textContent = '✗ ' + r.error; return; }
  const lines = [`✓ ${r.summary}  (${r.ms} ms)`];
  if (r.finalUrl && r.finalUrl !== $('#f-url').value.trim()) lines.push(`Redirected to ${r.finalUrl}`);
  if (r.variants) {
    for (const v of r.variants) {
      lines.push(`  • ${v.bandwidth ? Math.round(v.bandwidth / 1000) + ' kb/s' : '? kb/s'}  ${v.codecs}`);
    }
    if (r.audioRenditions) lines.push(`  ${r.audioRenditions} separate audio rendition(s)`);
  }
  if (r.targetDuration) lines.push(`Target segment duration ${r.targetDuration} s`);
  box.textContent = lines.join('\n');
}

$('#test').addEventListener('click', async () => {
  const url = $('#f-url').value.trim();
  if (!url) { $('#f-url').focus(); return; }
  const b = $('#test');
  b.disabled = true; b.textContent = 'Testing…';
  try { showTest(await api('test', { method: 'POST', body: JSON.stringify({ url }) })); }
  catch (e) { showTest({ ok: false, error: e.message }); }
  b.disabled = false; b.textContent = 'Test URL';
});

$('#cancel').addEventListener('click', resetForm);

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('#f-name').value, url: $('#f-url').value, notes: $('#f-notes').value,
    enabled: $('#f-enabled').checked, proxy: $('#f-proxy').checked,
  };
  try {
    if (editing) await api('streams/' + editing, { method: 'PUT', body: JSON.stringify(body) });
    else await api('streams', { method: 'POST', body: JSON.stringify(body) });
    toast(editing ? 'Saved' : 'Added');
    resetForm();
    await load();
  } catch (err) { toast(err.message); }
});

load().catch((e) => toast('Could not load streams: ' + e.message));
