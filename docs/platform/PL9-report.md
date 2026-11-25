# PL9 report: HUD and live assistance

- **Date:** 2026-11-25 · **Branch:** `platform/pl9-hud-live` (from `9bab779`, the PL8 merge) · not pushed, not merged.
- **Scope:** `docs/platform/BACKLOG.md` (PL9): configurable HUD layouts and context profiles, telemetry freshness and
  quality labels, cues with cooldowns and configurable timing, optional post-lap summary, a live consistency indicator
  only as far as PL6 supports it, one immediate switch for the HUD and every cue, and an audit of the bridge protocol
  and its recovery with stress tests. Never more assistance by default; protocol and protocol names unchanged.
- **In-game behaviour cannot be verified here** (no AC EVO on this machine in this run; the user's own Paddock was
  running and was not touched). Nothing in this phase is a claim that the HUD or the bridge cannot crash the game.

## What changed

| Commit | What |
| --- | --- |
| `1e2ae79` | `src/settings.js`: HUD parts `summary` and `consistency` (off by default), `hud.cueHoldMs` (2–10 s, 6 s), built-in layouts (`HUD_PRESETS`), `hudLayouts` (saved layouts, context profiles, normalised), `assistOff`, `assistKey`, spotter `cooldownMs` (0–3 s, 0). `src/spotter.js`: quiet time and `blocked()` (kill switch, stale telemetry), counters. New `src/assist.js` (kill switch: in memory first, then saved; `gate()` of the HUD payload) and `src/hudlayouts.js` (save, apply, delete, context profiles) |
| `1138f6e` | `src/live.js`: `freshness()` (telemetry stale after 500 ms without a new packet), `q` in the HUD payload (`tel`, `telAgeMs`, `delta`), an impossible delta is not sent, no `cue` / `ahead` from stale telemetry, cue result time from the setting, post-lap summary (`summary`), lap-time spread (`lapConsistency`, PL6 minimum and confidence words) |
| `7b11e0b` | `src/gamebridge.js`: writer and log-reader counters (`stats()`), slow-write back-off (60 ms → 1 s pause), injectable clock / writer / folders for tests; `src/health.js` and `src/diagnostics.js` show them and the kill switch |
| `23ea295` | `src/server.js`: `/api/assist`, `/api/hudlayouts`, the gated HUD payload (also for the overlay and `/api/hud/ref`), the spotter blocked while off or stale, context profiles applied on a new session (outside the tick), `packetAt`, the optional global shortcut |
| `1b85227` | `mod/trainerhud` **0.15.0**: hides on `off`, quality chip ("DATA 1.4 s OLD", "TELEMETRY STALE", "DELTA N/A"), dimmed numbers and no countdown / extrapolation from stale data, summary and spread chips, the two parts in the in-game settings window (off by default) |
| `8834b7c` | Pages: the sidebar switch, Alt+Q, Ctrl+K command, the shortcut list (`public/assist.js`, `public/palette.js`); Settings: layouts, context profiles, cue result time, spotter quiet time, the switch and its global shortcut; tray checkbox (`desktop/main.cjs`) |
| `638969e` | Fix: saving a layout answered with the list from before the save (found by the browser flow) |
| `90d17c4` | Tests: `test/hud-live.test.js` (16), `test/hud-bridge.test.js` (5), two browser flows |
| `ba69ec1` | this report, `docs/platform/HUD_BRIDGE.md`, DECISIONS, PHASE_LOG, DEVELOPMENT_STATE, CHANGELOG, FEATURE_INVENTORY, BACKLOG |

## Verified findings / rejected assumptions / unresolved

- **Verified:** the HUD already had configurable parts, size and opacity synced with the in-game settings window
  (`mod/trainerhud/trainerhud.js` `settingsFromPaddock` / `settingChanged`, `src/server.js` `runCommand` `hud`): layouts
  build on that one copy instead of adding a second mechanism.
- **Verified:** no freshness label existed. The HUD only switched to "Paddock offline" after 3 s
  (`readSlot`), and between reads it extrapolated the countdown up to 1 s and the delta up to 0.4 s from whatever it
  had; the server ended a session after 3 s of an unchanged packet id (`src/server.js` loop) but sent cues until then.
- **Verified:** scheduling stalls cannot break the slot discipline: `write()` works out the window it runs in, so the
  ≥150 ms margin is there again after any stall (simulation: 0 collisions in 3 × 120 s with stalls up to 2 s).
- **Verified:** the only collision path is one slot write slower than the margin (simulation: 23 collisions, all from
  writes that took over 150 ms). It cannot be stopped once started; the new back-off stops it from repeating.
- **Unresolved (static only):** a backwards system-clock step makes the HUD stop reading files until its page reloads
  (`slotUnsafe`); kept as it is, it is a crash guard. A log rewritten in place to the same or larger size is not
  noticed by the tail (size-based offset); the game writes a new log file per run.
