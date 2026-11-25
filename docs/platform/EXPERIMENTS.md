# Setup experiments (PL8): rules and limits

Code: `src/experimentstats.js` (pure rules), `src/experiments.js` (lifecycle, storage, warnings), `public/experiments.js` (pages `#/experiments`, `#/experiment`), `/api/experiments` (private GET). Tests: `test/experimentstats.test.js`, `test/experiments-db.test.js`, the PL8 browser flow.

## What an experiment is

One A/B test of two setups of one car on one track layout (the game's names, as in the laps), built on the P7 setup history:

- **Setups A and B** come from this car + track only: the setups driven here (setup history, `src/setuphistory.js`) and the saved `.carsetup` files of this car for this track (the game lists setups per track). Standard (no saved setup) can be used and named. The server looks each one up again; nothing sent by the page is trusted. The hash of each file's values (the setup snapshot recipe of `src/setupmatch.js`) is stored with the experiment, and the values are kept in `setup_snapshots`, so "what differs between A and B" stays readable after the file changes.
- **Hypothesis and expected outcome:** a measure (pace, consistency, valid laps, handling) and a direction (B better, B worse, no difference), plus free text.
- **Stint plan:** ABBA (default), ABAB, ABA or AB; laps per stint (6) and warm-up laps left out at the start of each stint (1).
- **Stints:** a time window the driver starts and ends in Paddock, or a past session of this car + track. Stints never overlap: a session whose laps lie in a window, or a new window while another ends after now, is refused. Each lap belongs to one stint only: a session stint keeps its session's laps, a window takes laps of other sessions. A finished stint without laps is shown with "no laps" and does not count as driven. One running stint per car + track at a time, across experiments.
- **Journal:** created / stint / review / archive events (automatic), the driver's notes, and the values that differ between A and B at creation. **Handling feedback:** setup, corner phase (entry, mid-corner, exit), balance (understeer, neutral, oversteer), optional corner and note. Feedback is the driver's judgement; Paddock does not measure balance.
- **Lifecycle:** planned → running (first stint) → reviewed (the result saved with a decision: keep A, keep B, test again, no decision) → archived (restorable; delete removes the experiment and its journal, never laps or setup files). A reviewed experiment can be reopened (the saved result is dropped, the journal keeps a line). A **follow-up** experiment points at its parent (ancestry); saved setups record the file they were saved or copied from (`data/setup-meta.json` `basedOnRel`, since PL8), shown as "From: Base ← …".

Paddock never applies a setup to the running game: there is no verified interface. Each stint tells the driver to load the setup in the game's setup screen. Experiments never write a `.carsetup` file (tested: every file byte-identical before and after an experiment's whole lifecycle).

## Which laps count

In this order; the first reason that applies is the one shown. Every left-out lap is listed with its reason, and the counts per setup are in the result table.

| Reason | Rule |
| --- | --- |
| Warm-up | the first `warmup` laps (default 1) of each run inside a stint: a run starts with the stint, with a new session (game or Paddock restarted) and after a pause of 5 minutes or more |
| Invalid | the lap's valid flag is off (counted separately as "valid laps") |
| Game version not recorded | the lap has no recorded AC EVO version (as PL7, D-PL7-9: unknown never matches) |
| Another game version | not the experiment's version: the version when it was created, else that of its first lap with one |
| Recognised as another setup | setup recognition (pit-box readings) put the lap on another saved file than the stint's (with Standard as a variant: on the other variant's file). Not applied when the readings are marked as wrong (`setupProbe` mismatch): stints alone decide then |
| Same setup file, other values | recognised as the stint's file, but with other recorded values than at creation (the file was edited) |
| Different conditions / aids / session type | matched-condition filter (on by default): PL4 `compat.classify` of the lap against the experiment's typical conditions (median track and air temperature, the most common weather, grip, aid class and session type of the laps still in). A difference counts only when it is certain: a "similar, not confirmed" caveat (readings not checked against the game) never leaves a lap out. Unknown values are not matched and are named in the confounds |
| Slow lap | more than 3 % slower than its setup's typical lap (median of the laps still in): traffic, a mistake or an off; Paddock cannot tell which |

## What is compared

Descriptive statistics first (`src/stats.js`):

- per setup: laps in its stints, counted laps, left-out laps by reason, typical lap (median), its ~95 % interval (box-plot notch, 1.58 × IQR / √n), spread (IQR), valid laps after the warm-up, the best counted lap (shown, labelled "not used"), stints driven;
- B against A: the difference of the typical laps and the Hodges–Lehmann shift (the median of every pairwise difference).

**Result:**

| Result | When |
| --- | --- |
| Inconclusive: not enough laps | fewer than 5 counted laps for A or for B |
| Inconclusive: inside the noise | the two medians' intervals overlap, each interval taken as at least ±50 ms (identical lap times have no spread, and a 0 ms interval would make any gap significant). Said as "these laps can't tell them apart", never "the same" |
| Inconclusive: conditions not recorded | a gap beyond the noise, but more than half of A's or B's counted laps have no recorded conditions (OD-PL-46 refinement) |
| Inconclusive: one stint | a gap beyond the noise, but A or B was driven in only one stint, so the gap can't be separated from what changed between stints |
| A difference | apart, and both setups driven in at least 2 stints: "X's typical lap was … quicker … This is a difference in these laps; it suggests, but does not prove, that the setup caused it" |

**Expected outcome:** pace is "agrees" / "does not agree" only with a difference; otherwise "not decided". Consistency and valid laps are described with their lean only ("descriptive only": no reliable interval for spreads or shares at these lap counts). Handling points to the feedback table.

**Confounds, always listed** (bold when the numbers point at them): stint order (strong when one setup was driven later on average by half a stint or more: ABAB, AB), learning (Theil–Sen slope of each setup's counted laps over the experiment; strong when the drift exceeds half the gap and 50 ms), tyres and fuel (not recorded per stint), traffic (when race-session laps are in), setup recognition not checked or marked wrong, matched conditions off or values not recorded.

## Warnings

- A setup file renamed, deleted or not readable (car limits unknown): said; laps recognised as another file are left out.
- A file's values changed since creation: laps on the new values are left out; a follow-up experiment tests them.
- **Patch-aware:** the game version now differs from the experiment's: laps on the new version are left out, and the page suggests a follow-up on the new version. Laps on another version are counted in the warning.
- After review the saved result is shown; when the laps changed since (a lap deleted), the page says so.

## Limits and what is not verified

- Thresholds (5 laps, 2 stints, 3 %, 1 warm-up lap, 5-minute run gap, ±50 ms interval floor, 50 ms learning drift) are set on synthetic laps only; not checked against real AC EVO stints (no game here).
- Fuel load, tyre wear and traffic are not observable per lap; only stated.
- Setup recognition and temperature readings may be unconfirmed (PL4); their status is respected as in Compare.
- Experiments read lap rows only (no traces); one car + track's rows per page load.
