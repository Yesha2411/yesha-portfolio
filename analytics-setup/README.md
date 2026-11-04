# yesha.online analytics

Privacy-first product analytics on **PostHog Cloud's free plan**. Everything runs from one file, `analytics.js`. `index.html` only gains the `<script>` tag and updated Privacy copy.

## Why PostHog (and why not the others)

| | PostHog (free) | Microsoft Clarity | Umami Cloud (Hobby) | Vercel Web Analytics (Hobby) | Matomo |
|---|---|---|---|---|---|
| Free allowance | 1M events/mo, 1 project, 1-yr retention | Free; no cap published | 100K events/mo, 3 sites, 6-mo retention | 50K events/mo, 1-month window | On-prem free, but you pay for a server; Cloud is paid |
| Over the limit | Events dropped, no bill (no card on file) | n/a | Plan limits | Collection pauses, no bill | n/a |
| Custom events | Yes | Limited (custom tags) | Yes | **Pro only** | Yes |
| Funnels | Yes | Basic | Yes | No | Premium plugin |
| Heatmaps | Yes; free plan = **3 capture URLs**, in-app viewer (toolbar viewer needs pay-as-you-go) | Yes, unlimited | No | No | Premium plugin |
| Rage and dead clicks | Yes (autocapture) | Yes | No | No | Premium |
| Session recordings | Available; **switched off here** | Always on (masked) | Paid plans | No | Premium |
| Cookies | None in this setup (`persistence: "memory"`) | Yes; consent required in EEA/UK/CH since Oct 31 2025 | None | None | Configurable |

**Chosen:** PostHog alone. It's the only free option with custom events, funnels, paths and heatmaps in one place, and it can run without cookies.

**Not chosen:**
- Clarity: always-on recordings and cookies conflict with "no invasive recordings".
- Vercel Analytics: no custom events on Hobby.
- Umami: no heatmaps.
- Matomo: heatmaps and funnels are paid plugins.

## Known limits (be honest about these in reports)

- **One visit = one visitor.** No cookies means PostHog can't recognise someone across page loads. "Unique users" in PostHog really means unique visits. A reload starts a new visit; toggling Calm motion reloads the page.
- **New vs returning** comes from the `yt-v` counter (a number and a timestamp, no ID). It's skipped for European time zones, so those visitors show as `unknown`.
- **Geography** comes from the IP address at ingestion. Turn on *Discard client IP data* (step 3 below) so the IP isn't stored.
- **Ad blockers** block PostHog, and those visitors aren't counted. **Bots and headless browsers** are filtered out by PostHog itself.
- **Heatmaps** on the free plan are limited to 3 capture URLs.
- **Video**: there are no embedded players, only YouTube and Instagram links. "Plays" means outbound clicks (`external_artifact_clicked`). Completion can't be measured.
- **Loader**: the loader can't actually be skipped. Taps during it are recorded as `loader_taps`, and `loader_waited=false` means they tapped. Leaving before it finishes sends `loader_abandoned`.
- The live **Brewed Opinions** cards have `pointer-events: none`. Clicks on them are matched by position and also show up as dead clicks.

## One-time setup (about 15 minutes)

1. **Create the account.** Go to https://us.posthog.com/signup and choose US Cloud. **Do not add a card**: staying on the free plan is what guarantees no bill.
2. **Copy the project API key** (`phc_…`) from Settings → Project → General. Put it in `analytics.js` as `CONFIG.key`. The key is public by design: it can send events but not read them.
3. **Project settings**:
   - Settings → Project → *IP data capture* → **Discard client IP data: ON** (geo still works).
   - Settings → Project → *Autocapture & heatmaps*:
     - Autocapture **ON**
     - Heatmaps **ON**
     - Dead clicks **ON**
     - Heatmap capture URLs: `https://www.yesha.online/*` (one wildcard covers every tab and case study, because each has its own `#hash`)
   - Settings → Project → *Session replay*: leave **OFF** (the code forces it off anyway).
   - Settings → Project → *Filter out internal and test users*: add `$host` = `localhost`.
