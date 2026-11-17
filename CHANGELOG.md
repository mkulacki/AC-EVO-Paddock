# Changelog

All notable changes to AC EVO Paddock. Newest first.

## Unreleased

Changes merged to `main` that are not in a release yet. Move them under a version heading when the next release is cut.

### Honest data: what is measured and what is not

- Every reading now says where it comes from: **Measured** (checked against the game), **Unconfirmed** (read from shared memory, not checked yet), **Calculated**, **AI**, **Not available**.
- **Setups → Setup recognition → Checked against the game:** confirm each group separately (pit-box readings, temperatures, tyres, brakes, suspension) instead of one switch. An earlier "Readings match the game" still counts for the pit-box readings and temperatures.
- **Car & setup:** suggestions based on readings you have not checked are listed apart, under *Unconfirmed hints*, instead of as advice. Balance (understeer / oversteer) comes from slip angles, which the game does not show, so it is shown as an unconfirmed reading.
- **AI coach, debrief and setup engineer** now rate their confidence (high, medium, low) and say what it rests on; they are told which readings are not checked and must not state them as facts.

### Development

- Automated tests: `npm test` (unit tests and an API smoke test with the mock car) and `npm run check` (syntax). See README, Contributing.

## 0.5.0-beta.1

### New: Car & setup report

- Paddock now records tyre temperatures (inner, middle, outer and core), hot pressures, brake temperatures and lock-ups, suspension travel, ride height and slip angles with every lap, 10 times a second.
- A **Car & setup** tab on the session page: the four tyres with their tread temperatures, pressures, brakes and suspension; balance (understeer / oversteer) at corner entry, mid-corner and exit; wheelspin; a lap-by-lap table; and setup suggestions such as camber, pressures, brake bias, springs, anti-roll bars.
- The AI engineer in Setups gets the same data for the latest session on that track.
- The readings are not confirmed in game yet: **Setups → Setup recognition** shows them live to compare with the game's tyre screen.

### New: session reports

- After every session of 3 laps or more, a report: best lap and session average, change against the previous session and your all-time best, three best and three weakest corners (with what differs from your best pass), consistency, setup used, conditions, and next practice targets.
- Also: lap-time trend chart, theoretical best of the session, where laps went invalid, a check of the previous report's targets, and an AI debrief on request (Gemini).
- **Telemetry on the session page**, in a new layout also used by Compare: your lap (the session best by default) against the ideal lap, picked from drop-down menus; a "where the time went" bar per corner; click a corner to zoom the charts and the map (both lines and brake points shown) and read what was different at entry, apex and exit; one cursor across the charts and the map; throttle and brake in one chart. The session's laps are in a folded table below.
- A Windows notification when it is ready (desktop app); the **Laps** tab is now **Sessions**: one row per session with its summary (best lap and change or new PB, average, consistency, laps, setup, weakest corners), listed *By track & car* or *By date*. Click a session to open it: the full report and that session's laps (compare, export, delete). Sessions under 3 laps open with the basics and their laps. Older sessions get a report on request.
- **Every lap now remembers its setup.** Paddock recognises the setup from a fingerprint taken in the pit box (pressures, camber, brake bias, fuel) and matches it with your saved setups; no match is called *Standard*. It can be corrected in the report. The readings still need a one-time check in game: **Setups → Setup recognition**.

### New: brake spotter (audio)

