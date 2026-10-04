// BISCAD — Studio. Code editor + parameters + viewer + versions, against API contract v1.
// Works offline as a demo (sample scenes) when the API is unreachable.

import { Viewer, mountToolbar, PartTree, SelectionPanel, StepsBar, fmt, fmtVec, paintRange } from './viewer.js';
import { api, SAMPLES, sampleUrl } from './api.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

const S = {
  online: false,
  examples: [],          // [{id, name, script?}]
  exampleId: null,
  docId: null,
  versionId: null,       // saved version (document history)
  buildId: null,         // id of the last successful build (exports/render work on it too)
  savedScript: null, savedParams: null,
  schema: [], params: {}, defaults: {},
  summary: null, lastBuildMs: null,
  buildSeq: 0, building: false,
  agent: { available: false },
  versions: [],
  firstLoad: true,
};

// ---------------------------------------------------------------- viewer

const viewer = new Viewer($('#viewer'), {
  measureProvider: (a, b, vid) => api.post(`/v1/versions/${vid}/measure`, { a, b }),
});
window.biscadViewer = viewer;
$('#tb').classList.add('vc-vertical');
mountToolbar(viewer, $('#tb'), ['select', 'measure', 'section', 'explode', '|', 'bbox', 'screenshot', '|', 'help']);
mountToolbar(viewer, $('#viewbar'), ['projection', 'views', 'fit']);
mountToolbar(viewer, $('#shadebar'), ['overlays', '|', 'shading']);
$$('#viewbar, #shadebar').forEach((strip_element) => strip_element.classList.add('vc-strip', 'vc-top'));
new PartTree(viewer, $('#tree'));
new SelectionPanel(viewer, $('#sel'));
const steps = new StepsBar(viewer, $('#steps'), {
  loadStepScene: (st) => api.get(st.scene_url),
  onChange: (i, st) => { markStepLine(st); update_viewport_info_overlay(); },
});

viewer.addEventListener('selectionchange', (e) => {
  const n = e.detail.ids.length;
  $('#selCount').textContent = n ? `${n} · ${e.detail.ids.slice(0, 3).join(', ')}${n > 3 ? '…' : ''}` : '';
  $('#statusSel').textContent = n ? `Selected ${e.detail.ids.slice(0, 2).join(', ')}${n > 2 ? ` +${n - 2}` : ''}` : '';
  if (n) openSec('secSel');
  update_viewport_info_overlay();
});
viewer.addEventListener('load', () => {
  $('#partCount').textContent = viewer.parts.length;
  $('#statusMesh').textContent = `${viewer.parts.length} part${viewer.parts.length === 1 ? '' : 's'} · ${(viewer.triangles || 0).toLocaleString()} tris`;
  renderSummary();
  update_viewport_info_overlay();
});
viewer.addEventListener('statechange', () => update_viewport_info_overlay());

function update_viewport_info_overlay() {
  const tool_names_for_overlay = { measure: 'Measure', select: '' };
  const projection_name = viewer.state.projection === 'perspective' ? 'User Perspective' : 'User Orthographic';
  const active_step = steps.steps[steps.current];
  const step_label = active_step && steps.current < steps.steps.length - 1 ? ` · step ${steps.current + 1}/${steps.steps.length}` : '';
  $('#vpProjection').textContent = projection_name + (tool_names_for_overlay[viewer.state.tool] ? ` · ${tool_names_for_overlay[viewer.state.tool]}` : '');
  $('#vpContext').textContent = `${$('#docName').value}${step_label}${viewer.selection.length ? ' | ' + viewer.selection[viewer.selection.length - 1] : ''}`;
}

// ---------------------------------------------------------------- editor

const editor = CodeMirror($('#editor'), {
  value: '',
  mode: 'python',
  theme: 'biscad',
  lineNumbers: true,
  indentUnit: 4,
  tabSize: 4,
  indentWithTabs: false,
  matchBrackets: true,
  autoCloseBrackets: true,
  styleActiveLine: true,
  viewportMargin: 50,
  lineWrapping: true,
  extraKeys: {
    'Ctrl-Enter': () => build(), 'Cmd-Enter': () => build(),
    'Ctrl-S': () => save(), 'Cmd-S': () => save(),
    Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ', 'end')),
    'Shift-Tab': (cm) => cm.indentSelection('subtract'),
  },
});
let errMarks = [];
function clearError() {
  for (const m of errMarks) m.clear?.();
  errMarks = [];
  editor.eachLine((l) => { editor.removeLineClass(l, 'background', 'cm-errline'); editor.removeLineClass(l, 'gutter', 'cm-errgutter'); });
  $('#errbar').hidden = true;
}
function showError(msg) {
  clearError();
  const text = String(msg || 'Build failed');
  const all = [...text.matchAll(/line (\d+)/gi)];
  const m = all.length ? all[all.length - 1] : text.match(/:(\d+):/);
  const line = m ? +m[1] - 1 : null;
  if (line != null && line >= 0 && line < editor.lineCount()) {
    editor.addLineClass(line, 'background', 'cm-errline');
    editor.addLineClass(line, 'gutter', 'cm-errgutter');
    const w = document.createElement('div');
    w.className = 'cm-errwidget';
    w.textContent = text;
    errMarks.push(editor.addLineWidget(line, w, { coverGutter: false, noHScroll: true }));
    editor.scrollIntoView({ line, ch: 0 }, 80);
  }
  const bar = $('#errbar');
  bar.textContent = (line != null ? `Line ${line + 1} · ` : '') + text;
  bar.hidden = false;
  bar.onclick = () => { if (line != null) { editor.focus(); editor.setCursor({ line, ch: 0 }); } setTab('code'); };
}
let stepMark = null;
function markStepLine(st) {
  if (stepMark != null) editor.removeLineClass(stepMark, 'background', 'cm-stepline');
  stepMark = null;
  if (st?.line && st.line - 1 < editor.lineCount()) {
    stepMark = st.line - 1;
    editor.addLineClass(stepMark, 'background', 'cm-stepline');
    editor.scrollIntoView({ line: stepMark, ch: 0 }, 60);
  }
}

