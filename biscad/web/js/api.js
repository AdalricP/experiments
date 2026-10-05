const api_base_storage_key = 'biscad-api';
const legacy_api_base_storage_key = 'biscad.api';
const api_key_storage_key = 'biscad.key';
const default_request_timeout_in_milliseconds = 120000;
const default_ping_timeout_in_milliseconds = 3500;
const object_url_lifetime_after_download_in_milliseconds = 4000;
const longest_plain_text_error_in_characters = 300;

export function read_stored_setting(setting_name) {
  try { return localStorage.getItem(setting_name); } catch (storage_error) { return null; }
}

export function write_stored_setting(setting_name, setting_text) {
  try { setting_text ? localStorage.setItem(setting_name, setting_text) : localStorage.removeItem(setting_name); } catch (storage_error) { return; }
}

const strip_trailing_slashes = (url_text) => (url_text || '').trim().replace(/\/+$/, '');
const is_json_response = (http_response) => (http_response.headers.get('content-type') || '').includes('json');

function resolve_initial_api_base_url() {
  const page_query = new URLSearchParams(location.search);
  const deployment_default_api_base_url = window.BISCAD_DEFAULT_API || '';
  if (!page_query.has('api')) return strip_trailing_slashes(read_stored_setting(api_base_storage_key) || read_stored_setting(legacy_api_base_storage_key)) || deployment_default_api_base_url;
  const api_base_url_from_query = strip_trailing_slashes(page_query.get('api'));
  write_stored_setting(api_base_storage_key, api_base_url_from_query);
  write_stored_setting(legacy_api_base_storage_key, null);
  return api_base_url_from_query || deployment_default_api_base_url;
}

function describe_failed_response(response_status, response_body) {
  const message_from_json = response_body && typeof response_body === 'object' && (response_body.error?.message || response_body.detail?.message || response_body.detail || response_body.error || response_body.message);
  const message_from_text = typeof response_body === 'string' && response_body.length < longest_plain_text_error_in_characters && response_body;
  const failure_message = message_from_json || message_from_text || `HTTP ${response_status}`;
  return typeof failure_message === 'string' ? failure_message : JSON.stringify(failure_message);
}

async function fetch_within_time_limit(request_url, fetch_options, timeout_in_milliseconds, read_response) {
  const abort_controller = new AbortController();
  const abort_timer = setTimeout(() => abort_controller.abort(), timeout_in_milliseconds);
  try { return await read_response(await fetch(request_url, { ...fetch_options, signal: abort_controller.signal })); } finally { clearTimeout(abort_timer); }
}

async function read_response_or_throw(http_response) {
  const response_body = is_json_response(http_response) ? await http_response.json() : await http_response.text();
  if (http_response.ok) return response_body;
  throw Object.assign(new Error(describe_failed_response(http_response.status, response_body)), { status: http_response.status, response_body, code: response_body?.error?.code });
}

export const api = {
  base_url: resolve_initial_api_base_url(),
  get api_key() { return read_stored_setting(api_key_storage_key) || ''; },
  set api_key(new_api_key) { write_stored_setting(api_key_storage_key, new_api_key); },
  set_base_url(new_base_url) {
    this.base_url = strip_trailing_slashes(new_base_url);
    write_stored_setting(api_base_storage_key, this.base_url);
  },
  resolve_url(path) { return /^https?:/.test(path) ? path : this.base_url + path; },
  build_headers(extra_headers = {}) { return this.api_key ? { ...extra_headers, Authorization: 'Bearer ' + this.api_key } : { ...extra_headers }; },
  request(http_method, path, request_body, { timeout_in_milliseconds = default_request_timeout_in_milliseconds } = {}) {
    const fetch_options = { method: http_method, headers: this.build_headers(request_body ? { 'Content-Type': 'application/json' } : {}), body: request_body ? JSON.stringify(request_body) : undefined };
    return fetch_within_time_limit(this.resolve_url(path), fetch_options, timeout_in_milliseconds, read_response_or_throw);
  },
  get(path, request_options) { return this.request('GET', path, null, request_options); },
  post(path, request_body, request_options) { return this.request('POST', path, request_body || {}, request_options); },
  async blob_url(path) {
    const http_response = await fetch(this.resolve_url(path), { headers: this.build_headers() });
    if (!http_response.ok) throw new Error(`HTTP ${http_response.status}`);
    return URL.createObjectURL(await http_response.blob());
  },
  async download(path, file_name) {
    const download_link = Object.assign(document.createElement('a'), { href: await this.blob_url(path), download: file_name });
    download_link.click();
    setTimeout(() => URL.revokeObjectURL(download_link.href), object_url_lifetime_after_download_in_milliseconds);
  },
  async is_reachable(timeout_in_milliseconds = default_ping_timeout_in_milliseconds) {
    const answers_with_json = (http_response) => http_response.ok && is_json_response(http_response);
    try { return await fetch_within_time_limit(this.resolve_url('/v1/examples'), { headers: this.build_headers() }, timeout_in_milliseconds, answers_with_json); } catch (network_error) { return false; }
  },
};

export const bundled_sample_models = [
  { id: 'quadruped', name: 'Quadruped robot (23-part assembly)' },
  { id: 'bracket', name: 'Angle bracket' },
  { id: 'flange', name: 'Bearing flange' },
  { id: 'gear', name: 'Spur gear' },
  { id: 'enclosure', name: 'Electronics enclosure' },
  { id: 'leg', name: 'Quadruped leg (assembly)' },
  { id: 'constrained_plate', name: 'Constraint-sketched plate' },
  { id: 'turntable', name: 'Turntable (assembly with joints)' },
];
export const resolve_sample_scene_url = (sample_id) => new URL(`../samples/${sample_id}.json`, import.meta.url).href;
