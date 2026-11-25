/*
 * TradeCognix front end: site behaviour, app shell, and the in-browser demo.
 *
 * Exposes window.TCUI, the shared rendering layer. js/api.js (loaded after this file) uses it
 * when TC_API_BASE is set, so demo and API mode draw exactly the same UI.
 * No build step, no dependencies beyond chart.js.
 */
(function () {
  "use strict";
  var doc = document, root = doc.documentElement;
  var $ = function (s, c) { return (c || doc).querySelector(s); };
  var $$ = function (s, c) { return [].slice.call((c || doc).querySelectorAll(s)); };
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var API_ON = !!(window.TC_API_BASE || "");
  var IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  /* ================= formatting (Indian) ================= */
  var esc = function (v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var inr = function (v) { return Math.round(v).toLocaleString("en-IN"); };
  var rupee = function (v) { v = v || 0; return (v < 0 ? "−₹" : "₹") + inr(Math.abs(v)); };
  var signed = function (v) { return (v > 0 ? "+" : "") + rupee(v); };
  function compact(v) {
    var a = Math.abs(v), s = v < 0 ? "−₹" : "₹";
    if (a >= 1e7) return s + (a / 1e7).toFixed(2).replace(/\.?0+$/, "") + " Cr";
    if (a >= 1e5) return s + (a / 1e5).toFixed(2).replace(/\.?0+$/, "") + " L";
    if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
    return s + Math.round(a);
  }
  var IST = "Asia/Kolkata";
  function istParts(d) {
    var o = {};
    new Intl.DateTimeFormat("en-GB", { timeZone: IST, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d || new Date()).forEach(function (p) { o[p.type] = p.value; });
    return { wd: o.weekday, h: +o.hour, m: +o.minute, hm: o.hour + ":" + o.minute };
  }
  function istTime(d) { return istParts(d).hm; }
  function istDate(d) { return new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" }).format(d); }

  /* ================= theme ================= */
  function theme() { return root.getAttribute("data-theme") === "light" ? "light" : "dark"; }
  function setTheme(t) {
    root.setAttribute("data-theme", t);
    try { localStorage.setItem("tc-theme", t); } catch (e) { /* private mode */ }
    $$("[data-theme-set]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.themeSet === t)); });
    $$("[data-theme-toggle]").forEach(function (b) { b.setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme"); });
    redrawCharts();
  }

  /* ================= toast & modals ================= */
  var tt;
  function toast(msg) {
    var t = $("#x-toast"); if (!t) return;
    t.textContent = msg; t.classList.add("is-on"); clearTimeout(tt);
    tt = setTimeout(function () { t.classList.remove("is-on"); }, 3600);
  }
  var lastFocus = null;
  function openModal(m) {
    if (!m) return;
    lastFocus = doc.activeElement; m.hidden = false;
    var f = $("input:not([type=hidden])", m) || $("button:not([data-close])", m) || $("button", m);
    if (f) setTimeout(function () { f.focus(); }, 20);
  }
  function closeModal(m) { if (!m || m.hidden) return; m.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  function openModalEl() { return $$(".modal").filter(function (m) { return !m.hidden; })[0]; }
  doc.addEventListener("keydown", function (e) {
    var m = openModalEl();
    if (!m) return;
    if (e.key === "Escape") { closeModal(m); return; }
    if (e.key === "Tab") { // focus trap
      var f = $$("button:not([disabled]), input, a[href], [tabindex]:not([tabindex='-1'])", m).filter(function (x) { return x.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  $$(".modal").forEach(function (m) { m.addEventListener("mousedown", function (e) { if (e.target === m) closeModal(m); }); });

  /* ================= state ================= */
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };
  var S = {
    user: store.get("tc_demo_user", null),
    connected: store.get("tc_demo_brokers", []),
    sessions: [],
    backtests: [],
    parsed: false,
    rules: null,
    model: null,
    afterAuth: null,
    afterBroker: null,
    nextSid: 101,
    // demo-only persistence (API mode keeps these on the server)
    saved: API_ON ? [] : store.get("tc_demo_strategies", []),
    journal: API_ON ? [] : store.get("tc_demo_journal", []),
    savedId: null
  };
  if (!API_ON) {
    S.sessions = store.get("tc_demo_sessions", []);
    S.sessions.forEach(function (s) { if (+s.id >= S.nextSid) S.nextSid = +s.id + 1; });
  }
  function persistDemo() {
    if (API_ON) return;
    store.set("tc_demo_sessions", S.sessions.slice(0, 30)); store.set("tc_demo_journal", S.journal.slice(0, 400)); store.set("tc_demo_strategies", S.saved);
  }
  function signedIn() { return API_ON ? !!localStorage.getItem("tc_token") : !!S.user; }

  /* ================= site ================= */
  $$("[data-bill]").forEach(function (b) {
    b.addEventListener("click", function () {
      $$("[data-bill]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      var y = b.dataset.bill === "y";
      $("#x-pro-price").textContent = y ? "₹9,990" : "₹999";
      $("#x-pro-per").textContent = y ? "/year" : "/month";
      $("#x-pro-note").innerHTML = y ? "≈ ₹833/month · <b>2 months free</b>" : "or ₹9,990/year";
      $("#x-elite-note").textContent = y ? "Monthly billing only" : "Billed monthly";
    });
  });

  /* ================= app shell & routing ================= */
  var site = $("#x-site"), app = $("#x-app");
  var VIEWS = { dashboard: "Dashboard", studio: "Strategy Studio", backtests: "Backtests", paper: "Paper & live", journal: "Journal", brokers: "Brokers", settings: "Settings" };
  var REAL = { dashboard: 1, studio: 1, backtests: 1, paper: 1, journal: 1, brokers: 1, settings: 1 };
  var current = null;

  function show(v) {
    if (!VIEWS[v]) v = "dashboard";
    current = v;
    var real = REAL[v] ? v : "soon";
    $$(".view").forEach(function (s) { s.hidden = s.dataset.v !== real; });
    $$(".tab").forEach(function (t) {
      var on = t.dataset.view === v || (v === "settings" && t.classList.contains("tab--more"));
      if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    $("#x-top-title").textContent = VIEWS[v];
    if (real === "soon") $("#x-soon-title").textContent = VIEWS[v];
    doc.title = VIEWS[v] + " · TradeCognix";
    if (v === "dashboard") { greet(); drawDash(); renderChecklist(); }
    if (v === "backtests") renderBacktests();
    if (v === "paper") renderSessions();
    if (v === "settings") renderSettings();
    if (v === "studio" && S.model && charts.bt == null) renderResults(S.model, true);
    if (v === "journal") { if (API_ON) renderJournalEmpty(); else renderDemoJournal(); }
    window.scrollTo(0, 0);
    // js/api.js listens for this to load account data (saved runs, strategies, journal) from the server.
    doc.dispatchEvent(new CustomEvent("tc:view", { detail: v }));
  }
  function openApp(v) {
    site.hidden = true; app.hidden = false;
    show(v || "dashboard");
  }
  function closeApp() {
    app.hidden = true; site.hidden = false; doc.title = "TradeCognix · Plain-English algo trading for Indian traders";
  }
  function route() {
    var h = location.hash;
    if (h.indexOf("#/") === 0) openApp(h.slice(2));
    else if (!app.hidden) closeApp();
  }
  function nav(v) {
    if (location.hash === "#/" + v) show(v);
    else location.hash = "#/" + v;
  }
  function backToSite() {
    if (location.hash.indexOf("#/") === 0) history.pushState(null, "", location.pathname + location.search);
    closeApp(); window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  doc.addEventListener("click", function (e) {
    var mb = e.target.closest("[data-menu]");
    if (mb) { toggleMenu(); return; }
    if (e.target.closest("#nav-menu a, #nav-menu button")) toggleMenu(false);
    var t = e.target.closest("[data-open-app],[data-back],[data-view],[data-ex],[data-close],[data-theme-toggle],[data-theme-set],[data-auth-open],[data-kill-open],[data-open-bt]");
    if (!t) return;
    if (t.hasAttribute("data-open-app")) { e.preventDefault(); nav(t.dataset.openApp || "dashboard"); }
    else if (t.hasAttribute("data-back")) { e.preventDefault(); backToSite(); }
    else if (t.dataset.view) { closeModal(openModalEl()); nav(t.dataset.view); }
    else if (t.dataset.ex) {
      var i = $("#x-input"); i.value = t.dataset.ex; i.dispatchEvent(new Event("input"));
      $$(".tpl").forEach(function (b) { b.setAttribute("aria-pressed", String(b === t)); });
      // Only focus on devices with a fine pointer: on phones focusing pops the keyboard over the template.
      if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) i.focus();
      else { var h = $("#x-input-hint"); if (h) h.textContent = "Template loaded. Edit it or tap Generate rules."; }
    }
    else if (t.hasAttribute("data-close")) closeModal(t.closest(".modal"));
    else if (t.hasAttribute("data-theme-toggle")) setTheme(theme() === "dark" ? "light" : "dark");
    else if (t.dataset.themeSet) setTheme(t.dataset.themeSet);
    else if (t.hasAttribute("data-auth-open")) { if (signedIn()) nav("settings"); else requireAuth(null); }
    else if (t.hasAttribute("data-kill-open")) openKill();
    else if (t.dataset.openBt) { var b = S.backtests[+t.dataset.openBt]; if (b) { S.model = b.model; nav("studio"); renderResults(b.model, true); var sw = $("#x-sweep"); if (sw) sw.hidden = true; } }
  });

  /* ================= market status (IST) ================= */
  var DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  function market() {
    var p = istParts(), mins = p.h * 60 + p.m, di = DAYS.indexOf(p.wd), weekday = di >= 0 && di < 5;
    var open = weekday && mins >= 555 && mins < 930;
    var text;
    if (open) text = "NSE open · closes 15:30";
    else if (weekday && mins < 555) text = "NSE closed · opens 09:15";
    else { var nd = di >= 4 ? "Mon" : DAYS[di + 1]; text = "NSE closed · opens " + nd + " 09:15"; }
    return { open: open, text: text, hm: p.hm, h: p.h };
  }
  function tickClock() {
    var m = market(), el = $("#x-mkt");
    if (!el) return;
    el.classList.toggle("is-open", m.open);
    $("#x-mkt-text").textContent = m.text + " ·";
    $("#x-clock").textContent = m.hm + " IST";
  }
  function greet() {
    var h = market().h, g = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    var name = S.user ? S.user.split("@")[0] : "";
    $("#x-greet").textContent = g + (name ? ", " + name : "");
  }

  /* ================= charts ================= */
  var charts = {};
  function cssVar(n) { return getComputedStyle(root).getPropertyValue(n).trim(); }
  function hexA(hex, a) {
    var m = hex.replace("#", ""); if (m.length === 3) m = m.split("").map(function (c) { return c + c; }).join("");
    var n = parseInt(m, 16); return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")";
  }
  function chartDefaults() {
    if (!window.Chart) return;
    var d = Chart.defaults;
    d.font.family = cssVar("--font-ui") || "system-ui"; d.font.size = 11.5;
    d.color = cssVar("--text-3"); d.borderColor = cssVar("--chart-grid");
    d.maintainAspectRatio = false; d.responsive = true;
    var tip = d.plugins.tooltip;
    tip.backgroundColor = cssVar("--surface-3"); tip.titleColor = cssVar("--text"); tip.bodyColor = cssVar("--text-2");
    tip.borderColor = cssVar("--border-strong"); tip.borderWidth = 1; tip.padding = 10; tip.cornerRadius = 8; tip.displayColors = false;
    tip.titleFont = { family: d.font.family, weight: "600", size: 12 }; tip.bodyFont = { family: cssVar("--font-mono"), size: 12 };
  }
  function equityChart(id, labels, values, fmtLabel, startAtZero) {
    if (!window.Chart) return null;
    chartDefaults();
    var el = doc.getElementById(id); if (!el) return null;
    var old = Chart.getChart(el); if (old) old.destroy();
    var last = values[values.length - 1] - (startAtZero ? 0 : values[0]);
    var col = cssVar(last >= 0 ? "--brand" : "--down");
    return new Chart(el, {
      type: "line",
      data: { labels: labels, datasets: [{ data: values, borderColor: col, borderWidth: 1.75, pointRadius: 0, pointHoverRadius: 3, pointHoverBackgroundColor: col, tension: 0, fill: startAtZero ? "origin" : "start",
        backgroundColor: function (c) {
          var a = c.chart.chartArea; if (!a) return hexA(col, 0.1);
          var g = c.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, hexA(col, 0.18)); g.addColorStop(1, hexA(col, 0)); return g;
        } }] },
      options: {
        animation: reduce ? false : { duration: 500 },
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 4, right: 4 } },
        scales: {
          x: { grid: { display: false }, border: { color: cssVar("--border") }, ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkipPadding: 16, callback: function (v, i) { return fmtLabel(labels[i]); } } },
          y: { position: "right", border: { display: false }, grid: { color: cssVar("--chart-grid") }, ticks: { maxTicksLimit: 5, font: { family: cssVar("--font-mono"), size: 11 }, callback: function (v) { return compact(v); } } }
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: function (c) { return fmtLabel(c[0].label, true); }, label: function (c) { return rupee(c.raw); } } } }
      }
    });
  }
  function drawDash() {
    // js/api.js sets S.dash to the signed-in account's cumulative net P&L; otherwise draw the demo curve.
    if (S.dash) {
      if (!S.dash.values.length) { if (charts.dash) { charts.dash.destroy && charts.dash.destroy(); charts.dash = null; } return; }
      charts.dash = equityChart("x-dash-chart", S.dash.labels, S.dash.values, function (l) { return l; }, true);
      return;
    }
    var raw = JSON.parse($("#x-equity-data").textContent);
    var labels = raw.map(function (_, i) { return i + 1; });
    charts.dash = equityChart("x-dash-chart", labels, raw, function (l) { return "Day " + l; }, false);
  }
  function redrawCharts() {
    if (!app.hidden && current === "dashboard") drawDash();
    if (S.model && !$("#x-results").hidden) drawEquity(S.model);
  }

  /* ================= progress & logs ================= */
  function progress(btn, prog, log, lines) {
    var btns = $$("#x-gen, #x-run"); btns.forEach(function (b) { b.disabled = true; });
    if (btn) btn.classList.add("is-loading");
    log.classList.remove("is-error", "is-ok");
    prog.classList.remove("is-run"); void prog.offsetWidth; prog.classList.add("is-run");
    var i = 0; log.textContent = lines[0];
    var iv = setInterval(function () { i = Math.min(lines.length - 1, i + 1); log.textContent = lines[i]; }, reduce ? 80 : 400);
    return function done() { clearInterval(iv); btns.forEach(function (b) { b.disabled = false; }); if (btn) btn.classList.remove("is-loading"); prog.classList.remove("is-run"); };
  }
  function setLog(el, msg, kind) { el.textContent = msg; el.classList.toggle("is-error", kind === "error"); el.classList.toggle("is-ok", kind === "ok"); }

  /* ================= Studio: prompt validation ================= */
  var input = $("#x-input"), hint = $("#x-input-hint"), HINT0 = hint.textContent, triedOnce = false;
  function validatePrompt(strict) {
    var t = input.value.trim(), msg = HINT0, kind = "";
    if (!t) { msg = "Describe a strategy first, or pick an example below."; kind = "error"; }
    else if (t.length < 20) { msg = "Add a bit more detail: instrument, entry and exit."; kind = "error"; }
    else if (!/\b(buy|sell|short|long)\b/i.test(normalise(t))) { msg = "Tip: say whether to buy or sell, e.g. “Buy Nifty ATM call when…”"; kind = "warn"; }
    else if (!/(exit|stop\s*loss|\bsl\b|\bstop\b|target|\btgt\b|trail|square|turns red|crosses above|close|opposite)/i.test(normalise(t))) { msg = "Tip: add an exit, e.g. a stop loss, target or exit time."; kind = "warn"; }
    var show = strict || triedOnce || kind !== "error";
    hint.textContent = show ? msg : HINT0;
    hint.classList.toggle("is-error", show && kind === "error");
    hint.classList.toggle("is-warn", show && kind === "warn");
    if (show && kind === "error") input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    $("#x-count").textContent = input.value.length + "/600";
    return kind !== "error";
  }
  input.addEventListener("input", function () { validatePrompt(false); });
  $("#x-clear").addEventListener("click", function () { input.value = ""; triedOnce = false; validatePrompt(false); input.focus(); });
  $$(".kbd-mod").forEach(function (k) { k.textContent = IS_MAC ? "⌘↵" : "Ctrl ↵"; });
  validatePrompt(false);

  /* ================= Studio: flow steps ================= */
  function setStep() {
    var paper = S.sessions.some(function (s) { return s.mode === "paper"; }), live = S.sessions.some(function (s) { return s.mode === "live"; });
    var cur = !S.parsed ? 1 : !S.model ? 2 : !paper && !live ? 3 : !live ? 4 : 5;
    $$("#x-flow li").forEach(function (li) {
      var n = +li.dataset.step;
      li.classList.toggle("is-done", n < cur);
      li.classList.toggle("is-current", n === cur);
      if (n === cur) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
    renderGuide(cur);
  }

  /* ================= Studio: first-run guide ================= */
  // A one-line coach above the Studio that follows the user's progress. Hidden for good once dismissed
  // or once they have started paper trading; "Show guide" brings it back.
  function renderGuide(cur) {
    var box = $("#x-guide"); if (!box) return;
    var off = localStorage.getItem("tc_guide_off") === "1";
    var finished = cur >= 4;
    box.hidden = off || finished;
    $("#x-guide-show").hidden = !off || finished;
    if (box.hidden) return;
    var act = $("#x-guide-act"), text, label = "", step = Math.min(cur, 3);
    if (cur === 1) { text = "New here? Tap a template, or describe your own idea in plain English, then press Generate rules."; label = "See templates"; }
    else if (cur === 2) text = "Check the rules. Click any value to change it, then press Run backtest. Brokerage, STT and slippage are included.";
    else if (signedIn()) text = "Happy with the result? Start paper trading. It runs on live prices and no money moves.";
    else { text = "Happy with the result? Create a free account to paper trade on live prices. No money moves."; label = "Create free account"; }
    $("#x-guide-step").textContent = step + "/3";
    $("#x-guide-text").textContent = text;
    act.hidden = !label; act.textContent = label;
    act.dataset.go = cur === 1 ? "tpl" : "auth";
  }
  $("#x-guide-act").addEventListener("click", function (e) {
    if (e.currentTarget.dataset.go === "tpl") {
      var g = $(".tpls"); g.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      var first = $(".tpl"); if (first) first.focus({ preventScroll: true });
    } else requireAuth(null);
  });
  $("#x-guide-close").addEventListener("click", function () { localStorage.setItem("tc_guide_off", "1"); setStep(); });
  $("#x-guide-show").addEventListener("click", function () { localStorage.removeItem("tc_guide_off"); setStep(); });

  /* ================= Studio: rules ================= */
  function renderRules(rules, explanation, warnings, opts) {
    opts = opts || {};
    S.rules = rules; S.parsed = true;
    var changed = opts.changed || [];
    $("#x-edit").innerHTML = Object.keys(rules).map(function (k) {
      return '<div class="rule x-rule' + (changed.indexOf(k) >= 0 ? " is-changed" : "") + '" data-row="' + esc(k) + '"><b>' + esc(k) + (changed.indexOf(k) >= 0 ? '<span class="sr-only"> (changed)</span>' : "") + '</b><span contenteditable="true" spellcheck="false" role="textbox" aria-label="' + esc(k) + '" data-k="' + esc(k) + '"></span><span class="rule__edit" aria-hidden="true"><svg><use href="#i-pencil" /></svg></span></div>';
    }).join("");
    $$("#x-edit [data-k]").forEach(function (s) { s.textContent = rules[s.dataset.k]; flagRule(s); });
    var ex = $("#x-explain");
    if (explanation) { ex.innerHTML = "<b>In plain words:</b> " + esc(explanation) + (warnings && warnings.length ? '<br><span class="hint is-warn">' + esc(warnings.join(" ")) + "</span>" : ""); ex.hidden = false; }
    else ex.hidden = true;
    $("#x-rules-panel").hidden = false;
    $("#x-run-log").textContent = "";
    $("#x-cop").hidden = false;
    if (!opts.keepCop) { copReset(); S.savedId = null; var sv = $("#x-save"); if (sv) sv.textContent = "Save strategy"; }
    setStep(); renderChecklist();
    if (!opts.keepCop && window.matchMedia("(max-width: 1180px)").matches) $("#x-rules-panel").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }
  function flagRule(span) {
    var row = span.closest(".rule"), v = span.textContent;
    row.classList.toggle("is-warn", /\?|review|\(default\)/i.test(v) || !v.trim());
    row.title = row.classList.contains("is-warn") ? "Check this value: it was missing from your description or is a default." : "";
  }
  $("#x-edit").addEventListener("input", function (e) { if (e.target.dataset && e.target.dataset.k) flagRule(e.target); });
  $("#x-edit").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); e.target.blur(); }
  });
  function readRules() { var r = {}; $$("#x-edit [data-k]").forEach(function (s) { r[s.dataset.k] = s.textContent.trim(); }); return r; }

  /* ================= Landing: mobile menu ================= */
  function toggleMenu(force) {
    var menu = document.getElementById("nav-menu"), btn = document.querySelector("[data-menu]");
    if (!menu || !btn) return;
    var open = typeof force === "boolean" ? force : menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    btn.closest(".nav").classList.toggle("is-open", open);
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") toggleMenu(false); });
  window.addEventListener("resize", function () { if (window.innerWidth > 980) toggleMenu(false); });

  /* ================= Studio: results (shared with api.js) ================= */
  /* model = { scope, illustrative, badge, metrics:{trades,winRate,gross,net,costs,maxDD,pf,expectancy},
               equity:{labels,values,fmt}, costs:{name:amount}, trades:[{when,side,instrument,entry,exit,net}], totalTrades } */
  function metricCell(label, value, cls, sub, hero) {
    return '<div class="metric x-metric' + (hero ? " metric--hero" : "") + '"><span>' + label + '</span><strong class="' + (cls || "") + '">' + esc(value) + "</strong>" + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</div>";
  }
  function drawEquity(model) {
    charts.bt = equityChart("x-bt-chart", model.equity.labels, model.equity.values, model.equity.fmt, true);
  }
  function renderResults(model, quiet) {
    S.model = model;
    var m = model.metrics, upDown = function (v) { return v >= 0 ? "up" : "down"; };
    var costPct = m.gross > 0 ? Math.round(m.costs / m.gross * 100) + "% of gross" : "";
    $("#x-mgrid").innerHTML = [
      metricCell("Net P&amp;L", signed(m.net), upDown(m.net), "after all costs", true),
      metricCell("Gross P&amp;L", signed(m.gross), upDown(m.gross), "before costs"),
      metricCell("Costs", rupee(m.costs), "down", costPct),
      metricCell("Max drawdown", rupee(m.maxDD), "down", "peak to trough"),
      metricCell("Trades", String(m.trades), "", model.days ? model.days : ""),
      metricCell("Win rate", m.winRate.toFixed(2) + "%", ""),
      metricCell("Profit factor", m.pf == null ? "—" : m.pf.toFixed(2), m.pf == null ? "" : m.pf >= 1 ? "up" : "down"),
      metricCell("Expectancy", signed(m.expectancy), upDown(m.expectancy), "per trade")
    ].join("");
    $("#x-res-scope").textContent = model.scope;
    var badge = $("#x-res-badge");
    badge.textContent = model.badge || (model.illustrative ? "Illustrative" : "Broker data");
    badge.className = "badge " + (model.illustrative ? "badge--warn" : "badge--live");
    var note = $("#x-res-note");
    if (note) { note.hidden = !model.note; note.querySelector("p").textContent = model.note || ""; }
    $("#x-eq-cap").innerHTML = "Net P&amp;L " + (m.net >= 0 ? "ended at " : "fell to ") + esc(signed(m.net)) + " over " + m.trades + " trades<small>Cumulative net P&amp;L, ₹ · after costs and slippage</small>";
    $("#x-cost-cap").innerHTML = "Costs took " + esc(rupee(m.costs)) + (m.gross > 0 ? " of " + esc(rupee(m.gross)) + " gross" : "") + "<small>Charges by type, ₹</small>";
    var keys = Object.keys(model.costs), max = Math.max.apply(null, keys.map(function (k) { return model.costs[k] || 0; }).concat([1]));
    $("#x-costbars").innerHTML = keys.map(function (k) {
      var v = model.costs[k] || 0;
      return '<div class="costbar"><span>' + esc(k) + '</span><span class="track" aria-hidden="true"><i style="width:' + (v / max * 100).toFixed(1) + '%"></i></span><span class="num">' + rupee(v) + "<small>" + (m.costs ? Math.round(v / m.costs * 100) : 0) + "%</small></span></div>";
    }).join("");
    $("#x-costsum").innerHTML = '<div><span>Gross P&amp;L</span><span class="num">' + signed(m.gross) + '</span></div><div><span>Total costs</span><span class="num down">−' + rupee(m.costs) + '</span></div><div class="total"><span>Net P&amp;L</span><span class="num ' + upDown(m.net) + '">' + signed(m.net) + "</span></div>";
    $("#x-trades").innerHTML = model.trades.length ? model.trades.map(function (t) {
      return "<tr><td class=\"num\">" + esc(t.when) + "</td><td>" + (t.side === "Sell" ? '<span class="down">Sell</span>' : '<span class="up">Buy</span>') + "</td><td>" + esc(t.instrument) + '</td><td class="r">' + t.entry.toFixed(2) + '</td><td class="r">' + t.exit.toFixed(2) + '</td><td class="r ' + upDown(t.net) + '">' + signed(t.net) + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="faint" style="text-align:center;padding:28px">No trades in this period. Try loosening the entry condition or a longer window.</td></tr>';
    $("#x-trades-note").textContent = model.trades.length ? "Latest " + model.trades.length + " of " + model.totalTrades : "";
    $("#x-results").hidden = false;
    $("#x-res-banner").hidden = true;
    renderInsights(model);
    var cmpBox = $("#x-res-cmp");
    if (!quiet && cop.base && cop.base !== model) { renderCompare(cop.base, model); cop.base = null; }
    else if (cmpBox && !quiet) cmpBox.hidden = true;
    if (quiet && cmpBox) cmpBox.hidden = true;
    if (!API_ON) { var sw = $("#x-sweep"); sw.hidden = !!quiet || !S.rules; $("#x-sweep-wrap").hidden = true; $("#x-sweep-rows").innerHTML = ""; if (!quiet) resetSweepNote(); }
    drawEquity(model);
    setStep(); renderChecklist();
    if (!quiet) {
      var r = $("#x-results");
      if (window.matchMedia("(max-width: 1180px)").matches) r.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      r.focus({ preventScroll: true });
    }
  }
  function recordBacktest(model, name) {
    S.backtests.unshift({ name: name, model: model, at: istTime() });
    $("#x-bt-count").textContent = S.backtests.length || "";
  }
  function renderBacktests() {
    if (!API_ON) {
      var sv = S.saved || [];
      $("#x-strat-panel").hidden = !sv.length;
      $("#x-strat-note").textContent = sv.length ? sv.length + " saved on this device" : "";
      $("#x-strat-body").innerHTML = sv.map(function (s) {
        var d = new Date(s.at), tf = String(s.rules.Timeframe || "").replace(" (default)", "");
        return '<tr><td class="wrap">' + esc(s.name) + "</td><td>" + esc((s.rules.Instrument || "").split(" ·")[0]) + "</td><td>" + esc(tf) + '</td><td class="r">' + istDate(d) + " · " + istTime(d) +
          '</td><td><div class="acts"><button class="btn btn--ghost btn--sm" type="button" data-open-dstrat="' + s.id + '">Open</button><button class="btn btn--ghost btn--sm" type="button" data-del-dstrat="' + s.id + '" aria-label="Delete ' + esc(s.name) + '">Delete</button></div></td></tr>';
      }).join("");
    }
    var has = S.backtests.length > 0;
    $("#x-bt-panel").hidden = !has; $("#x-bt-empty").hidden = has;
    $("#x-bt-body").innerHTML = S.backtests.map(function (b, i) {
      var m = b.model.metrics;
      return "<tr><td>" + esc(b.name) + "</td><td>" + esc(b.model.instrument || "") + '</td><td class="r">' + m.trades + '</td><td class="r">' + m.winRate.toFixed(1) + '%</td><td class="r ' + (m.net >= 0 ? "up" : "down") + '">' + signed(m.net) + '</td><td class="r">' + b.at + '</td><td><button class="btn btn--ghost btn--sm" type="button" data-open-bt="' + i + '">Open</button></td></tr>';
    }).join("");
  }

  /* ================= journal (demo / signed-out state) ================= */
  function renderJournalEmpty() {
    ["#x-j-panel", "#x-j-sum-panel", "#x-j-bar", "#x-j-export"].forEach(function (s) { $(s).hidden = true; });
    $("#x-j-empty").hidden = false;
    var api = !!window.TC_API_BASE, b = $("#x-j-empty-btn");
    if (api && !signedIn()) {
      $("#x-j-empty-h").textContent = "Sign in to see your journal";
      $("#x-j-empty-p").textContent = "The journal records every trade your paper and live sessions close, so it needs a free account.";
      b.textContent = "Create free account"; b.removeAttribute("data-view"); b.setAttribute("data-auth-open", "");
    } else {
      $("#x-j-empty-h").textContent = "No trades yet";
      $("#x-j-empty-p").textContent = api ? "Closed trades from your paper sessions land here, with charges and the reason each one exited."
        : "Start a paper session from a backtest and its simulated trades land here, with charges and the reason each one closed.";
      b.textContent = "Open Strategy Studio"; b.removeAttribute("data-auth-open"); b.setAttribute("data-view", "studio");
    }
  }

  /* ================= sessions & kill switch (shared) ================= */
  function addSession(s) {
    s.status = s.status || "running"; s.started = s.started || istTime();
    S.sessions.unshift(s); syncKill(); renderSessions(); setStep(); renderChecklist(); persistDemo();
    var b = $("#x-res-banner");
    b.innerHTML = '<div class="callout callout--ok"><svg aria-hidden="true"><use href="#i-check" /></svg><span style="flex:1">' + (s.mode === "live" ? "<strong>Live session #" + esc(s.id) + "</strong> started on " + esc(s.broker) + "." : "<strong>Paper session #" + esc(s.id) + "</strong> is running.") + " Runs on candle close, 09:15–15:30 IST.</span><button class=\"btn btn--ghost btn--sm\" type=\"button\" data-view=\"paper\">View</button></div>";
    b.hidden = false;
  }
  // js/api.js replaces the list with the account's sessions from the server (survives reloads and restarts).
  function setSessions(list) { S.sessions = list; syncKill(); renderSessions(); setStep(); renderChecklist(); }
  function running() { return S.sessions.filter(function (s) { return s.status === "running"; }); }
  function syncKill() {
    var n = running().length, k = $("#x-kill");
    k.classList.toggle("is-armed", n > 0);
    k.setAttribute("aria-label", n ? "Kill switch: stop " + n + " running session" + (n > 1 ? "s" : "") : "Kill switch: nothing running");
    $("#x-sess-count").textContent = n || "";
  }
  function stopSession(id, reason) {
    S.sessions.forEach(function (s) { if (String(s.id) === String(id) && s.status === "running") { s.status = reason || "stopped"; } });
    syncKill(); renderSessions(); setStep(); persistDemo();
  }
  function killAll() {
    var n = running().length;
    S.sessions.forEach(function (s) { if (s.status === "running") { s.status = "killed"; if (!API_ON) demoTrades(s, 1, "kill_switch"); } });
    syncKill(); renderSessions(); setStep(); persistDemo();
    return n;
  }
  function renderSessions() {
    var has = S.sessions.length > 0;
    $("#x-sess-panel").hidden = !has; $("#x-sess-empty").hidden = has;
    $("#x-sess-note").textContent = running().length + " running";
    $("#x-sess-body").innerHTML = S.sessions.map(function (s) {
      var state = s.status === "running" ? '<span class="badge badge--live">Running</span>' : s.status === "killed" ? '<span class="badge badge--down">Killed</span>' : s.status === "halted" ? '<span class="badge badge--warn" title="' + esc(s.reason || "") + '">Halted</span>' + (s.reason ? '<span class="sub">' + esc(s.reason) + "</span>" : "") : '<span class="badge">Stopped</span>';
      return '<tr><td class="num">#' + esc(s.id) + "</td><td>" + esc(s.name) + "</td><td>" + (s.mode === "live" ? '<span class="badge badge--down">Live</span>' : '<span class="badge badge--paper">Paper</span>') + "</td><td>" + esc(s.broker) + '</td><td class="num">' + esc(s.started) + "</td><td>" + state + "</td><td>" +
        (s.status === "running" ? '<button class="btn btn--ghost btn--sm" type="button" data-stop="' + esc(s.id) + '">Stop</button>' : "") + "</td></tr>";
    }).join("");
  }
  $("#x-sess-body").addEventListener("click", function (e) {
    var b = e.target.closest("[data-stop]"); if (!b) return;
    stopSession(b.dataset.stop); toast("Session #" + b.dataset.stop + " stopped");
  });
  function openKill() {
    var n = running().length;
    if (!n) { toast("Nothing is running. The kill switch arms when a paper or live session starts."); return; }
    $("#x-kill-text").textContent = "This halts " + n + " running session" + (n > 1 ? "s" : "") + " and squares off open positions immediately. You can start them again later.";
    openModal($("#x-kill-modal"));
  }
  $("#x-kill").addEventListener("click", openKill);
  $("#x-kill-confirm").addEventListener("click", function () {
    closeModal($("#x-kill-modal"));
    var n = killAll();
    toast("Kill switch: " + n + " session" + (n === 1 ? "" : "s") + " halted, positions squared off" + (API_ON ? "" : " (demo)"));
  });

  /* ================= auth (demo; api.js takes over submit in API mode) ================= */
  function requireAuth(next) {
    if (signedIn()) { if (next) next(); return; }
    S.afterAuth = next;
    var f = $("#tc-auth-form"); f.reset(); $("#tc-auth-err").textContent = "";
    $$(".field", f).forEach(function (x) { x.classList.remove("is-error"); $(".field__msg", x).textContent = ""; });
    $("#tc-auth-sub").textContent = next ? "Backtests are free without an account. Paper trading needs one, so your sessions and journal are saved." : "Backtests stay free without one. An account saves your strategies, paper sessions and journal.";
    openModal($("#tc-auth-modal"));
  }
  function validateAuth(f) {
    var ok = true;
    [["email", function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? "" : "Enter a valid email address."; }],
     ["password", function (v) { return v.length >= 8 ? "" : "Use at least 8 characters."; }]].forEach(function (p) {
      var inp = f[p[0]], msg = p[1](inp.value.trim()), wrap = inp.closest(".field");
      wrap.classList.toggle("is-error", !!msg); $(".field__msg", wrap).textContent = msg;
      if (msg) { inp.setAttribute("aria-invalid", "true"); if (ok) inp.focus(); ok = false; } else inp.removeAttribute("aria-invalid");
    });
    return ok;
  }
  function authDone(email) {
    closeModal($("#tc-auth-modal"));
    renderAccount(email); renderChecklist();
    var next = S.afterAuth; S.afterAuth = null;
    if (next) next();
  }
  $("#tc-auth-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    if (!validateAuth(f)) return;
    var mode = (e.submitter && e.submitter.value) || "register";
    S.user = f.email.value.trim(); store.set("tc_demo_user", S.user);
    toast(mode === "register" ? "Account created (demo). Welcome!" : "Signed in as " + S.user + " (demo)");
    authDone(S.user);
  });
  function renderAccount(email) {
    email = email || S.user || (API_ON && localStorage.getItem("tc_token") ? "Signed in" : "");
    var av = $("#x-avatar");
    av.textContent = email && email.indexOf("@") > 0 ? email.slice(0, 2).toUpperCase() : email ? "ME" : "?";
    av.classList.toggle("is-guest", !email);
    $("#x-acct-text").textContent = email ? "Signed in" + (email.indexOf("@") > 0 ? " as " + email : "") + (API_ON ? "." : " (demo).") : "Not signed in. Backtests work without an account.";
    var btn = $("#x-acct-btn");
    btn.textContent = email ? "Sign out" : "Create free account";
    if (email) btn.removeAttribute("data-auth-open"); else btn.setAttribute("data-auth-open", "");
  }
  $("#x-acct-btn").addEventListener("click", function () {
    if (!signedIn()) return;
    if (API_ON && window.TradeCognixAPI) window.TradeCognixAPI.signOut(); else { S.user = null; store.set("tc_demo_user", null); toast("Signed out"); }
    renderAccount(""); renderChecklist();
  });
  $("#x-reset").addEventListener("click", function () {
    ["tc_demo_user", "tc_demo_brokers", "tc_demo_sessions", "tc_demo_journal", "tc_demo_strategies"].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
    S.user = null; S.connected = []; S.sessions = []; S.backtests = []; S.model = null; S.parsed = false; S.saved = []; S.journal = []; S.savedId = null; S.afterBroker = null;
    $("#x-results").hidden = true; $("#x-rules-panel").hidden = true; $("#x-cop").hidden = true; copReset(); $("#x-gen-log").textContent = ""; $("#x-bt-count").textContent = "";
    syncKill(); renderAccount(""); renderBrokers(); setStep(); renderChecklist(); toast("Demo data cleared");
  });

  function renderSettings() {
    renderAccount();
    $$("[data-theme-set]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.themeSet === theme())); });
    $("#x-api-text").textContent = API_ON ? "Connected to " + window.TC_API_BASE + ". Open the site with ?api=off to return to demo mode." : "Demo mode: everything runs in your browser. Set TC_API_BASE in js/config.js, or open with ?api=https://your-api, to use the backend.";
    var b = $("#x-api-badge"); b.textContent = API_ON ? "API" : "Demo"; b.className = "badge " + (API_ON ? "badge--live" : "badge--warn");
    $("#x-api-connect").hidden = API_ON;
    if (!API_ON) $("#x-api-text").textContent = "Demo mode: everything runs in your browser and nothing is sent anywhere.";
  }
  $("#x-api-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var inp = $("#x-api-url"), err = $("#x-api-err"), v = inp.value.trim().replace(/\/+$/, "");
    var local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(v);
    var msg = !v ? "Enter your backend's address, e.g. https://api.example.com." : !/^https?:\/\/[^\s/?#]+\.[^\s/?#]+|^http:\/\/(localhost|127\.0\.0\.1)/i.test(v) ? "That doesn't look like a web address. It should start with https://." :
      location.protocol === "https:" && /^http:/i.test(v) && !local ? "Use an https:// address. Browsers block http APIs on an https page." : "";
    err.textContent = msg;
    if (msg) { inp.setAttribute("aria-invalid", "true"); inp.focus(); return; }
    inp.removeAttribute("aria-invalid");
    location.href = location.pathname + "?api=" + encodeURIComponent(v) + "#/settings";
  });

  /* ================= onboarding checklist ================= */
  function renderChecklist() {
    var done = { describe: S.parsed, backtest: !!S.model || S.backtests.length > 0, account: signedIn(), broker: S.connected.length > 0, paper: S.sessions.length > 0 };
    var n = 0;
    $$("#x-checklist li").forEach(function (li) { var d = !!done[li.dataset.ck]; li.classList.toggle("is-done", d); if (d) n++; });
    $("#x-ck-count").textContent = n + "/5";
    $("#x-ck-bar").style.width = (n / 5 * 100) + "%";
  }

  /* ================= brokers (shared) ================= */
  var DEMO_BROKERS = [
    { key: "Angel One", name: "Angel One", api: "SmartAPI", status: "live", fields: [["api_key", "API key"], ["client_code", "Client code"], ["pin", "PIN", 1], ["totp_secret", "TOTP secret", 1]] },
    { key: "Zerodha", name: "Zerodha", api: "Kite Connect" }, { key: "Upstox", name: "Upstox", api: "Upstox API" }, { key: "Dhan", name: "Dhan", api: "DhanHQ" },
    { key: "Fyers", name: "Fyers", api: "Fyers API" }, { key: "Groww", name: "Groww", api: "Trade API" }, { key: "ICICI Direct", name: "ICICI Direct", api: "Breeze" },
    { key: "Kotak Neo", name: "Kotak Neo", api: "Neo API" }, { key: "5paisa", name: "5paisa", api: "Xstream" }, { key: "Alice Blue", name: "Alice Blue", api: "ANT API" },
    { key: "Shoonya (Finvasia)", name: "Shoonya (Finvasia)", api: "Shoonya API" }, { key: "Motilal Oswal", name: "Motilal Oswal", api: "MO API" }
  ];
  var BROKER_LOGOS = { "Angel One": "angel-one.png", "Zerodha": "zerodha.svg", "Upstox": "upstox.svg", "Dhan": "dhan.svg", "Fyers": "fyers.svg", "Groww": "groww.png", "ICICI Direct": "icici-direct.svg", "Kotak Neo": "kotak-neo.svg", "5paisa": "5paisa.svg", "Alice Blue": "alice-blue.svg", "Shoonya (Finvasia)": "shoonya.svg", "Shoonya": "shoonya.svg", "Motilal Oswal": "motilal-oswal.png" };
  function brokerLogo(b) {
    var norm = function (x) { return String(x || "").replace(/\(.*\)/, "").toLowerCase().replace(/[^a-z0-9]/g, ""); };
    var f = null, want = [norm(b.key), norm(b.name)];
    Object.keys(BROKER_LOGOS).forEach(function (k) { if (!f && want.indexOf(norm(k)) >= 0) f = BROKER_LOGOS[k]; });
    return f ? '<span class="bcard__logo"><img src="brokers/' + f + '" alt="" loading="lazy" decoding="async" /></span>' : '<span class="bcard__mono" aria-hidden="true">' + esc(initials(b.name)) + "</span>";
  }
  function initials(name) { return name.replace(/\(.*\)/, "").trim().split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase(); }
  /* list items: { key, name, api, status: live|beta|rolling, connected, saved } */
  function renderBrokers(list) {
    list = list || DEMO_BROKERS.map(function (b) { return { key: b.key, name: b.name, api: b.api, status: b.status || "rolling", connected: S.connected.indexOf(b.key) >= 0 }; });
    $("#x-bgrid").innerHTML = list.map(function (b) {
      var label = b.status === "live" ? '<span class="up">Live</span>' : b.status === "beta" ? "Beta" : "Rolling out";
      var right = b.connected
        ? '<span class="connected x-connected"><span class="dot-live" aria-hidden="true"></span>Connected</span>'
        : '<button class="btn btn--' + (b.status === "live" ? "primary" : "secondary") + ' btn--sm" type="button" data-connect="' + esc(b.key) + '">' + (b.saved ? "Reconnect" : "Connect") + "</button>";
      return '<article class="bcard x-bcard"><div class="bcard__row">' + brokerLogo(b) + "<div><h3>" + esc(b.name) + "</h3><p>" + esc(b.api) + " · " + label + "</p></div></div>" + right + "</article>";
    }).join("");
  }
  function fieldHTML(name, label, secret, required, placeholder) {
    return '<label class="field x-field"><span>' + esc(label) + (required ? "" : " (optional)") + '</span><input name="' + esc(name) + '" ' + (secret ? 'type="password" ' : "") + 'autocomplete="off" ' + (required ? "required " : "") + 'placeholder="' + esc(placeholder || "") + '" /><small class="field__msg"></small></label>';
  }
  function openConnect(key) {
    var b = DEMO_BROKERS.filter(function (x) { return x.key === key; })[0]; if (!b) return;
    var form = $("#x-conn-form"); form.dataset.broker = ""; form.dataset.demo = key;
    $("#x-conn-title").textContent = "Connect " + b.name;
    $("#x-conn-intro").textContent = b.status === "live" ? "Demo only: nothing you type here leaves your browser." : b.name + " support is rolling out. In the demo you can try the form; nothing is sent.";
    var fields = b.fields || [["api_key", "API key"], ["client_id", "Client ID"], ["api_secret", "API secret", 1]];
    $("#x-conn-fields").innerHTML = fields.map(function (f) { return fieldHTML(f[0], f[1], f[2], true); }).join("");
    openModal($("#x-conn-modal"));
  }
  function validateFields(form) {
    var ok = true;
    $$("input[required]", form).forEach(function (i) {
      var wrap = i.closest(".field"), bad = !i.value.trim();
      wrap.classList.toggle("is-error", bad); var m = $(".field__msg", wrap); if (m) m.textContent = bad ? "Required." : "";
      if (bad) { i.setAttribute("aria-invalid", "true"); if (ok) i.focus(); ok = false; } else i.removeAttribute("aria-invalid");
    });
    return ok;
  }
  $("#x-bgrid").addEventListener("click", function (e) { var b = e.target.closest("[data-connect]"); if (b) openConnect(b.dataset.connect); });
  $("#x-conn-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target, key = form.dataset.demo;
    if (!validateFields(form)) return;
    if (S.connected.indexOf(key) < 0) S.connected.push(key);
    store.set("tc_demo_brokers", S.connected);
    closeModal($("#x-conn-modal")); renderBrokers(); renderChecklist();
    toast(key + " connected (demo). Nothing was sent.");
    if (S.afterBroker === "live" && S.model) { S.afterBroker = null; nav("studio"); setTimeout(function () { $("#x-golive").click(); }, 60); }
  });

  /* ================= demo parser ================= */
  // Rule-based reader for the browser demo. Understands plain English and common Hinglish
  // ("Nifty 5 min pe 20 EMA cross hone pe buy karo, 1% SL"). Output is the same rules table the
  // API returns (Instrument, Timeframe, Entry, Window, Exit, Risk), so both modes render alike.
  function toTime(h, m, ap) {
    h = +h; m = +(m || 0);
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 3) h += 12; // market hours: 3:15 means 15:15
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  var NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, ek: 1, "do": 2, teen: 3, char: 4, paanch: 5 };
  var STOCKS = [["hdfc bank", "HDFCBANK"], ["icici bank", "ICICIBANK"], ["axis bank", "AXISBANK"], ["kotak bank", "KOTAKBANK"], ["kotak mahindra", "KOTAKBANK"], ["state bank", "SBIN"], ["sbi", "SBIN"],
    ["reliance", "RELIANCE"], ["tcs", "TCS"], ["infosys", "INFY"], ["infy", "INFY"], ["itc", "ITC"], ["l&t", "LT"], ["larsen", "LT"], ["tata motors", "TATAMOTORS"], ["tata steel", "TATASTEEL"],
    ["bajaj finance", "BAJFINANCE"], ["maruti", "MARUTI"], ["wipro", "WIPRO"], ["hindustan unilever", "HINDUNILVR"], ["hul", "HINDUNILVR"], ["bharti airtel", "BHARTIARTL"], ["airtel", "BHARTIARTL"],
    ["adani enterprises", "ADANIENT"], ["sun pharma", "SUNPHARMA"], ["asian paints", "ASIANPAINT"], ["titan", "TITAN"], ["hcl tech", "HCLTECH"], ["ongc", "ONGC"], ["ntpc", "NTPC"], ["m&m", "M&M"], ["mahindra", "M&M"]];
  function findIndex(t) {
    return /nifty\s*50\s*stocks?/.test(t) ? "NIFTY 50 stocks" : /bank\s?nifty|\bbnf\b/.test(t) ? "BANKNIFTY" : /fin\s?nifty/.test(t) ? "FINNIFTY" : /midcp\s?nifty|midcap\s?nifty/.test(t) ? "MIDCPNIFTY" : /sensex/.test(t) ? "SENSEX" : /\bnifty\b/.test(t) ? "NIFTY" : null;
  }
  function findStock(t) {
    for (var i = 0; i < STOCKS.length; i++) if (new RegExp("(^|[^a-z])" + STOCKS[i][0].replace(/[&]/g, "\\&") + "([^a-z]|$)").test(t)) return STOCKS[i][1];
    return null;
  }
  // Hinglish and shorthand -> the plain-English words the rules below look for.
  function normalise(text) {
    var t = " " + text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ") + " ";
    t = t
      .replace(/\b(\d{1,2})[:.](\d{2})\s*baje\b/g, "$1:$2").replace(/\b(\d{1,2})\s*baje\b/g, "$1:00")
      .replace(/\b(kharido|khareedo|kharid lo|khareed lo|kharid|khareed|le lo|lelo|buy karo|buy kar lo|buy kro|buy karna|buy kar do)\b/g, " buy ")
      .replace(/\b(becho|bech do|bech|sell karo|sell kar do|sell kro|sell karna|short karo|short kar do)\b/g, " sell ")
      .replace(/\b(ke upar|ke uppar|ke oopar|ke uper|upar|uppar|oopar|uper)\b/g, " above ")
      .replace(/\b(ke neeche|ke niche|ke nichay|neeche|niche|nichay)\b/g, " below ")
      .replace(/\b(nikal jao|nikal lo|nikalo|nikal jaao|exit karo|exit kar do|exit kro|bahar niklo|square off karo|square off kar do)\b/g, " exit ")
      .replace(/\b(hone pe|hone par|ho jaye|ho jaaye|ho jae|hote hi|hone ke baad|ho to|ho toh|jab bhi|jab)\b/g, " when ")
      .replace(/\b(ke baad|ke bad)\b/g, " after ").replace(/\b(se pehle|se pahle|ke pehle)\b/g, " before ")
      .replace(/\b(din me|din mein|ek din me|per din|roz|rozana)\b/g, " a day ")
      .replace(/\b(sirf|bas|keval)\b/g, " only ").replace(/\baur\b/g, " and ").replace(/\bya\b/g, " or ").replace(/\b(ghante|ghanta)\b/g, " hour ")
      .replace(/\b(stop-?loss|stoploss)\b/g, "stop loss").replace(/\bpercent\b/g, "%")
      .replace(/\b(one|two|three|four|five|ek|do|teen|char|paanch)\s+(trades?|lots?)\b/g, function (m, a, b) { return NUMW[a] + " " + b; });
    return t.replace(/\s+/g, " ");
  }
  function pickTimes(t) {
    var out = [], re = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b|(\d{1,2})[:.](\d{2})(?![\d%]|\s*%)/g, m;
    while ((m = re.exec(t))) {
      var prev = t.charAt(m.index - 1);
      if (/[\d.,₹]/.test(prev)) continue; // part of a price or decimal
      var v = m[4] ? toTime(m[4], m[5]) : toTime(m[1], m[2], m[3]);
      if (v < "09:00" || v > "15:30") continue;
      out.push({ v: v, at: m.index, end: m.index + m[0].length });
    }
    return out;
  }
  // Must match LOT_SIZE in backend/app/backtest/rates.py
  var LOTS = { NIFTY: 65, BANKNIFTY: 30, FINNIFTY: 60, MIDCPNIFTY: 120, SENSEX: 20 };
  function lotFor(base) { return /BANKNIFTY/.test(base) ? LOTS.BANKNIFTY : /FINNIFTY/.test(base) ? LOTS.FINNIFTY : /MIDCPNIFTY/.test(base) ? LOTS.MIDCPNIFTY : /SENSEX/.test(base) ? LOTS.SENSEX : LOTS.NIFTY; }
  function parse(text) {
    var t = normalise(text), r = {};
    var idx = findIndex(t) || findStock(t);
    if (!idx) { var m0 = text.match(/\b(?:[Bb]uy|[Ss]ell|[Ss]hort|BUY|SELL)\s+([A-Z][A-Za-z&]+(?:\s[A-Z][a-z]+)?)/); idx = m0 && !/^(When|If|On|At|The|ATM|Call|Put)$/.test(m0[1]) ? m0[1].toUpperCase().replace(/\s+/g, "") : "Instrument?"; }
    var fs = t.match(/\b(buy|sell|short|long|go long|go short)\b/), side = fs && /sell|short/.test(fs[1]) ? "Sell" : "Buy";
    var mny = /\botm\b|out of the money/.test(t) ? "OTM" : /\bitm\b|in the money/.test(t) ? "ITM" : "ATM";
    var isPut = /\bput\b|\b(?:atm|itm|otm|\d{3,6})\s*pe\b|\bpe\s+option/.test(t), isCall = /\bcall\b|\bce\b/.test(t);
    var opt = /straddle/.test(t) ? "ATM straddle" : /strangle/.test(t) ? "OTM strangle" : isPut && !isCall ? mny + " put" : isCall ? mny + " call" : /\boptions?\b/.test(t) ? mny + (side === "Sell" ? " put" : " call") : null;
    var fut = /futures?|\bfut\b/.test(t);
    var equity = idx !== "Instrument?" && !findIndex(t) && !opt && !fut;
    r.Instrument = idx + (opt ? " options · " + side + " " + opt : fut ? " futures · " + side : equity ? " equity · " + side : " · " + side);

    // timeframe
    var tf = t.match(/(\d+)\s*-?\s*(?:min|mins|minute|minutes|m)\b(?!\s*(?:earlier|later|before|after|pehle|baad))/), tfv = null;
    if (/\b(?:1\s*-?\s*hour|1\s*h|60\s*-?\s*min\w*|hourly)\b/.test(t)) tfv = "1h";
    else if (tf) tfv = tf[1] === "60" ? "1h" : tf[1] + "m";
    else if (/\bdaily\b(?!\s*loss)|\bday candles?|\b1\s*d\b|\beod\b|\bswing\b|\bpositional\b/.test(t)) tfv = "1D";
    r.Timeframe = tfv || "5m (default)";

    // entry
    var emas = [], re = /(\d+)\s*-?\s*(?:period\s*)?(?:ema|exponential)\b|\bema\s*\(?\s*(\d+)/g, mm;
    while ((mm = re.exec(t))) emas.push(mm[1] || mm[2]);
    var pair = t.match(/(\d+)\s*(?:\/|and|&|,|x)\s*(\d+)\s*-?\s*(ema|sma|dma|ma)\b|\b(ema|sma)\s*(\d+)\s*(?:\/|and|&|,|x)\s*(\d+)/);
    if (pair && /ema/.test(pair[3] || pair[4])) emas = [pair[1] || pair[5], pair[2] || pair[6]];
    var smas = [], re2 = /(\d+)\s*-?\s*(?:sma|dma|ma|day moving average|moving average)\b|\bsma\s*\(?\s*(\d+)/g;
    while ((mm = re2.exec(t))) smas.push(mm[1] || mm[2]);
    if (pair && /sma|dma|^ma$/.test(pair[3] || pair[4] || "")) smas = [pair[1] || pair[5], pair[2] || pair[6]];
    var dw = t.match(/\b(above|below|under|crosses up|crosses down|cuts down|breaks down|breakdown)\b/);
    var down = dw ? /below|under|down/.test(dw[1]) : side === "Sell";
    var dir = down ? "▼" : "▲";
    var gap = t.match(/gaps?\s*(up|down)\s*(?:by\s*)?(?:more than\s*|over\s*)?(\d+(?:\.\d+)?)\s*%/);
    var rsi = t.match(/rsi\s*\(?\s*(\d+)?\s*\)?\s*(?:is\s*|goes\s*|drops\s*|falls\s*|crosses\s*|moves\s*|dips\s*|rises\s*|comes\s*)?(below|under|above|over|<|>)\s*(\d+)/);
    var rsi2 = !rsi && t.match(/rsi\s*\(?\s*(\d+)\s*\)?\s*(below|above)\b/);
    // Only what the backend DSL can run (backend/app/strategy/dsl.py): EMA/SMA, RSI, VWAP, Supertrend, ADX, ORB, fixed time.
    var UNSUP = [[/\bmacd\b/, "MACD"], [/bollinger|\bbb\b/, "Bollinger Bands"], [/stochastic/, "Stochastic"],
      [/(previous|prev|yesterday'?s?|pichle din k[ai]|last day'?s?)\s*(?:day'?s?\s*)?(high|low|close)|\bpd[hl]\b/, "previous-day levels"],
      [/52\s*-?\s*week/, "52-week levels"], [/iron\s*(condor|fly|butterfly)/, "iron condors / flies"], [/\bcpr\b|pivot/, "pivot / CPR levels"], [/\bgaps?\s*(up|down)/, "gap rules"]];
    var unsupported = UNSUP.filter(function (u) { return u[0].test(t); }).map(function (u) { return u[1]; });
    var primary = null;
    if (/opening range|\borb\b|first 15 min/.test(t)) { primary = "orb"; r.Entry = "Break " + (/below|breakdown|low/.test(t) || side === "Sell" ? "below" : "above") + " 09:15–09:30 range"; }
    else if (/straddle|strangle/.test(t)) { primary = "time"; r.Entry = side + " " + (opt || "straddle") + " at fixed time"; }
    else if (/golden cross/.test(t)) { primary = "ma"; r.Entry = "SMA 50 ▲ SMA 200"; }
    else if (/death cross/.test(t)) { primary = "ma"; r.Entry = "SMA 50 ▼ SMA 200"; }
    else if (emas.length >= 2) { primary = "ma"; r.Entry = "EMA " + emas[0] + " " + dir + " EMA " + emas[1]; }
    else if (smas.length >= 2) { primary = "ma"; r.Entry = "SMA " + smas[0] + " " + dir + " SMA " + smas[1]; }
    else if (rsi) { primary = "rsi"; r.Entry = "RSI " + (rsi[1] || 14) + (/below|under|</.test(rsi[2]) ? " < " : " > ") + rsi[3]; }
    else if (rsi2) { primary = "rsi"; r.Entry = "RSI 14" + (rsi2[2] === "below" ? " < " : " > ") + rsi2[1]; }
    else if (/rsi/.test(t) && /oversold|overbought/.test(t)) { primary = "rsi"; r.Entry = /oversold/.test(t) ? "RSI 14 < 30" : "RSI 14 > 70"; }
    else if (/supertrend/.test(t)) { primary = "st"; var st = t.match(/supertrend\s*\(?\s*(\d+)\s*[,/ ]\s*(\d+(?:\.\d+)?)/); r.Entry = "Supertrend " + (st ? st[1] + "," + st[2] : "10,3") + (side === "Sell" && !/green/.test(t) ? " turns red" : " turns green"); }
    else if (/vwap/.test(t)) { primary = "vwap"; r.Entry = /(crosses|breaks|slips|goes|falls)\s+below\s+vwap|below vwap/.test(t) && !/pull\s*back/.test(t)
      ? "Cross below VWAP" + (emas.length ? ", below EMA " + emas[0] : "")
      : /(crosses|breaks)\s+above\s+vwap/.test(t) ? "Cross above VWAP" + (emas.length ? ", above EMA " + emas[0] : "") : "Pullback to VWAP" + (emas.length ? ", above EMA " + emas[0] : ""); }
    else if (emas.length === 1) { primary = "ma1"; r.Entry = "Close " + dir + " EMA " + emas[0]; }
    else if (smas.length === 1) { primary = "ma1"; r.Entry = "Close " + dir + " SMA " + smas[0]; }
    else if (/\bat\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?/.test(t)) { primary = "time"; r.Entry = side + " at fixed time"; }
    else r.Entry = unsupported.length ? unsupported.join(", ") + " · not supported yet" : "Custom condition · review";
    // AND filters on top of the main signal, same as the backend parser
    if (primary && primary !== "time") {
      var rf = t.match(/rsi\s*\(?\s*\d{0,2}\s*\)?\s*(?:is\s*|stays?\s*)?(above|over|below|under|>=?|<=?)\s*(\d{1,2})/);
      if (primary !== "rsi" && rf) r.Entry += " + RSI 14 " + (/above|over|>/.test(rf[1]) ? "> " : "< ") + rf[2];
      var vf = t.match(/(above|over|below|under)\s+(?:the\s+)?vwap/);
      if (primary !== "vwap" && vf) r.Entry += " + close " + (/above|over/.test(vf[1]) ? "above" : "below") + " VWAP";
      var af = t.match(/adx\s*\(?\s*(\d{1,2})?\s*\)?\s*(?:is\s*)?(?:above|over|>=?)\s*(\d{1,2})/);
      if (af) r.Entry += " · ADX(14) > " + af[2];
    }
    Object.defineProperty(r, "_unsupported", { value: unsupported, enumerable: false });

    // time window and exit time
    var times = pickTimes(t), exitT = null, starts = [], ends = [];
    times.forEach(function (x) {
      var before = t.slice(Math.max(0, x.at - 32), x.at), after = t.slice(x.end, x.end + 14);
      if (/(between|from|after|start(?:ing)?(?:\s*at)?|enter(?:\s*after)?)\s*$/.test(before) || /^\s*after\b/.test(after)) starts.push(x.v);
      else if (/(and|to|till|until|upto|up to|before|no (?:new )?entr(?:y|ies) after|stop entering(?:\s*at)?)\s*$/.test(before) && starts.length && !/(exit|square)/.test(before.slice(-14))) ends.push(x.v);
      else if (/(exit|close|square|by|or|tak)\s*(?:\w+\s*){0,2}(?:at\s*)?$/.test(before) || /^\s*(?:pe|par|tak|ko)?\s*(?:exit|square)/.test(after) || x.v >= "14:00") exitT = x.v;
      else if (/\bat\s*$/.test(before)) starts.push("at " + x.v);
      else starts.push(x.v);
    });
    if (/opening range|\borb\b/.test(t)) r.Window = "after 09:30";
    else if (starts.length && ends.length) r.Window = starts[0].replace("at ", "") + "–" + ends[0];
    else if (starts.length) r.Window = /^at /.test(starts[0]) ? starts[0] : "after " + starts[0];
    else r.Window = "09:15–15:30 (market hours)";
    if (/expiry\s*day/.test(t)) r.Window += " · expiry day only";

    var ex = [];
    if (/opposite|reverse (?:cross|signal)|crosses back|ulta|death cross/.test(t) || /(?:exit|sell|close)\s+(?:\w+\s+){0,2}(?:when|if|on)\s+[^.,]*cross/.test(t) && /ema|sma|dma|\bma\b|golden|macd/.test(t)) ex.push("opposite cross");
    else if (/turns red|flips red/.test(t) && /supertrend/.test(t)) ex.push("Supertrend flips red");
    else if (rsi || rsi2) { var tail = t.slice(t.indexOf((rsi || rsi2)[0]) + (rsi || rsi2)[0].length); var ab = tail.match(/(?:above|over|>)\s*(\d+)|(\d+)\s*above/); if (ab) ex.push("RSI > " + (ab[1] || ab[2])); }
    var tNoTrail = t.replace(/trail(?:ing)?\s*(?:stop\s*(?:loss)?|sl)?\s*(?:of|at|by)?\s*\d+(?:\.\d+)?\s*%/g, " ");
    var sl = tNoTrail.match(/(?:stop\s*loss|\bsl\b|\bstop\b)\s*(?:of|at|=|:|hai|rakho|lagao)?\s*(\d+(?:\.\d+)?)\s*(%|points?|pts|rs|₹)?/) || tNoTrail.match(/(\d+(?:\.\d+)?)\s*(%|points?|pts)\s*(?:ka\s*)?(?:stop\s*loss|\bsl\b|\bstop\b)/);
    var tg = t.match(/(?:target|tgt|take\s*profit|profit\s*target|\btp\b)\s*(?:of|at|=|:|hai|rakho)?\s*(\d+(?:\.\d+)?)\s*(%|points?|pts)?/) || t.match(/(\d+(?:\.\d+)?)\s*(%|points?|pts)\s*(?:ka\s*)?(?:target|tgt|profit)/);
    var tr = t.match(/trail(?:ing)?\s*(?:stop\s*(?:loss)?|sl)?\s*(?:of|at|by)?\s*(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%\s*trail/);
    var unit = function (u) { return !u || u === "%" ? "%" : " pts"; };
    if (sl && !(sl[2] === undefined && +sl[1] > 100)) ex.push("SL " + sl[1] + unit(sl[2]) + (/each leg|per leg/.test(t) ? " per leg" : /premium/.test(t) && unit(sl[2]) === "%" ? " of premium" : ""));
    if (tg && !(tg[2] === undefined && +tg[1] > 100)) ex.push("target " + tg[1] + unit(tg[2]));
    else if (/target[^.]*previous (?:day'?s )?close|fill(?:s|ed)? the gap/.test(t)) ex.push("target prev close");
    if (tr) ex.push("trail " + (tr[1] || tr[2]) + "%");
    if (r.Timeframe !== "1D" || exitT) ex.push((exitT || "15:15") + " hard exit");
    r.Exit = ex.length ? ex.join(" / ") : "No exit found · review";

    var risk = [], mt = t.match(/(?:max(?:imum)?|only|at most|upto|up to)?\s*(\d+)\s*trades?\b/), dl = t.match(/(?:daily|per day|a day|max(?:imum)?|day'?s?)?\s*loss\s*(?:limit|cap)?\s*(?:of|is|=|:)?\s*(?:₹|rs\.?|inr)?\s*(\d[\d,]*)\s*(k\b)?/) || t.match(/(?:₹|rs\.?|inr)\s*(\d[\d,]*)\s*(k\b)?\s*(?:ka\s*)?(?:daily\s*)?loss/);
    risk.push(mt && +mt[1] > 0 && +mt[1] <= 50 ? mt[1] + (mt[1] === "1" ? " trade/day" : " trades/day") : "3 trades/day (default)");
    var lots = t.match(/(\d+)\s*lots?\b/), qty = t.match(/(?:qty|quantity)\s*(?:of\s*)?(\d+)|(\d+)\s*shares?\b/);
    if (lots) risk.push(lots[1] + (lots[1] === "1" ? " lot" : " lots")); else if (qty) risk.push((qty[1] || qty[2]) + " shares");
    if (dl && /loss/.test(dl[0])) { var amt = +dl[1].replace(/,/g, "") * (dl[2] ? 1000 : 1); if (amt >= 100) risk.push("₹" + inr(amt) + " daily loss cap"); }
    r.Risk = risk.join(" · ");
    return r;
  }
  function explain(r) {
    var tfs = (r.Timeframe || "").replace(" (default)", "");
    return (r.Instrument || "").replace(" · ", ": ") + ". Enter on " + r.Entry + " (" + tfs + " candles, " + r.Window + "). Exit on " + r.Exit + ". Risk: " + r.Risk + ".";
  }

  /* ================= demo backtest ================= */
  // Simulated, but consistent: the same market (regime, random draws) is replayed for every variant of a
  // strategy, so changing a stop, the timeframe or the exit time moves the numbers in a believable direction.
  function rng(seed) { var s = seed >>> 0 || 1; return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hash(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var hm = function (s) { var p = String(s).split(":"); return +p[0] * 60 + +p[1]; };
  var fmtHM = function (m) { var h = Math.floor(m / 60), n = m % 60; return (h < 10 ? "0" : "") + h + ":" + (n < 10 ? "0" : "") + n; };
  function ruleInfo(rules) {
    var I = rules.Instrument || "", E = rules.Entry || "", X = rules.Exit || "", R = rules.Risk || "", W = rules.Window || "";
    var TF = String(rules.Timeframe || "").replace(/\s*\(default\)/, "").toLowerCase().replace(/\s+/g, "");
    var tfMin = /^(\d+)m/.test(TF) ? +TF.match(/^(\d+)/)[1] : /h/.test(TF) ? 60 : /d/.test(TF) ? 375 : 5;
    var base = I.split(" ·")[0].replace(/\s+(options|futures|equity|option|future)$/i, "").trim() || "NIFTY";
    var isOpt = /options?\b/i.test(I), multi = /straddle|strangle|condor|CE\s*\+\s*PE/i.test(I), sellPrem = isOpt && /\bsell\b/i.test(I);
    var index = /NIFTY|SENSEX/.test(base), meanRev = /RSI|straddle|strangle|condor|pullback|BB|gap/i.test(E + " " + I);
    var num = function (re, s) { var m = s.match(re); return m ? parseFloat(m[1]) : null; };
    var sl = X.match(/SL\s*([\d.]+)\s*(%|pts)/i), tg = X.match(/target\s*([\d.]+)\s*(%|pts)/i);
    var hx = X.match(/(\d{2}:\d{2})\s*hard exit/), daily = tfMin >= 375;
    var times = (W.match(/\d{2}:\d{2}/g) || []);
    var fixed = /^at\s/.test(W) || /fixed time/.test(E) ? hm(times[0] || "09:20") : null;
    var start = times[0] && !/^09:15–15:30/.test(W) ? hm(times[0]) : 555;
    var exitM = hx ? hm(hx[1]) : daily ? 930 : 915;
    var end = times[1] ? hm(times[1]) : Math.min(900, exitM - 15);
    var lots = num(/(\d+)\s*lots?/, R), shares = num(/(\d+)\s*shares?/, R);
    return {
      base: base, tfMin: tfMin, isOpt: isOpt, multi: multi, sellPrem: sellPrem, index: index, meanRev: meanRev, daily: daily, fixed: fixed,
      start: start, end: Math.max(start, end), exitM: exitM, maxT: num(/(\d+)\s*trades?\/day/, R) || 3,
      sl: sl ? { v: +sl[1], pts: /pts/i.test(sl[2]) } : null, tg: tg ? { v: +tg[1], pts: /pts/i.test(tg[2]) } : null,
      trail: num(/trail\s*([\d.]+)\s*%/i, X), dl: num(/₹\s*([\d,]+)\s*daily loss cap/, R.replace(/,/g, "")),
      adx: num(/ADX\s*\(?14\)?\s*>\s*(\d+)/i, E), lotMul: lots || (shares ? shares / 50 : 1),
      seedKey: base + "|" + E.replace(/\s*·\s*ADX.*$/i, "") + "|" + (isOpt ? "o" : "f")
    };
  }
  function tradingDays() {
    var out = [], d = Date.UTC(2020, 0, 2), end = Date.now();
    for (; d <= end; d += 864e5) { var wd = new Date(d).getUTCDay(); if (wd !== 0 && wd !== 6) out.push(d); }
    return out;
  }
  var DAYS_CACHE = null;
  function backtest(rules) {
    var q = ruleInfo(rules), seed = hash(q.seedKey), S0 = rng(seed);
    var days = DAYS_CACHE || (DAYS_CACHE = tradingDays());
    var lot = lotFor(q.base);
    var tfF = { 1: 1.5, 3: 1.25, 5: 1, 10: 0.88, 15: 0.78, 30: 0.62, 60: 0.48 }[q.tfMin] || (q.daily ? 0.14 : 0.8);
    var baseFreq = 0.13 + S0() * 0.09, wr0 = 0.468 + S0() * 0.09;
    var U = (q.sellPrem ? 1500 : q.isOpt ? 1350 : q.index ? 1700 : 650) * clamp(q.lotMul, 0.2, 20) * (q.multi ? 1.5 : 1);
    var mag = clamp(Math.sqrt(q.tfMin / 5), 0.65, 2.6), span = Math.max(30, q.exitM - 555);
    var trades = [], reg = { trending: { days: 0, trades: 0, net: 0, wins: 0 }, range: { days: 0, trades: 0, net: 0, wins: 0 }, volatile: { days: 0, trades: 0, net: 0, wins: 0 } };
    var c = { Brokerage: 0, STT: 0, "Exchange & SEBI": 0, "Stamp duty": 0, GST: 0, Slippage: 0 };
    var cum = 0, peak = 0, dd = 0, wins = 0, gw = 0, gl = 0, gross = 0, eq = [0], eqT = [days[0]];
    var hours = {}, cooldown = 0, adxSave = 0, whip = 0, whipLoss = 0, legs = q.multi ? 2 : 1;
    for (var di = 0; di < days.length; di++) {
      var R = rng(seed ^ Math.imul(di + 1, 2654435761)), u = R();
      var regime = u < 0.17 ? "volatile" : u < 0.57 ? "trending" : "range";
      var adx = regime === "trending" ? 25 + R() * 20 : regime === "range" ? 11 + R() * 11 : 16 + R() * 20;
      reg[regime].days++;
      var pSig = q.fixed != null ? 0.92 : baseFreq * tfF * (q.daily ? 1 : 1.6);
      var sigU = R(), extraU = [R(), R(), R(), R()], dayDraws = [];
      for (var k = 0; k < 5; k++) dayDraws.push([R(), R(), R(), R(), R()]);
      if (sigU > pSig) continue;
      if (q.adx && adx < q.adx) continue;
      var n = 1; while (q.fixed == null && n < q.maxT && n <= 4 && extraU[n - 1] < 0.42 * tfF) n++;
      var dayNet = 0, lastExit = -1, lastLoss = false;
      for (var j = 0; j < n; j++) {
        var D = dayDraws[j];
        var bars = Math.max(1, Math.floor((q.end - q.start) / q.tfMin));
        var em = q.fixed != null ? q.fixed : q.start + q.tfMin * Math.floor(D[0] * bars);
        if (j > 0) em = Math.max(em, lastExit + q.tfMin);
        if (em > Math.min(q.end, q.exitM - q.tfMin) && !q.daily) break;
        var hold = q.daily ? 1 : Math.min(q.exitM - em, q.tfMin * (2 + Math.floor(D[1] * 10)));
        if (q.fixed != null && !q.daily) hold = q.exitM - em;
        var reentry = j > 0 && em - lastExit <= 3 * q.tfMin;
        var wr = wr0;
        if (q.meanRev) wr += regime === "range" ? 0.08 : regime === "trending" ? -0.06 : -0.09;
        else wr += regime === "trending" ? 0.1 : regime === "range" ? -0.09 : 0;
        if (q.sellPrem) wr += 0.14;
        if (reentry && lastLoss) wr -= 0.1;
        if (em >= 840) wr -= 0.07; // late-session chop
        var slN = q.sl ? (q.sl.pts ? q.sl.v / (q.isOpt ? 25 : /BANK/.test(q.base) ? 120 : 50) : q.sl.v / (q.isOpt ? 30 : 0.8)) : null;
        var tgN = q.tg ? (q.tg.pts ? q.tg.v / (q.isOpt ? 50 : /BANK/.test(q.base) ? 240 : 100) : q.tg.v / (q.isOpt ? 50 : 1.6)) : null;
        if (slN != null) wr -= 0.05 * (1 - clamp(slN, 0, 1));
        if (tgN != null) wr += 0.04 * (1 - clamp(tgN, 0, 1));
        var holdF = q.daily ? 1 : 0.55 + 0.45 * Math.sqrt(clamp(hold / span, 0.05, 1));
        var vol = regime === "volatile" ? 1.6 : regime === "trending" ? 1.1 : 0.8;
        var win = D[2] < wr, g;
        if (win) { g = U * (0.7 + D[3] * 1.95) * mag * vol * holdF * (q.sellPrem ? 0.6 : 1); if (tgN != null) g = Math.min(g, U * mag * (0.6 + 1.6 * clamp(tgN, 0.2, 1.5))); if (q.trail) g *= 0.95; }
        else { g = -U * (0.5 + D[3] * 1.4) * mag * vol * holdF * (q.sellPrem ? 1.35 : 1); if (slN != null) g = Math.max(g, -U * mag * (0.4 + clamp(slN, 0.2, 1.5))); if (q.trail) g *= 0.85; }
        var brok = 40 * legs, stt = (q.isOpt ? (q.sellPrem ? 30 : 12) : q.index ? 25 : 18 * clamp(q.lotMul, 0.5, 5)) * legs * (0.7 + D[4] * 0.6), exch = (q.isOpt ? 26 : 14) * legs * (0.8 + D[4] * 0.4);
        var stamp = (q.isOpt ? 3 : 6) * legs, gst = (brok + exch) * 0.18, slip = (55 + D[4] * 85) * legs * clamp(Math.sqrt(q.lotMul), 0.5, 3);
        var cost = brok + stt + exch + stamp + gst + slip, net = g - cost;
        if (q.dl && dayNet <= -q.dl) break;
        c.Brokerage += brok; c.STT += stt; c["Exchange & SEBI"] += exch; c["Stamp duty"] += stamp; c.GST += gst; c.Slippage += slip;
        var when = days[di] + (em - 330) * 6e4; // IST minutes -> UTC ms
        trades.push({ t: when, g: g, net: net, em: em, regime: regime });
        gross += g; cum += net; dayNet += net; eq.push(cum); eqT.push(when);
        if (net > 0) { wins++; gw += net; reg[regime].wins++; } else gl -= net;
        reg[regime].trades++; reg[regime].net += net;
        peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
        var hr = fmtHM(Math.floor(em / 60) * 60); hours[hr] = (hours[hr] || 0) + net;
        if (reentry && lastLoss) cooldown -= net;
        if (net < 0 && (reentry || (regime === "range" && hold <= 3 * q.tfMin))) { whip++; whipLoss += net; }
        if (!q.adx && adx < 20) adxSave -= net;
        lastExit = em + hold; lastLoss = net < 0;
      }
    }
    var nT = trades.length, end = Date.now();
    var step = Math.max(1, Math.floor(eq.length / 140)), vals = [], labels = [];
    for (var s = 0; s < eq.length; s += step) { vals.push(Math.round(eq[s])); labels.push(eqT[s]); }
    if (labels[labels.length - 1] !== eqT[eqT.length - 1]) { vals.push(Math.round(eq[eq.length - 1])); labels.push(eqT[eqT.length - 1]); }
    var lastPx = /BANKNIFTY/.test(q.base) ? 52200 : /FINNIFTY/.test(q.base) ? 23900 : /SENSEX/.test(q.base) ? 80900 : /MIDCP/.test(q.base) ? 12480 : 24600, recent = [], RT = rng(seed + nT);
    var sideBuy = !/\bSell\b/.test(rules.Instrument || ""), strikeStep = /BANKNIFTY|SENSEX/.test(q.base) ? 100 : 50;
    for (var k2 = nT - 1; k2 >= Math.max(0, nT - 8); k2--) {
      var tr = trades[k2], dt = new Date(tr.t), name;
      var strike = Math.round((lastPx + (RT() - 0.5) * 600) / strikeStep) * strikeStep;
      name = q.isOpt ? q.base + " " + strike + (/put/i.test(rules.Instrument) ? " PE" : q.multi ? " CE+PE" : " CE") : q.base;
      var qty = q.isOpt || q.index ? lot * Math.max(1, Math.round(q.lotMul)) : Math.max(1, Math.round(q.lotMul * 50));
      var entry = q.isOpt ? 90 + RT() * 140 : q.index ? lastPx * (0.98 + RT() * 0.04) : 400 + RT() * 2600;
      var exit = Math.max(0.05, entry + (sideBuy ? 1 : -1) * tr.g / qty);
      recent.push({ when: istDate(dt) + " · " + istTime(dt), side: sideBuy ? "Buy" : "Sell", instrument: name, entry: entry, exit: exit, net: tr.net });
    }
    var regimes = ["trending", "range", "volatile"].map(function (k) {
      var x = reg[k]; return { regime: k, days: x.days, trades: x.trades, net_pnl: Math.round(x.net), win_rate: x.trades ? x.wins / x.trades * 100 : 0, share_of_days: days.length ? x.days / days.length * 100 : 0 };
    });
    var hk = Object.keys(hours).sort(), worst = null, best = null;
    hk.forEach(function (h) { if (worst === null || hours[h] < hours[worst]) worst = h; if (best === null || hours[h] > hours[best]) best = h; });
    var sug = [];
    if (cooldown > 500) sug.push([cooldown, "Add a 3-bar cooldown after a loss: +" + rupee(cooldown) + " on this data"]);
    if (adxSave > 500) sug.push([adxSave, "Skip entries when ADX(14) is below 20: +" + rupee(adxSave) + " on this data"]);
    if (worst && hours[worst] < -500 && hk.length > 1) sug.push([-hours[worst], "Avoid new entries in the " + worst + " hour: +" + rupee(-hours[worst]) + " on this data"]);
    sug.sort(function (a, b) { return b[0] - a[0]; });
    var costs = Object.keys(c).reduce(function (a, k) { return a + c[k]; }, 0);
    return {
      instrument: q.base, illustrative: true, badge: "Simulated", note: "Demo mode: these numbers are simulated in your browser to show how results look. They are not a real backtest of your strategy.",
      scope: q.base + " · " + String(rules.Timeframe || "").replace(" (default)", "") + " · Jan 2020 – " + MON[new Date(end).getMonth()] + " " + new Date(end).getFullYear() + " · synthetic data",
      metrics: { trades: nT, winRate: nT ? wins / nT * 100 : 0, gross: gross, net: cum, costs: costs, maxDD: dd, pf: gl ? gw / gl : null, expectancy: nT ? cum / nT : 0 },
      equity: { labels: labels, values: vals, fmt: function (l, long) { var d = new Date(+l); return long ? istDate(d) : MON[d.getMonth()] + " ’" + String(d.getFullYear()).slice(2); } },
      costs: c, trades: recent, totalTrades: nT,
      regimes: nT ? regimes : null,
      autopsy: nT ? { whipsaw_trades: whip, whipsaw_loss: Math.round(whipLoss), cooldown_saving: Math.round(cooldown), adx_filter_saving: q.adx ? 0 : Math.round(adxSave),
        worst_hour: worst, worst_hour_pnl: worst ? Math.round(hours[worst]) : 0, best_hour: best, best_hour_pnl: best ? Math.round(hours[best]) : 0, suggestions: sug.slice(0, 3).map(function (x) { return x[1]; }) } : null
    };
  }

  /* ================= demo copilot ================= */
  // Same instructions as POST /api/strategies/copilot (CONTRACT.md §1), applied to the rules table.
  // Works on the API's rules too (Window "09:15–15:00", Exit "… / 15:15 hard exit", Risk "2 trades/day · 1 lot").
  var COP_EXAMPLES = "Try “exit 15 min earlier”, “add a 1% stop loss”, “max 1 trade a day” or “switch to 5 min”.";
  function copilotDemo(rules0, instruction) {
    var r = JSON.parse(JSON.stringify(rules0)), i = normalise(instruction), changes = [];
    var X = function () { return (r.Exit || "").split(/\s*\/\s*/).filter(function (p) { return p && !/No exit found/i.test(p); }); };
    var setX = function (parts) { r.Exit = parts.length ? parts.join(" / ") : "No exit found · review"; };
    var hardOf = function () { var m = (r.Exit || "").match(/(\d{2}:\d{2})\s*hard exit/); return m ? m[1] : null; };
    var setHard = function (v) {
      var parts = X().filter(function (p) { return !/hard exit|positional/.test(p); }); parts.push(v + " hard exit"); setX(parts);
    };
    var num = function (s) { return NUMW[s] != null ? NUMW[s] : +s; };
    var unitOf = function (u) { return !u || /%/.test(u) ? "%" : " pts"; };
    var win = function () {
      var w = r.Window || "", t = w.match(/\d{2}:\d{2}/g) || [];
      if (/^09:15–15:30 \(market/.test(w)) return { s: "09:15", e: "15:00" };
      return { s: t[0] || "09:15", e: t[1] || (/^at\s/.test(w) ? null : "15:00"), at: /^at\s/.test(w) };
    };
    var m;
    // exit N min earlier / later
    if ((m = i.match(/(?:exit|square off|hard exit|close)[^.]*?(\d+)\s*(?:min|mins|minutes?|m)\b\s*(earlier|sooner|before|pehle|later|after|baad)/)) || (m = i.match(/(\d+)\s*(?:min|mins|minutes?)\s*(earlier|sooner|pehle|later|baad)\s*(?:exit|square)/))) {
      var cur = hardOf() || "15:15", d = +m[1] * (/later|after|baad/.test(m[2]) ? 1 : -1), nv = fmtHM(clamp(hm(cur) + d, 570, 925));
      if (nv !== cur) { setHard(nv); changes.push("Hard exit moved from " + cur + " to " + nv); }
    } else if ((m = i.match(/(?:exit|square off|close (?:all|everything|positions?))\s*(?:all|everything|positions?)?\s*(?:at|by|before)\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)/))) {
      var tt = pickTimes(" " + m[1].replace(/^(\d{1,2})\s*(am|pm)?$/, function (a, h, ap) { return h + ":00" + (ap ? " " + ap : ""); }) + " ")[0];
      if (tt) { var was = hardOf(); setHard(tt.v); changes.push(was ? "Hard exit moved from " + was + " to " + tt.v : "Hard exit set to " + tt.v); }
    }
    // stop loss
    if (/(remove|no|drop|without)\s*(?:the\s*)?(?:stop\s*loss|\bsl\b)/.test(i)) {
      if (/SL\s/.test(r.Exit || "")) { setX(X().filter(function (p) { return !/^SL\s/.test(p); })); changes.push("Stop loss removed"); }
    } else if ((m = i.match(/(?:stop\s*loss|\bsl\b|\bstop\b)(?!\s*entering)\s*(?:to|of|at|=|:)?\s*(\d+(?:\.\d+)?)\s*(%|points?|pts)?/)) || (m = i.match(/(\d+(?:\.\d+)?)\s*(%|points?|pts)\s*(?:stop\s*loss|\bsl\b|\bstop\b)/))) {
      var sv = "SL " + m[1] + unitOf(m[2]), old = X().filter(function (p) { return /^SL\s/.test(p); })[0], suffix = old && / per leg| of premium/.test(old) ? old.match(/ per leg| of premium/)[0] : "";
      if (!/trail/.test(i.slice(Math.max(0, i.indexOf(m[0]) - 10), i.indexOf(m[0]) + 2))) {
        var parts0 = X(), at0 = parts0.indexOf(old);
        if (at0 >= 0) parts0[at0] = sv + suffix; else parts0.splice(Math.max(0, parts0.length - (hardOf() ? 1 : 0)), 0, sv + suffix);
        setX(parts0);
        changes.push(old ? "Stop loss changed from " + old.replace(/^SL\s/, "") + " to " + m[1] + unitOf(m[2]) : "Stop loss of " + m[1] + unitOf(m[2]) + " added");
      }
    }
    // target
    if (/(remove|no|drop|without)\s*(?:the\s*)?(?:target|tgt)/.test(i)) {
      if (/target/.test(r.Exit || "")) { setX(X().filter(function (p) { return !/^target/.test(p); })); changes.push("Target removed"); }
    } else if ((m = i.match(/(?:target|tgt|take\s*profit|profit\s*target)\s*(?:to|of|at|=|:)?\s*(\d+(?:\.\d+)?)\s*(%|points?|pts)?/)) || (m = i.match(/(\d+(?:\.\d+)?)\s*(%|points?|pts)\s*(?:target|tgt|profit)/))) {
      var oldT = X().filter(function (p) { return /^target/.test(p); })[0], restT = X().filter(function (p) { return !/^target/.test(p); });
      var pT = X(), aT = pT.indexOf(oldT);
      if (aT >= 0) pT[aT] = "target " + m[1] + unitOf(m[2]); else pT.splice(Math.max(0, pT.length - (hardOf() ? 1 : 0)), 0, "target " + m[1] + unitOf(m[2]));
      setX(pT); restT = null;
      changes.push(oldT ? "Target changed from " + oldT.replace(/^target\s/, "") + " to " + m[1] + unitOf(m[2]) : "Target of " + m[1] + unitOf(m[2]) + " added");
    }
    // trailing stop
    if ((m = i.match(/trail(?:ing)?\s*(?:stop\s*(?:loss)?|sl)?\s*(?:to|of|at|by)?\s*(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%\s*trail/))) {
      var v = m[1] || m[2], oldTr = X().filter(function (p) { return /^trail/.test(p); })[0], restTr = X().filter(function (p) { return !/^trail/.test(p); });
      var pTr = X(), aTr = pTr.indexOf(oldTr);
      if (aTr >= 0) pTr[aTr] = "trail " + v + "%"; else pTr.splice(Math.max(0, pTr.length - (hardOf() ? 1 : 0)), 0, "trail " + v + "%");
      setX(pTr); restTr = null;
      changes.push(oldTr ? "Trailing stop changed from " + oldTr.replace(/^trail\s/, "") + " to " + v + "%" : "Trailing stop of " + v + "% added");
    }
    // max trades a day
    if ((m = i.match(/(?:max(?:imum)?|only|at most|upto|up to|limit(?: to)?)?\s*(\d+|one|two|three|four|five)\s*trades?\s*(?:a|per|\/|each)?\s*(?:day|din)?/))) {
      var nT = num(m[1]), om = (r.Risk || "").match(/(\d+)\s*trades?\/day(?:\s*\(default\))?/);
      if (nT >= 1 && nT <= 50 && (!om || +om[1] !== nT || /default/.test(om[0]))) {
        var lbl = nT + (nT === 1 ? " trade/day" : " trades/day");
        r.Risk = om ? r.Risk.replace(om[0], lbl) : (r.Risk ? lbl + " · " + r.Risk : lbl);
        changes.push("Max trades a day " + (om ? "changed from " + om[1] + " to " : "set to ") + nT);
      }
    }
    // timeframe
    var tfm = i.match(/(?:switch|change|move|go|use|try|make it)\s+(?:it\s+)?(?:the\s+)?(?:timeframe\s+|candles?\s+|chart\s+)?(?:to\s+|on\s+)?(\d+)\s*-?\s*(?:min(?:ute)?s?|m)\b(?!\s*(?:earlier|later|before|after))|(\d+)\s*-?\s*min(?:ute)?s?\s*(?:candles?|chart|timeframe|bars?|tf)\b|(?:switch|change|move|go|use)\s+(?:to\s+)?(hourly|1\s*-?\s*hour|1\s*h\b|60\s*min|daily(?!\s*loss)|1\s*d\b)|(hourly|daily|1\s*-?\s*hour)\s*(?:candles?|chart|timeframe)/);
    if (tfm) {
      var raw = tfm[1] || tfm[2] || tfm[3] || tfm[4], ntf = /hour|1\s*h|60/.test(raw) ? "1h" : /daily|1\s*d/.test(raw) ? "1D" : raw + "m";
      var otf = String(r.Timeframe || "").replace(/\s*\(default\)/, "");
      if (ntf.toLowerCase() !== otf.toLowerCase()) { r.Timeframe = ntf; changes.push("Timeframe changed from " + (otf || "default") + " to " + ntf); }
    }
    // entry window
    if ((m = i.match(/(?:start|enter|entries|entry|trade|trading)\s*(?:only\s*)?(?:after|from|at)\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)|no (?:new )?entr(?:y|ies) before\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)/))) {
      var ts = pickTimes(" " + (m[1] || m[2]).replace(/^(\d{1,2})\s*(am|pm)?$/, function (a, h, ap) { return h + ":00" + (ap ? " " + ap : ""); }) + " ")[0];
      if (ts) { var w0 = win(), ow = r.Window; r.Window = w0.at ? "at " + ts.v : ts.v + "–" + w0.e; changes.push("Entries now start " + (w0.at ? "at " : "after ") + ts.v + (ow ? " (was " + ow + ")" : "")); }
    }
    if ((m = i.match(/no (?:new )?entr(?:y|ies) after\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)|stop (?:entering|new entries|taking (?:new )?trades)\s*(?:at|after|by)?\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)|(?:last|latest) entry\s*(?:at|by)?\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)/))) {
      var te = pickTimes(" " + (m[1] || m[2] || m[3]).replace(/^(\d{1,2})\s*(am|pm)?$/, function (a, h, ap) { return h + ":00" + (ap ? " " + ap : ""); }) + " ")[0];
      if (te) { var w1 = win(); r.Window = (w1.at ? w1.s : w1.s) + "–" + te.v; changes.push("No new entries after " + te.v); }
    }
    // EMA / SMA periods
    if ((m = i.match(/(\d+)\s*(?:and|&|\/|,|x)\s*(\d+)\s*-?\s*(ema|sma)\b|\b(ema|sma)\s*(\d+)\s*(?:and|&|\/|,|x)\s*(\d+)/))) {
      var kind = (m[3] || m[4]).toUpperCase(), a = m[1] || m[5], b = m[2] || m[6], oe = r.Entry || "";
      var dirE = /▼/.test(oe) ? "▼" : "▲", ne = kind + " " + a + " " + dirE + " " + kind + " " + b + ((oe.match(/\s*·\s*ADX.*$/) || [""])[0]);
      if (ne !== oe) { r.Entry = ne; changes.push(/EMA|SMA/.test(oe) ? "Moving averages changed to " + kind + " " + a + " / " + b : "Entry changed to " + kind + " " + a + " " + dirE + " " + kind + " " + b); }
    }
    // RSI levels
    if ((m = i.match(/rsi\s*(?:levels?\s*)?(?:to\s*)?(\d+)\s*(?:\/|and|-|,)\s*(\d+)/))) {
      var lo = Math.min(+m[1], +m[2]), hi = Math.max(+m[1], +m[2]), per = ((r.Entry || "").match(/RSI\s*(\d+)/) || [0, 14])[1];
      var sellSide = /\bSell\b/.test(r.Instrument || "");
      r.Entry = "RSI " + per + (sellSide ? " > " + hi : " < " + lo);
      var px = X().filter(function (p) { return !/^RSI/.test(p); }); px.unshift("RSI " + (sellSide ? "< " + lo : "> " + hi)); setX(px);
      changes.push("RSI levels set to " + lo + "/" + hi);
    }
    // instrument
    var inst = (r.Instrument || "").split(" · "), ibase = inst[0] || "", irest = inst.slice(1).join(" · ");
    var kindWord = (ibase.match(/\s(options|futures|equity)$/) || [])[1] || "", baseName = ibase.replace(/\s(options|futures|equity)$/, "");
    if ((m = i.match(/(?:switch|change|move|use|trade|run)\s+(?:it\s+|this\s+)?(?:to|on|with)?\s*(bank\s?nifty|fin\s?nifty|midcap\s?nifty|sensex|nifty|[a-z&]+(?:\s[a-z]+)?)\b/))) {
      var cand = findIndex(" " + m[1] + " ") || findStock(" " + m[1] + " ");
      if (cand && cand !== baseName) {
        var toEq = !findIndex(" " + m[1] + " ");
        var kw = toEq ? "equity" : kindWord === "equity" ? "futures" : kindWord;
        if (toEq && kindWord === "options") kw = "options";
        ibase = cand + (kw ? " " + kw : ""); changes.push("Instrument switched from " + baseName + " to " + cand); baseName = cand; kindWord = kw;
      }
    }
    var sideW = /\bSell\b/.test(irest) ? "Sell" : "Buy";
    if (/(?:switch|change|move|use|go)\s+(?:it\s+)?(?:to\s+)?(?:the\s+)?futures?\b|\bfutures instead\b/.test(i) && kindWord !== "futures") {
      ibase = baseName + " futures"; irest = sideW; changes.push("Switched to " + baseName + " futures"); kindWord = "futures";
    } else if (/(?:switch|change|move|use|go)\s+(?:it\s+)?(?:to\s+)?(?:the\s+)?options?\b|\boptions instead\b|\bbuy (?:calls?|puts?)\b/.test(i) && kindWord !== "options") {
      var cp = /\bputs?\b/.test(i) || sideW === "Sell" ? "put" : "call";
      ibase = baseName + " options"; irest = "Buy ATM " + cp; changes.push("Switched to " + baseName + " options (buy ATM " + cp + ")"); kindWord = "options";
    }
    if ((m = i.match(/\b(atm|itm|otm)\b/)) && kindWord === "options" && !/straddle|strangle|condor/.test(irest)) {
      var want = m[1].toUpperCase(), had = (irest.match(/\b(ATM|ITM|OTM)\b/) || [])[1];
      if (had !== want) { irest = had ? irest.replace(had, want) : irest + " " + want; changes.push("Strike changed " + (had ? "from " + had + " " : "") + "to " + want); }
    }
    var newInst = ibase + (irest ? " · " + irest : "");
    if (newInst !== r.Instrument) r.Instrument = newInst;
    // daily loss limit
    if ((m = i.match(/(?:daily\s*)?(?:max(?:imum)?\s*)?loss\s*(?:limit|cap)\s*(?:to|of|at|=|:)?\s*(?:₹|rs\.?|inr)?\s*(\d[\d,]*)\s*(k\b)?|(?:stop|quit)\s*(?:for the day\s*)?after\s*(?:losing\s*)?(?:₹|rs\.?|inr)?\s*(\d[\d,]*)\s*(k\b)?/))) {
      var amt = +String(m[1] || m[3]).replace(/,/g, "") * ((m[2] || m[4]) ? 1000 : 1), od = (r.Risk || "").match(/₹\s*[\d,]+\s*daily loss cap/);
      if (amt >= 100) { var lb = "₹" + inr(amt) + " daily loss cap"; r.Risk = od ? r.Risk.replace(od[0], lb) : (r.Risk ? r.Risk + " · " + lb : lb); changes.push((od ? "Daily loss cap changed to " : "Daily loss cap of ") + "₹" + inr(amt) + (od ? "" : " added")); }
    }
    // lots
    if ((m = i.match(/(?:use|trade|with|make it)\s*(\d+)\s*lots?\b/))) {
      var nl = +m[1], ol = (r.Risk || "").match(/(\d+)\s*lots?\b/), ll = nl + (nl === 1 ? " lot" : " lots");
      if (!ol || +ol[1] !== nl) { r.Risk = ol ? r.Risk.replace(ol[0], ll) : (r.Risk ? r.Risk + " · " + ll : ll); changes.push("Position size set to " + ll); }
    }
    // ADX filter
    if (/(remove|no|drop|without)\s*(?:the\s*)?adx/.test(i)) {
      if (/ADX/.test(r.Entry || "")) { r.Entry = r.Entry.replace(/\s*·\s*ADX.*$/, ""); changes.push("ADX filter removed"); }
    } else if ((m = i.match(/adx[^0-9]*(\d+)?/))) {
      var lvl = m[1] ? +m[1] : 20, oe2 = r.Entry || "", base2 = oe2.replace(/\s*·\s*ADX.*$/, "");
      if (lvl >= 5 && lvl <= 60) { r.Entry = base2 + " · ADX(14) > " + lvl; if (r.Entry !== oe2) changes.push("ADX(14) > " + lvl + " filter added to the entry"); }
    }
    var understood = changes.length > 0;
    return {
      rules: understood ? r : rules0, changes: changes, understood: understood,
      explanation: understood ? explain(r) : "I couldn't work out what to change from “" + instruction.trim().slice(0, 80) + "”. " + COP_EXAMPLES
    };
  }

  /* ================= demo sweep ================= */
  function sweepVariants(rules) {
    var I = rules.Instrument || "", single = /options/.test(I) && /\b(ATM|ITM|OTM)\s+(call|put)\b/i.test(I);
    var modes = single ? [["atm_buy", "Buy ATM"], ["itm_buy", "Buy ITM"], ["atm_sell", "Sell ATM"]] : [[null, null]];
    var out = [];
    ["5m", "15m", "30m"].forEach(function (tf) {
      ["09:20", "09:30", "09:45"].forEach(function (st) {
        modes.forEach(function (md) {
          var r = JSON.parse(JSON.stringify(rules)), w = r.Window || "";
          r.Timeframe = tf;
          var endT = (w.match(/\d{2}:\d{2}/g) || [])[1];
          r.Window = /^at\s/.test(w) ? "at " + st : st + "–" + (endT || "15:00");
          if (md[0]) r.Instrument = I.replace(/\b(Buy|Sell)\s+(ATM|ITM|OTM)\b/, md[1]);
          var bt = backtest(r);
          out.push({ timeframe: tf, entry_start: st, mode: md[0], modeLabel: md[1], trades: bt.metrics.trades, win_rate: bt.metrics.winRate, max_drawdown: bt.metrics.maxDD, net_pnl: bt.metrics.net, rules: r });
        });
      });
    });
    return { rows: out.sort(function (a, b) { return b.net_pnl - a.net_pnl; }), options: single };
  }

  /* ================= demo handlers (api.js intercepts in capture phase when API is on) ================= */
  $("#x-gen").addEventListener("click", function () {
    triedOnce = true;
    if (!validatePrompt(true)) { input.focus(); return; }
    var text = input.value.trim(), btn = this;
    var done = progress(btn, $("#x-gen-prog"), $("#x-gen-log"), ["Reading instrument and side…", "Finding indicators and timeframe…", "Extracting entry, exit and time window…", "Applying risk guardrails…"]);
    setTimeout(function () {
      done();
      var rules = parse(text);
      var unsure = Object.keys(rules).filter(function (k) { return /\?|review|\(default\)/.test(rules[k]); });
      if (/not supported yet/.test(rules.Entry)) {
        setLog($("#x-gen-log"), rules._unsupported.join(", ") + (rules._unsupported.length > 1 ? " aren't" : " isn't") + " supported yet. Use EMA/SMA, RSI, VWAP, Supertrend, ADX, an opening range or a fixed entry time.", "error");
        return;
      }
      if (/Instrument\?/.test(rules.Instrument) && /review/.test(rules.Entry)) {
        setLog($("#x-gen-log"), "Couldn't find an instrument or an entry condition. Try naming one, e.g. “Buy Nifty ATM call when 9 EMA crosses above 21 EMA”.", "error");
        return;
      }
      renderRules(rules, explain(rules));
      var ign = rules._unsupported && rules._unsupported.length ? " Ignored " + rules._unsupported.join(", ") + " (not supported yet)." : "";
      setLog($("#x-gen-log"), "Parsed " + Object.keys(rules).length + " rules" + (unsure.length ? " · check " + unsure.join(", ") : "") + "." + ign, unsure.length || ign ? "" : "ok");
    }, reduce ? 200 : 1300);
  });

  $("#x-run").addEventListener("click", function () {
    var rules = readRules(), btn = this;
    var empty = Object.keys(rules).filter(function (k) { return !rules[k]; });
    if (empty.length) { setLog($("#x-run-log"), "Fill in " + empty.join(", ") + " before running.", "error"); var el = $('#x-edit [data-k="' + empty[0] + '"]'); if (el) el.focus(); return; }
    var done = progress(btn, $("#x-run-prog"), $("#x-run-log"), ["Loading NSE candles, Jan 2020 to today…", "Simulating fills with slippage…", "Applying brokerage, STT, exchange, GST, stamp duty…", "Computing metrics…"]);
    setTimeout(function () {
      done();
      var model = backtest(rules);
      model.rules = rules;
      recordBacktest(model, rules.Entry);
      setLog($("#x-run-log"), "Backtest complete: " + model.metrics.trades + " trades, net " + signed(model.metrics.net) + ".", "ok");
      renderResults(model);
    }, reduce ? 200 : 1500);
  });

  function connectedBroker() { return S.connected[0] || null; }
  function startDemoSession(mode) {
    var r = S.rules || {};
    var sess = { id: S.nextSid++, name: (r.Entry || "Strategy") + " · " + (r.Instrument || "").split(" ·")[0], mode: mode, broker: mode === "live" ? connectedBroker() : (connectedBroker() || "Paper engine"), instrument: (r.Instrument || ""), rules: r };
    demoTrades(sess, 2 + (S.nextSid % 2), null);
    addSession(sess);
    toast(mode === "live" ? "Live session started (demo: no real orders are placed)" : "Paper trading started. Runs on candle close in market hours.");
  }
  $("#x-paper").addEventListener("click", function () {
    if (!S.model) { toast("Run a backtest first"); return; }
    requireAuth(function () { startDemoSession("paper"); });
  });
  $("#x-golive").addEventListener("click", function () {
    if (!S.model) { toast("Run a backtest first"); return; }
    var open = function () {
      $("#x-live-input").value = ""; $("#x-live-confirm").disabled = true;
      $("#x-live-broker").textContent = API_ON ? "your connected broker" : connectedBroker();
      openModal($("#x-live-modal"));
    };
    if (API_ON) { open(); return; }
    requireAuth(function () {
      if (!connectedBroker()) { S.afterBroker = "live"; toast("Connect a broker first. We'll bring you back to go live."); nav("brokers"); return; }
      open();
    });
  });
  $("#x-live-input").addEventListener("input", function (e) {
    var v = e.target.value.trim(), ok = v === "LIVE";
    $("#x-live-confirm").disabled = !ok;
    var h = $("#x-live-hint");
    h.textContent = !v ? "Case-sensitive." : ok ? "Confirmed." : v.toUpperCase() === "LIVE" ? "Type it in capitals: LIVE" : "Type LIVE exactly.";
    h.className = "hint" + (ok ? "" : v ? " is-warn" : "");
  });
  $("#x-live-confirm").addEventListener("click", function () { closeModal($("#x-live-modal")); startDemoSession("live"); });

  /* ================= Strategy Copilot (shared UI; api.js supplies the API call) ================= */
  var cop = { undo: null, base: null };
  function copReset() {
    cop.undo = null; cop.base = null;
    var out = $("#x-cop-out"); if (out) out.hidden = true;
    var c = $("#x-cop-cmp"); if (c) c.hidden = true;
    var i = $("#x-cop-input"); if (i) { i.value = ""; i.removeAttribute("aria-invalid"); }
  }
  function copBusy(on) {
    var go = $("#x-cop-go"); go.classList.toggle("is-loading", on); go.disabled = on;
    $$("[data-cop], [data-cop-try]").forEach(function (b) { b.disabled = on; });
  }
  function copMessage(text, kind) {
    var m = $("#x-cop-msg"); $("#x-cop-out").hidden = false;
    m.textContent = text; m.className = "cop__msg" + (kind ? " is-" + kind : "");
  }
  function runCopilot(instr) {
    instr = String(instr || "").trim();
    var inp = $("#x-cop-input");
    if (!S.parsed) { toast("Generate rules first, then tell the copilot what to change"); return; }
    if (!instr) { inp.setAttribute("aria-invalid", "true"); copMessage("Tell the copilot what to change. " + COP_EXAMPLES, "warn"); $("#x-cop-changes").innerHTML = ""; $("#x-cop-explain").hidden = true; $("#x-cop-actions").hidden = true; inp.focus(); return; }
    if (instr.length > 500) { copMessage("Keep it under 500 characters: one or two changes at a time works best.", "warn"); return; }
    inp.removeAttribute("aria-invalid");
    var before = readRules(), explBefore = $("#x-explain").hidden ? "" : $("#x-explain").textContent.replace(/^In plain words:\s*/, "");
    var A = API_ON && window.TradeCognixAPI && window.TradeCognixAPI.copilot;
    copBusy(true);
    var p = A ? window.TradeCognixAPI.copilot(instr) : new Promise(function (res) { setTimeout(function () { res(copilotDemo(before, instr)); }, reduce ? 0 : 380); });
    p.then(function (res) { copBusy(false); applyCopilot(res, before, explBefore); },
      function (x) {
        copBusy(false);
        if (x && x.userFacing) { copMessage(x.message, "error"); return; }
        toast("Copilot API unavailable, so the change was made in your browser");
        applyCopilot(copilotDemo(before, instr), before, explBefore);
      });
  }
  function applyCopilot(res, before, explBefore) {
    var list = $("#x-cop-changes"), ex = $("#x-cop-explain");
    if (!res || !res.understood) {
      copMessage((res && res.explanation) || "I couldn't work out what to change. " + COP_EXAMPLES, "warn");
      list.innerHTML = ""; ex.hidden = true; $("#x-cop-actions").hidden = !cop.undo; return;
    }
    var after = res.rules || before;
    var keys = Object.keys(after).filter(function (k) { return String(after[k]) !== String(before[k]); });
    if (!cop.undo) cop.undo = { rules: before, explanation: explBefore, spec: res.prevSpec };
    if (!cop.base && S.model) cop.base = S.model;
    renderRules(after, res.explanation, [], { changed: keys, keepCop: true });
    var n = (res.changes || []).length;
    copMessage(n + (n === 1 ? " change" : " changes") + " applied. " + (S.model ? "Re-run the backtest to compare." : "Run the backtest to see how it does."), "ok");
    list.innerHTML = (res.changes || []).map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") +
      keys.map(function (k) { return '<li class="cop__diff"><b>' + esc(k) + '</b><span class="old">' + esc(before[k] || "—") + '</span><span class="arr" aria-label="changed to">→</span><span class="new">' + esc(after[k]) + "</span></li>"; }).join("");
    ex.hidden = !res.explanation; ex.innerHTML = "<b>Updated rules in plain words:</b> " + esc(res.explanation || "");
    $("#x-cop-run").textContent = S.model ? "Re-run backtest" : "Run backtest";
    $("#x-cop-actions").hidden = false; $("#x-cop-cmp").hidden = true;
    $("#x-cop-input").value = "";
  }
  $("#x-cop-form").addEventListener("submit", function (e) { e.preventDefault(); runCopilot($("#x-cop-input").value); });
  $("#x-cop").addEventListener("click", function (e) {
    var c = e.target.closest("[data-cop]"); if (c) { runCopilot(c.dataset.cop); return; }
    if (e.target.closest("#x-cop-run")) { var run = $("#x-run"); if (!run.disabled) run.click(); return; }
    if (e.target.closest("#x-cop-undo") && cop.undo) {
      var u = cop.undo; cop.undo = null;
      if (u.spec && window.TradeCognixAPI && window.TradeCognixAPI.restoreSpec) window.TradeCognixAPI.restoreSpec(u.spec);
      renderRules(u.rules, u.explanation, [], { keepCop: true });
      copMessage("Changes undone. The rules are back to how they were.", "");
      $("#x-cop-changes").innerHTML = ""; $("#x-cop-explain").hidden = true; $("#x-cop-actions").hidden = true; $("#x-cop-cmp").hidden = true;
    }
  });
  function cmpRow(label, a, b, fmt, better) {
    var d = b - a, good = better === "up" ? d > 0 : better === "down" ? d < 0 : null, cls = !d || good === null ? "" : good ? "up" : "down";
    return '<div class="cmp__row"><span>' + label + '</span><span class="num">' + fmt(a) + '</span><span class="cmp__arr" aria-hidden="true">→</span><span class="num ' + cls + '">' + fmt(b) + "</span></div>";
  }
  function renderCompare(a, b) {
    var A = a.metrics, B = b.metrics, d = B.net - A.net;
    var html = '<p class="cmp__head"><span>Before → after the copilot change</span><strong class="num ' + (d >= 0 ? "up" : "down") + '">' + (d >= 0 ? "+" : "") + rupee(d) + " net</strong></p>" +
      cmpRow("Net P&amp;L", A.net, B.net, signed, "up") + cmpRow("Max drawdown", A.maxDD, B.maxDD, rupee, "down") +
      cmpRow("Win rate", A.winRate, B.winRate, function (v) { return v.toFixed(1) + "%"; }, "up") + cmpRow("Trades", A.trades, B.trades, function (v) { return String(v); }, null);
    [$("#x-res-cmp"), $("#x-cop-cmp")].forEach(function (el) { if (el) { el.innerHTML = html; el.hidden = false; } });
  }

  /* ================= regimes & autopsy (contract §2; demo computes its own) ================= */
  var REG = { trending: ["Trending", "ADX(14) at 25 or more at the close"], range: ["Range-bound", "Low ADX, no clear direction"], volatile: ["Volatile", "Day range in the top 20% of the sample"] };
  function hourOf(s) { var m = String(s || "").match(/^(\d{1,2})/); return m ? +m[1] : null; }
  function tryFor(text, au) {
    if (/adx/i.test(text)) { var lv = text.match(/(?:below|under|<)\s*(\d+)/i); return "Add ADX filter > " + (lv ? lv[1] : 20); }
    var h = /hour/i.test(text) ? hourOf((text.match(/(\d{1,2}):00/) || [])[0] || (au && au.worst_hour)) : null;
    if (h != null) return h >= 12 ? "No entries after " + (h < 10 ? "0" : "") + h + ":00" : "Start after " + (h + 1 < 10 ? "0" : "") + (h + 1) + ":00";
    return null;
  }
  function renderInsights(model) {
    var rg = Array.isArray(model.regimes) && model.regimes.length ? model.regimes : null;
    var au = model.autopsy && typeof model.autopsy === "object" ? model.autopsy : null;
    $("#x-insights").hidden = !rg && !au; $("#x-regimes").hidden = !rg; $("#x-autopsy").hidden = !au;
    $("#x-insights").classList.toggle("is-single", !rg || !au);
    if (rg) {
      var order = ["trending", "range", "volatile"];
      rg = rg.slice().sort(function (a, b) { return order.indexOf(a.regime) - order.indexOf(b.regime); });
      $("#x-regbar").innerHTML = rg.map(function (x) { return '<i class="rg-' + esc(x.regime) + '" style="width:' + Math.max(0, +x.share_of_days || 0).toFixed(1) + '%"></i>'; }).join("");
      $("#x-reg-body").innerHTML = rg.map(function (x) {
        var L = REG[x.regime] || [x.regime, ""], n = +x.net_pnl || 0;
        return '<tr><td><span class="rg-dot rg-' + esc(x.regime) + '" aria-hidden="true"></span>' + esc(L[0]) + '<span class="sub" title="' + esc(L[1]) + '">' + Math.round(+x.share_of_days || 0) + '% of days</span></td><td class="r col-days">' + inr(x.days || 0) + '</td><td class="r">' + inr(x.trades || 0) +
          '</td><td class="r">' + (x.trades ? (+x.win_rate).toFixed(1) + "%" : "—") + '</td><td class="r ' + (x.trades ? (n >= 0 ? "up" : "down") : "faint") + '">' + (x.trades ? signed(n) : "—") + "</td></tr>";
      }).join("");
      var best = rg.filter(function (x) { return x.trades; }).sort(function (a, b) { return b.net_pnl - a.net_pnl; });
      $("#x-reg-sub").textContent = best.length > 1 ? "Best on " + (REG[best[0].regime] || [best[0].regime])[0].toLowerCase() + " days, worst on " + (REG[best[best.length - 1].regime] || [best[best.length - 1].regime])[0].toLowerCase() + " days" : "How the rules did on trending, range-bound and volatile days";
    }
    if (au) {
      var f = [];
      if (au.whipsaw_trades != null) f.push(["Whipsaws", au.whipsaw_trades ? inr(au.whipsaw_trades) + (au.whipsaw_trades === 1 ? " trade · " : " trades · ") + '<span class="down">' + rupee(-Math.abs(au.whipsaw_loss || 0)) + "</span>" : "None"]);
      if (au.best_hour) f.push(["Best hour", esc(au.best_hour) + ' · <span class="' + ((au.best_hour_pnl || 0) >= 0 ? "up" : "down") + '">' + signed(au.best_hour_pnl || 0) + "</span>"]);
      if (au.worst_hour) f.push(["Worst hour", esc(au.worst_hour) + ' · <span class="' + ((au.worst_hour_pnl || 0) >= 0 ? "up" : "down") + '">' + signed(au.worst_hour_pnl || 0) + "</span>"]);
      if (au.cooldown_saving) f.push(["3-bar cooldown", '<span class="' + (au.cooldown_saving > 0 ? "up" : "down") + '">' + signed(au.cooldown_saving) + "</span>"]);
      if (au.adx_filter_saving) f.push(["ADX &lt; 20 filter", '<span class="' + (au.adx_filter_saving > 0 ? "up" : "down") + '">' + signed(au.adx_filter_saving) + "</span>"]);
      $("#x-aut-facts").innerHTML = f.map(function (x) { return "<div><dt>" + x[0] + '</dt><dd class="num">' + x[1] + "</dd></div>"; }).join("");
      var sug = (au.suggestions || []).slice(0, 3);
      $("#x-aut-list").innerHTML = sug.length ? sug.map(function (t) {
        var ins = S.parsed ? tryFor(t, au) : null;
        return '<li><svg aria-hidden="true"><use href="#i-check" /></svg><span>' + esc(t) + "</span>" + (ins ? '<button class="btn btn--ghost btn--sm" type="button" data-cop-try="' + esc(ins) + '" aria-label="Try it: ' + esc(ins) + '">Try it</button>' : "") + "</li>";
      }).join("") : '<li class="faint"><span>Nothing obvious to fix: no filter we tested would have added more than a rounding error.</span></li>';
    }
  }
  $("#x-aut-list").addEventListener("click", function (e) {
    var b = e.target.closest("[data-cop-try]"); if (!b) return;
    var c = $("#x-cop"); c.hidden = false;
    $("#x-cop-input").value = b.dataset.copTry;
    c.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    runCopilot(b.dataset.copTry);
  });

  /* ================= demo: compare settings (sweep) ================= */
  var SWEEP_NOTE = "Same rules on 5, 15 and 30-minute candles with 9:20, 9:30 and 9:45 starts, ranked by net P&L after charges.";
  var dsweep = null;
  function resetSweepNote() {
    var opt = /options/.test((S.rules || {}).Instrument || "") && /\b(ATM|ITM|OTM)\s+(call|put)\b/i.test((S.rules || {}).Instrument || "");
    $("#x-sweep-note").textContent = opt ? SWEEP_NOTE.replace(" starts,", " starts, buying ATM, buying ITM or selling ATM,") : SWEEP_NOTE;
  }
  $("#x-sweep-run").addEventListener("click", function () {
    if (API_ON) return; // api.js handles it
    var btn = this, rules = readRules();
    btn.disabled = true; btn.classList.add("is-loading");
    $("#x-sweep-note").textContent = "Running the combinations in your browser…";
    setTimeout(function () {
      dsweep = sweepVariants(rules);
      var rows = dsweep.rows, opt = dsweep.options;
      $("#x-sweep-modeh").hidden = !opt;
      $("#x-sweep-rows").innerHTML = rows.map(function (x, i) {
        return "<tr" + (i === 0 ? ' class="is-best"' : "") + "><td>" + esc(x.timeframe) + "</td><td>" + esc(x.entry_start) + "</td>" + (opt ? "<td>" + esc(x.modeLabel) + "</td>" : "") +
          '<td class="r">' + x.trades + '</td><td class="r">' + x.win_rate.toFixed(1) + '%</td><td class="r">' + rupee(x.max_drawdown) + '</td><td class="r ' + (x.net_pnl >= 0 ? "up" : "down") + '">' + signed(x.net_pnl) + '</td><td class="r"><button class="btn btn--secondary btn--sm" type="button" data-dsweep-use="' + i + '">Use</button></td></tr>';
      }).join("");
      $("#x-sweep-wrap").hidden = !rows.length;
      var b = rows[0];
      $("#x-sweep-note").textContent = rows.length ? "Best on net: " + b.timeframe + " candles from " + b.entry_start + (opt ? ", " + b.modeLabel : "") + ". Simulated prices, so treat the ranking as a guide, not a forecast." : "None of the combinations produced trades.";
      btn.disabled = false; btn.classList.remove("is-loading");
    }, reduce ? 30 : 450);
  });
  $("#x-sweep-rows").addEventListener("click", function (e) {
    var b = e.target.closest("[data-dsweep-use]"); if (!b || !dsweep) return;
    var x = dsweep.rows[+b.dataset.dsweepUse]; if (!x) return;
    renderRules(x.rules, explain(x.rules), [], { changed: Object.keys(x.rules).filter(function (k) { return x.rules[k] !== readRules()[k]; }), keepCop: true });
    toast("Using " + x.timeframe + " candles from " + x.entry_start + (x.modeLabel ? ", " + x.modeLabel : "") + ". Running the backtest…");
    $("#x-run").click();
  });

  /* ================= demo: save strategies on this device ================= */
  $("#x-save").addEventListener("click", function () {
    if (API_ON) return; // api.js handles it
    var btn = this;
    requireAuth(function () {
      var r = readRules(), name = ((r.Entry || "Strategy") + " · " + (r.Instrument || "").split(" ·")[0]).slice(0, 80);
      var ex = S.savedId && S.saved.filter(function (s) { return s.id === S.savedId; })[0];
      if (ex) { ex.rules = r; ex.name = name; ex.prompt = input.value; ex.at = Date.now(); }
      else { S.savedId = Date.now(); S.saved.unshift({ id: S.savedId, name: name, rules: r, prompt: input.value, at: Date.now() }); }
      persistDemo();
      btn.textContent = "Saved"; toast("Strategy saved on this device (demo). Find it under Backtests.");
      setTimeout(function () { btn.textContent = "Save changes"; }, 1600);
    });
  });
  doc.addEventListener("click", function (e) {
    var o = e.target.closest("[data-open-dstrat]"), d = e.target.closest("[data-del-dstrat]");
    if (o) {
      var s = S.saved.filter(function (x) { return String(x.id) === o.dataset.openDstrat; })[0]; if (!s) return;
      nav("studio");
      setTimeout(function () {
        input.value = s.prompt || ""; validatePrompt(false);
        renderRules(s.rules, explain(s.rules)); S.savedId = s.id; $("#x-save").textContent = "Save changes";
        setLog($("#x-gen-log"), "Loaded “" + s.name + "” from this device.", "ok");
      }, 0);
    } else if (d) {
      var s2 = S.saved.filter(function (x) { return String(x.id) === d.dataset.delDstrat; })[0]; if (!s2) return;
      if (!window.confirm("Delete “" + s2.name + "” from this device?")) return;
      S.saved = S.saved.filter(function (x) { return x !== s2; }); if (S.savedId === s2.id) S.savedId = null;
      persistDemo(); renderBacktests(); toast("Strategy deleted");
    }
  });

  /* ================= demo: journal ================= */
  // Paper sessions in the demo close a few simulated trades so the journal, filters and CSV export can be tried.
  function lastSessionDay() {
    var now = new Date(), p = istParts(now), di = DAYS.indexOf(p.wd), mins = p.h * 60 + p.m, back = 0;
    if (di >= 5) back = di - 4; else if (mins < 600) back = di === 0 ? 3 : 1;
    var d = new Date(now.getTime() - back * 864e5), parts = new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(d);
    return { date: parts, upto: back ? 915 : Math.min(915, mins - 5) };
  }
  function demoTrades(sess, n, reason) {
    var r = sess.rules || S.rules || {}, q = ruleInfo(r), R = rng(hash(String(sess.id) + (reason || "") + S.journal.length)), day = lastSessionDay();
    var lot = lotFor(q.base);
    var qty = q.isOpt || q.index ? lot * Math.max(1, Math.round(q.lotMul)) : Math.max(1, Math.round(q.lotMul * 50));
    var lastPx = /BANKNIFTY/.test(q.base) ? 52200 : /SENSEX/.test(q.base) ? 80900 : /FINNIFTY/.test(q.base) ? 23900 : 24600, sideBuy = !/\bSell\b/.test(r.Instrument || "");
    var lo = Math.max(q.start, 560), hi = Math.max(lo + 10, Math.min(day.upto, q.exitM));
    for (var i = 0; i < n; i++) {
      var m = reason ? Math.max(lo, Math.min(day.upto, 915)) : Math.round(lo + (hi - lo) * (i + R()) / n);
      var win = R() < 0.52, mv = (win ? 1 : -1) * (q.isOpt ? 6 + R() * 22 : q.index ? 20 + R() * 70 : 2 + R() * 9);
      var entry = q.isOpt ? 90 + R() * 140 : q.index ? lastPx * (0.99 + R() * 0.02) : 400 + R() * 2600;
      var exit = Math.max(0.05, entry + (sideBuy ? mv : -mv)), charges = Math.round((q.isOpt ? 95 : 120) + R() * 80);
      var strike = Math.round((lastPx + (R() - 0.5) * 400) / 50) * 50;
      var sym = q.isOpt ? q.base + " " + strike + (/put/i.test(r.Instrument || "") ? " PE" : q.multi ? " CE+PE" : " CE") : q.base;
      var iso = day.date + "T" + fmtHM(Math.min(m, 929)) + ":00+05:30";
      S.journal.unshift({ exit_time: iso, strategy_tag: sess.name, session: sess.id, mode: sess.mode, symbol: sym, side: sideBuy ? "buy" : "sell", quantity: qty, entry_price: entry, exit_price: exit,
        charges: charges, net_pnl: Math.round((exit - entry) * (sideBuy ? 1 : -1) * qty - charges), exit_reason: reason || (win ? (/target/.test(r.Exit || "") ? "target" : "signal_exit") : (/SL/.test(r.Exit || "") ? "stop_loss" : "signal_exit")) });
    }
    S.journal.sort(function (a, b) { return a.exit_time < b.exit_time ? 1 : -1; });
    persistDemo();
  }
  var djmode = "";
  function renderDemoJournal() {
    if (!S.journal.length) { renderJournalEmpty(); return; }
    var rows = S.journal.filter(function (t) { return !djmode || t.mode === djmode; }), any = rows.length > 0;
    $("#x-j-bar").hidden = false; $("#x-j-export").hidden = !any;
    $("#x-j-panel").hidden = !any; $("#x-j-sum-panel").hidden = !any; $("#x-j-empty").hidden = any;
    $$("[data-jmode]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.jmode === djmode)); });
    if (!any) {
      $("#x-j-empty-h").textContent = "No " + djmode + " trades yet";
      $("#x-j-empty-p").textContent = djmode === "live" ? "Live trades appear here once a live session closes a position. In the demo, go live from a backtest to try it." : "Closed trades from your paper sessions land here.";
      var eb = $("#x-j-empty-btn"); eb.textContent = "Open Strategy Studio"; eb.removeAttribute("data-auth-open"); eb.setAttribute("data-view", "studio");
      return;
    }
    $("#x-j-count").textContent = rows.length + (rows.length === 1 ? " trade" : " trades") + " · simulated";
    var by = {};
    rows.forEach(function (t) { var k = t.strategy_tag; by[k] = by[k] || { n: 0, w: 0, c: 0, p: 0 }; by[k].n++; if (t.net_pnl > 0) by[k].w++; by[k].c += t.charges; by[k].p += t.net_pnl; });
    $("#x-j-sum-body").innerHTML = Object.keys(by).sort(function (a, b) { return by[b].p - by[a].p; }).map(function (k) {
      var x = by[k]; return '<tr><td class="wrap">' + esc(k) + '</td><td class="r">' + x.n + '</td><td class="r">' + (x.w / x.n * 100).toFixed(1) + '%</td><td class="r">' + rupee(x.c) + '</td><td class="r ' + (x.p >= 0 ? "up" : "down") + '">' + signed(x.p) + "</td></tr>";
    }).join("");
    $("#x-j-body").innerHTML = rows.slice(0, 300).map(function (t) {
      var d = new Date(t.exit_time);
      return "<tr><td>" + istDate(d) + " · " + istTime(d) + '</td><td class="wrap">' + esc(t.strategy_tag) + (t.mode === "live" ? ' <span class="badge badge--live">Live</span>' : "") + "</td><td>" + esc(t.symbol) + "</td><td>" + (t.side === "sell" ? "Sell" : "Buy") +
        '</td><td class="r">' + t.quantity + '</td><td class="r">' + t.entry_price.toFixed(2) + '</td><td class="r">' + t.exit_price.toFixed(2) + '</td><td class="r ' + (t.net_pnl >= 0 ? "up" : "down") + '">' + signed(t.net_pnl) + "</td><td>" + esc(t.exit_reason.replace(/_/g, " ")) + "</td></tr>";
    }).join("");
  }
  doc.addEventListener("click", function (e) {
    if (API_ON) return; // api.js owns the journal in API mode
    var jb = e.target.closest("[data-jmode]");
    if (jb) { djmode = jb.dataset.jmode; renderDemoJournal(); return; }
    if (e.target.closest("#x-j-export")) {
      var rows = S.journal.filter(function (t) { return !djmode || t.mode === djmode; });
      var q = function (v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var csv = ["exit_time_ist,strategy,mode,symbol,side,quantity,entry_price,exit_price,charges,net_pnl,exit_reason"].concat(rows.map(function (t) {
        var d = new Date(t.exit_time);
        return [istDate(d) + " " + istTime(d), t.strategy_tag, t.mode, t.symbol, t.side, t.quantity, t.entry_price.toFixed(2), t.exit_price.toFixed(2), t.charges, t.net_pnl, t.exit_reason].map(q).join(",");
      })).join("\n");
      var blob = new Blob(["\ufeff" + csv + "\n"], { type: "text/csv;charset=utf-8" }), u = URL.createObjectURL(blob), a = doc.createElement("a");
      a.href = u; a.download = "tradecognix-journal-demo-" + new Date().toISOString().slice(0, 10) + ".csv"; doc.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
      toast("Exported " + rows.length + " simulated trade" + (rows.length === 1 ? "" : "s") + " to CSV");
    }
  });

  /* ================= skip link: the app has its own main ================= */
  var skip = $(".skip");
  if (skip) skip.addEventListener("click", function (e) {
    if (app.hidden) return;
    e.preventDefault(); var m = $("#x-main"); m.focus(); m.scrollIntoView();
  });

  /* ================= keyboard ================= */
  doc.addEventListener("keydown", function (e) {
    if (app.hidden || current !== "studio" || openModalEl()) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (doc.activeElement && doc.activeElement.id === "x-cop-input") { runCopilot(doc.activeElement.value); return; }
      var inPrompt = doc.activeElement === input, rulesOn = !$("#x-rules-panel").hidden;
      var b = !inPrompt && rulesOn ? $("#x-run") : $("#x-gen");
      if (!b.disabled) b.click();
    } else if (e.key === "/" && !/INPUT|TEXTAREA/.test(doc.activeElement.tagName) && !doc.activeElement.isContentEditable) {
      e.preventDefault(); input.focus();
    }
  });

  /* ================= public layer for api.js ================= */
  window.TCUI = {
    toast: toast, openModal: openModal, closeModal: closeModal, progress: progress, setLog: setLog,
    renderRules: renderRules, readRules: readRules, renderResults: renderResults, recordBacktest: recordBacktest,
    renderBrokers: renderBrokers, fieldHTML: fieldHTML, validateFields: validateFields, validateAuth: validateAuth, validatePrompt: function () { triedOnce = true; return validatePrompt(true); },
    addSession: addSession, stopSession: stopSession, renderJournalEmpty: renderJournalEmpty, esc: esc, drawDash: drawDash, setSessions: setSessions, killAll: killAll, running: running,
    authDone: authDone, renderAccount: renderAccount, renderChecklist: renderChecklist, setStep: setStep,
    nav: nav, fmt: { inr: inr, rupee: rupee, signed: signed, compact: compact, istDate: istDate, istTime: istTime }, state: S,
    // the in-browser engine, also used by api.js as a fallback when the API lacks an endpoint
    demo: { parse: parse, explain: explain, backtest: backtest, copilot: copilotDemo, sweep: sweepVariants }
  };

  /* ================= boot ================= */
  if (API_ON) {
    $("#x-mode-title").textContent = "Connected workspace";
    $("#x-mode-text").textContent = "Wired to the TradeCognix API.";
  } else {
    $("#x-save").hidden = false;
    $("#x-run-note").textContent = "Simulated in your browser · Jan 2020 to today";
  }
  setTheme(theme());
  renderBrokers(); renderAccount(); renderChecklist(); setStep(); syncKill(); if (!API_ON) renderSessions();
  tickClock(); setInterval(tickClock, 30000);
  route();
})();
