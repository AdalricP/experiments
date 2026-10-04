const select_all = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const prefers_reduced_motion_for_site = matchMedia("(prefers-reduced-motion: reduce)").matches;
const replay_step_interval_in_milliseconds = 2200;
const key_request_timeout_in_milliseconds = 12000;
const copy_feedback_duration_in_milliseconds = 1600;
const docs_heading_activation_line_in_pixels = 140;

function read_stored_setting(setting_name) {
  try { return localStorage.getItem(setting_name); } catch (storage_error) { return null; }
}

function write_stored_setting(setting_name, setting_text) {
  try { setting_text === null ? localStorage.removeItem(setting_name) : localStorage.setItem(setting_name, setting_text); } catch (storage_error) { return; }
}

function resolve_api_base_url() {
  const api_override_from_query = new URLSearchParams(location.search).get("api");
  const should_reset_override = api_override_from_query === "" || api_override_from_query === "reset";
  if (api_override_from_query !== null) write_stored_setting("biscad-api", should_reset_override ? null : api_override_from_query.replace(/\/+$/, ""));
  const page_origin = /^https?:/.test(location.origin) ? location.origin : "http://localhost:8000";
  return (read_stored_setting("biscad-api") || window.BISCAD_DEFAULT_API || page_origin).replace(/\/+$/, "");
}

function fill_code_placeholders(api_base_url, saved_api_key) {
  select_all(".host").forEach(element => (element.textContent = api_base_url));
  select_all(".host_mcp").forEach(element => (element.textContent = api_base_url + "/mcp"));
  if (saved_api_key) select_all(".api_key").forEach(element => (element.textContent = saved_api_key));
}

async function copy_text_to_clipboard(text_to_copy) {
  try { await navigator.clipboard.writeText(text_to_copy); return true; } catch (clipboard_error) { return false; }
}

async function copy_visible_code_block(click_event) {
  const copy_button = click_event.target.closest("[data-copy]");
  const code_box = copy_button && copy_button.closest(".code");
  const visible_pre = code_box && select_all("pre", code_box).find(pre_element => !pre_element.hidden);
  if (!visible_pre) return;
  const was_copied = await copy_text_to_clipboard(visible_pre.textContent.replace(/\n$/, ""));
  const copy_label = copy_button.querySelector(".copy_label");
  copy_label.textContent = was_copied ? "Copied" : "Press ⌘C";
  setTimeout(() => (copy_label.textContent = "Copy"), copy_feedback_duration_in_milliseconds);
}

function select_code_tab(tab_buttons, chosen_tab) {
  tab_buttons.forEach(tab_button => {
    const is_chosen = tab_button === chosen_tab;
    tab_button.setAttribute("aria-selected", is_chosen);
    tab_button.tabIndex = is_chosen ? 0 : -1;
    document.getElementById(tab_button.getAttribute("aria-controls")).hidden = !is_chosen;
  });
  write_stored_setting("biscad-lang", chosen_tab.textContent.trim());
}

function wire_code_tabs(tab_box) {
  const tab_buttons = select_all('[role="tab"]', tab_box);
  tab_buttons.forEach((tab_button, tab_index) => {
    tab_button.addEventListener("click", () => select_code_tab(tab_buttons, tab_button));
    tab_button.addEventListener("keydown", key_event => {
      const step_direction = { ArrowRight: 1, ArrowLeft: -1 }[key_event.key];
      if (!step_direction) return;
      const next_tab = tab_buttons[(tab_index + step_direction + tab_buttons.length) % tab_buttons.length];
      select_code_tab(tab_buttons, next_tab);
      next_tab.focus();
    });
  });
  const preferred_tab = tab_buttons.find(tab_button => tab_button.textContent.trim() === read_stored_setting("biscad-lang"));
  if (preferred_tab) select_code_tab(tab_buttons, preferred_tab);
}

async function load_hero_viewer(viewer_frame) {
  const viewer_iframe = viewer_frame.querySelector("iframe");
  const viewer_source = viewer_iframe.dataset.src;
  const viewer_response = await fetch(viewer_source.split("?")[0], { method: "HEAD", cache: "no-store" }).catch(() => null);
  if (!viewer_response || !viewer_response.ok) {
    viewer_frame.querySelector(".screen_label").innerHTML = 'Live viewer offline · <a href="studio.html">open the studio</a>';
    return;
  }
  viewer_iframe.addEventListener("load", () => setTimeout(() => viewer_frame.classList.add("is_ready"), 350), { once: true });
  viewer_iframe.src = viewer_source;
}

function describe_key_request_failure(http_response, response_body, api_base_url) {
  const server_message = response_body && (response_body.detail || response_body.error);
  if (http_response.status === 429) return "Too many requests. Try again in one minute.";
  if (server_message) return typeof server_message === "string" ? server_message : JSON.stringify(server_message);
  return `The key service at ${api_base_url} did not answer (HTTP ${http_response.status}). Try again soon, or self-host.`;
}