4. **Deploy** (merge to `main`; Vercel publishes it).
5. **Exclude yourself.** On your own browsers, open Privacy in the footer and click **Turn off analytics**.
6. **Build the dashboard.** Create a personal API key in Settings → User → Personal API keys, with scopes `action:write`, `dashboard:write`, `insight:write`, `project:read`. Then run:
   ```
   POSTHOG_API_KEY=phx_... POSTHOG_PROJECT_ID=<number in your PostHog URL> node analytics-setup/posthog-setup.mjs
   ```
   This creates the **yesha.online · Opportunities** dashboard with 41 insights, including the three funnels. Use `--dry-run` to preview. Running it twice is safe.
7. **Built-in reports.** PostHog's **Web analytics** tab already covers visitors, referrers, UTM, countries/cities, devices, browsers, OS and screen sizes. Dashboards support date-range and property filters (device, referrer, `section`, `case_study`).

**Check it's working:** open `https://www.yesha.online/?yt_debug=1` and open the browser console. Every event is printed as it fires.

## Funnels (created by the setup script)

| Funnel | Steps |
|---|---|
| Hiring | `site_loaded` → `section_viewed` (work) → `case_study_opened` → chapter = research → `case_study_outcomes_reached` → *Resume or Let's talk* |
| Founder / client | `site_loaded` → `section_viewed` (playground or about) → *Explored an experiment or evaluation* → *Opened a case study or evaluation* → *Asked for a UX evaluation or call* |
| Case study (per project) | `case_study_card_viewed` → `case_study_opened` → problem → research → outcomes → *Walkthrough or contact* (broken down by `case_study`, all steps same project) |
| Chapter drop-off | opened → problem → research → insights → strategy → decisions → outcomes → what_i_learned, per project |
| Loader | `site_loaded` → `site_entered` |

*Italic* steps are PostHog Actions (any of several events), also created by the script.

## Event dictionary

Every event carries `section`, `view_type`, `case_study_context` (while reading), `last_case_study`, `engaged_seconds_on_site`, `visitor_type` and `visit_number_bucket`. PostHog adds referrer, UTM, device, browser, OS, screen size and geo.

**Visit and navigation**

| Event | Key properties |
|---|---|
| `site_loaded` | `landing_route` |
| `site_entered` (loader done) | `loader_seconds`, `loader_waited`, `loader_taps`, `loader_settings_changed`, `music_on`, `text_size`, `calm_motion`, `focus_mode`, `theme`, `reduced_motion` |
| `loader_abandoned` / `loader_setting_toggled` | `seconds`, `loader_taps` / `setting`, `on` |
| `$pageview` (virtual) | `$pathname`: `/work`, `/playground`, `/hot-takes`, `/about`, `/work/<case>`, `/playground/<experiment>`, `/about/evaluations/<eval>` |
| `section_viewed` | `section`, `via` (landing / tab / link / back_from_case_study) |
| `view_left` | `view`, `seconds_engaged`, `max_scroll_pct`, `exit` |
| `scroll_depth_reached` | `depth` (25/50/75/100), `view` |
| `section_end_reached`, `footer_reached` | `section` |
| `visit_ended` (beacon on leave) | `engaged_seconds`, `sections_seen`, `case_studies`, `lead_actions`, `asked_yes_ha` |

**Work**

| Event | Key properties |
|---|---|
| `case_study_card_viewed` | `case_study`, `case_study_position` (1 Lucid, 2 Navigator, 3 HealthNexus, 4 Nucleus) |
| `case_study_opened` | `case_study`, `source` (work_card / next_project / cross_link / ask_yes_ha / deep_link), `open_count` |
| `case_study_chapter_viewed` | `chapter` (overview, problem, research, insights, strategy, decisions, outcomes, what_i_learned), `chapter_number`, `via` (scroll / contents). Counts after 1 s on the chapter, once per visit. |
| `case_study_outcomes_reached`, `case_study_finished` | `case_study` |
| `case_study_closed` | `seconds_engaged`, `deepest_chapter`, `chapters_seen`, `reached_outcomes`, `exit` (all_work / next_project / tab / left_site) |
| `next_project_clicked` | `from`, `to`, `placement` |
| `case_study_contents_clicked`, `case_study_image_zoomed`, `case_study_demo_used` | `chapter` / `image` / `demo`, `control` |

**Playground**

