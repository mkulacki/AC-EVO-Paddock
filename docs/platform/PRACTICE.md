# Structured practice (PL7): rules, thresholds and limits

Code: `src/practice.js` (pure rules), `src/drills.js` (storage and the loop), `src/service.js` `drillPassesAsync` (corner passes, in slices), `public/practice.js` (cards), `GET/POST /api/practice`. Keep this file in step with `PRACTICE` and `METRICS` in `src/practice.js`. Deterministic: no AI anywhere in the loop, so it works the same with AI switched off.

## What a drill is

One behaviour in one corner of one car + track ("one focus"), made by the driver from a finding of the Lap analysis (`docs/platform/ANALYSIS.md`): **Practise this** next to a finding on one of the top three cards. Its findings already rest on at least 5 passes and compare the median of all passes with the median of the quicker quarter, so a drill always comes from a **repeated** weakness, never from one lap.

Storage builds on the P9 goals: a drill is a `goals` row of kind `drill` (`src/db.js` goals table). The prescription sits in `goals.extra`, the target in `goals.target`, and the first time it is met in `goals.met_*`, as for any goal. `drill_events` (schema v3) keeps what happened later: `restart`, `stopped`, `replaced`, `met`, each with the evaluation of that moment, so a result stays readable after its laps are deleted. The P9 goal lists, Home, achievements, suggestions and the session planner ignore kind `drill` (`src/goals.js` `goalsOnly`). The P8 training plan (session-report targets, `src/coach.js` `planStatus`) is unchanged and independent.

## The prescription (six parts, all from stored numbers)

| Part | Source |
| --- | --- |
| Observed issue | the finding's observation (`src/opportunities.js` `differences`) |
| Evidence | passes, laps, sessions, confidence word, opportunity rank and realistic gain of the corner, typical and quicker-quarter medians of the metric |
| Exercise | one fixed sentence per metric and direction, quoting those medians; "change only this" |
| Success criterion | at least half of the newest 10 passes reach the target |
| Minimum evidence | 5 valid passes since the start, with the reading the metric needs, on laps comparable with the "before" laps |
| Review point | 10 passes since the start (or the last "keep practising") without meeting it |

The interpretation sentence of the finding is shown as "Why it may help", labelled a possibility, not a proven cause.

## Target (adaptive, from recent repeatability)

- **Target** = the median of the quicker quarter of the corner's passes in the newest 30 valid laps: something the driver already does in about one pass in four. A drill renewed later (**Renew target from my latest laps**, or a new drill after one was met) takes its target from the newest laps again.
- **Tolerance** = half of the smallest difference the analysis names for that metric (`RULES.diff`): braking point / brake-off point 2.5 m, release time 50 ms, apex speed 1 km/h, throttle pick-up point 4 m, time to full throttle 75 ms, part-throttle time 75 ms, exit speed 1.5 km/h; brake re-applications aim at 0; a gear must be exactly the quicker passes' clear gear. Since a finding needs a gap of at least the full threshold, a pass must close at least half of it.
- A pass **reaches** the target when it is on the quicker passes' side of target ∓ tolerance.
- **Refused:** a corner that is not a ranked opportunity, fewer than 5 "before" passes with the reading, no difference any more, or a target that half of the "before" passes already reach. Also refused: the newest lap has no recorded game version.

## Judging

- Only **valid own laps** driven after the drill started, with the reading the metric needs (pedal for brake / throttle metrics; a gear reading and not the automatic gearbox for a gear drill), on the same corner grid as the best lap. The corner is found again by its apex (within 40 m), because corners come from the best lap, which can change.
- **Corner identity (D-PL7-8):** corner names are positions from the start line on the best lap, so a new best lap with one more corner renumbers the ones after it. A drill keeps its corner's apex distance and is matched to the current corners by apex (within 40 m) everywhere: its passes, its name on the pages ("T3 (T2 when the drill started)"), mastery, superseded drills and Renew / Practise again. If no corner is within 40 m, the drill "cannot be checked" and shows its old name.
- **History:** `drill_events` of goals that no longer exist are removed at every start (an older Paddock can delete a drill's goals row without them, and goals ids are reused); "met" is recorded in turn with Stop, Keep and new drills (D-PL7-10, D-PL7-11).
- **Game versions (OD-PL-34, D-PL7-9):** only laps whose recorded game version equals the newest analysed lap's count, in the "before" and in the drill; a lap on another version or without a recorded version is left out and counted ("another game version", "game version not recorded"), and the evidence says how many analysed laps were left out of the "before". No drill can be made when the newest lap has no recorded version. What else varies between the before and drill laps (setups, aids) is shown with the PL4 `compat.mix` panel.
- States: **collecting** (fewer than 5 passes), **practising**, **review point** (10 passes not met), **met**, **stopped** (or replaced), **cannot be checked** (corner gone, core readings marked wrong).
- **Met** at the first pass where at least 5 passes have been driven and at least half of the newest 10 (a rolling window, so early misses do not hold it back for ever) reach the target. Stored once (`goals.met_*` + a `met` event); a met drill stays met.
- **Keep practising** at the review point: the passes from then on are judged afresh (earlier ones stay counted as driven).
- **Before → now:** the share of passes reaching the target before (the "before" passes) and now (the judged passes), each with its number of passes ("33 % of 12 passes before → 100 % of 5 after"), and their medians. The corner time is shown as context only, never as the criterion: "faster" / "slower" only when the two median intervals do not overlap and the change is at least 30 ms (as the analysis trend), else "no clear change".

## Revisit, mastery, progress

- **Revisit (slipping):** for a met drill, the newest 10 passes (at least 5) of the newest 30 laps after it was met; slipping when fewer than 25 % reach its target. Not checked when a newer drill on the same corner and behaviour exists. Shown on Development ("Revisit", **Practise again**) and as the corner's mastery.
- **Corner mastery** (Lap analysis corner rows): Not enough passes (< 5) · Time to find (a ranked opportunity) · Practising (an active drill) · Revisit (a met drill slipping) · Steady (enough passes, no repeatable gain of 30 ms). The confidence word and drills met there are in the tooltip. No "mastered" label: it would claim more than the numbers show.
- **Progress summary** (Development): counts of active, met, stopped and to-revisit drills, and per met drill the share before → after with both pass counts and the corner-time verdict.

## When it is worked out

On demand: when Development or Lap analysis is opened (`GET /api/practice`), in slices (`runInSlices`), using the per-lap numbers the analysis keeps (PL3 lap-points cache). The met time is the time of the pass that met it, so opening the page later gives the same answer. Nothing runs in the telemetry loop.

## Limits

- Thresholds are tuned on synthetic and mock laps only; not checked against real AC EVO laps.
- The brake reading is the pedal position, not pressure; distances are from the timing line on the lap's own grid.
- A criterion measures one behaviour; reaching it does not prove the corner got faster (the corner time is shown beside it, as an association).