editor.on('change', () => {
  if (errMarks.length || !$('#errbar').hidden) clearError();
  updateDirty();
  clearTimeout(editor._schemaT);
  editor._schemaT = setTimeout(() => {
    const sc = parseSchema(editor.getValue());
    if (JSON.stringify(sc.map((p) => [p.name, p.type])) !== JSON.stringify(S.schema.map((p) => [p.name, p.type]))) setSchema(sc, true);
  }, 500);
});

// Read `params = {...}` defaults locally so the panel appears instantly (server param_schema wins).
function parseSchema(src) {
  const m = src.match(/^params\s*=\s*(\{[\s\S]*?\})\s*$/m);
  if (!m) return [];
  const body = m[1];
  try {
    const json = body.replace(/#.*$/gm, '').replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null').replace(/,\s*}/g, '}');
    const o = JSON.parse(json);
    return Object.entries(o).map(([name, v]) => {
      let type = 'string';
      if (typeof v === 'boolean') type = 'bool';
      else if (typeof v === 'number') {
        const lit = body.match(new RegExp(`["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*:\\s*([-+0-9.eE]+)`));
        type = lit && /[.eE]/.test(lit[1]) ? 'float' : 'int';
      }
      return { name, default: v, type };
    });
  } catch (e) { return S.schema; }
}

// ---------------------------------------------------------------- logs / status

function log(msg, cls = '') {
  const pre = $('#logsBody');
  const t = new Date().toLocaleTimeString([], { hour12: false });
  pre.insertAdjacentHTML('beforeend', `<span class="t">${t}</span>  <span class="${cls}">${esc(msg)}</span>\n`);
  pre.scrollTop = pre.scrollHeight;
  $('#logsSum').textContent = msg.split('\n')[0];
}
$('#logsToggle').onclick = () => $('#logs').classList.toggle('open');

function setStatus(kind, text) {
  const s = $('#status');
  s.className = 'status ' + kind;
  s.querySelector('span').textContent = text;
}
function progress(on) { $('#progress').classList.toggle('on', on); }

function notice(html) {
  const n = $('#notice');
  if (!html) { n.hidden = true; return; }
  n.innerHTML = html + '<button class="vc-x" aria-label="Dismiss">×</button>';
  n.hidden = false;
  n.querySelector('.vc-x').onclick = () => { n.hidden = true; };
  n.querySelector('[data-settings]')?.addEventListener('click', () => openMenu('settingsMenu'));
}

// ---------------------------------------------------------------- params panel

function setSchema(schema, keepValues = true) {
  S.schema = schema || [];
  const prev = S.params;
  S.defaults = Object.fromEntries(S.schema.map((p) => [p.name, p.default]));
  S.params = {};
  for (const p of S.schema) if (keepValues && prev[p.name] != null && typeof prev[p.name] === typeof p.default && prev[p.name] !== p.default) S.params[p.name] = prev[p.name];
  renderParams();
}

function paramRange(p) {
  const d = Number(p.default) || 0;
  const n = p.name.toLowerCase();
  if (p.type === 'int' && /count|teeth|bolts|holes|n_|num|segments|rows|cols/.test(n)) return [Math.max(1, Math.round(d / 4)), Math.max(d * 3, d + 8), 1];
  if (/angle|deg/.test(n)) return [-180, 180, p.type === 'int' ? 1 : 0.5];
  const a = Math.abs(d) || 10;
  const max = d >= 0 ? a * 3 : a;
  const min = d >= 0 ? (d === 0 ? 0 : Math.min(0, d) || +(a * 0.1).toFixed(2)) : -a * 3;
  const step = p.type === 'int' ? 1 : a >= 20 ? 0.5 : a >= 2 ? 0.1 : 0.01;
  return [min, max, step];
}

function renderParams() {
  const root = $('#params');
  $('#paramCount').textContent = S.schema.length || '';
  if (!S.schema.length) {
    root.innerHTML = `<div class="vc-sel-empty">Define <code>params = {"width": 40}</code> at the top of the script to get live sliders. Each change rebuilds the model.</div>`;
    return;
  }
  root.innerHTML = '';
  for (const p of S.schema) {
    const val = S.params[p.name] ?? p.default;
    if (p.type === 'bool') {
      const row = document.createElement('label');
      row.className = 'param-bool';
      row.innerHTML = `<span>${esc(p.name)}</span><span class="vc-switch"><input type="checkbox" ${val ? 'checked' : ''}><i></i></span>`;
      row.querySelector('input').onchange = (e) => setParam(p, e.target.checked);
      root.appendChild(row);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'param' + (S.params[p.name] != null ? ' mod' : '');
    if (p.type === 'string') {
      row.innerHTML = `<label title="${esc(p.name)}">${esc(p.name)}</label><input type="text" value="${esc(val)}">`;
      row.querySelector('input').onchange = (e) => setParam(p, e.target.value, row);
      root.appendChild(row);
      continue;
    }
    const [min, max, step] = paramRange(p);
    row.innerHTML = `<label title="${esc(p.name)}">${esc(p.name.replace(/_/g, ' '))}</label><div class="param-field"><input type="range" min="${Math.min(min, val)}" max="${Math.max(max, val)}" step="${step}" value="${val}" aria-label="${esc(p.name)}"><input type="number" step="${step}" value="${val}"></div>`;
    const num = row.querySelector('input[type=number]'), rng = row.querySelector('input[type=range]');
    paintRange(rng);
    rng.oninput = () => { num.value = rng.value; setParam(p, +rng.value, row, 260); };
    num.onchange = () => {
      let v = p.type === 'int' ? Math.round(+num.value) : +num.value;
      if (!isFinite(v)) v = p.default;
      if (v > +rng.max) rng.max = v; if (v < +rng.min) rng.min = v;
      rng.value = v; paintRange(rng); setParam(p, v, row, 0);
    };
    num.onkeydown = (e) => { if (e.key === 'Enter') num.blur(); };
    root.appendChild(row);
  }
  const foot = document.createElement('div');
  foot.className = 'params-foot';
  foot.innerHTML = `<span>Drag a field or type a value</span><button>Reset all</button>`;
  foot.querySelector('button').onclick = () => { S.params = {}; renderParams(); scheduleBuild(0); };
  root.appendChild(foot);
}

let paramT = null;
function setParam(p, v, row, delay = 300) {
  if (v === p.default) delete S.params[p.name]; else S.params[p.name] = v;
  row?.classList.toggle('mod', S.params[p.name] != null);
  updateDirty();
  scheduleBuild(delay);
}
function scheduleBuild(delay) {
  clearTimeout(paramT);
  paramT = setTimeout(() => build({ fromParams: true }), delay);
}

// ---------------------------------------------------------------- build

async function build({ fromParams = false, quiet = false } = {}) {
  const script = editor.getValue();
  if (!S.online) {
    notice(`<b>Offline demo</b><span>Building needs the BISCAD API.</span><button data-settings>Set API</button>`);
    if (!quiet) viewer.flash('Building needs the API');
    return;
  }
  const seq = ++S.buildSeq;
  S.building = true;
  $('#buildBtn').classList.add('busy');
  progress(true);
  setStatus('busy', 'Building');
  const t0 = performance.now();
  try {
    const body = { script, params: { ...S.params } };
    const q = $('#quality').value;
    if (q && q !== 'normal') body.quality = q;
    const res = await api.post('/v1/build', body);
    if (seq !== S.buildSeq) return;
    const ms = Math.round(performance.now() - t0);
    if (res.param_schema && !fromParams) setSchema(res.param_schema, true);
    if (!res.ok) {
      showError(res.error);
      log(res.error || 'Build failed', 'e');
      if (res.logs) log(res.logs);
      setStatus('error', 'Error');
      if (innerWidth <= 760) setTab('code');
      return;
    }
    clearError();
    S.buildId = res.id || null;
    S.summary = res.summary || null;
    S.lastBuildMs = res.summary?.timing_ms?.total ?? ms;
    let scene = res.scene;
    if (!scene && res.links?.scene) scene = await api.get(res.links.scene);
    if (scene) viewer.loadScene(scene, { keepCamera: !S.firstLoad, versionId: S.buildId });
    S.firstLoad = false;
    steps.setSteps(res.steps || [], { finalScene: scene });
    if (res.logs) log(res.logs.trimEnd());
    const tri = res.summary?.triangles ?? viewer.triangles;
    log(`Built in ${fmt(S.lastBuildMs, 0)} ms · ${viewer.parts.length} part${viewer.parts.length === 1 ? '' : 's'} · ${(tri || 0).toLocaleString()} tris`, 'ok');
    setStatus('online', 'Online');
    renderSummary();
    updateDirty();
  } catch (e) {
    if (seq !== S.buildSeq) return;
    log('Build request failed: ' + e.message, 'e');
    if (e.status === 401 || e.status === 402 || e.status === 429) notice(`<b>${e.status === 401 ? 'Auth' : 'Quota'}</b><span>${esc(e.message)}</span><button data-settings>API key</button>`);
    else if (!e.status) { await checkOnline(); }
    else showError(e.message);
    setStatus(S.online ? 'online' : 'offline', S.online ? 'Online' : 'Offline');
  } finally {
    if (seq === S.buildSeq) {
      S.building = false;
      $('#buildBtn').classList.remove('busy');
      progress(false);
    }
  }
}
$('#buildBtn').onclick = () => build();

// ---------------------------------------------------------------- summary

function renderSummary() {
  const st = viewer.stats();
  const sm = S.summary;
  const vol = sm?.volume ?? st.volume;      // mm³
  const area = sm?.area ?? st.area;
  const size = sm?.bbox ? sm.bbox.max.map((x, i) => x - sm.bbox.min[i]) : st.bbox.size;
  const g = (dens) => (vol / 1000) * dens;
  const mass = (x) => (x >= 1000 ? `${fmt(x / 1000, 3)} kg` : `${fmt(x, 1)} g`);
  $('#buildTime').textContent = S.lastBuildMs != null ? `${fmt(S.lastBuildMs, 0)} ms` : (S.online ? '' : 'sample');
  $('#statusBuild').textContent = S.lastBuildMs != null ? `Built in ${fmt(S.lastBuildMs, 0)} ms` : '';
  if (!viewer.parts.length) { $('#summary').innerHTML = '<div class="vc-sel-empty">No model yet.</div>'; return; }
  $('#summary').innerHTML = `
    <div class="big"><div><b>${fmt(vol / 1000, 2)}</b><span>cm³ volume</span></div><div><b>${fmt(area / 100, 1)}</b><span>cm² area</span></div></div>
    <dl class="kv">
      <dt class="grp">Mass</dt>
      <dt>Steel · 7.85</dt><dd>${mass(sm?.mass_g_steel ?? g(7.85))}</dd>
      <dt>Aluminium · 2.70</dt><dd>${mass(sm?.mass_g_aluminium ?? g(2.70))}</dd>
      <dt>PLA · 1.24</dt><dd>${mass(sm?.mass_g_pla ?? g(1.24))}</dd>
      <dt class="grp">Geometry</dt>
      <dt>Bounding box</dt><dd>${fmt(size[0], 1)} × ${fmt(size[1], 1)} × ${fmt(size[2], 1)}</dd>
      ${sm?.center_of_mass ? `<dt>Center of mass</dt><dd>${fmtVec(sm.center_of_mass, 1)}</dd>` : ''}
      <dt>Parts</dt><dd>${st.parts}</dd>
      <dt>Faces · edges</dt><dd>${st.faces} · ${st.edges}</dd>
      <dt>Triangles</dt><dd>${st.triangles.toLocaleString()}</dd>
      ${sm?.parts?.some((p) => p.valid === false) ? `<dt>Validity</dt><dd class="bad">invalid solid</dd>` : sm?.parts ? `<dt>Validity</dt><dd>valid B-rep</dd>` : ''}
      ${!sm ? `<dt>Source</dt><dd>mesh estimate</dd>` : ''}
    </dl>`;
}

// ---------------------------------------------------------------- examples

async function loadExamples() {
  let list = [];
  if (S.online) {
    try {
      const r = await api.get('/v1/examples');
      list = Array.isArray(r) ? r : r.examples || [];
    } catch (e) { list = []; }
  }
  if (!list.length) list = SAMPLES.map((s) => ({ ...s }));
  S.examples = list;
  const sel = $('#examples');
  sel.innerHTML = `<option value="" disabled>Examples</option>` + list.map((e) => `<option value="${esc(e.id)}">${esc(e.name || e.id)}</option>`).join('');
  sel.onchange = () => openExample(sel.value);
}

const SAMPLE_IDS = new Set(SAMPLES.map((s) => s.id));
async function openExample(id) {
  const ex = S.examples.find((e) => e.id === id) || { id };
  S.exampleId = id;
  $('#examples').value = id;
  S.docId = null; S.versionId = null; S.buildId = null; S.savedScript = null; S.savedParams = null; S.summary = null; S.lastBuildMs = null;
  S.versions = []; renderHistory();
  $('#docName').value = ex.name || id;
  editor.setValue(ex.script || `# ${ex.name || id}\n# Offline demo: this sample is a pre-built scene.\n# Connect the BISCAD API (settings, top right) to edit and rebuild.\n`);
  editor.clearHistory();
  S.params = {};
  setSchema(ex.script ? parseSchema(ex.script) : [], false);
  steps.setSteps([]);
  viewer.setGhost(null);
  S.firstLoad = true;
  // show the pre-built sample instantly when we have one, then build for real
  let shown = false;
  if (SAMPLE_IDS.has(id)) {
    try { await viewer.load(sampleUrl(id)); shown = true; S.firstLoad = false; } catch (e) { /* no sample */ }
  }
  renderSummary();
  updateDirty();
  history.replaceState(null, '', `?example=${encodeURIComponent(id)}`);
  if (S.online && ex.script) build({ quiet: true });
  else if (!shown) viewer.clear();
}

// ---------------------------------------------------------------- versions

function updateDirty() {
  const b = $('#verBadge');
  const dirty = S.versionId && (editor.getValue() !== S.savedScript || JSON.stringify(S.params) !== JSON.stringify(S.savedParams || {}));
  if (!S.versionId) { b.textContent = 'unsaved'; b.classList.remove('saved'); }
  else { b.textContent = S.versionId + (dirty ? ' · edited' : ''); b.classList.toggle('saved', !dirty); }
  const id = S.versionId || S.buildId;
  $$('#exportMenu [data-fmt], #exportMenu [data-open]').forEach((x) => { x.disabled = !id; });
  $('#exportNote').textContent = id ? (S.versionId ? '' : 'From the last build — save to keep it in history.') : (S.online ? 'Build the model to export.' : 'Exports need the BISCAD API.');
}

async function save() {
  if (!S.online) { viewer.flash('Saving needs the API'); notice(`<b>Offline demo</b><span>Saving needs the BISCAD API.</span><button data-settings>Set API</button>`); return null; }
  const btn = $('#saveBtn');
  btn.disabled = true;
  setStatus('busy', 'Saving');
  try {
    const name = $('#docName').value.trim() || 'Untitled part';
    const body = { script: editor.getValue(), params: { ...S.params } };
    let version;
    if (!S.docId) {
      const r = await api.post('/v1/documents', { name, ...body });
      S.docId = r.document?.id;
      version = r.version;
    } else {
      const r = await api.post(`/v1/documents/${S.docId}/versions`, { ...body, parent: S.versionId, message: `edit ${new Date().toLocaleTimeString([], { hour12: false })}` });
      version = r.version || r;
    }
    if (!version?.id) throw new Error('no version returned');
    S.versionId = version.id;
    S.savedScript = body.script; S.savedParams = { ...S.params };
    if (version.ok === false || version.status === 'error') { showError(version.error); log('Saved, but the build failed: ' + version.error, 'e'); }
    else {
      viewer.versionId = S.versionId;
      if (version.summary) S.summary = version.summary;
      if (version.steps?.length) steps.setSteps(version.steps, { finalScene: viewer.sceneData });
      else api.get(`/v1/versions/${S.versionId}/steps`).then((r) => steps.setSteps(r.steps || [], { finalScene: viewer.sceneData })).catch(() => {});
      log(`Saved ${S.versionId} to ${S.docId}`, 'ok');
    }
    history.replaceState(null, '', `?v=${encodeURIComponent(S.versionId)}`);
    updateDirty();
    refreshHistory();
    viewer.flash('Saved ' + S.versionId);
    setStatus('online', 'Online');
    return S.versionId;
  } catch (e) {
    log('Save failed: ' + e.message, 'e');
    viewer.flash('Save failed: ' + e.message);
    setStatus('online', 'Online');
    return null;
  } finally { btn.disabled = false; }
}
$('#saveBtn').onclick = () => save();

async function refreshHistory() {
  if (!S.docId) { S.versions = []; renderHistory(); return; }
  try {
    const r = await api.get(`/v1/documents/${S.docId}`);
    S.versions = (r.versions || []).slice().sort((a, b) => (b.created || 0) - (a.created || 0));
    if (r.document?.name) $('#docName').value = r.document.name;
  } catch (e) { /* keep */ }
  renderHistory();
}

function renderHistory() {
  const root = $('#history');
  $('#verCount').textContent = S.versions.length || '';
  if (!S.versions.length) { root.innerHTML = '<div class="vc-empty">Save to start a version history.</div>'; return; }
  root.innerHTML = '';
  for (const v of S.versions) {
    const b = document.createElement('button');
    b.className = 'hist' + (v.id === S.versionId ? ' on' : '') + (v.status === 'error' ? ' err' : '');
    const when = v.created ? new Date(v.created * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    b.innerHTML = `<i></i><div><b>${esc(v.id)}</b><span>${esc(v.message || (v.status === 'error' ? 'build error' : 'version'))}</span></div><small>${esc(when)}</small>`;
    b.onclick = () => loadVersion(v.id);
    root.appendChild(b);
  }
}

async function loadVersion(vid) {
  progress(true);
  try {
    const v = await api.get(`/v1/versions/${encodeURIComponent(vid)}`);
    S.versionId = v.id; S.buildId = v.id; S.docId = v.document_id || S.docId;
    editor.setValue(v.script || '');
    editor.clearHistory();
    S.params = { ...(v.params || {}) };
    setSchema(v.param_schema || parseSchema(v.script || ''), true);
    for (const k of Object.keys(S.params)) if (S.params[k] === S.defaults[k]) delete S.params[k];
    renderParams();
    S.savedScript = editor.getValue(); S.savedParams = { ...S.params };
    S.summary = v.summary || null;
    S.lastBuildMs = v.summary?.timing_ms?.total ?? null;
    if (v.status === 'error' || v.ok === false) { showError(v.error); viewer.clear(); }
    else {
      const scene = await api.get(v.links?.scene || `/v1/versions/${v.id}/scene`);
      viewer.loadScene(scene, { keepCamera: !S.firstLoad, versionId: v.id });
      S.firstLoad = false;
      if (v.steps?.length) steps.setSteps(v.steps, { finalScene: scene });
      else api.get(`/v1/versions/${v.id}/steps`).then((r) => steps.setSteps(r.steps || [], { finalScene: scene })).catch(() => steps.setSteps([]));
    }
    history.replaceState(null, '', `?v=${encodeURIComponent(v.id)}`);
    $('#examples').value = '';
    await refreshHistory();
    updateDirty();
    renderSummary();
    log(`Loaded ${v.id}`, 'ok');
  } catch (e) {
    log(`Could not load ${vid}: ${e.message}`, 'e');
    viewer.flash('Could not load version');
  } finally { progress(false); }
}

// ---------------------------------------------------------------- export / share / agent view

const currentId = () => S.versionId || S.buildId;
function slug() { return ($('#docName').value || 'biscad').trim().replace(/[^\w.-]+/g, '_').slice(0, 60) || 'biscad'; }

$('#exportMenu').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  closeMenus();
  if (b.dataset.a === 'png') { viewer.screenshot({ download: true, name: slug() + '.png' }); return; }
  const id = currentId();
  if (!id) return;
  if (b.dataset.fmt) {
    const f = b.dataset.fmt;
    log(`Exporting ${f.toUpperCase()}…`);
    progress(true);
    try { await api.download(`/v1/versions/${id}/export/${f}`, `${slug()}.${f}`); log(`Exported ${slug()}.${f}`, 'ok'); }
    catch (err) { log(`Export ${f} failed: ${err.message}`, 'e'); viewer.flash('Export failed'); }
    finally { progress(false); }
  } else if (b.dataset.open) {
    const path = `/v1/versions/${id}/${b.dataset.open}`;
    if (api.key) {   // auth header can't ride a plain link: fetch, then open the blob
      const w = window.open('', '_blank');
      try {
        const url = await api.blobUrl(path);
        if (w) w.location.href = url; else window.open(url, '_blank');
      } catch (err) { w?.close(); viewer.flash('Could not open: ' + err.message); }
    } else window.open(api.url(path), '_blank');
  }
});

function shareUrls(id) {
  const base = new URL('view.html', location.href);
  base.searchParams.set('v', id);
  if (api.base) base.searchParams.set('api', api.base);
  const embed = new URL(base); embed.searchParams.set('embed', '1');
  return { link: base.href, embed: `<iframe src="${embed.href}" width="100%" height="480" style="border:0" allow="fullscreen" loading="lazy"></iframe>` };
}
async function openShare() {
  let id = S.versionId;
  const dirty = id && (editor.getValue() !== S.savedScript || JSON.stringify(S.params) !== JSON.stringify(S.savedParams || {}));
  if (!id || dirty) {
    if (!S.online) { viewer.flash('Sharing needs the API'); return; }
    id = await save();
    if (!id) return;
  }
  const u = shareUrls(id);
  $('#shareLink').value = u.link;
  $('#embedCode').value = u.embed;
  $('#openViewer').href = u.link;
  openMenu('shareMenu');
}
$('#shareBtn').onclick = (e) => { e.stopPropagation(); $('#shareMenu').classList.contains('on') ? closeMenus() : openShare(); };
$$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  const inp = $('#' + b.dataset.copy);
  try { await navigator.clipboard.writeText(inp.value); } catch (e) { inp.select(); document.execCommand('copy'); }
  const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = t; }, 1200);
}));

