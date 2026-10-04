import { Viewer, mount_toolbar, PartTree, SelectionPanel, StepsBar, format_number, format_vector, paint_range_fill, copy_text_to_clipboard } from './viewer.js';
import { api, bundled_sample_models, resolve_sample_scene_url, read_stored_setting, write_stored_setting } from './api.js';
const select_element = (selector, root = document) => root.querySelector(selector);
const select_all_elements = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape_html = (text) => String(text ?? '').replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
const pluralize = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const on_button_click = (container_selector, handle_button_click) => select_element(container_selector).addEventListener('click', (click_event) => {
  const clicked_button = click_event.target.closest('button');
  if (clicked_button) handle_button_click(clicked_button);
});
const offline_notice_html = (reason_text) => `<b>Offline demo</b><span>${reason_text}</span><button data-settings>Set API</button>`;
const is_mac_platform = /Mac|iPhone|iPad/.test(navigator.platform);
const narrow_layout_width_in_pixels = 760;
const is_narrow_layout = () => innerWidth <= narrow_layout_width_in_pixels;
const schema_parse_delay_in_milliseconds = 500;
const agent_timeout_in_milliseconds = 240000;
const agent_progress_refresh_in_milliseconds = 500;
const estimated_agent_round_duration_in_seconds = 25;
const copy_feedback_duration_in_milliseconds = 1200;
const bundled_sample_ids = new Set(bundled_sample_models.map((sample_model) => sample_model.id));

const studio_state = {
  is_online: false, examples: [], example_id: null, document_id: null, version_id: null, build_id: null, saved_script: null, saved_parameters: null,
  parameter_schema: [], parameter_overrides: {}, build_summary: null, last_build_duration_in_milliseconds: null, build_sequence_number: 0,
  agent_status: { available: false }, versions: [], is_first_load: true,
};

const viewer = new Viewer(select_element('#viewer'), {
  measure_with_kernel: (first_entity_id, second_entity_id, version_id) => api.post(`/v1/versions/${version_id}/measure`, { a: first_entity_id, b: second_entity_id }),
});
window.biscad_viewer = viewer;
select_element('#tb').classList.add('vc-vertical');
mount_toolbar(viewer, select_element('#tb'), ['select', 'measure', 'section', 'explode', '|', 'bbox', 'screenshot', '|', 'help']);
mount_toolbar(viewer, select_element('#viewbar'), ['projection', 'views', 'fit']);
mount_toolbar(viewer, select_element('#shadebar'), ['overlays', '|', 'shading']);
select_all_elements('#viewbar, #shadebar').forEach((strip_element) => strip_element.classList.add('vc-strip', 'vc-top'));
new PartTree(viewer, select_element('#tree'));
new SelectionPanel(viewer, select_element('#sel'));
const steps_bar = new StepsBar(viewer, select_element('#steps'), {
  load_step_scene: (build_step) => api.get(build_step.scene_url),
  on_step_change: (step_index, build_step) => { mark_step_line(build_step); update_viewport_info_overlay(); },
});
viewer.addEventListener('selectionchange', (selection_event) => {
  const selected_ids = selection_event.detail.ids;
  select_element('#selCount').textContent = selected_ids.length ? `${selected_ids.length} · ${selected_ids.slice(0, 3).join(', ')}${selected_ids.length > 3 ? '…' : ''}` : '';
  select_element('#statusSel').textContent = selected_ids.length ? `Selected ${selected_ids.slice(0, 2).join(', ')}${selected_ids.length > 2 ? ` +${selected_ids.length - 2}` : ''}` : '';
  if (selected_ids.length) open_section('secSel');
  update_viewport_info_overlay();
});
viewer.addEventListener('load', () => {
  select_element('#partCount').textContent = viewer.parts.length;
  select_element('#statusMesh').textContent = `${pluralize(viewer.parts.length, 'part')} · ${(viewer.triangle_count || 0).toLocaleString()} tris`;
  render_summary();
  update_viewport_info_overlay();
});
viewer.addEventListener('statechange', () => update_viewport_info_overlay());
function update_viewport_info_overlay() {
  const tool_label = { measure: 'Measure' }[viewer.state.tool];
  const projection_label = viewer.state.projection === 'perspective' ? 'User Perspective' : 'User Orthographic';
  const is_replaying_earlier_step = steps_bar.steps[steps_bar.current_step_index] && steps_bar.current_step_index < steps_bar.steps.length - 1;
  const step_label = is_replaying_earlier_step ? ` · step ${steps_bar.current_step_index + 1}/${steps_bar.steps.length}` : '';
  select_element('#vpProjection').textContent = projection_label + (tool_label ? ` · ${tool_label}` : '');
  select_element('#vpContext').textContent = `${select_element('#docName').value}${step_label}${viewer.selection.length ? ' | ' + viewer.selection[viewer.selection.length - 1] : ''}`;
}

const editor = CodeMirror(select_element('#editor'), {
  value: '', mode: 'python', theme: 'biscad', lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false,
  matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true, viewportMargin: 50, lineWrapping: true,
  extraKeys: {
    'Ctrl-Enter': () => build(), 'Cmd-Enter': () => build(),
    'Ctrl-S': () => save(), 'Cmd-S': () => save(),
    Tab: (code_editor) => (code_editor.somethingSelected() ? code_editor.indentSelection('add') : code_editor.replaceSelection('    ', 'end')),
    'Shift-Tab': (code_editor) => code_editor.indentSelection('subtract'),
  },
});