async function request_api_key(email_address, api_base_url) {
  const abort_controller = new AbortController();
  const abort_timer = setTimeout(() => abort_controller.abort(), key_request_timeout_in_milliseconds);
  const http_response = await fetch(api_base_url + "/v1/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email_address }),
    signal: abort_controller.signal,
  }).finally(() => clearTimeout(abort_timer));
  const response_body = await http_response.json().catch(() => null);
  if (!http_response.ok || !response_body || !response_body.api_key) throw new Error(describe_key_request_failure(http_response, response_body, api_base_url));
  return response_body;
}

function show_key_status(status_element, status_text, is_error) {
  status_element.textContent = status_text;
  status_element.classList.toggle("is_error", is_error);
}

async function submit_key_form(submit_event, api_base_url) {
  submit_event.preventDefault();
  const key_form = submit_event.target;
  const status_element = document.getElementById("key-status");
  const email_address = key_form.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email_address)) {
    show_key_status(status_element, "Enter a valid email address.", true);
    return key_form.email.focus();
  }
  const submit_button = key_form.querySelector("button[type=submit]");
  submit_button.disabled = true;
  show_key_status(status_element, "Creating your key…", false);
  try {
    const created_key = await request_api_key(email_address, api_base_url);
    document.getElementById("key-value").textContent = created_key.api_key;
    document.getElementById("key-result").hidden = false;
    write_stored_setting("biscad.key", created_key.api_key);
    fill_code_placeholders(api_base_url, created_key.api_key);
    show_key_status(status_element, `Plan: ${created_key.plan || "free"}. Keep the key safe. We show it only once.`, false);
  } catch (key_error) {
    const is_network_failure = key_error.name === "AbortError" || key_error instanceof TypeError;
    show_key_status(status_element, is_network_failure ? `Cannot reach the API at ${api_base_url}. Try again soon, or self-host.` : key_error.message, true);
  } finally {
    submit_button.disabled = false;
  }
}

function open_faq_entry_from_hash() {
  const hash_target = location.hash && document.getElementById(location.hash.slice(1));
  if (hash_target && hash_target.tagName === "DETAILS") hash_target.open = true;
}

function wire_build_step_replay(replay_box) {
  const replay_steps = select_all(".replay_steps li", replay_box);
  const code_lines = select_all(".ln", replay_box);
  const replay_state = { active_step_index: 0, interval_timer: 0, is_visible: false };
  const show_step = step_index => {
    replay_state.active_step_index = step_index;
    replay_steps.forEach((step_element, index_of_step) => step_element.classList.toggle("is_active", index_of_step === step_index));
    replay_steps.forEach((step_element, index_of_step) => step_element.classList.toggle("is_done", index_of_step < step_index));
    code_lines.forEach(code_line => code_line.classList.toggle("is_active", Number(code_line.dataset.line) === step_index));
  };
  const stop_playing = () => { clearInterval(replay_state.interval_timer); replay_state.interval_timer = 0; };
  const start_playing = () => {
    if (prefers_reduced_motion_for_site || replay_state.interval_timer || !replay_state.is_visible) return;
    replay_state.interval_timer = setInterval(() => show_step((replay_state.active_step_index + 1) % replay_steps.length), replay_step_interval_in_milliseconds);
  };
  replay_steps.forEach((step_element, step_index) => step_element.addEventListener("click", () => { stop_playing(); show_step(step_index); }));
  show_step(prefers_reduced_motion_for_site ? replay_steps.length - 1 : 0);
  new IntersectionObserver(([visibility_entry]) => {
    replay_state.is_visible = visibility_entry.isIntersecting;
    replay_state.is_visible ? start_playing() : stop_playing();
  }, { threshold: 0.35 }).observe(replay_box);
}

function wire_docs_scroll_spy(docs_nav_links) {
  const link_heading_pairs = docs_nav_links
    .map(nav_link => ({ nav_link, heading: document.getElementById(nav_link.getAttribute("href").slice(1)) }))
    .filter(link_heading_pair => link_heading_pair.heading);
  const highlight_current_section = () => {
    const passed_pairs = link_heading_pairs.filter(pair => pair.heading.getBoundingClientRect().top < docs_heading_activation_line_in_pixels);
    const current_pair = passed_pairs[passed_pairs.length - 1] || link_heading_pairs[0];
    docs_nav_links.forEach(nav_link => nav_link.classList.toggle("is_active", nav_link === current_pair.nav_link));
  };
  addEventListener("scroll", () => requestAnimationFrame(highlight_current_section), { passive: true });
  highlight_current_section();
}

function start_site() {
  const api_base_url = resolve_api_base_url();
  window.BISCAD_API = api_base_url;
  fill_code_placeholders(api_base_url, read_stored_setting("biscad.key"));
  document.addEventListener("click", copy_visible_code_block);
  select_all("[data-tabs]").forEach(wire_code_tabs);
  select_all("#hero-viewer").forEach(load_hero_viewer);
  select_all("#key-form").forEach(key_form => key_form.addEventListener("submit", submit_event => submit_key_form(submit_event, api_base_url)));
  select_all("#replay").forEach(wire_build_step_replay);
  const docs_nav_links = select_all(".docs_nav a[href^='#']");
  if (docs_nav_links.length) wire_docs_scroll_spy(docs_nav_links);
  addEventListener("hashchange", open_faq_entry_from_hash);
  open_faq_entry_from_hash();
}

start_site();