let agentView = 'iso';
async function showAgentView() {
  const id = currentId();
  if (!id) { viewer.flash(S.online ? 'Build the model first' : 'Agent view needs the API'); return; }
  $('#agentModal').hidden = false;
  $$('#agentViews button').forEach((b) => b.classList.toggle('on', b.dataset.v === agentView));
  const hl = viewer.selection.filter((s) => s.includes('/')).join(',');
  const path = agentView === 'grid'
    ? `/v1/versions/${id}/render-grid.png?labels=1${hl ? '&highlight=' + encodeURIComponent(hl) : ''}`
    : `/v1/versions/${id}/render.png?view=${agentView}&labels=1&w=1200&h=900${hl ? '&highlight=' + encodeURIComponent(hl) : ''}`;
  $('#agentUrl').textContent = path.replace(/&w=1200&h=900/, '');
  $('#agentLoad').classList.add('on');
  try {
    const url = await api.blobUrl(path);
    const img = $('#agentImg');
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.src = url;
  } catch (e) { viewer.flash('Render failed: ' + e.message); }
  finally { $('#agentLoad').classList.remove('on'); }
}
$('#agentBtn').onclick = showAgentView;
$('#agentViews').onclick = (e) => { const b = e.target.closest('button'); if (b) { agentView = b.dataset.v; showAgentView(); } };
$('#agentModal').addEventListener('click', (e) => { if (e.target.id === 'agentModal' || e.target.closest('[data-close]')) $('#agentModal').hidden = true; });