let error_line_widgets = [];
function clear_build_error() {
  error_line_widgets.forEach((line_widget) => line_widget.clear?.());
  error_line_widgets = [];
  editor.eachLine((line_handle) => { editor.removeLineClass(line_handle, 'background', 'cm-errline'); editor.removeLineClass(line_handle, 'gutter', 'cm-errgutter'); });
  select_element('#errbar').hidden = true;
}
function find_error_line_index(error_text) {
  const line_mentions = [...error_text.matchAll(/line (\d+)/gi)];
  const line_match = line_mentions.length ? line_mentions[line_mentions.length - 1] : error_text.match(/:(\d+):/);
  return line_match ? +line_match[1] - 1 : null;
}
function mark_error_line(error_line_index, error_text) {
  editor.addLineClass(error_line_index, 'background', 'cm-errline');
  editor.addLineClass(error_line_index, 'gutter', 'cm-errgutter');
  error_line_widgets.push(editor.addLineWidget(error_line_index, Object.assign(document.createElement('div'), { className: 'cm-errwidget', textContent: error_text }), { coverGutter: false, noHScroll: true }));
  editor.scrollIntoView({ line: error_line_index, ch: 0 }, 80);
}
function show_build_error(error_message) {
  clear_build_error();
  const error_text = String(error_message || 'Build failed');
  const error_line_index = find_error_line_index(error_text);
  if (error_line_index != null && error_line_index >= 0 && error_line_index < editor.lineCount()) mark_error_line(error_line_index, error_text);
  const error_bar = select_element('#errbar');
  error_bar.textContent = (error_line_index != null ? `Line ${error_line_index + 1} · ` : '') + error_text;
  error_bar.hidden = false;
  error_bar.onclick = () => {
    if (error_line_index != null) { editor.focus(); editor.setCursor({ line: error_line_index, ch: 0 }); }
    set_mobile_tab('code');
  };
}
let highlighted_step_line_index = null;
function mark_step_line(build_step) {
  if (highlighted_step_line_index != null) editor.removeLineClass(highlighted_step_line_index, 'background', 'cm-stepline');
  highlighted_step_line_index = build_step?.line && build_step.line - 1 < editor.lineCount() ? build_step.line - 1 : null;
  if (highlighted_step_line_index == null) return;
  editor.addLineClass(highlighted_step_line_index, 'background', 'cm-stepline');
  editor.scrollIntoView({ line: highlighted_step_line_index, ch: 0 }, 60);
}
let schema_parse_timer = null;
editor.on('change', () => {
  if (error_line_widgets.length || !select_element('#errbar').hidden) clear_build_error();
  update_save_state();
  clearTimeout(schema_parse_timer);
  schema_parse_timer = setTimeout(refresh_schema_from_script, schema_parse_delay_in_milliseconds);
});
function refresh_schema_from_script() {
  const parsed_schema = parse_parameter_schema(editor.getValue());
  const describe_schema_shape = (parameter_schema) => JSON.stringify(parameter_schema.map((parameter) => [parameter.name, parameter.type]));
  if (describe_schema_shape(parsed_schema) !== describe_schema_shape(studio_state.parameter_schema)) set_parameter_schema(parsed_schema, true);
}

