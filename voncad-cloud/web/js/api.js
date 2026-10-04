// Voncad Cloud — tiny API client shared by studio.html and view.html.
// Base URL: same origin, or `?api=https://...` (persisted in localStorage; `?api=` with no value resets).

const LS_API = 'voncad-api';
const LS_API_OLD = 'voncad.api';
const LS_KEY = 'voncad.key';

function initBase() {
  const q = new URLSearchParams(location.search);
  if (q.has('api')) {
    const v = (q.get('api') || '').trim().replace(/\/+$/, '');
    try { v ? localStorage.setItem(LS_API, v) : localStorage.removeItem(LS_API); localStorage.removeItem(LS_API_OLD); } catch (e) {}
    return v || (typeof window !== 'undefined' && window.VONCAD_DEFAULT_API) || '';
  }
  try {
    const v = localStorage.getItem(LS_API) || localStorage.getItem(LS_API_OLD);
    if (v) return v.replace(/\/+$/, '');
  } catch (e) {}
  return (typeof window !== 'undefined' && window.VONCAD_DEFAULT_API) || '';
}

export const api = {
  base: initBase(),
  get key() { try { return localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; } },
  set key(v) { try { v ? localStorage.setItem(LS_KEY, v) : localStorage.removeItem(LS_KEY); } catch (e) {} },
  setBase(v) {
    this.base = (v || '').trim().replace(/\/+$/, '');
    try { this.base ? localStorage.setItem(LS_API, this.base) : localStorage.removeItem(LS_API); } catch (e) {}
  },
  url(path) {
    if (/^https?:/.test(path)) return path;
    return (this.base || '') + path;
  },
  headers(extra = {}) {
    const h = { ...extra };
    if (this.key) h.Authorization = 'Bearer ' + this.key;
    return h;
  },
  async req(method, path, body, { timeout = 120000 } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(this.url(path), {
        method,
        headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json() : await res.text();
      if (!res.ok) {
        const msg = (data && typeof data === 'object' && (data.error?.message || data.detail?.message || data.detail || data.error || data.message)) || (typeof data === 'string' && data.length < 300 && data) || `HTTP ${res.status}`;
        const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        err.status = res.status; err.data = data; err.code = data?.error?.code;
        throw err;
      }
      return data;
    } finally { clearTimeout(t); }
  },
  get(path, opts) { return this.req('GET', path, null, opts); },
  post(path, body, opts) { return this.req('POST', path, body || {}, opts); },
  /** Download a binary endpoint (adds auth header) and save it. */
  async download(path, filename) {
    const res = await fetch(this.url(path), { headers: this.headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  },
  async blobUrl(path) {
    const res = await fetch(this.url(path), { headers: this.headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return URL.createObjectURL(await res.blob());
  },
  /** true when the API answers (examples is cheap and public). */
  async ping(timeout = 3500) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeout);
      const res = await fetch(this.url('/v1/examples'), { headers: this.headers(), signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) return false;
      const ct = res.headers.get('content-type') || '';
      return ct.includes('json');
    } catch (e) { return false; }
  },
};

export const SAMPLES = [
  { id: 'quadruped', name: 'Quadruped robot (23-part assembly)' },
  { id: 'bracket', name: 'Angle bracket' },
  { id: 'flange', name: 'Bearing flange' },
  { id: 'gear', name: 'Spur gear' },
  { id: 'enclosure', name: 'Electronics enclosure' },
  { id: 'leg', name: 'Quadruped leg (assembly)' },
];
export const sampleUrl = (id) => new URL(`../samples/${id}.json`, import.meta.url).href;
