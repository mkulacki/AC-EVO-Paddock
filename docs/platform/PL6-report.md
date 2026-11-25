# PL6 report: actionable lap analysis (deterministic, no AI)

- **Date:** 2026-11-25 · **Branch:** `platform/pl6-analysis` (from `c65fa65`, the PL5 merge) · not pushed, not merged
- **Scope:** `docs/platform/BACKLOG.md` (PL6). Algorithms, thresholds and limits: `docs/platform/ANALYSIS.md`.

## What changed

| Commit | What |
| --- | --- |
| `a288182` | `src/stats.js`: quantiles (type 7), summary with the median interval (1.58 × IQR / √n), mode, Theil–Sen slope, `apart`; `test/stats.test.js` |
| `271bcb7` | `src/analysis.js`: new technique metric `holdMs` (throttle hesitation), `phaseTimes` (entry / apex / exit on fixed grid points), `channelPresence`; tests in `test/technique.test.js` |
| `3a95dfc` | `src/opportunities.js`: ranked corner opportunities (realistic gain = median − q1, "up to" = median − fastest), phase losses, findings (braking, brake release, apex speed, throttle pickup, hesitation, exit speed, gear) with observation and interpretation kept apart, gear groups, distributions, repeatable target lap, multi-session trends, PB explanation; `test/opportunities.test.js` (hand-written metric fixtures) |
| `afe65c2` | `src/service.js` `lapAnalysisAsync` / `analysisSteps` (in slices, cached per car + track + window + filter, invalidated with the car + track), `lapPasses` (per-lap numbers in the PL3 lap-points cache), compat anchor and filters, bookmarks per corner (`src/notes.js` `forCombo`); `GET /api/analysis`; `test/lapfixtures.js` (synthetic laps with known patterns), `test/lapanalysis.test.js` |
| `6dddedb` | `public/analysis.js` Lap analysis page (`#/analysis`): top three cards, all corners with distribution strips and braking / throttle / gear details, target lap tiles, PB card, trends; links from Sessions, Consistency and Ctrl+K; CSS; browser flow; the browser import flow now deletes a mock lap, not the oldest lap overall |
| `76cd6c2` | yield before every lap whose metrics are not kept (the first version held the loop 41 ms when traces were in memory); PB explanation test |
| `197737f` | `docs/platform/ANALYSIS.md`, `docs/DECISIONS.md` (D-PL6-1 … 9, OD-PL-25 … 31), fixtures provenance, FEATURE_INVENTORY, ARCHITECTURE, BACKLOG, CHANGELOG |
| (this commit) | this report, `docs/PHASE_LOG.md`, `docs/DEVELOPMENT_STATE.md` |

New files: `src/stats.js`, `src/opportunities.js`, `public/analysis.js`, `test/stats.test.js`, `test/opportunities.test.js`, `test/lapanalysis.test.js`, `test/lapfixtures.js`, `docs/platform/ANALYSIS.md`, this report.

## Verified findings / rejected assumptions / unresolved

Verified:

- The P6 technique analysis to extend is `src/analysis.js:161` `cornerMetrics`, `src/analysis.js:229` `techniqueMetrics` with the definitions in `src/analysis.js:201` `TECHNIQUE`; the session report compares the session's typical pass with the corner's **single fastest pass ever** (`src/report.js:44` `cornerReasons`, `src/report.js:79` `styleNotes`), and the Consistency "focus corners" use mean − fastest pass (`public/consistency.js:42-45`). Both can be driven by one lucky pass; PL6 ranks by median − first quartile and compares group medians (fixture "one lucky pass": ideal gain 505 ms, not ranked).
- A channel missing from a lap file is resampled as zeros (`src/analysis.js:17`, `data[c]?.[i] ?? 0`), so a lap without gear data reads as gear 0 all lap: `channelPresence` now detects it and the lap is left out of gear comparisons (test: 3 laps without gear).
- There is no brake-pressure reading: the brake channel is the input read from shared memory (`src/recorder.js:64`, `f.brake`). The brake-release comparison uses it and the page calls it the pedal position.
- Whether the automatic gearbox was on is not stored per lap (`laps.aids` holds the aids class only, `src/aids.js`); every gear comparison says so.
- Per-lap corner times for every valid lap are already kept (PL3, `src/service.js` `lapCornerTimes`), so the multi-session trend needs no extra trace reads.
- The first analysis version held the event loop 41 ms when the traces were already in memory (it yielded only before a database read); fixed in `76cd6c2`, longest hold now 12.7 ms.
- The browser import flow deleted and re-imported the oldest lap overall (`test/browser.flows.js:206` before this phase), which turned one of the analysis fixture laps into an import (imports are not analysed) and flipped the ranking; it now picks a mock lap.