function parse_parameter_schema(script_source) {
  const params_match = script_source.match(/^params\s*=\s*(\{[\s\S]*?\})\s*$/m);
  if (!params_match) return [];
  const params_literal = params_match[1];
  try {
    const params_as_json = params_literal.replace(/#.*$/gm, '').replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null').replace(/,\s*}/g, '}');
    return Object.entries(JSON.parse(params_as_json)).map(([parameter_name, default_setting]) => ({ name: parameter_name, default: default_setting, type: infer_parameter_type(params_literal, parameter_name, default_setting) }));
  } catch (parse_error) { return studio_state.parameter_schema; }
}
function infer_parameter_type(params_literal, parameter_name, default_setting) {
  if (typeof default_setting === 'boolean') return 'bool';
  if (typeof default_setting !== 'number') return 'string';
  const numeric_literal = params_literal.match(new RegExp(`["']${parameter_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*:\\s*([-+0-9.eE]+)`));
  return numeric_literal && /[.eE]/.test(numeric_literal[1]) ? 'float' : 'int';
}

function log_message(message_text, css_class = '') {
  const logs_body = select_element('#logsBody');
  const time_of_day = new Date().toLocaleTimeString([], { hour12: false });
  logs_body.insertAdjacentHTML('beforeend', `<span class="t">${time_of_day}</span>  <span class="${css_class}">${escape_html(message_text)}</span>\n`);
  logs_body.scrollTop = logs_body.scrollHeight;
  select_element('#logsSum').textContent = message_text.split('\n')[0];
}
select_element('#logsToggle').onclick = () => select_element('#logs').classList.toggle('open');
function set_status(status_kind, status_text) {
  const status_element = select_element('#status');
  status_element.className = 'status ' + status_kind;
  status_element.querySelector('span').textContent = status_text;
}
const set_connection_status = (offline_text = 'Offline') => set_status(studio_state.is_online ? 'online' : 'offline', studio_state.is_online ? 'Online' : offline_text);
const show_progress = (is_busy) => select_element('#progress').classList.toggle('on', is_busy);
function show_notice(notice_html) {
  const notice_element = select_element('#notice');
  notice_element.hidden = !notice_html;
  if (!notice_html) return;
  notice_element.innerHTML = notice_html + '<button class="vc-x" aria-label="Dismiss">×</button>';
  notice_element.querySelector('.vc-x').onclick = () => { notice_element.hidden = true; };
  notice_element.querySelector('[data-settings]')?.addEventListener('click', () => open_menu('settingsMenu'));
}

function set_parameter_schema(parameter_schema, should_keep_overrides = true) {
  const previous_overrides = studio_state.parameter_overrides;
  const is_kept_override = (parameter) => should_keep_overrides && previous_overrides[parameter.name] != null && typeof previous_overrides[parameter.name] === typeof parameter.default && previous_overrides[parameter.name] !== parameter.default;
  studio_state.parameter_schema = parameter_schema || [];
  studio_state.parameter_overrides = Object.fromEntries(studio_state.parameter_schema.filter(is_kept_override).map((parameter) => [parameter.name, previous_overrides[parameter.name]]));
  render_parameters();
}
function slider_range_for_parameter(parameter) {
  const default_number = Number(parameter.default) || 0;
  const lowercase_name = parameter.name.toLowerCase();
  if (parameter.type === 'int' && /count|teeth|bolts|holes|n_|num|segments|rows|cols/.test(lowercase_name)) return [Math.max(1, Math.round(default_number / 4)), Math.max(default_number * 3, default_number + 8), 1];
  if (/angle|deg/.test(lowercase_name)) return [-180, 180, parameter.type === 'int' ? 1 : 0.5];
  const magnitude = Math.abs(default_number) || 10;
  const slider_maximum = default_number >= 0 ? magnitude * 3 : magnitude;
  const slider_minimum = default_number >= 0 ? (default_number === 0 ? 0 : Math.min(0, default_number) || +(magnitude * 0.1).toFixed(2)) : -magnitude * 3;
  const slider_step = parameter.type === 'int' ? 1 : magnitude >= 20 ? 0.5 : magnitude >= 2 ? 0.1 : 0.01;
  return [slider_minimum, slider_maximum, slider_step];
}
function render_parameters() {
  const parameters_element = select_element('#params');
  select_element('#paramCount').textContent = studio_state.parameter_schema.length || '';
  if (studio_state.parameter_schema.length) return parameters_element.replaceChildren(...studio_state.parameter_schema.map(create_parameter_row), create_parameters_footer());
  parameters_element.innerHTML = `<div class="vc-sel-empty">Define <code>params = {"width": 40}</code> at the top of the script to get live sliders. Each change rebuilds the model.</div>`;
}
function create_parameter_row(parameter) {
  const current_setting = studio_state.parameter_overrides[parameter.name] ?? parameter.default;
  if (parameter.type === 'bool') {
    const boolean_row = Object.assign(document.createElement('label'), { className: 'param-bool', innerHTML: `<span>${escape_html(parameter.name)}</span><span class="vc-switch"><input type="checkbox" ${current_setting ? 'checked' : ''}><i></i></span>` });
    boolean_row.querySelector('input').onchange = (change_event) => set_parameter(parameter, change_event.target.checked);
    return boolean_row;
  }
  const parameter_row = Object.assign(document.createElement('div'), { className: 'param' + (studio_state.parameter_overrides[parameter.name] != null ? ' mod' : '') });
  if (parameter.type !== 'string') return fill_numeric_parameter_row(parameter_row, parameter, current_setting);
  parameter_row.innerHTML = `<label title="${escape_html(parameter.name)}">${escape_html(parameter.name)}</label><input type="text" value="${escape_html(current_setting)}">`;
  parameter_row.querySelector('input').onchange = (change_event) => set_parameter(parameter, change_event.target.value, parameter_row);
  return parameter_row;
}
function fill_numeric_parameter_row(parameter_row, parameter, current_setting) {
  const [slider_minimum, slider_maximum, slider_step] = slider_range_for_parameter(parameter);
  parameter_row.innerHTML = `<label title="${escape_html(parameter.name)}">${escape_html(parameter.name.replace(/_/g, ' '))}</label><div class="param-field"><input type="range" min="${Math.min(slider_minimum, current_setting)}" max="${Math.max(slider_maximum, current_setting)}" step="${slider_step}" value="${current_setting}" aria-label="${escape_html(parameter.name)}"><input type="number" step="${slider_step}" value="${current_setting}"></div>`;
  const number_input = parameter_row.querySelector('input[type=number]'), range_input = parameter_row.querySelector('input[type=range]');
  paint_range_fill(range_input);
  range_input.oninput = () => { number_input.value = range_input.value; set_parameter(parameter, +range_input.value, parameter_row, 260); };
  number_input.onchange = () => {
    const typed_number = parameter.type === 'int' ? Math.round(+number_input.value) : +number_input.value;
    const accepted_number = isFinite(typed_number) ? typed_number : parameter.default;
    if (accepted_number > +range_input.max) range_input.max = accepted_number;
    if (accepted_number < +range_input.min) range_input.min = accepted_number;
    range_input.value = accepted_number;
    paint_range_fill(range_input);
    set_parameter(parameter, accepted_number, parameter_row, 0);
  };
  number_input.onkeydown = (key_event) => { if (key_event.key === 'Enter') number_input.blur(); };
  return parameter_row;
}
function create_parameters_footer() {
  const parameters_footer = Object.assign(document.createElement('div'), { className: 'params-foot', innerHTML: `<span>Drag a field or type a value</span><button>Reset all</button>` });
  parameters_footer.querySelector('button').onclick = () => { studio_state.parameter_overrides = {}; render_parameters(); schedule_build(0); };
  return parameters_footer;
}
let build_schedule_timer = null;
function set_parameter(parameter, new_setting, parameter_row, delay_in_milliseconds = 300) {
  if (new_setting === parameter.default) delete studio_state.parameter_overrides[parameter.name];
  else studio_state.parameter_overrides[parameter.name] = new_setting;
  parameter_row?.classList.toggle('mod', studio_state.parameter_overrides[parameter.name] != null);
  update_save_state();
  schedule_build(delay_in_milliseconds);
}
function schedule_build(delay_in_milliseconds) {
  clearTimeout(build_schedule_timer);
  build_schedule_timer = setTimeout(() => build({ is_from_parameters: true }), delay_in_milliseconds);
}

function build_request_body() {
  const quality_setting = select_element('#quality').value;
  return { script: editor.getValue(), params: { ...studio_state.parameter_overrides }, ...(quality_setting && quality_setting !== 'normal' ? { quality: quality_setting } : {}) };
}
function set_building(is_building) {
  select_element('#buildBtn').classList.toggle('busy', is_building);
  show_progress(is_building);
}
async function build({ is_from_parameters = false, is_quiet = false } = {}) {
  if (!studio_state.is_online) {
    show_notice(offline_notice_html('Building needs the BISCAD API.'));
    if (!is_quiet) viewer.flash('Building needs the API');
    return;
  }
  const build_sequence_number = ++studio_state.build_sequence_number;
  const is_latest_build = () => build_sequence_number === studio_state.build_sequence_number;
  set_building(true);
  set_status('busy', 'Building');
  const build_start_time_in_milliseconds = performance.now();
  try {
    const build_response = await api.post('/v1/build', build_request_body());
    if (!is_latest_build()) return;
    const round_trip_in_milliseconds = Math.round(performance.now() - build_start_time_in_milliseconds);
    if (build_response.param_schema && !is_from_parameters) set_parameter_schema(build_response.param_schema, true);
    if (!build_response.ok) return report_build_failure(build_response);
    await show_build_result(build_response, round_trip_in_milliseconds);
  } catch (request_error) {
    if (is_latest_build()) await report_build_request_error(request_error);
  } finally {
    if (is_latest_build()) set_building(false);
  }
}
select_element('#buildBtn').onclick = () => build();
function report_build_failure(build_response) {
  show_build_error(build_response.error);
  log_message(build_response.error || 'Build failed', 'e');
  if (build_response.logs) log_message(build_response.logs);
  set_status('error', 'Error');
  if (is_narrow_layout()) set_mobile_tab('code');
}
async function show_build_result(build_response, round_trip_in_milliseconds) {
  clear_build_error();
  studio_state.build_id = build_response.id || null;
  studio_state.build_summary = build_response.summary || null;
  studio_state.last_build_duration_in_milliseconds = build_response.summary?.timing_ms?.total ?? round_trip_in_milliseconds;
  const built_scene = build_response.scene || (build_response.links?.scene ? await api.get(build_response.links.scene) : null);
  if (built_scene) viewer.load_scene(built_scene, { keep_camera: !studio_state.is_first_load, version_id: studio_state.build_id });
  studio_state.is_first_load = false;
  steps_bar.set_steps(build_response.steps || [], { final_scene: built_scene });
  if (build_response.logs) log_message(build_response.logs.trimEnd());
  const triangle_count = build_response.summary?.triangles ?? viewer.triangle_count;
  log_message(`Built in ${format_number(studio_state.last_build_duration_in_milliseconds, 0)} ms · ${pluralize(viewer.parts.length, 'part')} · ${(triangle_count || 0).toLocaleString()} tris`, 'ok');
  set_status('online', 'Online');
  render_summary();
  update_save_state();
}
async function report_build_request_error(request_error) {
  log_message('Build request failed: ' + request_error.message, 'e');
  if ([401, 402, 429].includes(request_error.status)) show_notice(`<b>${request_error.status === 401 ? 'Auth' : 'Quota'}</b><span>${escape_html(request_error.message)}</span><button data-settings>API key</button>`);
  else if (!request_error.status) await check_online();
  else show_build_error(request_error.message);
  set_connection_status();
}

function render_summary() {
  const statistics = viewer.describe_model_statistics();
  const build_summary = studio_state.build_summary;
  const volume_in_cubic_millimeters = build_summary?.volume ?? statistics.volume_in_cubic_millimeters;
  const area_in_square_millimeters = build_summary?.area ?? statistics.area_in_square_millimeters;
  const bounding_size = build_summary?.bbox ? build_summary.bbox.max.map((maximum, axis_index) => maximum - build_summary.bbox.min[axis_index]) : statistics.bounding_box.size;
  const estimated_mass_in_grams = (density_in_grams_per_cubic_centimeter) => (volume_in_cubic_millimeters / 1000) * density_in_grams_per_cubic_centimeter;
  const format_mass = (mass_in_grams) => (mass_in_grams >= 1000 ? `${format_number(mass_in_grams / 1000, 3)} kg` : `${format_number(mass_in_grams, 1)} g`);
  const build_time_text = studio_state.last_build_duration_in_milliseconds != null ? `${format_number(studio_state.last_build_duration_in_milliseconds, 0)} ms` : null;
  select_element('#buildTime').textContent = build_time_text || (studio_state.is_online ? '' : 'sample');
  select_element('#statusBuild').textContent = build_time_text ? `Built in ${build_time_text}` : '';
  if (!viewer.parts.length) { select_element('#summary').innerHTML = '<div class="vc-sel-empty">No model yet.</div>'; return; }
  const validity_row = build_summary?.parts ? `<dt>Validity</dt>${build_summary.parts.some((part) => part.valid === false) ? '<dd class="bad">invalid solid</dd>' : '<dd>valid B-rep</dd>'}` : '';
  select_element('#summary').innerHTML = `
    <div class="big"><div><b>${format_number(volume_in_cubic_millimeters / 1000, 2)}</b><span>cm³ volume</span></div><div><b>${format_number(area_in_square_millimeters / 100, 1)}</b><span>cm² area</span></div></div>
    <dl class="kv">
      <dt class="grp">Mass</dt>
      <dt>Steel · 7.85</dt><dd>${format_mass(build_summary?.mass_g_steel ?? estimated_mass_in_grams(7.85))}</dd>
      <dt>Aluminium · 2.70</dt><dd>${format_mass(build_summary?.mass_g_aluminium ?? estimated_mass_in_grams(2.70))}</dd>
      <dt>PLA · 1.24</dt><dd>${format_mass(build_summary?.mass_g_pla ?? estimated_mass_in_grams(1.24))}</dd>
      <dt class="grp">Geometry</dt>
      <dt>Bounding box</dt><dd>${format_number(bounding_size[0], 1)} × ${format_number(bounding_size[1], 1)} × ${format_number(bounding_size[2], 1)}</dd>
      ${build_summary?.center_of_mass ? `<dt>Center of mass</dt><dd>${format_vector(build_summary.center_of_mass, 1)}</dd>` : ''}
      <dt>Parts</dt><dd>${statistics.part_count}</dd>
      <dt>Faces · edges</dt><dd>${statistics.face_count} · ${statistics.edge_count}</dd>
      <dt>Triangles</dt><dd>${statistics.triangle_count.toLocaleString()}</dd>
      ${validity_row}
      ${!build_summary ? `<dt>Source</dt><dd>mesh estimate</dd>` : ''}
    </dl>`;
}

async function load_examples() {
  const read_example_list = (examples_response) => (Array.isArray(examples_response) ? examples_response : examples_response.examples || []);
  const examples_from_api = studio_state.is_online ? await api.get('/v1/examples').then(read_example_list).catch(() => []) : [];
  studio_state.examples = examples_from_api.length ? examples_from_api : bundled_sample_models.map((sample_model) => ({ ...sample_model }));
  const examples_select = select_element('#examples');
  examples_select.innerHTML = `<option value="" disabled>Examples</option>` + studio_state.examples.map((example) => `<option value="${escape_html(example.id)}">${escape_html(example.name || example.id)}</option>`).join('');
  examples_select.onchange = () => open_example(examples_select.value);
}
async function show_bundled_sample(sample_id) {
  try { await viewer.load(resolve_sample_scene_url(sample_id)); } catch (sample_error) { return false; }
  studio_state.is_first_load = false;
  return true;
}
async function open_example(example_id) {
  const example = studio_state.examples.find((candidate_example) => candidate_example.id === example_id) || { id: example_id };
  Object.assign(studio_state, { example_id, document_id: null, version_id: null, build_id: null, saved_script: null, saved_parameters: null, build_summary: null, last_build_duration_in_milliseconds: null, versions: [], parameter_overrides: {} });
  select_element('#examples').value = example_id;
  render_history();
  select_element('#docName').value = example.name || example_id;
  editor.setValue(example.script || `# ${example.name || example_id}\n# Offline demo: this sample is a pre-built scene.\n# Connect the BISCAD API (settings, top right) to edit and rebuild.\n`);
  editor.clearHistory();
  set_parameter_schema(example.script ? parse_parameter_schema(example.script) : [], false);
  steps_bar.set_steps([]);
  viewer.set_ghost(null);
  studio_state.is_first_load = true;
  const is_sample_shown = bundled_sample_ids.has(example_id) && await show_bundled_sample(example_id);
  render_summary();
  update_save_state();
  history.replaceState(null, '', `?example=${encodeURIComponent(example_id)}`);
  if (studio_state.is_online && example.script) build({ is_quiet: true });
  else if (!is_sample_shown) viewer.clear();
}

const current_version_or_build_id = () => studio_state.version_id || studio_state.build_id;
const has_unsaved_edits = () => editor.getValue() !== studio_state.saved_script || JSON.stringify(studio_state.parameter_overrides) !== JSON.stringify(studio_state.saved_parameters || {});
function update_save_state() {
  const version_badge = select_element('#verBadge');
  const is_edited = !!studio_state.version_id && has_unsaved_edits();
  version_badge.textContent = studio_state.version_id ? studio_state.version_id + (is_edited ? ' · edited' : '') : 'unsaved';
  version_badge.classList.toggle('saved', !!studio_state.version_id && !is_edited);
  const exportable_id = current_version_or_build_id();
  select_all_elements('#exportMenu [data-fmt], #exportMenu [data-open]').forEach((export_button) => { export_button.disabled = !exportable_id; });
  select_element('#exportNote').textContent = exportable_id ? (studio_state.version_id ? '' : 'From the last build — save to keep it in history.') : (studio_state.is_online ? 'Build the model to export.' : 'Exports need the BISCAD API.');
}
function show_version_steps(version_id, known_steps, final_scene, handle_failure = () => {}) {
  if (known_steps?.length) return steps_bar.set_steps(known_steps, { final_scene });
  api.get(`/v1/versions/${version_id}/steps`).then((steps_response) => steps_bar.set_steps(steps_response.steps || [], { final_scene })).catch(handle_failure);
}

async function post_new_version(version_payload) {
  if (!studio_state.document_id) {
    const document_response = await api.post('/v1/documents', { name: select_element('#docName').value.trim() || 'Untitled part', ...version_payload });
    studio_state.document_id = document_response.document?.id;
    return document_response.version;
  }
  const version_response = await api.post(`/v1/documents/${studio_state.document_id}/versions`, { ...version_payload, parent: studio_state.version_id, message: `edit ${new Date().toLocaleTimeString([], { hour12: false })}` });
  return version_response.version || version_response;
}
async function save_new_version() {
  const version_payload = { script: editor.getValue(), params: { ...studio_state.parameter_overrides } };
  const saved_version = await post_new_version(version_payload);
  if (!saved_version?.id) throw new Error('no version returned');
  Object.assign(studio_state, { version_id: saved_version.id, saved_script: version_payload.script, saved_parameters: { ...studio_state.parameter_overrides } });
  if (saved_version.ok === false || saved_version.status === 'error') {
    show_build_error(saved_version.error);
    log_message('Saved, but the build failed: ' + saved_version.error, 'e');
  } else {
    viewer.version_id = studio_state.version_id;
    if (saved_version.summary) studio_state.build_summary = saved_version.summary;
    show_version_steps(studio_state.version_id, saved_version.steps, viewer.loaded_scene);
    log_message(`Saved ${studio_state.version_id} to ${studio_state.document_id}`, 'ok');
  }
  history.replaceState(null, '', `?v=${encodeURIComponent(studio_state.version_id)}`);
  update_save_state();
  refresh_history();
  viewer.flash('Saved ' + studio_state.version_id);
  set_status('online', 'Online');
  return studio_state.version_id;
}
async function save() {
  if (!studio_state.is_online) {
    viewer.flash('Saving needs the API');
    show_notice(offline_notice_html('Saving needs the BISCAD API.'));
    return null;
  }
  const save_button = select_element('#saveBtn');
  save_button.disabled = true;
  set_status('busy', 'Saving');
  try { return await save_new_version(); } catch (save_error) {
    log_message('Save failed: ' + save_error.message, 'e');
    viewer.flash('Save failed: ' + save_error.message);
    set_status('online', 'Online');
    return null;
  } finally { save_button.disabled = false; }
}
select_element('#saveBtn').onclick = () => save();

async function refresh_history() {
  const document_response = studio_state.document_id ? await api.get(`/v1/documents/${studio_state.document_id}`).catch(() => null) : { versions: [] };
  if (document_response) {
    studio_state.versions = (document_response.versions || []).slice().sort((first_version, second_version) => (second_version.created || 0) - (first_version.created || 0));
    if (document_response.document?.name) select_element('#docName').value = document_response.document.name;
  }
  render_history();
}
function render_history() {
  const history_element = select_element('#history');
  select_element('#verCount').textContent = studio_state.versions.length || '';
  if (studio_state.versions.length) return history_element.replaceChildren(...studio_state.versions.map(create_history_entry));
  history_element.innerHTML = '<div class="vc-empty">Save to start a version history.</div>';
}
function create_history_entry(saved_version) {
  const saved_at_text = saved_version.created ? new Date(saved_version.created * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const history_button = Object.assign(document.createElement('button'), {
    className: 'hist' + (saved_version.id === studio_state.version_id ? ' on' : '') + (saved_version.status === 'error' ? ' err' : ''),
    innerHTML: `<i></i><div><b>${escape_html(saved_version.id)}</b><span>${escape_html(saved_version.message || (saved_version.status === 'error' ? 'build error' : 'version'))}</span></div><small>${escape_html(saved_at_text)}</small>`,
  });
  history_button.onclick = () => load_version(saved_version.id);
  return history_button;
}
async function load_version_scene(saved_version, should_keep_camera) {
  const version_scene = await api.get(saved_version.links?.scene || `/v1/versions/${saved_version.id}/scene`);
  viewer.load_scene(version_scene, { keep_camera: should_keep_camera, version_id: saved_version.id });
  return version_scene;
}
async function show_saved_version(saved_version) {
  Object.assign(studio_state, { version_id: saved_version.id, build_id: saved_version.id, document_id: saved_version.document_id || studio_state.document_id });
  editor.setValue(saved_version.script || '');
  editor.clearHistory();
  studio_state.parameter_overrides = { ...(saved_version.params || {}) };
  set_parameter_schema(saved_version.param_schema || parse_parameter_schema(saved_version.script || ''), true);
  Object.assign(studio_state, { saved_script: editor.getValue(), saved_parameters: { ...studio_state.parameter_overrides }, build_summary: saved_version.summary || null, last_build_duration_in_milliseconds: saved_version.summary?.timing_ms?.total ?? null });
  if (saved_version.status === 'error' || saved_version.ok === false) {
    show_build_error(saved_version.error);
    viewer.clear();
  } else {
    const version_scene = await load_version_scene(saved_version, !studio_state.is_first_load);
    studio_state.is_first_load = false;
    show_version_steps(saved_version.id, saved_version.steps, version_scene, () => steps_bar.set_steps([]));
  }
  history.replaceState(null, '', `?v=${encodeURIComponent(saved_version.id)}`);
  select_element('#examples').value = '';
  await refresh_history();
  update_save_state();
  render_summary();
  log_message(`Loaded ${saved_version.id}`, 'ok');
}
async function load_version(version_id) {
  show_progress(true);
  try { await show_saved_version(await api.get(`/v1/versions/${encodeURIComponent(version_id)}`)); } catch (load_error) {
    log_message(`Could not load ${version_id}: ${load_error.message}`, 'e');
    viewer.flash('Could not load version');
  } finally { show_progress(false); }
}

const document_file_stem = () => (select_element('#docName').value || 'biscad').trim().replace(/[^\w.-]+/g, '_').slice(0, 60) || 'biscad';
async function export_file(version_id, file_format) {
  log_message(`Exporting ${file_format.toUpperCase()}…`);
  show_progress(true);
  try {
    await api.download(`/v1/versions/${version_id}/export/${file_format}`, `${document_file_stem()}.${file_format}`);
    log_message(`Exported ${document_file_stem()}.${file_format}`, 'ok');
  } catch (export_error) {
    log_message(`Export ${file_format} failed: ${export_error.message}`, 'e');
    viewer.flash('Export failed');
  } finally { show_progress(false); }
}
async function open_version_resource(resource_path) {
  if (!api.api_key) return window.open(api.resolve_url(resource_path), '_blank');
  const opened_window = window.open('', '_blank');
  try {
    const resource_url = await api.blob_url(resource_path);
    if (opened_window) opened_window.location.href = resource_url;
    else window.open(resource_url, '_blank');
  } catch (open_error) { opened_window?.close(); viewer.flash('Could not open: ' + open_error.message); }
}
on_button_click('#exportMenu', (export_button) => {
  if (export_button.disabled) return;
  close_menus();
  if (export_button.dataset.a === 'png') return viewer.screenshot({ should_download: true, file_name: document_file_stem() + '.png' });
  const exportable_id = current_version_or_build_id();
  if (exportable_id && export_button.dataset.fmt) export_file(exportable_id, export_button.dataset.fmt);
  else if (exportable_id && export_button.dataset.open) open_version_resource(`/v1/versions/${exportable_id}/${export_button.dataset.open}`);
});

function build_share_links(version_id) {
  const viewer_url = new URL('view.html', location.href);
  viewer_url.searchParams.set('v', version_id);
  if (api.base_url) viewer_url.searchParams.set('api', api.base_url);
  const embed_url = new URL(viewer_url);
  embed_url.searchParams.set('embed', '1');
  return { viewer_link: viewer_url.href, embed_code: `<iframe src="${embed_url.href}" width="100%" height="480" style="border:0" allow="fullscreen" loading="lazy"></iframe>` };
}
async function open_share_menu() {
  const needs_save = !studio_state.version_id || has_unsaved_edits();
  if (needs_save && !studio_state.is_online) return viewer.flash('Sharing needs the API');
  const shared_version_id = needs_save ? await save() : studio_state.version_id;
  if (!shared_version_id) return;
  const { viewer_link, embed_code } = build_share_links(shared_version_id);
  select_element('#shareLink').value = viewer_link;
  select_element('#embedCode').value = embed_code;
  select_element('#openViewer').href = viewer_link;
  open_menu('shareMenu');
}
select_element('#shareBtn').onclick = (click_event) => {
  click_event.stopPropagation();
  if (select_element('#shareMenu').classList.contains('on')) close_menus();
  else open_share_menu();
};
select_all_elements('[data-copy]').forEach((copy_button) => copy_button.addEventListener('click', async () => {
  await copy_text_to_clipboard(select_element('#' + copy_button.dataset.copy).value);
  const original_label = copy_button.textContent;
  copy_button.textContent = 'Copied';
  setTimeout(() => { copy_button.textContent = original_label; }, copy_feedback_duration_in_milliseconds);
}));

let agent_view_name = 'iso';
async function show_agent_view() {
  const exportable_id = current_version_or_build_id();
  if (!exportable_id) return viewer.flash(studio_state.is_online ? 'Build the model first' : 'Agent view needs the API');
  select_element('#agentModal').hidden = false;
  select_all_elements('#agentViews button').forEach((view_button) => view_button.classList.toggle('on', view_button.dataset.v === agent_view_name));
  const highlighted_ids = viewer.selection.filter((entity_id) => entity_id.includes('/')).join(',');
  const highlight_query = highlighted_ids ? '&highlight=' + encodeURIComponent(highlighted_ids) : '';
  const render_path = agent_view_name === 'grid'
    ? `/v1/versions/${exportable_id}/render-grid.png?labels=1${highlight_query}`
    : `/v1/versions/${exportable_id}/render.png?view=${agent_view_name}&labels=1&theme=dark&w=1200&h=900${highlight_query}`;
  select_element('#agentUrl').textContent = render_path.replace(/&w=1200&h=900/, '');
  select_element('#agentLoad').classList.add('on');
  try {
    const render_url = await api.blob_url(render_path);
    const agent_image = select_element('#agentImg');
    if (agent_image.src.startsWith('blob:')) URL.revokeObjectURL(agent_image.src);
    agent_image.src = render_url;
  } catch (render_error) { viewer.flash('Render failed: ' + render_error.message); }
  finally { select_element('#agentLoad').classList.remove('on'); }
}
select_element('#agentBtn').onclick = show_agent_view;
on_button_click('#agentViews', (view_button) => { agent_view_name = view_button.dataset.v; show_agent_view(); });
select_element('#agentModal').addEventListener('click', (click_event) => { if (click_event.target.id === 'agentModal' || click_event.target.closest('[data-close]')) select_element('#agentModal').hidden = true; });

function close_menus() { select_all_elements('.menu.on').forEach((menu_element) => menu_element.classList.remove('on')); }
function open_menu(menu_id) { close_menus(); select_element('#' + menu_id).classList.add('on'); }
function toggle_menu_from_button(menu_id, prepare_and_open_menu) {
  return (click_event) => {
    click_event.stopPropagation();
    const was_open = select_element('#' + menu_id).classList.contains('on');
    close_menus();
    if (!was_open) prepare_and_open_menu();
  };
}
select_element('#exportBtn').onclick = toggle_menu_from_button('exportMenu', () => { update_save_state(); open_menu('exportMenu'); });
select_element('#settingsBtn').onclick = toggle_menu_from_button('settingsMenu', () => {
  select_element('#apiBase').value = api.base_url;
  select_element('#apiKey').value = api.api_key;
  open_menu('settingsMenu');
  load_account_note();
});
select_element('#status').onclick = (click_event) => { click_event.stopPropagation(); select_element('#settingsBtn').click(); };
document.addEventListener('pointerdown', (pointer_event) => { if (!pointer_event.target.closest('.menuw')) close_menus(); });
select_element('#settingsSave').onclick = async () => {
  api.set_base_url(select_element('#apiBase').value);
  api.api_key = select_element('#apiKey').value.trim();
  write_stored_setting('biscad.quality', select_element('#quality').value);
  close_menus();
  const was_online = studio_state.is_online;
  await check_online();
  if (studio_state.is_online && !was_online) {
    await load_examples();
    show_notice(null);
    if (studio_state.example_id) select_element('#examples').value = studio_state.example_id;
    build({ is_quiet: true });
  }
  check_agent();
};
const stored_quality_setting = read_stored_setting('biscad.quality');
if (stored_quality_setting) select_element('#quality').value = stored_quality_setting;
async function load_account_note() {
  const account_note = select_element('#meNote');
  if (!studio_state.is_online) { account_note.textContent = 'API unreachable — running the offline demo.'; return; }
  try {
    const account = await api.get('/v1/me');
    const usage = account.usage || {};
    account_note.textContent = `${account.anonymous ? 'Anonymous playground' : 'Plan: ' + (account.plan || '—')} · ${usage.builds ?? usage.calls_month ?? 0} builds this month`;
  } catch (account_error) { account_note.textContent = account_error.status === 401 ? 'Key rejected — check it.' : 'Anonymous use works with a playground quota.'; }
}
async function check_online() {
  set_status('busy', 'Connecting');
  studio_state.is_online = await api.is_reachable();
  set_connection_status('Offline demo');
  const api_state_element = select_element('#statusApi');
  api_state_element.className = 'api-state ' + (studio_state.is_online ? 'online' : 'offline');
  api_state_element.textContent = studio_state.is_online ? `API ${(api.base_url || location.origin).replace(/^https?:\/\//, '')}` : 'API offline · samples only';
  if (!studio_state.is_online) show_notice(offline_notice_html('Samples only — building needs the BISCAD API.'));
  update_save_state();
}

let ask_mode = 'modify';
on_button_click('#askMode', (mode_button) => {
  ask_mode = mode_button.dataset.v;
  select_all_elements('#askMode button').forEach((candidate_button) => candidate_button.classList.toggle('on', candidate_button === mode_button));
});
const ask_input = select_element('#askInput');
ask_input.addEventListener('input', () => { ask_input.style.height = 'auto'; ask_input.style.height = Math.min(ask_input.scrollHeight, 120) + 'px'; });
ask_input.addEventListener('keydown', (key_event) => { if (key_event.key === 'Enter' && !key_event.shiftKey) run_shortcut(key_event, ask_agent); });
select_element('#askGo').onclick = () => ask_agent();
select_element('.ask-k').textContent = is_mac_platform ? '⌘K' : 'Ctrl K';
async function check_agent() {
  const agent_status = studio_state.is_online ? await api.get('/v1/agent').catch(() => ({ available: false })) : { available: false };
  studio_state.agent_status = agent_status;
  const ask_box = select_element('#ask');
  ask_box.classList.toggle('disabled', !agent_status.available);
  const tooltip_text = agent_status.available ? `Text-to-CAD · ${agent_status.model || 'Claude'} · up to ${agent_status.max_rounds || '?'} rounds` : (studio_state.is_online ? "Text-to-CAD isn't enabled on this server" : 'Text-to-CAD needs the BISCAD API');
  ask_box.title = tooltip_text;
  ask_input.disabled = !agent_status.available;
  select_element('#askGo').disabled = !agent_status.available;
  ask_input.placeholder = agent_status.available ? (ask_mode === 'new' ? 'Describe a new part…' : 'Describe a part, or a change…') : tooltip_text;
}

let is_asking_agent = false;
async function ask_agent() {
  const prompt_text = ask_input.value.trim();
  if (!prompt_text || is_asking_agent || !studio_state.agent_status.available) return;
  if (!api.api_key) {
    set_ask_status('An API key is required — add one in settings.', 'err');
    return open_menu('settingsMenu');
  }
  is_asking_agent = true;
  const ask_start_time_in_milliseconds = Date.now();
  const elapsed_seconds = () => Math.round((Date.now() - ask_start_time_in_milliseconds) / 1000);
  const progress_timer = setInterval(() => {
    const seconds_elapsed = elapsed_seconds();
    set_ask_status(`Claude is designing… round ${Math.min(studio_state.agent_status.max_rounds || 9, 1 + Math.floor(seconds_elapsed / estimated_agent_round_duration_in_seconds))} · ${seconds_elapsed}s`, 'busy');
  }, agent_progress_refresh_in_milliseconds);
  set_ask_status('Claude is designing…', 'busy');
  show_progress(true);
  try { await run_agent_request(prompt_text, elapsed_seconds); } catch (ask_error) { report_agent_failure(ask_error); } finally {
    clearInterval(progress_timer);
    is_asking_agent = false;
    show_progress(false);
  }
}
async function run_agent_request(prompt_text, elapsed_seconds) {
  const modification_context = ask_mode === 'modify' ? { script: editor.getValue(), ...(studio_state.document_id ? { document_id: studio_state.document_id } : {}) } : {};
  const agent_response = await api.post('/v1/agent', { prompt: prompt_text, ...modification_context }, { timeout_in_milliseconds: agent_timeout_in_milliseconds });
  if (!agent_response.ok && !agent_response.version) throw Object.assign(new Error(agent_response.error?.message || agent_response.error || 'Agent failed'), { response_body: agent_response });
  const agent_rounds = agent_response.rounds || [];
  render_agent_rounds(agent_rounds);
  if (agent_response.version) await adopt_agent_version(agent_response.version);
  set_ask_status(agent_response.ok ? `Done in ${elapsed_seconds()}s · ${pluralize(agent_rounds.length, 'round')}` : (agent_response.error?.message || agent_response.error || 'Finished with errors'), agent_response.ok ? '' : 'err');
  log_message(`Ask: ${prompt_text}`, agent_response.ok ? 'ok' : 'e');
  update_save_state();
  render_summary();
}
async function adopt_agent_version(agent_version) {
  if (agent_version.script) {
    editor.setValue(agent_version.script);
    set_parameter_schema(agent_version.param_schema || parse_parameter_schema(agent_version.script), false);
  }
  if (agent_version.document_id) studio_state.document_id = agent_version.document_id;
  if (!agent_version.id) return;
  studio_state.build_id = agent_version.id;
  if (agent_version.document_id) {
    Object.assign(studio_state, { version_id: agent_version.id, saved_script: editor.getValue(), saved_parameters: {} });
    refresh_history();
  }
  const agent_scene = await load_version_scene(agent_version, false);
  studio_state.build_summary = agent_version.summary || null;
  steps_bar.set_steps(agent_version.steps || [], { final_scene: agent_scene });
  if (!agent_version.steps) show_version_steps(agent_version.id, null, agent_scene);
}
function report_agent_failure(ask_error) {
  const failure_message = { 401: 'API key required or invalid.', 402: 'Out of quota for text-to-CAD.', 501: "Text-to-CAD isn't enabled on this server." }[ask_error.status] || ask_error.message;
  set_ask_status(failure_message, 'err');
  if (ask_error.response_body?.rounds) render_agent_rounds(ask_error.response_body.rounds);
  log_message('Ask failed: ' + failure_message, 'e');
}
function set_ask_status(status_text, css_class = '') {
  Object.assign(select_element('#askStatus'), { textContent: status_text, className: 'ask-status ' + css_class, title: status_text });
}
function render_agent_rounds(agent_rounds) {
  const rounds_element = select_element('#rounds');
  rounds_element.hidden = !agent_rounds.length;
  rounds_element.replaceChildren(...agent_rounds.map((agent_round, round_index) => {
    const round_button = Object.assign(document.createElement('button'), {
      className: 'round' + (agent_round.ok ? '' : ' bad') + (round_index === agent_rounds.length - 1 ? ' on' : ''),
      innerHTML: `<i></i>R${round_index + 1}`,
      title: agent_round.ok ? (agent_round.note || 'ok') : (agent_round.error || 'failed'),
    });
    round_button.onclick = () => show_agent_round(agent_round, round_index, round_button);
    return round_button;
  }));
}
async function show_agent_round(agent_round, round_index, round_button) {
  if (!agent_round.version_id) return;
  select_all_elements('.round', select_element('#rounds')).forEach((candidate_button) => candidate_button.classList.toggle('on', candidate_button === round_button));
  try {
    viewer.load_scene(await api.get(`/v1/versions/${agent_round.version_id}/scene`), { keep_camera: true, version_id: agent_round.version_id });
    set_ask_status(`Round ${round_index + 1}: ${agent_round.note || (agent_round.ok ? 'ok' : agent_round.error || '')}`);
  } catch (round_error) { set_ask_status(`Round ${round_index + 1} has no geometry${agent_round.error ? ': ' + agent_round.error : ''}`, 'err'); }
}

select_all_elements('.sec-h').forEach((section_header) => section_header.addEventListener('click', () => section_header.parentElement.classList.toggle('closed')));
function open_section(section_id) { select_element('#' + section_id).classList.remove('closed'); }
select_element('#secHistory').classList.add('closed');
const resizer_element = select_element('#resizer');
let drag_start_x_in_pixels = 0, drag_start_width_in_pixels = 0;
const stored_left_panel_width_in_pixels = +read_stored_setting('biscad.left');
if (stored_left_panel_width_in_pixels > 280) document.body.style.setProperty('--left', stored_left_panel_width_in_pixels + 'px');
resizer_element.addEventListener('pointerdown', (pointer_event) => {
  drag_start_x_in_pixels = pointer_event.clientX;
  drag_start_width_in_pixels = select_element('#left').offsetWidth;
  resizer_element.setPointerCapture(pointer_event.pointerId);
  resizer_element.classList.add('drag');
});
resizer_element.addEventListener('pointermove', (pointer_event) => {
  if (!resizer_element.classList.contains('drag')) return;
  document.body.style.setProperty('--left', Math.max(300, Math.min(innerWidth * 0.6, drag_start_width_in_pixels + pointer_event.clientX - drag_start_x_in_pixels)) + 'px');
  editor.refresh();
});
resizer_element.addEventListener('pointerup', () => {
  resizer_element.classList.remove('drag');
  write_stored_setting('biscad.left', select_element('#left').offsetWidth);
});

function switch_body_mode(class_prefix, mode_names, chosen_mode, mode_buttons_selector, read_button_mode) {
  document.body.classList.remove(...mode_names.map((mode_name) => class_prefix + mode_name));
  document.body.classList.add(class_prefix + chosen_mode);
  select_all_elements(mode_buttons_selector).forEach((mode_button) => mode_button.classList.toggle('on', read_button_mode(mode_button) === chosen_mode));
}
function set_workspace(workspace_name) {
  switch_body_mode('ws-', ['script', 'model', 'analyze'], workspace_name, '#workspaces button', (workspace_button) => workspace_button.dataset.ws);
  if (workspace_name === 'analyze') { ['secModel', 'secSel', 'secParts'].forEach(open_section); select_element('#secParams').classList.add('closed'); }
  if (workspace_name === 'script') { open_section('secParams'); setTimeout(() => editor.refresh(), 0); }
}
on_button_click('#workspaces', (workspace_button) => set_workspace(workspace_button.dataset.ws));
function set_mobile_tab(tab_name) {
  switch_body_mode('tab-', ['code', 'model', 'inspect'], tab_name, '#mtabs button', (tab_button) => tab_button.dataset.tab);
  if (tab_name === 'code') setTimeout(() => editor.refresh(), 0);
}
on_button_click('#mtabs', (tab_button) => {
  if (innerWidth <= narrow_layout_width_in_pixels || tab_button.dataset.tab !== 'inspect') return set_mobile_tab(tab_button.dataset.tab);
  document.body.classList.toggle('show-inspect');
  tab_button.classList.toggle('on');
});

const is_typing_target = (event_target) => !!event_target?.closest?.('input, textarea, select, button, [contenteditable="true"], .CodeMirror');
function run_shortcut(key_event, shortcut_action) { key_event.preventDefault(); shortcut_action(); }
function focus_ask_input() {
  if (is_narrow_layout()) set_mobile_tab('code');
  ask_input.focus();
}
window.addEventListener('keydown', (key_event) => {
  const has_modifier = key_event.metaKey || key_event.ctrlKey;
  const lowercase_key = (key_event.key || '').toLowerCase();
  if (has_modifier && key_event.key === 'Enter') return run_shortcut(key_event, () => build());
  if (has_modifier && lowercase_key === 's') return run_shortcut(key_event, () => save());
  if (has_modifier && lowercase_key === 'k') return run_shortcut(key_event, focus_ask_input);
  if (key_event.key === 'Escape') { close_menus(); select_element('#agentModal').hidden = true; return; }
  if (has_modifier || is_typing_target(key_event.target) || steps_bar.steps.length <= 1) return;
  if (key_event.key === 'ArrowLeft' || key_event.key === 'ArrowRight') return run_shortcut(key_event, () => steps_bar.step_by(key_event.key === 'ArrowLeft' ? -1 : 1));
  if (key_event.key === ' ') run_shortcut(key_event, () => steps_bar.toggle_playback());
});
select_element('#docName').addEventListener('input', () => update_viewport_info_overlay());
select_element('#buildBtn').title = `Build (${is_mac_platform ? '⌘' : 'Ctrl'} Enter)`;
select_element('#buildBtn kbd').textContent = is_mac_platform ? '⌘↵' : 'Ctrl ↵';

(async function boot_studio() {
  const page_query = new URLSearchParams(location.search);
  render_parameters();
  await check_online();
  await load_examples();
  check_agent();
  const requested_version_id = page_query.get('v');
  if (requested_version_id && studio_state.is_online) return load_version(requested_version_id);
  if (requested_version_id) log_message(`Version ${requested_version_id} needs the API — showing a sample instead.`, 'e');
  const requested_example_id = page_query.get('example') || page_query.get('sample');
  const first_example = (requested_example_id && studio_state.examples.find((example) => example.id === requested_example_id)) || studio_state.examples.find((example) => example.id === 'quadruped') || studio_state.examples[0];
  if (first_example) await open_example(first_example.id);
  log_message(studio_state.is_online ? `Connected to ${api.base_url || location.origin}` : 'Offline demo — samples only');
})();