// ---------------------------------------------------------------- menus & settings

function closeMenus() { $$('.menu.on').forEach((m) => m.classList.remove('on')); }
function openMenu(id) { closeMenus(); $('#' + id).classList.add('on'); }
$('#exportBtn').onclick = (e) => { e.stopPropagation(); const on = $('#exportMenu').classList.contains('on'); closeMenus(); if (!on) { updateDirty(); openMenu('exportMenu'); } };
$('#settingsBtn').onclick = (e) => {
  e.stopPropagation();
  const on = $('#settingsMenu').classList.contains('on');
  closeMenus();
  if (!on) { $('#apiBase').value = api.base; $('#apiKey').value = api.key; openMenu('settingsMenu'); loadMe(); }
};
$('#status').onclick = (e) => { e.stopPropagation(); $('#settingsBtn').click(); };
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menuw')) closeMenus(); });
$('#settingsSave').onclick = async () => {
  api.setBase($('#apiBase').value);
  api.key = $('#apiKey').value.trim();
  try { localStorage.setItem('biscad.quality', $('#quality').value); } catch (e) {}
  closeMenus();
  const was = S.online;
  await checkOnline();
  if (S.online && !was) { await loadExamples(); notice(null); if (S.exampleId) $('#examples').value = S.exampleId; build({ quiet: true }); }
  checkAgent();
};
try { const q = localStorage.getItem('biscad.quality'); if (q) $('#quality').value = q; } catch (e) {}