| Event | Key properties |
|---|---|
| `replay_viewed` | `tool` (claude_ui_generation / claude_code / codex), `via` |
| `lab_filter_clicked` | `filter` |
| `experiment_card_viewed`, `playground_experiment_opened` | `experiment`, `experiment_position`, `experiment_category`, `source` |
| `artifact_tab_clicked` | `tab` (read / artifact) |
| `artifact_viewed` | |
| `artifact_command_run` | `command` (known commands only, else `other`), `file`, `input` |
| `playground_experiment_closed` | `seconds_engaged`, `viewed_artifact` |
| `external_artifact_clicked` | `destination`, `link_type` |
| `experiment_interaction` | `action` (compare_slider / take_apart) |
| `browse_lab_clicked`, `replay_result_clicked` | |

**Hot takes**

| Event | Key properties |
|---|---|
| `hot_take_viewed`, `hot_take_opened` | `take`, `take_position`, `platform` (linkedin / medium) |
| `brewed_opinions_viewed`, `brewed_opinions_clicked` | `teaser` |

**About**

| Event | Key properties |
|---|---|
| `about_chapter_viewed` | `chapter`, `chapter_number`, `via` |
| `about_contents_opened` | |
| `evaluation_shelf_viewed` | |
| `evaluation_shelf_item_previewed` (hover) / `_selected` (click) | `evaluation` |
| `evaluation_opened` / `evaluation_closed` | `evaluation`, `seconds_engaged` |
| `recommendation_viewed` | `location` |
| `tool_kit_viewed` / `tool_kit_item_clicked` | `tool` |
| `shelf_cta_viewed` ("Want your product on the shelf?") | |
| `field_notes_clicked` | |

**Conversions.** Each fires its own event **and** `lead_action` with `action`, `strength`, `location`, `case_study` (last one read), `sections_seen`, `explored_about`, `explored_playground`, `opened_evaluation_shelf`, `lead_number`.

| Event | Strength | Notes |
|---|---|---|
| `contact_clicked` | strong | `intent`: lets_talk / email / hot_take_reply / experiments / role_match |
| `ux_evaluation_requested`, `book_call_clicked`, `walkthrough_requested` | strong | |
| `email_copied`, `resume_downloaded` | strong | |
| `event_invite_submitted` | strong | Only `has_place` and `has_note`, never the form values |
| `event_invite_opened` | soft | |
| `social_clicked` | soft | `network`: linkedin / medium / instagram / podcast |

`location` values: sidebar, site_footer, work_end, playground_end, hot_takes_end, hot_takes_follow, about_shelf_cta, case_study, case_study_image (NDA tag), case_study_footer, experiment_sheet, evaluation_sheet, ask_yes_ha.

**Other**

| Event | Key properties |
|---|---|
| `ask_opened` | `via` (search_bar / button / slash_key) |
| `ask_question_sent` | `kind` (suggested / typed), `topic` (taken from the answer's source, e.g. `lucid_finance`, `about`, or `unanswered`), `answered`. The question text is never sent. |
| `ask_source_link_clicked` | |
| `reading_mode_toggled` | `setting` (motion / music / focus / font), `on` |
| `becoming_ish_toggled`, `becoming_ish_item_clicked` | `open` / `company` |
| `life_in_looks_opened`, `_filtered`, `_beat_toggled`, `_closed` | `tiles_hit`, `seconds` |
| `privacy_panel_opened`, `privacy_panel_closed`, `footer_link_clicked` | |
| PostHog autocapture | `$autocapture`, `$rageclick`, `$dead_click`, `$$heatmap`, `$pageleave` |

## Privacy guarantees (enforced in code)

- Nothing loads when the browser sends Global Privacy Control or Do Not Track, or when the visitor turns analytics off in Privacy. The `before_send` hook drops every event after an opt-out, autocapture included.
- No cookies, and no PostHog storage. The only stored keys are `yt-v` (the visit counter, outside Europe) and `yt-optout` (only after someone opts out).
- Ask Yes-ha inputs, the chat log, the invite form and the artifact console are tagged `ph-no-capture`. Their text never leaves the page.
- Query strings other than `utm_*` and `ref` are stripped from URLs before sending.
- PostHog loads after the first idle moment and never blocks rendering. Every listener is passive and wrapped in try/catch.

*This isn't legal advice. If you start targeting EU audiences specifically, revisit the visit counter and the GDPR basis for IP-based geolocation.*
