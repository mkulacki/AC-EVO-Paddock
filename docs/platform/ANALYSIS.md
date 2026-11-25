# Lap analysis (PL6): algorithms, thresholds and limits

The **Lap analysis** page (`#/analysis?combo=track|layout|car`, `public/analysis.js`) answers "where is my time, and what
did I do differently when I was quicker?" for one car on one track. It is worked out from the driver's own laps,
deterministically, without AI. This file is the reference for what it computes; keep it in step with
`src/opportunities.js` (`RULES`), `src/analysis.js` and `src/service.js` (`lapAnalysisAsync`).

## What it builds on (existing P6 analysis)

PL6 extends the P6 technique analysis instead of adding a parallel one:

| Existing piece | Where | Used for |
| --- | --- | --- |
| Distance resampling, corner detection (speed minima, or the game's track model) | `src/analysis.js:8` `resample`, `src/analysis.js:68` `detectCorners`, `src/track.js` `cornersOnGrid` | the corners (T1 … Tn) and the shared distance grid of a car + track |
| Per-corner metrics: brake / lift point, brake release point, min speed, throttle pickup, exit speed, coasting, min gear | `src/analysis.js:161` `cornerMetrics` | the findings below |
| Technique metrics: brake application, trail braking, release time, release bumps, apex to full throttle, re-lifts, steering | `src/analysis.js:229` `techniqueMetrics`, definitions `src/analysis.js:201` `TECHNIQUE` | the findings below |
| Session report "weakest corners" reasons and P6 style notes (typical pass against the corner's fastest pass) | `src/report.js:44` `cornerReasons`, `src/report.js:79` `styleNotes` | the difference thresholds (the same levels where they exist) |
| Consistency "focus corners" (mean − fastest pass) | `public/consistency.js:42` | superseded on the analysis page by the realistic gain; the Consistency page keeps its own |
| Ideal lap (fastest pass of every corner, spliced) and the per-lap corner-time cache | `src/analysis.js:372` `buildIdeal`, `src/service.js` `comboInfo` / `lapCornerTimes` (PL3) | the theoretical ideal; the trends |
| Compatibility classes and group caveats | `src/compat.js` `classify`, `mix` (PL4) | which laps are used and how mixed laps are labelled |

New in PL6:

- `src/analysis.js:304` `phaseTimes` (entry / apex / exit), `src/analysis.js:315` `channelPresence`, and a new technique
  metric `holdMs` "Throttle hesitation" (`src/analysis.js:208`; it also appears in the Consistency page's technique table
  and spread chart).
- `src/stats.js`: quantiles (R type 7), median interval, mode, Theil–Sen slope, `apart` (non-overlapping median
  intervals). PL8 can reuse it.
- `src/opportunities.js`: the pure aggregation (`analyse`, `RULES`, `differences`).
- `src/service.js:481` `lapAnalysisAsync` with `src/service.js:406` `analysisSteps`; route `GET /api/analysis`
  (`src/server.js:812`).

## Which laps

1. The car + track's **own valid laps** (`source = 'local'`, `valid = 1`), as the ideal lap uses. Imported laps, online
   laps and invalid laps are never analysed.
2. **Anchor = the newest valid lap.** Every lap is classified against it with `compat.classify` (PL4). A lap whose class
   is `incompatible` (another layout, an unknown car) is left out and listed with the reason ("Laps left out or
   limited"). Laps with caveats (another game version, setup, aids, conditions, session type) are used, and what varies
   between the analysed laps is shown with `compat.mix` (the "Mixed laps" card).
3. Optional filter "Only laps like the newest": same **game version** or same **setup** as the anchor. Laps that differ
   are left out and listed. If the anchor has no recorded value, the filter is not applied and the page says so. Setups
   follow `compat.classify`: with the pit-box readings marked as wrong every setup counts as unknown (the filter is not
   applied, and the page says so); while setup recognition is not checked against the game, the filter is applied and
   labelled.
4. **Window:** the newest `ANALYSIS_WINDOW` (30) laps of what is left (default, OD-PL-25), or all of them. Trends and the
   PB explanation always use every lap of the filtered set.
5. A lap measured on another distance grid (another track length) is left out and listed.

## Channels (never fabricated)

Everything rests on the `core` group (speed, pedals, steering, gear; built-in verified, `src/channels.js`). If the
driver marked it as not matching the game (`state = 'unsupported'`), the page shows no analysis at all.

Per lap, `channelPresence` checks which channels hold data (a lap file without a channel is resampled as zeros):

- no gear data (gear 0 all lap): the lap is left out of every gear comparison (counted under "without gear data");
- no brake data: left out of the braking and release medians; no throttle data: left out of the throttle medians.

Limits said on the page: the brake channel is the **pedal position**, not brake pressure (Paddock has no checked
pressure reading). The automatic gearbox setting comes with each lap from the Paddock HUD (`laps.aids.assists.gearbox`,
`src/aids.js`): laps driven with it are left out of every gear comparison; laps without a recorded setting (no HUD
reading, or assist readings marked as wrong) are used and labelled, since they may include automatic shifts. A top card
with a braking or gear finding carries the matching caveat. G-forces and slip (unverified) are not used.

## Per lap, per corner (the "pass")

For every corner of every analysed lap, on the shared grid (`src/service.js:397` `lapPasses`, kept per lap in the PL3
lap-points cache under the key `pl6|PASS_REV|corner signature`):

| Value | Definition |
| --- | --- |
| `timeMs` | time through the corner segment (segment start = the fastest point after the previous corner) |
| `entryMs`, `apexMs`, `exitMs` | `phaseTimes`: entry = segment start to 25 m (`APEX_HALF_M`) before the reference apex; apex = 25 m either side of it; exit = from there to the segment end. The reference apex is the best lap's slowest point, so the boundaries are the same grid points for every lap and the phases add up to `timeMs` |
| `brakePoint`, `brakeRelease`, `minSpeed`, `throttlePickup`, `exitSpeed`, `minGear`, `coastM` | `cornerMetrics` (unchanged) |
| `releaseMs`, `releaseBumps`, `trailM`, `pickupMs`, `reLifts` | `techniqueMetrics` (unchanged) |
| `holdMs` (new) | throttle hesitation: from the first throttle over 20 % after the slowest point until full throttle (over 95 %) or the segment end, the time with the throttle between 20 and 95 % and rising less than 20 % a second |

## Per corner

With `n` = the passes of the corner (`src/opportunities.js:170` `cornerRow`):

- **Distribution:** min, q1, median, q3, max, σ, and (from 5 passes on) the **interval of the median** `ci = 1.58 × IQR / √n` (the box-plot
  notch, McGill, Tukey and Larsen 1978). Drawn as one strip per corner (dots = passes, box = middle half, dark band = the
  median's interval); each dot names its lap.
- **Minimum samples:** fewer than `minPasses` = 5 passes: nothing is concluded ("Needs 5 valid passes (n so far)").
- **Confidence word:** 5–9 passes low, 10–19 medium, 20+ high. Shown on every card and row (OD-PL-26).
- **Faster passes** = the passes at or under the first quartile ("the quicker quarter"); typical = all passes. Every
  comparison is between the **medians** of the two groups, so one lucky pass cannot drive it.
- **Gains:** realistic = median − q1 (what the typical pass gains by matching what you already do in 1 pass out of 4);
  "up to" = median − fastest pass. Ranking uses the realistic gain (ties: the larger "up to", then fewer passes). A
  realistic gain under `minGainMs` = 30 ms is not listed (OD-PL-27, OD-PL-28).
- **Phase losses:** per phase, median(all passes) − median(faster passes). The main phase is the largest one if it is at
  least 20 ms; otherwise the loss is "spread over the whole corner". Medians of the parts need not add up exactly to the
  median of the whole: the bar shows each phase's own number.
- **Findings** (`differences`, `src/opportunities.js:47`): the faster passes' median against the typical pass's, named
  only from these differences on (OD-PL-29):

  | Finding | Threshold | Level from |
  | --- | --- | --- |
  | Braking point earlier / later | 5 m | report `cornerReasons` |
  | Off the brake earlier / later | 5 m | new |
  | Brake release time | max(100 ms, 25 % of the shorter) | new |
  | Brake re-applications while releasing | typical 1 or more, faster 0 | report `styleNotes` |
  | Speed at the slowest point | 2 km/h | report `cornerReasons` |
  | Back on the throttle (distance) | 8 m | report `cornerReasons` |
  | Slowest point to full throttle | max(150 ms, 25 % of the faster) | report `styleNotes` |
  | Throttle hesitation | 150 ms | new |
  | Exit speed | 3 km/h | report `cornerReasons` |
  | Gear at the slowest point | the most frequent gear differs | new |

  Each finding has an **observation** (numbers only, no "may") and a separate **interpretation** worded as a possibility
  (OD-PL-30). Findings are ordered by their size relative to the threshold. Counts (re-applications, re-lifts) are
  whole numbers: the median rounded down. The gear finding needs a clear gear on both sides: at least 3 passes in the
  most used gear of the typical passes and of the quicker quarter, and no tie (`clearGear`); otherwise there is none.
- **Gear comparison:** passes per gear at the slowest point (laps with the manual gearbox or an unknown setting); when two gears each have 3 or more passes, their median
  corner times are compared and labelled as an association.
- **Links:** every card and row links to Compare at that corner (a typical pass, the median one or the slower of two
  middles, against a representative fast pass, the faster pass nearest q1; or against the fastest pass), to the
  corner's distribution row on the page and to the Consistency page. Corners the driver bookmarked (PL5) are marked.

## The top three

The first three ranked corners as cards that can be read without a chart: a headline ("T2: about 0.20 s a lap to gain,
most of it on the way out"), passes and confidence, the phase bar, "What was measured" (typical, quick-quarter and
fastest times, then up to three findings) and "What it may mean" (their interpretations), and the links. Under them,
the causation note: the differences go together with the time but do not prove the cause.

## Target lap (repeatable) next to the ideal

- **Target lap** = the sum over corners of q1 (`targetLap`, `src/opportunities.js:212`), only when every corner has 5 or
  more passes. **Rough range** = √(Σ h²), h = half the width of each corner's first-quartile interval
  (`stats.quantileRange`: the values at the ranks n·p ± 1.96·√(n·p·(1−p)), distribution-free), added as independent
  errors; shown to 0.1 s and labelled "rough".
- Next to it: the best and the typical (median) lap of the analysed laps, and the **theoretical ideal** (the existing
  ideal lap from all valid laps, `comboInfo`). The ideal of the analysed laps only (Σ min) is in the data.
- Limits: corners are treated as independent; the target is a sum of quartiles, not a lap that was driven.

## Across sessions

Sessions with 3 or more valid laps, the newest 10, oldest first (`trends`, `src/opportunities.js:225`). For the lap and
for every corner: each session's median, the change from the first to the latest, the Theil–Sen slope per session, and a
verdict: "faster" / "slower" only when the first and the latest session's median intervals do not overlap
(`stats.apart`) **and** the change is at least `RULES.trendMinMs` (100 ms for the lap, 30 ms for a corner); otherwise
"no clear change". Needs 3 such sessions. The Progress page (per day) is linked.

## What made the personal best faster

The best lap of the filtered set against the best lap recorded before it (`pbExplain`): the change per corner and phase,
the three biggest gains with their findings (the same thresholds, worded for one lap: "Your best lap started braking
10 m later"), and the corners where it lost time (20 ms or more). The pair's compatibility (`compat.classify`) is shown
when it is not "compatible". The page notes that one lap against one lap can be luck.

## Performance (PL3 budgets)

On demand only (the page asks), never in the telemetry loop. `lapAnalysisAsync` runs `analysisSteps` with
`runInSlices` (8 ms slices) and yields before every lap whose numbers are not kept yet; the per-lap numbers stay in the
lap-points cache, the result per car + track + window + filter until a lap of that car + track changes
(`svc.invalidate`). A run during which those laps change is worked out again before it answers (up to 3 times), and
what the core, setup and assist readings are worth is part of the cache key. `/api/analysis` is a private GET (refused
cross-site, like `/api/overview`). Measured on a seeded mock history (120 laps, traces in memory): 30 laps 41 ms in all with a longest
hold of 12.7 ms; then all 104 valid laps 16 ms more (longest hold 5.8 ms); a repeat 0.01 ms. A lap not in the trace
cache adds the PL3 read (~8 ms) to its slice. Budget: no hold over 33 ms.

## Reproducibility and fixtures

The same laps give the same result in any order (laps are sorted by time, then id; nothing random). Tests:

- `test/opportunities.test.js`: metric-level fixtures written out by hand (a consistent corner, exit hesitation with a
  gear difference, early braking, one lucky pass, a corner improving over sessions; too few laps; missing gear and
  brake channels; PB wording; order independence; threshold edges).
- `test/lapanalysis.test.js`: synthetic laps from `test/lapfixtures.js` (a 3-corner circuit; braking factor, held
  throttle and gear per corner) through resampling, corner detection and the service: the early-braking corner is lost
  on the entry with a later braking point named, the held-throttle corner on the exit with hesitation, exit speed and
  gear; the clean corner is not listed; slices; the game-version filter; laps without gear; bookmarks; a new PB.
- `test/stats.test.js`; `test/technique.test.js` (hesitation, phases, channel presence).
- Browser: `test/browser.flows.js` "lap analysis" (top cards, the observation / interpretation split, links, keyboard,
  narrow window).

Provenance of the fixtures: `test/fixtures/README.md`.

## Known limitations

- Associations, not causes: a faster pass that braked later may have been faster for another reason (a tow, the line,
  the previous corner). The page says so; the advice is one change at a time.
- Corner segments run from the fastest point after one corner to the fastest point after the next, so "exit" includes
  the following straight and "entry" the end of the previous one. Phase boundaries are fixed distances around the best
  lap's apex, not each pass's own apex.
- The line (lateral position) is not among the findings (it is on Compare and Consistency); setups are labelled, not
  compared (PL8).
- Thresholds are fixed and the same for every car; they come from the session report where one existed.
- The median interval assumes independent passes; laps within one session are not quite independent.
- Imported and online laps are not analysed.
- The Consistency page and the AI coach still read every lap's full trace at once (a PL3 follow-up, untouched here).