async function loadMe() {
  const n = $('#meNote');
  if (!S.online) { n.textContent = 'API unreachable — running the offline demo.'; return; }
  try {
    const me = await api.get('/v1/me');
    const u = me.usage || {};
    n.textContent = `${me.anonymous ? 'Anonymous playground' : 'Plan: ' + (me.plan || '—')} · ${u.builds ?? u.calls_month ?? 0} builds this month`;
  } catch (e) { n.textContent = e.status === 401 ? 'Key rejected — check it.' : 'Anonymous use works with a playground quota.'; }
}

async function checkOnline() {
  setStatus('busy', 'Connecting');
  S.online = await api.ping();
  setStatus(S.online ? 'online' : 'offline', S.online ? 'Online' : 'Offline demo');
  const api_state_element = $('#statusApi');
  api_state_element.className = 'api-state ' + (S.online ? 'online' : 'offline');
  api_state_element.textContent = S.online ? `API ${(api.base || location.origin).replace(/^https?:\/\//, '')}` : 'API offline · samples only';
  if (!S.online) notice(`<b>Offline demo</b><span>Samples only — building needs the BISCAD API.</span><button data-settings>Set API</button>`);
  updateDirty();
  return S.online;
}

// ---------------------------------------------------------------- ask (text-to-CAD)

