#!/usr/bin/env node
/* Creates the yesha.online dashboard, funnels and grouped actions in PostHog.

   1. In PostHog: Settings → User → Personal API keys → Create key
      Scopes: action:write, dashboard:write, insight:write, project:read
   2. Your project ID is the number in the PostHog URL: us.posthog.com/project/<ID>
   3. Run (Node 18+):
        POSTHOG_API_KEY=phx_... POSTHOG_PROJECT_ID=12345 node analytics-setup/posthog-setup.mjs
      Add --dry-run to print what would be created without calling PostHog.
      EU cloud: also set POSTHOG_HOST=https://eu.posthog.com

   Running it twice is safe: actions are reused by name, and the script stops
   if the dashboard already exists (pass --force to create a second copy).
   The personal key is only read from the environment and never stored. */

const HOST = (process.env.POSTHOG_HOST || "https://us.posthog.com").replace(/\/$/, "");
const KEY = process.env.POSTHOG_API_KEY, PID = process.env.POSTHOG_PROJECT_ID;
const DRY = process.argv.includes("--dry-run"), FORCE = process.argv.includes("--force");
const DASHBOARD = "yesha.online · Opportunities";
if (!DRY && (!KEY || !PID)) { console.error("Set POSTHOG_API_KEY and POSTHOG_PROJECT_ID (or pass --dry-run)."); process.exit(1); }

