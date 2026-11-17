# Feature inventory

Audited 2026-11-17 against `main` = `de836d2` (v0.5.0-beta.1). It compares the requested capability list with the code.

Status key: **Done** = implemented · **Partial** = implemented in part · **Missing** · **Broken** · **Refactor** = works but needs restructuring · **Not feasible** = cannot be done with the available data or infrastructure.
"Unverified" means the feature exists, but its input channels are not confirmed in game.

## Already in the app (not in the requested list, kept as is)

Race tab (Content-Manager-style launcher: practice, hotlap, quick race, race weekend, online join, presets, random), in-game Paddock HUD (delta, cues, corners, track limits), audio brake spotter, own brake points, Mods tab (mod manager), bundled ACE UI App Loader management, Tracks tab (EVO-native track models), desktop overlay, lap export/import.

## User interface and experience

| Capability | Status | Where / note |
| --- | --- | --- |
| Motorsport engineering-cockpit design | Done | `style.css` "pit-wall timing screen" design system (0.5.0 design pass) |
| Dark graphite interface | Done | dark first, light theme from the OS setting |
| Orange accent | Decided: lime (D1) | the user kept the lime accent |
| Consistent typography/spacing | Done | Barlow / Barlow Condensed, type scale tokens |
| Reusable component library | Partial | CSS classes are shared; no JS component helpers for cards, states and tables beyond `util.js` |
| Sidebar navigation | Done (P4) | collapsible icon rail |
| Responsive layouts | Done for desktop (P4) | rail below 900 px, checked at 860/1024 px |
| Customizable dashboard widgets | Missing | no dashboard yet. Deferred: low value for the cost |
| Global search | Done (P4) | command palette, Ctrl+K |
| Keyboard shortcuts | Done (P4) | ? list, Alt+1…7, Ctrl+B, Ctrl+K |
| Command Center (palette) | Done (P4) | |
| Loading/empty/error states | Done (P4) | router loading bar + error card; shared helpers |

## Driver dashboard

| Capability | Status | Note |
| --- | --- | --- |
| Driver performance overview | Done (P5) | Home |
| Recent sessions | Done | Sessions tab, by date |
| Performance trends | Done | Progress page per combo; report lap-time trend |
| Personal records | Done (P5) | Home → Your records |
| Driving consistency | Done | Consistency page, 0–100 score in reports |
| Session summaries | Done | session reports |
| Important warnings | Done (P5) | Home → Needs attention |
| Recommended next actions | Done (P5) | Home → Next practice targets |

## Telemetry engineering

| Capability | Status | Note |
| --- | --- | --- |
| Session analysis | Done | session page: telemetry, report, Car & setup |
| Driver performance score | Partial | consistency score only; no overall score |
| Driving style analysis | Missing | channels exist (thr/brk/str at 60 Hz) to measure trail braking, release, throttle pickup and steering corrections |
| Corner-by-corner rankings | Partial | best/weakest 3 per session, focus corners on Consistency; no ranking of all corners across passes |
| Session timeline | Partial | lap list, trend chart, invalid-lap locations; no single timeline view |
| Speed & braking analysis | Done | corner table, charts |
| Throttle & steering analysis | Done | charts + corner metrics (throttle-on, coasting) |
| Telemetry comparison | Done | Compare (up to 3 laps vs best/ideal/any) |
| Driving heatmaps | Partial | map coloured by delta; replay can colour the line by inputs; no brake/throttle heatmap layer on the map |
| Performance progression | Done | Progress page |
| Ghost & replay | Done (desktop) | racing-line replay with same-time ghost mode. An in-game ghost car is **not feasible**: the game has no API to draw one |

## AI driving coach (Gemini, user's key)

| Capability | Status | Note |
| --- | --- | --- |
| Post-session engineer report | Done | AI debrief button on the report |
| Personalised training plans | Done (P8) | a report's measurable targets saved as the combo's plan, checked against every later session |
| Technique analysis | Done (P6) | per-corner brake/trail/release/throttle/steering metrics, corner rankings, inputs map layer, report style section, performance score |
| Braking-point recommendations | Done (P8) | AI suggestions per corner, validated (zone, ≤ 15 m later than the fastest pass), applied to brake marks only after review |
| Corner entry/exit analysis | Done | corner card entry/apex/exit + coach |
| Setup vs driving issue analysis | Partial | setup engineer + Car & setup rules, on **unverified** channels; laps split by setup since P7 |
| Telemetry-aware chat | Done (P8) | Coach page: chat per track + car with reports, style, setups and plan as context; per-lap follow-ups as before |
| Improvement recommendations | Done | coach, debrief, targets |
| Confidence indicators | Done (P2) | provenance badges, unconfirmed hints kept apart, AI confidence on every answer |

## Garage and car setup

| Capability | Status | Note |
| --- | --- | --- |
| Car profiles | Done | garage with the game's spec sheet (Race tab) |
| Setup management | Done | Setups tab, edits the game's `.carsetup` within the limits |
| Setup history | Done (P7) | Setup history page per track + car, versions of edited files apart |
| Setup version comparison | Done (P7) | compare two setups: lap times and exactly the values that differ |
| Performance comparison per setup | Done (P7) | best and typical lap, spread and conditions per setup across sessions |
| Import / export / portable sharing | Done | `.carsetup` share/import |
| Setup recommendations | Done (unverified) | rules + AI engineer; inputs unverified |

## Driver development

| Capability | Status | Note |
| --- | --- | --- |
| Personal goals | Missing | |
| Achievements | Missing | needs a product yes (gamification) |
| Challenges | Missing | needs a product yes |
| Training plans | Done (P8) | see AI coach |
| Session planner | Partial | Race tab presets; no plan with goals |
| Race weekend history | Partial | sessions store `session_type`; no weekend grouping view |
| Progress tracking | Done | Progress + report target checks |

## Application management

| Capability | Status | Note |
| --- | --- | --- |
| Backup & restore | Done (P3) | Settings → Backup and restore |
| Data export | Done (P3) | laps/sessions CSV + per-lap `.lap.gz` |
| Automatic updates | Done (P3, check and notify) | daily GitHub check, link to the release; no auto-install (user's choice) |
| Diagnostics | Done (P3) | Settings → Diagnostics, redacted |
| App health information | Partial | as above, spread over three pages |
| Error reporting | Done (P3) | "Copy for a bug report" (redacted) |

## Engineering

| Item | Status |
| --- | --- |
| Automated tests | **Missing** (none) |
| Lint / type checks | Missing (`node --check` only) |
| `src/server.js` router + loop + orchestration in one file | Refactor (gradual) |
| Shared-memory offsets for car data and setup fingerprint | **Unverified in game** |
| Broken features found in the baseline | None. All main endpoints return 200 with seeded mock data |