let askMode = 'modify';
$('#askMode').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  askMode = b.dataset.v;
  $$('#askMode button').forEach((x) => x.classList.toggle('on', x === b));
};
const askInput = $('#askInput');
askInput.addEventListener('input', () => { askInput.style.height = 'auto'; askInput.style.height = Math.min(askInput.scrollHeight, 120) + 'px'; });
askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
$('#askGo').onclick = () => ask();
$('.ask-k').textContent = isMac ? '⌘K' : 'Ctrl K';

async function checkAgent() {
  const box = $('#ask');
  let info = { available: false };
  if (S.online) { try { info = await api.get('/v1/agent'); } catch (e) { info = { available: false }; } }
  S.agent = info;
  box.classList.toggle('disabled', !info.available);
  const tip = info.available ? `Text-to-CAD · ${info.model || 'Claude'} · up to ${info.max_rounds || '?'} rounds` : (S.online ? "Text-to-CAD isn't enabled on this server" : 'Text-to-CAD needs the BISCAD API');
  box.title = tip;
  askInput.disabled = !info.available;
  $('#askGo').disabled = !info.available;
  askInput.placeholder = info.available ? (askMode === 'new' ? 'Describe a new part…' : 'Describe a part, or a change…') : tip;
}

let askBusy = false;
async function ask() {
  const prompt = askInput.value.trim();
  if (!prompt || askBusy || !S.agent.available) return;
  if (!api.key) { setAskStatus('An API key is required — add one in settings.', 'err'); openMenu('settingsMenu'); return; }
  askBusy = true;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    const round = Math.min(S.agent.max_rounds || 9, 1 + Math.floor(s / 25));
    setAskStatus(`Claude is designing… round ${round} · ${s}s`, 'busy');
  }, 500);
  setAskStatus('Claude is designing…', 'busy');
  progress(true);
  try {
    const body = { prompt };
    if (askMode === 'modify') { body.script = editor.getValue(); if (S.docId) body.document_id = S.docId; }
    const r = await api.post('/v1/agent', body, { timeout: 240000 });
    if (!r.ok && !r.version) throw Object.assign(new Error(r.error?.message || r.error || 'Agent failed'), { data: r });
    renderRounds(r.rounds || []);
    const v = r.version;
    if (v?.script) { editor.setValue(v.script); setSchema(v.param_schema || parseSchema(v.script), false); }
    if (v?.document_id) S.docId = v.document_id;
    if (v?.id) {
      S.buildId = v.id;
      if (v.document_id) { S.versionId = v.id; S.savedScript = editor.getValue(); S.savedParams = {}; refreshHistory(); }
      const scene = await api.get(v.links?.scene || `/v1/versions/${v.id}/scene`);
      viewer.loadScene(scene, { keepCamera: false, versionId: v.id });
      S.summary = v.summary || null;
      steps.setSteps(v.steps || [], { finalScene: scene });
      if (!v.steps) api.get(`/v1/versions/${v.id}/steps`).then((x) => steps.setSteps(x.steps || [], { finalScene: scene })).catch(() => {});
    }
    setAskStatus(r.ok ? `Done in ${Math.round((Date.now() - t0) / 1000)}s · ${(r.rounds || []).length} round${(r.rounds || []).length === 1 ? '' : 's'}` : (r.error?.message || r.error || 'Finished with errors'), r.ok ? '' : 'err');
    log(`Ask: ${prompt}`, r.ok ? 'ok' : 'e');
    updateDirty(); renderSummary();
  } catch (e) {
    const code = e.status;
    const msg = code === 401 ? 'API key required or invalid.' : code === 402 ? 'Out of quota for text-to-CAD.' : code === 501 ? "Text-to-CAD isn't enabled on this server." : e.message;
    setAskStatus(msg, 'err');
    if (e.data?.rounds) renderRounds(e.data.rounds);
    log('Ask failed: ' + msg, 'e');
  } finally {
    clearInterval(timer);
    askBusy = false;
    progress(false);
  }
}
function setAskStatus(t, cls = '') { const s = $('#askStatus'); s.textContent = t; s.className = 'ask-status ' + cls; s.title = t; }
function renderRounds(rounds) {
  const root = $('#rounds');
  root.hidden = !rounds.length;
  root.innerHTML = '';
  rounds.forEach((rd, i) => {
    const b = document.createElement('button');
    b.className = 'round' + (rd.ok ? '' : ' bad') + (i === rounds.length - 1 ? ' on' : '');
    b.innerHTML = `<i></i>R${i + 1}`;
    b.title = rd.ok ? (rd.note || 'ok') : (rd.error || 'failed');
    b.onclick = async () => {
      if (!rd.version_id) return;
      $$('.round', root).forEach((x) => x.classList.toggle('on', x === b));
      try {
        const sc = await api.get(`/v1/versions/${rd.version_id}/scene`);
        viewer.loadScene(sc, { keepCamera: true, versionId: rd.version_id });
        setAskStatus(`Round ${i + 1}: ${rd.note || (rd.ok ? 'ok' : rd.error || '')}`);
      } catch (e) { setAskStatus(`Round ${i + 1} has no geometry${rd.error ? ': ' + rd.error : ''}`, 'err'); }
    };
    root.appendChild(b);
  });
}