let fakeId = 1000;
async function api(method, path, body) {
  if (DRY) { if (method !== "GET") console.log(`${method} ${path}  ${body && body.name ? "· " + body.name : ""}`); return method === "GET" ? { results: [] } : { id: ++fakeId }; }
  const r = await fetch(`${HOST}/api/projects/${PID}${path}`, {
    method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}

/* ---------- query builders ---------- */
const P = (key, value, operator = "exact") => ({ key, value, operator, type: "event" });
const E = (event, props, name) => ({ kind: "EventsNode", event, name: name || event, ...(props ? { properties: props } : {}) });
const A = (id, name) => ({ kind: "ActionsNode", id, name });
const RANGE = { date_from: "-30d" };
function trend(series, { breakdown, display = "ActionsBarValue", math = "dau", interval = "day" } = {}) {
  return { kind: "InsightVizNode", source: {
    kind: "TrendsQuery", interval, dateRange: RANGE, filterTestAccounts: true,
    series: series.map(s => ({ math, ...s })),
    trendsFilter: { display },
    ...(breakdown ? { breakdownFilter: { breakdown, breakdown_type: "event" } } : {}),
  } };
}
function funnel(series, { breakdown, attribution } = {}) {
  return { kind: "InsightVizNode", source: {
    kind: "FunnelsQuery", series, dateRange: RANGE, filterTestAccounts: true,
    funnelsFilter: { funnelVizType: "steps", funnelOrderType: "ordered", funnelWindowInterval: 1, funnelWindowIntervalUnit: "day",
      ...(attribution ? { breakdownAttributionType: attribution } : {}) },
    ...(breakdown ? { breakdownFilter: { breakdown, breakdown_type: "event" } } : {}),
  } };
}
const avg = (event, prop, props) => ({ ...E(event, props), math: "avg", math_property: prop });
const CH = ["overview", "problem", "research", "insights", "strategy", "decisions", "outcomes", "what_i_learned"];

/* ---------- grouped actions (an action = any of several events) ---------- */
const ACTIONS = {
  hiringConvert: { name: "Resume or Let's talk", steps: [{ event: "resume_downloaded" }, { event: "contact_clicked", properties: [P("intent", "lets_talk")] }] },
  explored: { name: "Explored an experiment or evaluation", steps: ["playground_experiment_opened", "replay_viewed", "evaluation_shelf_item_selected", "evaluation_shelf_item_previewed", "about_chapter_viewed"].map(event => ({ event })) },
  openedDeep: { name: "Opened a case study or evaluation", steps: [{ event: "case_study_opened" }, { event: "evaluation_opened" }] },
  clientConvert: { name: "Asked for a UX evaluation or call", steps: [{ event: "ux_evaluation_requested" }, { event: "book_call_clicked" }] },
  walkOrContact: { name: "Walkthrough or contact", steps: [{ event: "walkthrough_requested" }, { event: "lead_action", properties: [P("strength", "strong")] }] },
};

async function main() {
  const existing = (await api("GET", "/dashboards/?limit=200")).results || [];
  if (!FORCE && existing.some(d => d.name === DASHBOARD && !d.deleted)) { console.log(`"${DASHBOARD}" already exists. Pass --force to create another.`); return; }

  const haveActions = (await api("GET", "/actions/?limit=500")).results || [];
  const ids = {};
  for (const [k, a] of Object.entries(ACTIONS)) {
    const found = haveActions.find(x => x.name === a.name && !x.deleted);
    ids[k] = found ? found.id : (await api("POST", "/actions/", { name: a.name, steps: a.steps })).id;
  }

  const dash = await api("POST", "/dashboards/", { name: DASHBOARD, description: "Which work, experiments and sections lead to opportunities. Built by analytics-setup/posthog-setup.mjs." });

  const INSIGHTS = [
    /* funnels */
    ["Hiring funnel", "Lands → Work → opens a case study → Research → Outcomes → Resume or Let's talk", funnel([
      E("site_loaded", null, "Landed"), E("section_viewed", [P("section", "work")], "Saw Work"), E("case_study_opened"),
      E("case_study_chapter_viewed", [P("chapter", "research")], "Reached Research"), E("case_study_outcomes_reached"), A(ids.hiringConvert, ACTIONS.hiringConvert.name)])],
    ["Founder / client funnel", "Lands → Playground or About → explores → opens a case study or evaluation → asks for an evaluation or call", funnel([
      E("site_loaded", null, "Landed"), E("section_viewed", [P("section", ["playground", "about"])], "Opened Playground or About"),
      A(ids.explored, ACTIONS.explored.name), A(ids.openedDeep, ACTIONS.openedDeep.name), A(ids.clientConvert, ACTIONS.clientConvert.name)])],
    ["Case-study funnel, by project", "Card seen → opened → Problem → Research → Outcomes → walkthrough or contact. Each project is its own row.", funnel([
      E("case_study_card_viewed"), E("case_study_opened"),
      E("case_study_chapter_viewed", [P("chapter", "problem")], "Problem"), E("case_study_chapter_viewed", [P("chapter", "research")], "Research"),
      E("case_study_outcomes_reached", null, "Outcomes"), A(ids.walkOrContact, ACTIONS.walkOrContact.name)], { breakdown: "case_study", attribution: "all_events" })],
    ["Chapter drop-off, by project", "Where readers stop inside each case study", funnel([
      E("case_study_opened"), ...CH.slice(1).map(c => E("case_study_chapter_viewed", [P("chapter", c)], c))], { breakdown: "case_study", attribution: "all_events" })],
    ["Loader: landed vs entered", "Visitors who leave before the loader finishes", funnel([E("site_loaded"), E("site_entered")])],

    /* audience */
    ["Unique visits", "One visit = one page load (no cookies, so no cross-day IDs)", trend([E("site_loaded", null, "Landed"), E("site_entered", null, "Entered")], { display: "ActionsLineGraph" })],
    ["New vs returning", "From the visit counter; 'unknown' = European time zones (no counter stored)", trend([E("site_entered")], { breakdown: "visitor_type", display: "ActionsPie" })],
    ["Traffic sources", "Referring domain; $direct = typed in or no referrer", trend([E("site_entered")], { breakdown: "$referring_domain", display: "ActionsTable" })],
    ["Countries", "", trend([E("site_entered")], { breakdown: "$geoip_country_code", display: "WorldMap" })],
    ["Cities", "", trend([E("site_entered")], { breakdown: "$geoip_city_name", display: "ActionsTable" })],
    ["Devices", "", trend([E("site_entered")], { breakdown: "$device_type", display: "ActionsPie" })],
    ["Browsers", "", trend([E("site_entered")], { breakdown: "$browser", display: "ActionsTable" })],
    ["Operating systems", "", trend([E("site_entered")], { breakdown: "$os", display: "ActionsTable" })],
    ["Screen widths", "", trend([E("site_entered")], { breakdown: "$screen_width", display: "ActionsTable" })],

    /* engagement */
    ["Most viewed sections", "", trend([E("section_viewed")], { breakdown: "section", math: "total" })],
    ["Avg engaged seconds per view", "Only counts time with the tab visible and recent input", trend([avg("view_left", "seconds_engaged")], { breakdown: "view" })],
    ["Scrolled to the end, by view", "", trend([E("scroll_depth_reached", [P("depth", "100")])], { breakdown: "view" })],
    ["Scroll depth reached", "", trend([E("scroll_depth_reached")], { breakdown: "depth" })],
    ["Rage and dead clicks", "Open Heatmaps to see where", trend([E("$rageclick"), E("$dead_click")], { display: "ActionsLineGraph", math: "total" })],
    ["Visitor paths", "Order of tabs, case studies and experiments", { kind: "InsightVizNode", source: { kind: "PathsQuery", dateRange: RANGE, filterTestAccounts: true, pathsFilter: { includeEventTypes: ["$pageview"], stepLimit: 6 } } }],

    /* work */
    ["Case studies opened", "", trend([E("case_study_opened")], { breakdown: "case_study" })],
    ["Avg engaged seconds per case study", "", trend([avg("case_study_closed", "seconds_engaged")], { breakdown: "case_study" })],
    ["Reached Outcomes, by project", "", trend([E("case_study_outcomes_reached")], { breakdown: "case_study" })],
    ["Where readers leave a case study", "Deepest chapter reached when the case study was closed", trend([E("case_study_closed")], { breakdown: "deepest_chapter", math: "total" })],
    ["Next project clicks", "", trend([E("next_project_clicked")], { breakdown: "from", math: "total" })],
    ["Walkthrough requests", "", trend([E("walkthrough_requested")], { breakdown: "case_study", math: "total" })],

    /* conversions */
    ["Contact actions", "Every lead action, strongest first", trend([E("lead_action")], { breakdown: "action", math: "total" })],
    ["Strong leads by last case study read", "Which project people read last before reaching out", trend([E("lead_action", [P("strength", "strong")])], { breakdown: "case_study" })],
    ["Lead actions by location", "Which button placement converts", trend([E("lead_action")], { breakdown: "location", math: "total" })],
    ["Explored About before contacting?", "", trend([E("lead_action", [P("strength", "strong")])], { breakdown: "explored_about", display: "ActionsPie" })],

    /* playground */
    ["Experiments opened", "", trend([E("playground_experiment_opened")], { breakdown: "experiment" })],
    ["Replays by tool", "", trend([E("replay_viewed")], { breakdown: "tool", math: "total" })],
    ["Read vs Artifact tab", "", trend([E("artifact_tab_clicked")], { breakdown: "tab", math: "total" })],
    ["Lab filters", "", trend([E("lab_filter_clicked")], { breakdown: "filter", math: "total" })],
    ["External artifact and video clicks", "", trend([E("external_artifact_clicked")], { breakdown: "experiment", math: "total" })],

    /* hot takes + about */
    ["Hot takes opened", "", trend([E("hot_take_opened")], { breakdown: "take" })],
    ["Hot takes by platform", "", trend([E("hot_take_opened")], { breakdown: "platform", display: "ActionsPie", math: "total" })],
    ["Evaluation shelf interest", "", trend([E("evaluation_shelf_item_selected"), E("evaluation_shelf_item_previewed"), E("evaluation_opened")], { breakdown: "evaluation" })],
    ["About: process chapters", "", trend([E("about_chapter_viewed")], { breakdown: "chapter" })],
    ["Ask Yes-ha topics", "Topic of the answer only; questions are never sent", trend([E("ask_question_sent")], { breakdown: "topic", math: "total" })],
    ["Reading mode and loader choices", "", trend([E("reading_mode_toggled"), E("loader_setting_toggled")], { breakdown: "setting", math: "total" })],
  ];

  let ok = 0;
  for (const [name, description, query] of INSIGHTS) {
    try { await api("POST", "/insights/", { name, description, query, dashboards: [dash.id] }); ok++; }
    catch (e) { console.warn(`! ${name}: ${e.message}`); }
  }
  console.log(`\nCreated ${ok}/${INSIGHTS.length} insights on "${DASHBOARD}".`);
  if (!DRY) console.log(`Open: ${HOST}/project/${PID}/dashboard/${dash.id}`);
}
main().catch(e => { console.error(e.message); process.exit(1); });
