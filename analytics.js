/* ==========================================================================
   yesha.online · privacy-first product analytics
   --------------------------------------------------------------------------
   Sends events to PostHog Cloud on the free plan. With no card on file,
   PostHog drops events past the free monthly allowance instead of billing.

   What it does NOT do
   - No cookies and no PostHog browser storage (persistence: "memory")
   - No session recordings, surveys or feature flags
   - Never sends anything a visitor types (Ask Yes-ha, invite form, console)
   - Nothing runs when the browser sends Global Privacy Control or Do Not
     Track, or when the visitor turns analytics off in the Privacy panel

   The one thing kept in the browser: "yt-v", a visit counter with no ID
   (skipped for European time zones), so new vs returning can be told apart.

   Every listener is passive and wrapped in try/catch, so a problem here can
   never break the site. index.html only gains the <script> tag and the
   updated Privacy copy.

   Debug: add ?yt_debug=1 to the URL to log every event to the console
   (window.__yt.log) without needing a PostHog key.
   ========================================================================== */
(() => {
"use strict";

const CONFIG = {
  /* PostHog project API key (starts with "phc_"). It is public by design:
     it can only send events, never read them. Empty = analytics stay off. */
  key: "phc_C2fH7LKqmsPUh4wfaYkxdCfPcaFfxfKNPXi9m584vFVb",
  api_host: "https://us.i.posthog.com",
  ui_host: "https://us.posthog.com",
};

/* ---------- tiny helpers ---------- */
const q = (s, r = document) => r.querySelector(s);
const qa = (s, r = document) => [...r.querySelectorAll(s)];
const now = () => performance.now();
const root = document.documentElement;
const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
const lsDel = k => { try { localStorage.removeItem(k); } catch (_) {} };
const slug = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
const txt = el => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
const safe = fn => function () { try { return fn.apply(this, arguments); } catch (e) { if (DEBUG) console.warn("[yt]", e); } };

const DEBUG = /[?&]yt_debug=1\b/.test(location.search) || lsGet("yt-debug") === "1";
const OPT_KEY = "yt-optout", VISIT_KEY = "yt-v";
const GPC = navigator.globalPrivacyControl === true;
const DNT = [navigator.doNotTrack, window.doNotTrack, navigator.msDoNotTrack].some(v => v === "1" || v === "yes");
const optedOut = () => lsGet(OPT_KEY) === "1";
const allowed = () => !GPC && !DNT && !optedOut();
let TZ = ""; try { TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) {}
const IN_EUROPE = /^Europe\//.test(TZ) || /^Atlantic\/(Reykjavik|Canary|Madeira|Azores|Faroe)$/.test(TZ);
/* Owner switch: open any page once with ?yt_me=1 to tag this browser's events
   as internal (is_internal: true), so PostHog's "Filter out internal and test
   users" hides them. ?yt_me=0 removes the tag. */
const meParam = (location.search.match(/[?&]yt_me=([01])\b/) || [])[1];
if (meParam === "1") lsSet("yt-me", "1"); else if (meParam === "0") lsDel("yt-me");
const IS_ME = lsGet("yt-me") === "1";

/* ---------- state for this visit ---------- */
const S = {
  view: null, viewEngaged: 0, viewMax: 0, milestones: new Set(),
  engagedTotal: 0, lastInput: now(),
  sections: new Set(), studies: new Set(), lastStudy: null, study: {},
  sheet: null, fired: new Set(), leads: 0, flags: {},
  lastClick: { el: null, t: -1e9 },
  ready: root.classList.contains("ready"), entered: false, loaderTaps: 0, loaderToggles: 0,
  askKind: null, askVia: null, askCount: 0, askOpen: false,
  chPending: null, chTimer: 0, lk: null, privAt: 0, ended: false,
};
let enabled = false, installed = false, ph = null, loading = false, visit = { visitor_type: "unknown" };
const queue = [];
const BEACON = { transport: "sendBeacon" };

/* ---------- sending ---------- */
function context(){
  const v = S.view, c = {
    section: v ? v.section : undefined,
    view_type: v ? v.type : undefined,
    case_study_context: v && v.type === "case_study" ? v.case_study : undefined,
    last_case_study: S.lastStudy || undefined,
    engaged_seconds_on_site: Math.round(S.engagedTotal),
    visitor_type: visit.visitor_type,
    visit_number_bucket: visit.visit_number_bucket,
    is_internal: IS_ME || undefined,
  };
  return c;
}
function track(name, props, opts){
  if (!enabled) return;
  const p = Object.assign(context(), props || {});
  Object.keys(p).forEach(k => { if (p[k] === undefined || p[k] === null || p[k] === "") delete p[k]; });
  if (DEBUG){ (window.__yt.log).push({ event: name, properties: p }); console.debug("[yt]", name, p); }
  if (!CONFIG.key) return;
  if (ph) ph.capture(name, p, opts); else queue.push([name, p, opts]);
}
const once = (key, name, props) => { if (S.fired.has(key)) return; S.fired.add(key); track(name, props); };
const clickedRecently = (sel, ms = 1500) => { const c = S.lastClick; return !!(c.el && now() - c.t < ms && c.el.closest && c.el.closest(sel)); };

/* lead actions: a specific event, plus one umbrella "lead_action" for funnels */
function lead(name, props, strength = "strong"){
  track(name, props);
  S.leads++;
  track("lead_action", Object.assign({}, props, {
    action: name, strength,
    case_study: S.lastStudy || undefined,
    case_studies_read: S.studies.size,
    sections_seen: [...S.sections].sort().join(","),
    explored_about: S.sections.has("about"),
    explored_playground: S.sections.has("playground"),
    explored_hot_takes: S.sections.has("hot_takes"),
    opened_evaluation_shelf: !!S.flags.shelf,
    lead_number: S.leads,
  }));
}

/* ---------- PostHog loader (async, after first idle moment) ---------- */
function loadPostHog(){
  if (!CONFIG.key || ph || loading || !enabled) return;
  loading = true;
  /* official PostHog snippet: creates a stub and loads array.js async */
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  window.posthog.init(CONFIG.key, {
    api_host: CONFIG.api_host,
    ui_host: CONFIG.ui_host,
    persistence: "memory",            // no cookies, no localStorage
    person_profiles: "identified_only", // anonymous events only; identify() is never called
    autocapture: true,                 // clicks, for heatmaps, rage and dead clicks
    rageclick: true,
    capture_dead_clicks: true,
    enable_heatmaps: true,
    capture_pageview: false,           // virtual pageviews are sent below, one per tab or case study
    capture_pageleave: true,
    capture_performance: false,
    disable_session_recording: true,
    disable_surveys: true,
    advanced_disable_feature_flags: true,
    respect_dnt: true,
    before_send: ev => {
      if (!enabled || !ev) return null; // on-site opt-out drops everything, autocapture included
      const p = ev.properties || {};
      ["$current_url", "$referrer", "$initial_referrer"].forEach(k => { if (typeof p[k] === "string") p[k] = scrubUrl(p[k]); });
      return ev;
    },
    loaded: inst => { ph = inst; if (IS_ME) inst.register({ is_internal: true }); while (queue.length){ const [n, p, o] = queue.shift(); inst.capture(n, p, o); } },
  });
}
function scrubUrl(u){
  try {
    const url = new URL(u);
    if (url.hostname !== location.hostname) return u;
    [...url.searchParams.keys()].forEach(k => { if (!/^utm_|^ref$/.test(k)) url.searchParams.delete(k); });
    return url.toString();
  } catch (_) { return u; }
}

/* ---------- visits: new vs returning (no identifier) ---------- */
function countVisit(){
  if (IN_EUROPE) return { visitor_type: "unknown" };
  let v = null; try { v = JSON.parse(lsGet(VISIT_KEY) || "null"); } catch (_) {}
  if (!v || typeof v.n !== "number") v = { n: 0, t: 0 };
  const t = Date.now();
  if (t - v.t > 30 * 60 * 1000) v.n += 1;
  lsSet(VISIT_KEY, JSON.stringify({ n: v.n, t }));
  return { visitor_type: v.n > 1 ? "returning" : "new", visit_number_bucket: v.n <= 1 ? "1" : v.n === 2 ? "2" : v.n <= 5 ? "3-5" : "6+" };
}
function touchVisit(){ if (IN_EUROPE || !enabled) return; try { const v = JSON.parse(lsGet(VISIT_KEY) || "null"); if (v) lsSet(VISIT_KEY, JSON.stringify({ n: v.n, t: Date.now() })); } catch (_) {} }

/* ---------- lookups ---------- */
const TAB_SECTION = { work: "work", playground: "playground", "hot-takes": "hot_takes", about: "about" };
const CHAPTER_KEY = { overview: "overview", problem: "problem", research: "research", insights: "insights", strategy: "strategy", decisions: "decisions", outcomes: "outcomes", reflection: "what_i_learned" };
const TOOL = { claude: "claude_ui_generation", code: "claude_code", codex: "codex" };
const COMMANDS = ["help", "ls", "cat", "tools", "next", "read", "clear"];
const DEMOS = [
  ["#demo-apply, #demo-no, #demo-undo, #demo-again, #demo-reset", "ai_edit_preview"],
  ["#au-seg button", "audit_before_after"],
  ["#fx-seg button, #fx-apply, #fx-reset", "token_fix"],
  ["#rs-seg button", "role_switcher"],
  ["#gd-acts button, #gd-reset", "ai_grouping"],
];
const studyOf = el => { const a = el && el.closest && el.closest("article.cs"); return a ? a.dataset.slug : undefined; };
const studyName = s => { const a = q(`article.cs[data-slug="${s}"]`); return a ? txt(q(".cs-toc > .mono", a)) || s : s; };
const studyPosition = s => { const i = qa("#grid .card").findIndex(c => c.dataset.slug === s); return i < 0 ? undefined : i + 1; };
function labLookup(name){
  const cards = qa("#lab .pg"), i = cards.findIndex(c => txt(q("h3", c)) === name);
  if (i < 0) return { experiment: slug(name) };
  const c = cards[i];
  return { experiment: (c.dataset.slug || "").replace(/^pg-/, ""), experiment_name: name, experiment_position: i + 1, experiment_category: c.dataset.tag };
}
const takeKey = el => slug(txt(q(".mono", el)));
const takePosition = el => qa(".takes .take:not(.more)").indexOf(el) + 1;

function locationOf(t){
  if (t.closest("#chat, .ask, #ask-panel")) return "ask_yes_ha";
  if (t.closest(".rail")) return "sidebar";
  if (t.closest(".sfoot")) return "site_footer";
  if (t.closest("article.cs")) return t.closest(".nda-tag") ? "case_study_image" : t.closest(".cs-foot") ? "case_study_footer" : t.closest(".cs-bar") ? "case_study_top_bar" : "case_study";
  if (t.closest("#case")) return S.sheet && S.sheet.kind === "evaluation" ? "evaluation_sheet" : "experiment_sheet";
  if (t.closest("#inv")) return "event_invite";
  if (t.closest("#yn")) return "hiring_quiz";
  if (t.closest(".work-end")) return "work_end";
  if (t.closest(".lab-end")) return "playground_end";
  if (t.closest("#p-takes")) return t.closest(".social") ? "hot_takes_follow" : t.closest(".fade") ? "hot_takes_end" : "hot_takes";
  if (t.closest(".ab-cta")) return "about_shelf_cta";
  if (t.closest("#p-about")) return "about";
  if (t.closest("#p-play")) return "playground";
  if (t.closest("#p-work")) return "work";
  return "other";
}

/* ---------- views: tabs and full-page case studies ---------- */
function readView(){
  const st = qa("article.cs").find(a => !a.hidden);
  if (st) return { type: "case_study", section: "work", case_study: st.dataset.slug, key: "case_study:" + st.dataset.slug, path: "/work/" + st.dataset.slug };
  const t = q('.tabs [role="tab"][aria-selected="true"]'), h = t ? t.dataset.hash : "work";
  return { type: "tab", section: TAB_SECTION[h] || slug(h), key: "tab:" + h, path: "/" + h };
}
function scrollPct(){
  const H = document.documentElement.scrollHeight;
  return H > 0 ? Math.min(100, Math.round((scrollY + innerHeight) / H * 100)) : 100;
}
function syncView(){
  if (!S.entered) return;
  const v = readView(), prev = S.view;
  if (prev && v.key === prev.key) return;
  if (prev) leaveView(prev, exitReason());
  S.view = v; S.viewEngaged = 0; S.viewMax = scrollPct(); S.milestones = new Set();
  track("$pageview", { $current_url: location.href, $pathname: v.path, $title: document.title });
  if (v.type === "tab"){
    S.sections.add(v.section);
    const via = !prev ? "landing" : clickedRecently('[role="tab"]') ? "tab" : prev.type === "case_study" ? "back_from_case_study" : "link";
    track("section_viewed", { section: v.section, via });
  } else studyOpened(v, prev);
}
function exitReason(){
  if (clickedRecently(".cs-go-next")) return "next_project";
  if (clickedRecently(".cs-go-back")) return "all_work";
  if (clickedRecently('[role="tab"]')) return "tab";
  return "other";
}
function leaveView(v, exit){
  if (v.type === "case_study") commitChapter(true);
  track("view_left", { view: v.key, view_type: v.type, section: v.section, case_study: v.case_study, seconds_engaged: Math.round(S.viewEngaged), max_scroll_pct: S.viewMax, exit });
  if (v.type === "case_study"){
    const st = S.study[v.case_study] || {};
    track("case_study_closed", {
      case_study: v.case_study, seconds_engaged: Math.round(S.viewEngaged), max_scroll_pct: S.viewMax, exit,
      deepest_chapter: st.deepestKey, deepest_chapter_number: st.deepest >= 0 ? st.deepest + 1 : undefined,
      chapters_seen: st.chapters ? st.chapters.size : 0,
      reached_outcomes: !!(st.chapters && st.chapters.has("outcomes")),
    });
  }
}
function studyOpened(v, prev){
  const s = v.case_study;
  S.studies.add(s); S.lastStudy = s;
  const st = S.study[s] || (S.study[s] = { opens: 0, chapters: new Set(), deepest: -1, deepestKey: null });
  st.opens++;
  const source = !prev ? "deep_link" : clickedRecently(".card") ? "work_card" : clickedRecently(".cs-go-next") ? "next_project"
    : clickedRecently("[data-go-study]") ? "cross_link" : clickedRecently("[data-open], .yn-opt") ? "hiring_quiz"
    : clickedRecently(".src-chip a") ? "ask_yes_ha" : "link";
  track("case_study_opened", { case_study: s, case_study_name: studyName(s), case_study_position: studyPosition(s), source, open_count: st.opens });
}

/* chapters: follow the case study's own "now reading" label, counted after a 1s dwell */
function onChapter(a){
  if (a.hidden || !S.view || S.view.case_study !== a.dataset.slug) return;
  const label = txt(q(".cs-now", a)), secs = qa(".cs-sec", a), i = secs.findIndex(x => x.dataset.label === label);
  if (i < 0) return;
  const key = CHAPTER_KEY[secs[i].id.split("-").slice(1).join("-")] || slug(label);
  clearTimeout(S.chTimer);
  S.chPending = { s: a.dataset.slug, key, i, label, via: clickedRecently(".cs-toc button", 2500) ? "contents" : "scroll", t: now() };
  S.chTimer = setTimeout(() => commitChapter(false), 1000);
}
function commitChapter(leaving){
  const p = S.chPending; if (!p) return;
  if (leaving && now() - p.t < 1000){ S.chPending = null; clearTimeout(S.chTimer); return; }
  S.chPending = null;
  const st = S.study[p.s]; if (!st || st.chapters.has(p.key)) return;
  st.chapters.add(p.key);
  if (p.i > st.deepest){ st.deepest = p.i; st.deepestKey = p.key; }
  const props = { case_study: p.s, chapter: p.key, chapter_number: p.i + 1, chapter_label: p.label, chapters_seen: st.chapters.size, via: p.via };
  track("case_study_chapter_viewed", props);
  if (p.key === "outcomes") track("case_study_outcomes_reached", { case_study: p.s, chapters_seen: st.chapters.size });
  if (p.key === "what_i_learned") track("case_study_finished", { case_study: p.s, chapters_seen: st.chapters.size });
}

/* ---------- the experiment / evaluation sheet (dialog#case) ---------- */
function onSheet(){
  const dlg = q("#case");
  if (!dlg.open){ if (S.sheet) closeSheet(clickedRecently("#case-close") ? "close_button" : "dismissed"); return; }
  const name = txt(q("#case-title")); if (!name) return;
  const kind = !q("#pa-vsw").hidden ? "experiment" : /evaluation/i.test(txt(q("#case-next"))) ? "evaluation" : "project";
  if (S.sheet && S.sheet.name === name) return;
  const source = clickedRecently("#case-next") ? "next_button" : clickedRecently('[data-pc], #pa-form') ? "artifact_console"
    : clickedRecently(".pg-btn") ? "lab_card" : clickedRecently("#ev-open") ? "evaluation_shelf" : clickedRecently("[data-ec]") ? "replay" : "other";
  if (S.sheet) closeSheet("next");
  S.sheet = { name, kind, t: now(), engaged: 0, art: false };
  if (kind === "experiment"){
    Object.assign(S.sheet, labLookup(name));
    track("playground_experiment_opened", { experiment: S.sheet.experiment, experiment_name: name, experiment_position: S.sheet.experiment_position, experiment_category: S.sheet.experiment_category, source });
    track("$pageview", { $current_url: location.href, $pathname: "/playground/" + S.sheet.experiment, $title: name });
    onArtifact();
  } else if (kind === "evaluation"){
    S.sheet.evaluation = slug(name); S.flags.shelf = true;
    track("evaluation_opened", { evaluation: S.sheet.evaluation, evaluation_name: name, source });
    track("$pageview", { $current_url: location.href, $pathname: "/about/evaluations/" + S.sheet.evaluation, $title: name });
  }
}
function closeSheet(exit){
  const s = S.sheet; S.sheet = null; if (!s) return;
  if (s.kind === "experiment") track("playground_experiment_closed", { experiment: s.experiment, seconds_engaged: Math.round(s.engaged), viewed_artifact: s.art, exit });
  else if (s.kind === "evaluation") track("evaluation_closed", { evaluation: s.evaluation, seconds_engaged: Math.round(s.engaged), exit });
}
function onArtifact(){
  if (!S.sheet || S.sheet.kind !== "experiment" || q("#pa").hidden || S.sheet.art) return;
  S.sheet.art = true;
  track("artifact_viewed", { experiment: S.sheet.experiment });
}

/* ---------- clicks: one delegated, capture-phase, passive listener ---------- */
const onClick = safe(e => {
  const t = e.target; if (!(t instanceof Element)) return;
  S.lastClick = { el: t, t: now() }; S.lastInput = now();
  if (!S.entered){ if (t.closest("#loader-ui [data-k]")) loaderToggle(t.closest("[data-k]")); return; }
  const loc = locationOf(t);
  const a = t.closest("a[href]");
  if (a){
    const href = a.getAttribute("href") || "";
    if (/^mailto:/i.test(href)) mailClick(a, href, loc);
    else if (/\.pdf(\?|#|$)/i.test(href)) lead("resume_downloaded", { location: loc, case_study: studyOf(a) });
    else if (/^https?:/i.test(href)) outbound(a, href, loc);
    if (t.closest(".sfoot")) track("footer_link_clicked", { link: slug(txt(a)).slice(0, 40) || "link" });
  }
  let el;
  if (t.closest(".copy")) lead("email_copied", { location: loc, case_study: studyOf(t) });
  if (t.closest(".inv-open")) lead("event_invite_opened", { location: loc }, "soft");
  if (t.closest("#inv-x")) track("event_invite_cancelled");
  if ((el = t.closest(".cs-go-next"))) track("next_project_clicked", { from: studyOf(el), to: el.dataset.next, placement: el.closest(".cs-bar") ? "top_bar" : "end_card" });
  if ((el = t.closest(".cs-toc button"))) track("case_study_contents_clicked", { case_study: studyOf(el), chapter: CHAPTER_KEY[(el.dataset.sec || "").split("-").slice(1).join("-")] });
  if ((el = t.closest(".cs .zoom"))) track("case_study_image_zoomed", { case_study: studyOf(el), image: el.dataset.title });
  for (const [sel, demo] of DEMOS) if ((el = t.closest(sel)) && el.closest("article.cs")) track("case_study_demo_used", { case_study: studyOf(el), demo, control: el.id || el.dataset.v || el.dataset.mode || el.dataset.r || slug(txt(el)).slice(0, 30) });
  /* playground */
  if ((el = t.closest("#lab-f .lf"))) track("lab_filter_clicked", { filter: el.dataset.cat });
  if ((el = t.closest("#ec .ec-tools button[data-tool]"))) setTimeout(() => replayed("tool_button"));
  if (t.closest("#pgh-run")) setTimeout(() => replayed("run_button"));
  if ((el = t.closest("[data-ec]"))) track("replay_result_clicked", { target: el.dataset.ec });
  if (t.closest("#pgh-browse")) track("browse_lab_clicked");
  if ((el = t.closest("#pa-vsw button"))) track("artifact_tab_clicked", { tab: el.dataset.pv === "art" ? "artifact" : "read", experiment: S.sheet && S.sheet.experiment });
  if ((el = t.closest("#pa [data-pc]"))) command(el.dataset.pc, "click");
  if (t.closest("#case-extra .ex button, #ex-btn")) track("experiment_interaction", { experiment: S.sheet && S.sheet.experiment, action: "take_apart" });
  /* hot takes */
  /* the "Brewed Opinions" teasers have pointer-events:none, so match the click by position */
  if (t.closest(".takes") && !t.closest(".take:not(.more)")){
    const hit = qa(".takes .take.more").find(m => { const r = m.getBoundingClientRect(); return r.width && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; });
    if (hit) track("brewed_opinions_clicked", { teaser: takeKey(hit) });
  }
  if (t.closest("#all-takes")) track("field_notes_clicked");
  /* about */
  if ((el = t.closest("#shelf .spine"))){ S.flags.shelf = true; track("evaluation_shelf_item_selected", { evaluation: spineKey(el), via: "click" }); }
  if ((el = t.closest(".kit li"))) track("tool_kit_item_clicked", { tool: slug(txt(el)) });
  if (t.closest("#chap-back")) track("about_contents_opened");
  /* privacy */
  if (t.closest("#priv-btn")) track("privacy_panel_opened");
  /* rail */
  if (t.closest("#acc")) setTimeout(() => track("becoming_ish_toggled", { open: q("#acc").getAttribute("aria-expanded") === "true" }));
  if ((el = t.closest("#learn-row .tick-chip"))) track("becoming_ish_item_clicked", { company: slug(txt(el)) });
  if ((el = t.closest("#lk .lk-seg button"))) track("life_in_looks_filtered", { filter: slug(el.dataset.f) });
  if (t.closest("#lk .lk-beat")) setTimeout(() => track("life_in_looks_beat_toggled", { on: q("#lk .lk-beat").getAttribute("aria-pressed") === "true" }));
  if ((el = t.closest(".rmode .sw"))){ const k = el.dataset.k; track("reading_mode_toggled", { setting: k, on: el.getAttribute("aria-checked") !== "true" }, k === "motion" ? BEACON : undefined); }
  /* ask yes-ha */
  if (t.closest(".prompt")) S.askKind = "suggested";
  if (t.closest("#fab")) S.askVia = "button";
  if ((el = t.closest(".src-chip a"))) track("ask_source_link_clicked", { topic: chipTopic(el.closest(".src-chip")) });
});

function mailClick(a, href, loc){
  const m = href.match(/[?&]subject=([^&]*)/i);
  let subject = ""; try { subject = m ? decodeURIComponent(m[1]).toLowerCase() : ""; } catch (_) {}
  const base = { location: loc, case_study: studyOf(a), label: a.closest("#chat") ? undefined : txt(a).slice(0, 60) };
  if (subject.includes("walkthrough")) lead("walkthrough_requested", Object.assign(base, { case_study: studyOf(a) || "lucid-finance" }));
  else if (subject.includes("ux evaluation")) lead("ux_evaluation_requested", base);
  else if (subject.includes("book a call")) lead("book_call_clicked", base);
  else {
    const intent = subject.includes("talk") ? "lets_talk" : subject.includes("hot take") ? "hot_take_reply"
      : subject.includes("experiment") ? "experiments" : subject.startsWith("saw your portfolio") ? "role_match" : "email";
    lead("contact_clicked", Object.assign(base, { intent }));
  }
}
function outbound(a, href, loc){
  let host = ""; try { host = new URL(href).hostname.replace(/^www\./, ""); } catch (_) {}
  const network = /linkedin\.com$|lnkd\.in$/.test(host) ? "linkedin" : /medium\.com$/.test(host) ? "medium" : /instagram\.com$/.test(host) ? "instagram"
    : /spotify\.com$/.test(host) ? "podcast" : /youtube\.com$|youtu\.be$/.test(host) ? "youtube" : host;
  const take = a.closest(".take");
  if (take) return track("hot_take_opened", { take: takeKey(take), take_position: takePosition(take), platform: network });
  if (a.id === "case-vid") return track("external_artifact_clicked", { experiment: S.sheet && S.sheet.experiment, destination: network, link_type: network === "youtube" ? "video" : "external_page" });
  if (["linkedin", "medium", "instagram", "podcast"].includes(network)) return lead("social_clicked", { network, location: loc }, "soft");
  track("outbound_link_clicked", { destination: host, location: loc });
}
function replayed(via){
  const b = q('#ec .ec-tools button[aria-pressed="true"]');
  if (b) track("replay_viewed", { tool: TOOL[b.dataset.tool] || b.dataset.tool, via });
}
function command(raw, input){
  const parts = String(raw || "").trim().toLowerCase().split(/\s+/), c = COMMANDS.includes(parts[0]) ? parts[0] : "other";
  const file = c === "cat" && /^(readme|question|built|learned)(\.md)?$/.test(parts[1] || "readme") ? (parts[1] || "readme.md") : undefined;
  track("artifact_command_run", { experiment: S.sheet && S.sheet.experiment, command: c, file, input });
}
const spineKey = el => slug((el.getAttribute("aria-label") || "").split(",")[0]);
function chipTopic(chip){
  if (!chip) return undefined;
  return slug(txt(chip).replace(/^from:\s*/i, "").split(" · ")[0]);
}
function loaderToggle(b){
  S.loaderToggles++;
  track("loader_setting_toggled", { setting: b.dataset.k, on: b.getAttribute("aria-pressed") !== "true" });
}

/* ---------- forms and keys ---------- */
const onSubmit = safe(e => {
  const f = e.target;
  if (f.id === "inv-f") lead("event_invite_submitted", { has_place: !!(f.wh && f.wh.value.trim()), has_note: !!(f.nt && f.nt.value.trim()), location: "event_invite" });
  if (f.id === "pa-form") command(q("#pa-cmd").value, "typed");
});
const onKey = safe(e => {
  S.lastInput = now();
  const t = e.target;
  if (e.key === "Enter" && t && (t.id === "ask-input" || t.id === "ask-input-2") && t.value.trim()) S.askKind = "typed";
  if (e.key === "/" && !/INPUT|TEXTAREA/.test((document.activeElement || {}).tagName || "")) S.askVia = "slash_key";
  if (t && t.closest && t.closest('[role="tab"]') && /^Arrow|^Home$|^End$/.test(e.key)) S.lastClick = { el: t, t: now() };
});

/* ---------- observers ---------- */
function observe(el, opts, fn){ if (el) new MutationObserver(safe(fn)).observe(el, opts); }
function impressions(sel, name, props, threshold = 0.5){
  const els = qa(sel); if (!els.length || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver(es => es.forEach(safe(en => {
    if (!en.isIntersecting) return; io.unobserve(en.target); track(name, props(en.target));
  })), { threshold });
  els.forEach(el => io.observe(el));
}
function install(){
  if (installed) return; installed = true;
  ["#ask-input", "#ask-input-2", "#chat", "#inv-f", "#pa-cmd", "#pa-log"].forEach(s => { const el = q(s); if (el) el.classList.add("ph-no-capture"); });

  document.addEventListener("click", onClick, true);
  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", safe(e => {
    S.lastInput = now();
    if (!e.target.closest) return;
    if (!S.entered && e.target.closest("#loader") && !e.target.closest("[data-k]")) S.loaderTaps++;
    if (e.target.closest("#ask-input")) S.askVia = "search_bar"; // focus opens the panel before "click" fires
  }), { capture: true, passive: true });
  ["wheel", "touchstart", "pointermove"].forEach(t => addEventListener(t, () => { S.lastInput = now(); }, { passive: true }));

  /* scroll depth, rAF-throttled */
  let sRaf = 0;
  addEventListener("scroll", () => {
    S.lastInput = now();
    if (sRaf || !S.view) return;
    sRaf = requestAnimationFrame(safe(() => {
      sRaf = 0; const p = scrollPct(); S.viewMax = Math.max(S.viewMax, p);
      [25, 50, 75, 100].forEach(m => {
        if (p >= (m === 100 ? 98 : m) && !S.milestones.has(m)){
          S.milestones.add(m);
          track("scroll_depth_reached", { depth: m, view: S.view.key, section: S.view.section, case_study: S.view.case_study });
        }
      });
    }));
  }, { passive: true });

  /* engaged time: page visible and some input in the last 30s */
  setInterval(safe(() => {
    if (document.hidden || !S.entered || now() - S.lastInput > 30000) return;
    S.engagedTotal++; S.viewEngaged++;
    if (S.sheet) S.sheet.engaged++;
  }), 1000);

  /* loader → site entered */
  if (S.ready) entered();
  else observe(root, { attributes: true, attributeFilter: ["class"] }, () => { if (root.classList.contains("ready")) entered(); });

  /* views */
  observe(q(".tabs"), { attributes: true, subtree: true, attributeFilter: ["aria-selected"] }, syncView);
  qa("article.cs").forEach(a => {
    observe(a, { attributes: true, attributeFilter: ["hidden"] }, syncView);
    observe(q(".cs-now", a), { childList: true, characterData: true, subtree: true }, () => onChapter(a));
  });

  /* experiment / evaluation sheet */
  observe(q("#case"), { attributes: true, attributeFilter: ["open"] }, onSheet);
  observe(q("#case-title"), { childList: true, characterData: true, subtree: true }, () => { if (q("#case").open) onSheet(); });
  observe(q("#pa"), { attributes: true, attributeFilter: ["hidden"] }, onArtifact);
  let baOnce = false;
  document.addEventListener("input", safe(e => {
    if (!baOnce && e.target.closest && e.target.closest("#case-extra .ba")){ baOnce = true; track("experiment_interaction", { experiment: S.sheet && S.sheet.experiment, action: "compare_slider" }); }
  }), { capture: true, passive: true });

  /* about: process chapters, shelf previews */
  observe(q("#chap-title"), { childList: true, characterData: true, subtree: true }, () => {
    if (q("#chap-view").hidden) return;
    const title = txt(q("#chap-title")), i = qa("#toc button").findIndex(b => txt(b).includes(title));
    track("about_chapter_viewed", { chapter: slug(title), chapter_number: i + 1, via: clickedRecently("#toc button") ? "contents" : clickedRecently("#chap-next") ? "next" : clickedRecently("#toc-start") ? "start" : "other" });
  });
  const shelf = q("#shelf");
  if (shelf) shelf.addEventListener("pointerover", safe(e => {
    const sp = e.pointerType === "mouse" && e.target.closest(".spine");
    if (sp){ S.flags.shelf = true; once("spine:" + spineKey(sp), "evaluation_shelf_item_previewed", { evaluation: spineKey(sp) }); }
  }), { passive: true });

  /* privacy panel open / close */
  observe(q("#priv"), { attributes: true, attributeFilter: ["open"] }, () => {
    if (q("#priv").open) S.privAt = now(); else if (S.privAt){ track("privacy_panel_closed", { seconds: Math.round((now() - S.privAt) / 1000) }); S.privAt = 0; }
  });

  /* ask yes-ha */
  observe(q("#ask-panel"), { attributes: true, attributeFilter: ["class"] }, () => {
    const open = q("#ask-panel").classList.contains("open");
    if (open && !S.askOpen) track("ask_opened", { via: S.askVia || "keyboard_focus" });
    S.askOpen = open; if (!open) S.askVia = null;
  });
  observe(q("#chat"), { attributes: true, subtree: true, attributeFilter: ["class"], attributeOldValue: true }, ms => ms.forEach(m => {
    const li = m.target;
    if (!li.matches || !li.matches("li.bub.yes") || li.classList.contains("typing") || !/typing/.test(m.oldValue || "")) return;
    const chip = q(".src-chip", li), answered = !!chip;
    S.askCount++;
    track("ask_question_sent", { kind: S.askKind || "typed", topic: answered ? chipTopic(chip) : "unanswered", answered, question_number: S.askCount });
    S.askKind = null;
  }));

  /* life in looks */
  const lk = q("#lk");
  observe(lk, { attributes: true, attributeFilter: ["class"] }, () => {
    const open = lk.classList.contains("open");
    if (open && !S.lk){ S.lk = { t: now(), hits: 0 }; track("life_in_looks_opened"); }
    else if (!open && S.lk){ track("life_in_looks_closed", { seconds: Math.round((now() - S.lk.t) / 1000), tiles_hit: S.lk.hits }); S.lk = null; }
  });
  observe(q("#lk .lk-score b"), { childList: true, characterData: true, subtree: true }, () => { if (S.lk) S.lk.hits++; });

  /* leaving */
  addEventListener("pagehide", safe(() => {
    if (S.ended) return; S.ended = true;
    if (!S.entered){ track("loader_abandoned", { seconds: Math.round(now() / 1000), loader_taps: S.loaderTaps }, BEACON); return; }
    if (S.view) leaveView(S.view, "left_site");
    if (S.sheet) closeSheet("left_site");
    track("visit_ended", {
      engaged_seconds: Math.round(S.engagedTotal), sections_seen: [...S.sections].sort().join(","), sections_count: S.sections.size,
      case_studies_read: S.studies.size, case_studies: [...S.studies].join(","), lead_actions: S.leads, asked_yes_ha: S.askCount,
    }, BEACON);
    touchVisit();
  }));
  addEventListener("pageshow", e => { if (e.persisted) S.ended = false; });
}

function entered(){
  if (S.entered) return;
  S.entered = true; S.ready = true;
  track("site_entered", {
    loader_seconds: Math.round(now() / 100) / 10, loader_waited: S.loaderTaps === 0, loader_taps: S.loaderTaps, loader_settings_changed: S.loaderToggles,
    landing_route: location.hash || "#work",
    theme: "dark", music_on: root.classList.contains("q-music"), text_size: root.classList.contains("q-font") ? "readable" : "standard",
    calm_motion: root.classList.contains("q-motion"), focus_mode: root.classList.contains("q-focus"),
    reduced_motion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
  syncView();
  /* impressions, after the loader so nothing counts while it covers the page */
  impressions("#grid .card", "case_study_card_viewed", el => ({ case_study: el.dataset.slug, case_study_position: studyPosition(el.dataset.slug) }));
  impressions("#lab .pg", "experiment_card_viewed", el => ({ experiment: (el.dataset.slug || "").replace(/^pg-/, ""), experiment_category: el.dataset.tag }));
  impressions(".takes .take:not(.more)", "hot_take_viewed", el => ({ take: takeKey(el), take_position: takePosition(el) }));
  impressions(".takes .take.more", "brewed_opinions_viewed", el => ({ teaser: takeKey(el) }));
  impressions("#shelf", "evaluation_shelf_viewed", () => ({}), 0.3);
  impressions(".ab-cta", "shelf_cta_viewed", () => ({}));
  impressions(".ab-kit", "tool_kit_viewed", () => ({}));
  impressions(".rec-quote, .cs-quote", "recommendation_viewed", el => ({ location: el.closest("article.cs") ? "case_study" : "about", case_study: studyOf(el) }));
  impressions(".work-end, .lab-end, #p-takes .fade", "section_end_reached", el => ({ section: el.closest("#p-work") ? "work" : el.closest("#p-play") ? "playground" : "hot_takes" }), 0.3);
  impressions(".sfoot", "footer_reached", () => ({}), 0.2);
}

/* ---------- privacy panel: on/off switch for this browser ---------- */
function wirePrivacy(){
  const b = q("#priv-opt"), s = q("#priv-state"); if (!b || !s) return;
  const paint = () => {
    if (GPC || DNT){ b.hidden = true; b.style.display = "none"; s.textContent = "Your browser asks sites not to track you, so analytics are off for you."; return; }
    const off = optedOut();
    s.textContent = off ? "Analytics are off in this browser." : "Analytics are on in this browser.";
    b.textContent = off ? "Turn analytics back on" : "Turn off analytics";
  };
  b.addEventListener("click", safe(() => {
    if (optedOut()){ lsDel(OPT_KEY); start(); }
    else { lsSet(OPT_KEY, "1"); lsDel(VISIT_KEY); enabled = false; queue.length = 0; }
    paint();
  }));
  paint();
}

/* ---------- start ---------- */
function start(){
  if (!allowed() || !(CONFIG.key || DEBUG)) return;
  enabled = true;
  if (!installed){
    visit = countVisit();
    install();
    track("site_loaded", { landing_route: location.hash || "#work" });
  }
  const go = () => loadPostHog();
  if ("requestIdleCallback" in window) requestIdleCallback(go, { timeout: 2500 }); else setTimeout(go, 1200);
}

window.__yt = { log: [], get enabled(){ return enabled; }, get state(){ return S; } };
safe(wirePrivacy)();
safe(start)();
})();