// ---------------------------------------------------------------- layout: sections, resizer, tabs, keys

$$('.sec-h').forEach((h) => h.addEventListener('click', () => h.parentElement.classList.toggle('closed')));
function openSec(id) { $('#' + id).classList.remove('closed'); }
$('#secHistory').classList.add('closed');

(() => {
  const rz = $('#resizer');
  let x0 = 0, w0 = 0;
  try { const w = +localStorage.getItem('biscad.left'); if (w > 280) document.body.style.setProperty('--left', w + 'px'); } catch (e) {}
  rz.addEventListener('pointerdown', (e) => {
    x0 = e.clientX; w0 = $('#left').offsetWidth;
    rz.setPointerCapture(e.pointerId); rz.classList.add('drag');
  });
  rz.addEventListener('pointermove', (e) => {
    if (!rz.classList.contains('drag')) return;
    const w = Math.max(300, Math.min(innerWidth * 0.6, w0 + e.clientX - x0));
    document.body.style.setProperty('--left', w + 'px');
    editor.refresh();
  });
  rz.addEventListener('pointerup', () => {
    rz.classList.remove('drag');
    try { localStorage.setItem('biscad.left', $('#left').offsetWidth); } catch (e) {}
  });
})();

$('#workspaces').onclick = (event) => {
  const workspace_button = event.target.closest('button');
  if (workspace_button) set_workspace(workspace_button.dataset.ws);
};
function set_workspace(workspace_name) {
  document.body.classList.remove('ws-script', 'ws-model', 'ws-analyze');
  document.body.classList.add('ws-' + workspace_name);
  $$('#workspaces button').forEach((workspace_button) => workspace_button.classList.toggle('on', workspace_button.dataset.ws === workspace_name));
  if (workspace_name === 'analyze') { ['secModel', 'secSel', 'secParts'].forEach(openSec); $('#secParams').classList.add('closed'); }
  if (workspace_name === 'script') { openSec('secParams'); setTimeout(() => editor.refresh(), 0); }
}

