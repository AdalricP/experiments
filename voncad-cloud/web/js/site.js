// Voncad Cloud — landing + docs behaviour. No dependencies.
//  - API base: ?api=<url> (saved to localStorage "voncad-api"), else location.origin
//  - fills .host / .host-mcp / .api-key placeholders in code samples
//  - copy buttons, code tabs, API key form, hero viewer iframe, FAQ deep links,
//    build-step replay demo, docs scroll-spy
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- API base
  function store(op, k, v) {
    try { return op === "get" ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch (e) { return null; }
  }
  const qs = new URLSearchParams(location.search);
  const override = qs.get("api");
  if (override !== null) {
    if (override === "" || override === "reset") { try { localStorage.removeItem("voncad-api"); } catch (e) {} }
    else store("set", "voncad-api", override.replace(/\/+$/, ""));
  }
  const origin = /^https?:/.test(location.origin) ? location.origin : "http://localhost:8000";
  const API = (store("get", "voncad-api") || window.VONCAD_DEFAULT_API || origin).replace(/\/+$/, "");
  window.VONCAD_API = API;

  $$(".host").forEach(el => (el.textContent = API));
  $$(".host-mcp").forEach(el => (el.textContent = API + "/mcp"));
  const savedKey = store("get", "voncad.key");
  if (savedKey) $$(".api-key").forEach(el => (el.textContent = savedKey));

  // ---------------------------------------------------------------- copy
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
    ta.remove();
    return ok;
  }
  document.addEventListener("click", async e => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const box = btn.closest(".code");
    const pre = box && ($$("pre", box).find(p => !p.hidden) || $("pre", box));
    if (!pre) return;
    const ok = await copyText(pre.textContent.replace(/\n$/, ""));
    const label = $(".copy-label", btn);
    btn.classList.add("done");
    if (label) label.textContent = ok ? "Copied" : "Press ⌘C";
    setTimeout(() => { btn.classList.remove("done"); if (label) label.textContent = "Copy"; }, 1600);
  });

  // ---------------------------------------------------------------- tabs
  $$("[data-tabs]").forEach(box => {
    const tabs = $$('[role="tab"]', box);
    const select = t => {
      tabs.forEach(x => {
        const on = x === t;
        x.setAttribute("aria-selected", on);
        x.tabIndex = on ? 0 : -1;
        document.getElementById(x.getAttribute("aria-controls")).hidden = !on;
      });
      store("set", "voncad-lang", t.textContent.trim());
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(t));
      t.addEventListener("keydown", e => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        const n = tabs[(i + d + tabs.length) % tabs.length];
        select(n); n.focus();
      });
    });
    const pref = store("get", "voncad-lang");
    const t = pref && tabs.find(x => x.textContent.trim() === pref);
    if (t) select(t);
  });

  // ---------------------------------------------------------------- hero viewer
  // Only swap the placeholder for the iframe once view.html exists and has rendered.
  const frame = $("#hero-viewer");
  if (frame) {
    const iframe = $("iframe", frame);
    const src = iframe.dataset.src;
    const show = () => frame.classList.add("ready");
    fetch(src.split("?")[0], { method: "HEAD", cache: "no-store" })
      .then(r => {
        if (!r.ok) throw new Error("no viewer");
        iframe.addEventListener("load", () => setTimeout(show, 350), { once: true });
        iframe.src = src;
      })
      .catch(() => {
        const l = $(".placeholder .label", frame);
        if (l) l.innerHTML = 'Live viewer · <a href="studio.html">open in Studio</a>';
      });
  }

  // ---------------------------------------------------------------- API key form
  const form = $("#key-form");
  if (form) {
    const status = $("#key-status"), result = $("#key-result"), value = $("#key-value");
    const btn = $("button[type=submit]", form);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const email = form.email.value.trim();
      status.classList.remove("err");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        status.textContent = "Enter a valid email address.";
        status.classList.add("err");
        form.email.focus();
        return;
      }
      btn.disabled = true;
      status.textContent = "Creating your key…";
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      try {
        const r = await fetch(API + "/v1/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
          signal: ctl.signal,
        });
        let data = null;
        try { data = await r.json(); } catch (_) {}
        if (!r.ok || !data || !data.api_key) {
          const msg = data && (data.detail || data.error);
          throw new Error(r.status === 429 ? "Too many requests. Try again in a minute."
            : msg ? String(typeof msg === "string" ? msg : JSON.stringify(msg))
            : `The key service isn't answering at ${API} (HTTP ${r.status}). Try again shortly, or self-host in one command.`);
        }
        value.textContent = data.api_key;
        result.hidden = false;
        store("set", "voncad.key", data.api_key);
        $$(".api-key").forEach(el => (el.textContent = data.api_key));
        status.textContent = `Plan: ${data.plan || "free"}. Store it somewhere safe; we only show it once.`;
      } catch (err) {
        status.classList.add("err");
        status.textContent = err.name === "AbortError" || err instanceof TypeError
          ? `Can't reach the API at ${API}. It may be down or blocked. Try again shortly, or self-host in one command.`
          : err.message;
      } finally {
        clearTimeout(timer);
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- FAQ deep links
  function openTarget() {
    const el = location.hash && document.getElementById(location.hash.slice(1));
    if (el && el.tagName === "DETAILS") el.open = true;
  }
  addEventListener("hashchange", openTarget);
  openTarget();

  // ---------------------------------------------------------------- build-step replay
  const replay = $("#replay");
  if (replay) {
    const steps = $$(".replay-steps li", replay);
    const lines = $$(".ln", replay);
    let i = 0, timer = 0, visible = false;
    const set = n => {
      i = n;
      steps.forEach((s, k) => { s.classList.toggle("on", k === n); s.classList.toggle("done", k < n); });
      lines.forEach(l => l.classList.toggle("on", +l.dataset.line === n));
    };
    const tick = () => { set((i + 1) % steps.length); };
    const play = () => { if (!still && !timer && visible) timer = setInterval(tick, 2200); };
    const stop = () => { clearInterval(timer); timer = 0; };
    steps.forEach((s, k) => s.addEventListener("click", () => { stop(); set(k); }));
    set(still ? steps.length - 1 : 0);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([en]) => { visible = en.isIntersecting; visible ? play() : stop(); }, { threshold: .35 }).observe(replay);
    }
  }

  // ---------------------------------------------------------------- docs scroll-spy
  const navLinks = $$(".docs-nav a[href^='#']");
  if (navLinks.length) {
    const pairs = navLinks.map(a => [a, document.getElementById(a.getAttribute("href").slice(1))]).filter(p => p[1]);
    let raf = 0;
    const spy = () => {
      raf = 0;
      let cur = pairs[0];
      for (const p of pairs) if (p[1].getBoundingClientRect().top < 140) cur = p;   // last heading above the fold line
      navLinks.forEach(a => a.classList.toggle("active", a === cur[0]));
    };
    addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(spy); }, { passive: true });
    spy();
  }
})();