- **Rejected:** a live per-corner consistency indicator: PL6's corner thresholds are tuned on synthetic laps only.
  Only the lap-time spread (PL6's 5-sample minimum, IQR, confidence words) was built, off by default (OD-PL-56).
- **Bug found and fixed:** `POST /api/hudlayouts {action: 'save'}` built its answer before saving (`638969e`).

## Tests (before → after)

- `npm run check`: 149/149 → **154/154**
- `npm test` (Node 22.23.4): 397/397 → **418/418**
- `npm run test:electron` (Node 24.22.2): 397/397 → **418/418**
- `npm run test:browser` (headless Edge): 24/24 → **26/26**
- New: spotter defaults identical to before and cooldown only dropping words; blocked spotter (kill switch, stale);
  freshness and invalid-delta labels on the server and in the HUD; post-lap summary and spread only when switched on;
  kill switch gate, persistence and toggling; layouts and context profiles; HUD 0.15.0 constants and parts; bridge
  stalls, slow disk, real files with a reader thread, folder appearing, failed writes, log rotation / cut-back /
  partial lines / duplicates / stale commands; browser: Alt+Q, Ctrl+K, Settings switch, cross-site refusal, layouts,
  profiles, cue and quiet-time settings.
- Stress results: `docs/platform/HUD_BRIDGE.md` §5 (updated after the review round below).

## Checks that could not run

- Anything in AC EVO: the 0.15.0 HUD in Gameface (hiding on the kill switch, the new chips, the parts in the loader's
  settings window), real slot read timing, real write times on the user's disk and antivirus.
- `npm run smoke:packaged` and `npm run bench`: port 8080 is used by the user's running Paddock; the 60 Hz loop gained
  only O(1) work per tick (a timestamp, the spotter's blocked check), so the bench was not rerun.
- The tray checkbox and the global shortcut (desktop app only; syntax-checked, not run).

## Performance and compatibility

- 60 Hz loop: one assignment and one boolean check per tick. The HUD payload (20 Hz) gains `q` (~60 bytes); summary and
  spread only when their parts are on (the spread sorts at most 200 numbers).
- Old HUDs (≤ 0.14.0) ignore the new fields; with the kill switch on they show an empty strip with no cue (D-PL9-4).
  Paddock installs 0.15.0 the next time AC EVO is closed. Aids / assists checks made with 0.14.0 must be confirmed again
  (OD-PL-13 (a), D-PL9-5).
- Defaults keep today's behaviour: same parts, cue result 6 s, spotter quiet time 0, no context profile, switch on.

## Migration and recovery

No database change. New `settings.json` keys (`assistOff`, `assistKey`, `hudLayouts`, `hud.cueHoldMs`,
`spotter.cooldownMs`) are normalised on read; an older Paddock keeps unknown keys. Recovery: Settings → Paddock HUD
"Reset to defaults"; the switch from any of its places; deleting `hudLayouts` from `settings.json` drops saved layouts.

## Needs approval

- Push and merge of `platform/pl9-hud-live`; a release would ship HUD 0.15.0 to players (installed with the game
  closed). Nothing was pushed, deployed or published.

## Open decisions (added to DECISIONS.md)

OD-PL-54 … 63, all OPEN (operator), recommended default applied, user reviews in the app: context profiles off;
post-lap summary off; lap-time spread off and lap times only; kill switch survives restarts; built-in layouts
Default / Minimal / Race; stale after 500 ms (telemetry) and 1 s (HUD data); slow-write back-off 60 ms → 1 s; switch
by sidebar, Alt+Q, Ctrl+K, Settings, tray, optional global shortcut, no in-game key; spotter quiet time 0–3 s, default
0; cue result 2–10 s, default 6 s. Made without asking: D-PL9-1 … 9.

## Remaining risks

- The in-game HUD 0.15.0 is untested in AC EVO; a rendering problem there would show as a wrong or missing chip, and
  the kill switch hide relies on hiding the root's children (the loader's own display handling is not known).
- A single slow write can still overlap a read; the back-off limits repeats only. Worker-thread reads are not the
  game's resource loader.
- Staleness thresholds are not tuned against real AC EVO packet rates (if the game updates its packet id less often
  than every 500 ms while driving, "TELEMETRY STALE" would flicker; not expected).
- Context profiles overwrite the current look when a session starts (opt-in, says so in Settings).

## Review round (2026-11-25)

Independent review; fixes in `f2d4e9f`, `eee30ee`, `d5da044`, regression tests in `31285e9`. HUD stays 0.15.0 (unreleased; read rules unchanged).

| # | Finding | Fix | Regression test |
| --- | --- | --- | --- |
| 1 | The back-off paused after any write over 60 ms: a steady 70 ms disk got 55 writes a minute, 69 % of HUD reads over 1 s old, 29 % over 3 s; after the kill switch some slots kept the old state for seconds (the HUD flickered) | back off only when a write ends < 30 ms before its read window; write slot w+5 when it is behind (old switch/look state, or 9 windows unwritten); the HUD keeps the newer copy (OD-PL-60 refinement, D-PL9-10) | hud-bridge: 70 ms fresh (0 % over 1 s), kill switch reaches every slot (70 / 200 ms), no flicker, steady schedule unchanged |
| 2 | Reference-pedal markers were still moved along with the car from stale data | hidden when the data is stale (D-PL9-11) | hud-live static check |
| 3 | `/api/hudlayouts` got the HUD's open CORS header (cross-site GET 200) | exact HUD paths only; hudlayouts and assist are private GETs (D-PL9-12) | browser flow |
| 4 | `constructor` / `toString` were accepted as built-in layouts and reset the look | own keys only, 404 | hud-live |
| 5 | The pause used the wall clock (a step back stretched it) | monotonic clock | hud-bridge |

Tests after the round: check 154/154, test 426/426 (Node 22 and 24), test:browser 26/26. Stress numbers in `docs/platform/HUD_BRIDGE.md` §5 are from after the fixes.

## Recommended next phase

PL10 (leaderboard integrity, code only; community features as a design doc). Before it, the user drives once with
0.15.0 installed: Integration health shows the bridge counters, and the kill switch / labels can be checked in game.