function is_typing_target(event_target) {
  return !!event_target?.closest?.('input, textarea, select, button, [contenteditable="true"], .CodeMirror');
}

function setTab(tab) {
  document.body.classList.remove('tab-code', 'tab-model', 'tab-inspect');
  document.body.classList.add('tab-' + tab);
  $$('#mtabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'code') setTimeout(() => editor.refresh(), 0);
}
$('#mtabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const t = b.dataset.tab;
  if (innerWidth > 760 && t === 'inspect') { document.body.classList.toggle('show-inspect'); b.classList.toggle('on'); return; }
  setTab(t);
};

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 'Enter') { e.preventDefault(); build(); }
  else if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
  else if (mod && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (innerWidth <= 760) setTab('code');
    askInput.focus();
  } else if (e.key === 'Escape') { closeMenus(); $('#agentModal').hidden = true; }
  else if (!mod && !is_typing_target(e.target) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && steps.steps.length > 1) { e.preventDefault(); steps.step_by(e.key === 'ArrowLeft' ? -1 : 1); }
  else if (!mod && !is_typing_target(e.target) && e.key === ' ' && steps.steps.length > 1) { e.preventDefault(); steps.playing ? steps.stop() : steps.play(); }
});
$('#docName').addEventListener('input', () => update_viewport_info_overlay());
$('#buildBtn').title = `Build (${MOD} Enter)`;
$('#buildBtn kbd').textContent = isMac ? '⌘↵' : 'Ctrl ↵';

// ---------------------------------------------------------------- boot

(async function boot() {
  const q = new URLSearchParams(location.search);
  renderParams();
  await checkOnline();
  await loadExamples();
  checkAgent();
  const vid = q.get('v');
  if (vid && S.online) { await loadVersion(vid); return; }
  if (vid && !S.online) log(`Version ${vid} needs the API — showing a sample instead.`, 'e');
  const want = q.get('example') || q.get('sample');
  const first = (want && S.examples.find((e) => e.id === want)) || S.examples.find((e) => e.id === 'quadruped') || S.examples[0];
  if (first) await openExample(first.id);
  log(S.online ? `Connected to ${api.base || location.origin}` : 'Offline demo — samples only');
})();