Rejected assumption:

- "A brake-release comparison needs brake pressure": done on the pedal position, labelled as such.

Unresolved (no game here):

- Whether the fixed thresholds (OD-PL-29) and the 25 m apex phase suit real AC EVO cars and very long corners; checked only on synthetic and mock laps.
- The Consistency page (`src/service.js:305` `consistency`) and the AI coach still read every lap's full trace at once (PL3 follow-up); not touched, because PL6 did not change them.

## Tests run and results

| Command | Before (`c65fa65`) | After |
| --- | --- | --- |
| `npm run check` | 131/131 | 138/138 |
| `npm test` (Node 22.23.4) | 307/307 | 337/337 |
| `npm run test:electron` (Node 24.22.2, Electron 44.11.1) | 307/307 | 337/337 |
| `npm run test:browser` (headless Edge) | 21/21 | 22/22 (2 consecutive full runs) |

New tests: stats (5), technique (+3), opportunities (12), lapanalysis (10), browser "lap analysis" (1).

## Checks that could not run, and why

- `npm run smoke:packaged`: not run (the user's Paddock is running on port 8080; the packaged exe is not started in this phase).
- `npm run bench`: not rerun (the telemetry loop and the lap save are unchanged); the analysis was measured separately (below).
- No AC EVO here: real laps, real cars and the in-game HUD are not involved; thresholds are unverified against real driving.
- UI checked by DOM assertions in headless Edge (cards, observation / interpretation split, links, keyboard, 700 px width), not looked at by a person; no screen-reader run.

## Performance or compatibility impact

- The analysis runs only when the page asks (`GET /api/analysis`), in 8 ms slices, never in the telemetry loop. Mock history of 120 laps (104 valid), traces in memory: newest 30 laps 41 ms in total with a longest hold of 12.7 ms; all laps 16 ms more (hold 5.8 ms); repeat from the cache 0.01 ms. A lap not in the trace cache adds the PL3 read (~8 ms) to its own slice. Budget (no hold over 33 ms) met.
- Memory: one small entry per lap in the existing bounded lap-points cache (`POINTS_MAX`); results per car + track + window + filter until its laps change.
- Compatibility: the Consistency page gets one more technique column (Throttle hesitation, D-PL6-6). Session reports, Compare, Progress, Home and the HUD are unchanged. No new dependency.

## Migration and recovery implications

None: no DB change (D-PL6-9), no settings change, nothing stored. Per-lap numbers are kept in memory only and worked out again after a restart. Removing the branch removes the page; no data to recover.

## Needs approval

- Push / merge of `platform/pl6-analysis` (into `platform/integration`, then `main`). Nothing else: no backend, deploy, upload or privacy change.

## Open decisions (added to DECISIONS.md)

OD-PL-25 default lap window (built: newest 30 valid laps) · OD-PL-26 minimum samples and confidence words (built: 5 passes; low 5–9 / medium 10–19 / high 20+; gear groups 3; trends 3 sessions of 3+ laps, newest 10) · OD-PL-27 meaning of realistic gain / target lap (built: first quartile) · OD-PL-28 smallest gain listed (built: 30 ms) · OD-PL-29 difference thresholds (built: fixed, session-report levels where they exist) · OD-PL-30 interpretation sentences (built: shown as "What it may mean", hedged, with the causation note) · OD-PL-31 Home's next step (built: unchanged). Made without asking: D-PL6-1 … 9.

## Remaining risks

- Thresholds and phase boundaries are tuned on synthetic and mock laps only; a real car may produce findings that are too many or too few until OD-PL-29 is settled with real laps.
- Associations can still be misread as causes despite the wording; the page states it under the top cards and in the PB card.
- The median interval assumes independent passes; laps within one session are correlated, so the trend verdict can be optimistic.
- A long history opened with cold traces costs ~8 ms per lap in slices (seconds for hundreds of laps with window "all"); the page waits, the recording does not.
- Consistency page and AI coach full-trace reads remain (PL3 follow-up).

## Recommended next phase

PL7 (structured practice): turn the top opportunities and their findings (corner, phase, finding key, numbers, sample size) into prescriptions with a success criterion that the next analysis can check; decide OD-PL-31 first, since it decides whether Home and PL7 get the analysis in the background.