- A voice or beeps count down to each braking point while you drive: "three, two, one, brake", or "lift" where the reference lap only lifted. Suggested in [#3](https://github.com/mkulacki/AC-EVO-Paddock/issues/3), so you can keep your eyes on the road. It also works in VR.
- It uses the braking points of the HUD's reference lap (all-time best by default). The countdown is in seconds from your current speed.
- Settings → Brake spotter: on/off (off by default), sound (two calm team-radio voices, Orus and Algenib, or beeps), full countdown or only "brake", every point or big stops only, volume, timing (±500 ms), and a Test button.
- Sound plays from Paddock on the default audio device, also while the desktop app is in the tray.
- The voice clips were generated with Gemini text-to-speech, with a team-radio effect, and ship with the app (`src/tools/make-spotter-clips.js` remakes them).

### New: your own brake points

- Set brake points yourself, per track and car, and have the spotter and the HUD's "brake in N m" count down only to those (Settings → Brake spotter → Count down to → My brake points).
- **Mark them while driving** with a wheel or button-box button (works in game and in VR) or a keyboard shortcut (desktop app). Set it by pressing it in Settings. Each press beeps, and a press near a point moves it.
- **Record them from your braking:** drive one lap and every braking point becomes a brake point.
- **Edit them on the track map** (Tracks → a track → Brake points): drag, add, delete, brake or lift, or fill from your best lap. Changes made in the game show up on the page straight away.

### Fixes

- **Game files folder found when Saved Games was moved or renamed** ([#3](https://github.com/mkulacki/AC-EVO-Paddock/issues/3)). Paddock used to assume `<user>\Saved Games\ACE`. It now asks Windows where Saved Games really is, so a moved folder like `I:\JMC\Parties enregistrées\ACE` is found. This affected installing the HUD, mods, setups and in-game features.
- New setting **Game files folder** to enter that folder by hand if needed. It accepts either the `ACE` folder or the Saved Games folder that contains it. The Settings page shows which folder is in use and warns if it doesn't exist. Changing it needs a restart, and the page offers a "Restart now" button.

### Design pass on the desktop app

- **New look:** a new colour palette with light and dark themes. Lap-time colours are now consistent: purple for best, green for session best, yellow for slow, blue for faster and red for slower. The accent colour is lime green, and the Mods tab has its own teal.
- **Fonts work offline:** the Barlow and Barlow Condensed typefaces are now bundled with the app (`@fontsource`) and no longer load from Google Fonts.
- **Laps list:**
  - Click any lap row to compare it with your best lap. Click the best lap to compare it with the ideal lap.
  - New "Session best" badge marks the fastest valid lap of each session.
  - The Driver column only shows when laps from more than one driver are listed.
  - Session headings read like "Practice on Sat 14 Nov 2026, 12:30, 8 laps".
  - The car/track actions are in their own row: Start hotlap is now the main button, and Compare selected sits with the reference picker.
  - The global "Remove invalid laps" button above the list was removed. The per car and track "Remove invalid laps" button stays.
  - "vs best" was removed from each row (clicking the row does that) and "vs ideal" became "Ideal".
- **Compare view:** clearer chart titles with units shown as a subtitle (for example "Gap to reference, in seconds, rising means losing time"), and a cleaner "The ideal lap joins your best sectors" panel.
- **Status bar:** the game status is in plain words ("AC EVO isn't running", "AC EVO is in the menus", "On track", "Watching a replay"). When recording it shows "Recording <car> at <track>, <time>".
- **Restart Paddock** moved from the "Developer: restart" header button to a card on the Settings page.
- **Wording:** text across the app (Laps, Compare, Consistency, Progress, Tracks, Garage, Setups, Race, Mods, Game, Settings) now uses plain sentences instead of `·` separators and shorthand like "vs", "+ =" and "−". Badges are capitalised ("Best", "Off", "Detected", "Imported").
- Gemini models in Settings are listed by name with the model ID in brackets.
- **Running from source:** `start.bat` now runs `npm install` again whenever `package-lock.json` changes, not only on first run. If you start Paddock by hand, run `npm install` once after updating so you get the new font packages. Release zip users don't need to do anything.
- Accessibility: added labels to icon-only buttons (export, delete) and to the lap selection checkboxes.

## 0.4.0-beta.1

- Paddock HUD redesign: broadcast-style top strip, every part selectable.

## 0.3.0-beta.1

- ACE UI App Loader is bundled and managed automatically.
