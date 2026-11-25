# Changelog

All notable changes to AC EVO Paddock. Newest first.

## Unreleased

### Lap analysis (platform phase PL6)

- **Lap analysis** page for every car and track (Sessions → **Analysis**, the Consistency page, or Ctrl+K "analysis"): where your time is, worked out from your own valid laps without AI. The three biggest opportunities come first, each readable on its own: how much a lap you can gain by driving the corner as you already do in 1 pass out of 4, whether it goes on the entry, around the apex or on the exit, what your quicker passes did differently (braking point, brake release, speed at the apex, throttle, hesitation on the throttle, exit speed, gear), kept apart from what that may mean, and links to Compare at that corner.
- Every corner's spread of times, a **repeatable target lap** next to the ideal lap, what made your **personal best** faster than the one before, and the trend **across sessions**. Nothing is concluded from fewer than 5 passes of a corner; each number shows how many laps it rests on, and differences are labelled as associations, not proven causes. Laps that cannot be compared with your newest one are left out and listed; mixed game versions, setups or aids are labelled, and you can keep only laps of the same game version or setup.
- The Consistency page's technique table has a new column, **Throttle hesitation**.

### Onboarding and usability (platform phase PL5)

- **Setup guide** (`#/welcome`): find AC EVO, check the connections, read what stays on your computer and what is optional (AI, online leaderboards, game mods: each can be skipped; skipping switches nothing on or off), drive a first session and open a first comparison. It never opens by itself: Home (before your first lap), Settings and Ctrl+K ("setup guide") offer it. Skipping game mods there tells Paddock not to install or update the HUD and App Loader in the game folder; **Settings → In-game HUD** turns that on or off at any time (on, as before, unless you change it).
- **Home** starts with your last session (with its tags and note), your practice objective (an open goal, training plan or report targets for that car and track) and one **next step** with the numbers behind it ("Why: your ideal lap is 0.51 s faster than your best…"). A line shows new personal bests of the last 30 days.
- **Session notes, tags and corner bookmarks** on every session page: what you noticed, short tags (Sessions can be filtered by one, Ctrl+K finds them) and corners to work on, listed again on later sessions with that car and track. They stay on this computer: never uploaded, not sent to the AI, not in lap files; Settings backups include them. The database is upgraded once (schema v2, new tables only); a copy of the old file is kept as `telemetry.backup-v1-<time>.db`, and Paddock 0.7 can still open the upgraded file. Deleting the last lap of a session deletes its notes, tags and bookmarks too. A laps database made by a newer Paddock is left untouched and recording is switched off; Home, Integration health and the sidebar say so and ask you to install that newer Paddock.
- **Easier to read and use by keyboard:** muted text and the light theme's timing colours have more contrast; fields show a focus ring; Ctrl + / Ctrl − / Ctrl 0 resize text (listed under `?`); pages without data say what to do next.

### Data safety (platform phase PL1)

- **Backups never hold your leaderboard sign-in** (the Steam login token and who it belongs to), not even with "include secrets". Restoring settings from a backup keeps the sign-in this install has, so you stay signed in. An older backup that still holds a sign-in restores without it.
- **A restore never loses a key or password:** your current Gemini key and server passwords always win over the backup's; the backup only fills in empty ones, and saved servers (and presets with a password) missing from the backup are kept. A current settings or Race tab file saved by Notepad (with a BOM) is read correctly; a damaged one is kept aside as `<name>.unreadable-<time>` before the restore, never silently dropped.
- **The backup made before a restore holds no secrets** (no Gemini key, server passwords or sign-in). Undoing a restore with it keeps the key, passwords and sign-in you have at that moment.
- **Diagnostics** also take out the leaderboard token and your Steam name.
- **Settings, Race tab servers and setup notes are saved safely:** written to a temporary file first, so a crash never leaves half a file. A damaged file is no longer silently replaced by defaults: it is kept next to it as `<name>.unreadable-<time>`, and the Settings page says which file it was, where the copy is and how to get its contents back (also when a file could not be read at all and saving it is refused, and then Save is switched off). The notice can be dismissed, or the damaged copy deleted from the page.
- **Lap import is checked:** a file is read within size limits, every value is checked, and a bad file gets a plain message instead of an error 500. Importing a lap that is already there is refused and names the lap you have. Exported laps no longer carry your leaderboard data (Steam id, rank).
- **Mods:** an install that fails midway puts back the files it was replacing. Zips with file names Windows reserves (`CON`, `aux.txt`, names ending in a dot) are refused.
- **Backups and mod zips** are never unpacked beyond the size they state. A backup whose database holds triggers or views (Paddock never makes them) is not restored.
- Downloads of private data (backups, lap and CSV exports, diagnostics, setups) are refused when another website asks for them.

### Compatibility and provenance (platform phase PL4)

- **Telemetry checks remember the game version.** A group you checked against the game (Setups → Setup recognition) counts only on the AC EVO version, and with the Paddock reader, it was checked with. After a game update, or a Paddock HUD update for the driving aids, Paddock asks you to check again (one click: **Still matches**). Suspension and driving-aid checks count for the car you checked them with. **Checks made with an older Paddock no longer count** until you confirm them once more, because the game version was not recorded then. A "doesn't match" stays until you undo it. While Paddock does not know the game version (AC EVO not started on this PC yet), or for the driving aids while the HUD is not installed, "Matches the game" is switched off with the reason. Going back to Paddock 0.7 shows these checks as not checked.
- **Compare tells you when laps are not like for like:** another game version, another setup (or the same file with changed values), track temperature more than 5 °C apart, other weather or grip, other driving aids, another session type, or something not recorded for one of the laps. Each point says what it changes. Temperatures and aids that look the same count as the same only once you have checked those readings against the game; until then one line says "Some readings aren't confirmed yet", with a link to where you confirm them. A lap of another car or track layout is not shown, on the Telemetry or the Racing line replay tab, until you choose **Compare anyway**. Consistency and Progress note when their laps were recorded on different game versions, setups or aids. Exported lap files carry the shared-memory reader revision with the lap's conditions.
- **Integration health** on the Game page (also Ctrl+K → "Integration health"): game connection, telemetry freshness, recording, Paddock HUD and App Loader, telemetry checks and online services, each with what to do. It uses only what Paddock already knows, sends nothing, and shows error texts without folder paths.
- The AI coach, debrief and setup engineer no longer get setup names or temperatures (also in the per-setup history) you marked as not matching the game. The replay's G-force circle is labelled unconfirmed (the game shows no G values to check against).

### Recording reliability (platform phase PL3)

- **Recording no longer pauses with a long lap history.** With hundreds of laps on a car and track, Paddock used to stop reading telemetry for seconds at the start of a session and, past 300 laps, after every lap (it re-read the whole history for the HUD's reference laps). Opening the Laps or Home page for the first time stopped it for up to half a minute with thousands of laps. That work now runs in small slices, so laps keep recording; the results are the same. The HUD keeps its references while new ones are worked out, or shows none for a moment on a new car or track.
- **Diagnostics show recording timing:** how regularly the 60 Hz loop ran, late ticks, stalls, slow pages and memory (numbers only).
- For contributors: `npm run bench` measures recording and history performance on the mock car (`docs/platform/PERFORMANCE.md`).

### Quality checks (platform phase PL2)

- For contributors: `npm run verify` runs the syntax check, the tests on your Node and on the desktop app's own Node, and browser tests of the main pages in headless Edge. A GitHub workflow is set up to run the same on every push. `npm run smoke:packaged` starts a built app once with scratch folders.
- Requirements corrected: running from source needs Node.js 22.13 or newer.
- Leaderboard: the background sending now runs on timers Paddock can stop (found through a test that failed now and then); what is sent, and when, is unchanged.

## 0.7.0-beta.1

### New: online leaderboards

- **Leaderboards** page (sidebar): lap times of every Paddock driver, per track, layout and car, with sector times, air and track temperature and the game version. Filter by game version and temperature.
- **Class boards** for GT3, GT4 and GT2: every car of the class on one board.
- **Sign in with Steam** to send laps (your name on the board is your Steam name; your password goes to Steam only). Sending is **off until you switch it on**, and then only your best valid lap per track, layout and car goes up, automatically after each lap or with *Send now*.
- **Compare with another driver:** laps carry light telemetry (speed, pedals, steering, gear, line), so any lap on the board opens in Compare next to yours.
- **Driver profiles:** every board a driver is on, with their place, wins and podiums.
- **Leaderboard target in the HUD:** a chip with the driver just ahead of you (or P1), the predicted gap to their time and your split after each sector.
- **Leaderboard window in game** (Paddock HUD 0.14.0): a separate small window next to the strip with P1–P3, the two drivers above you, you and the two below. Next to you it shows the gap to your time; a lap you drove but did not send yet already counts. Drag it on its own; switch it off under Settings > Paddock HUD.
- **Place changes:** a notice when someone goes past you, and a *Leaderboard changes* card on Home with places lost, places gained and new boards.
- Report a lap that looks wrong; moderators can hide it.

### New: Cars page

- Every car you drove: distance, time, laps, your record on each track, top speed, driving style, milestones and a few fun facts. *Drive it* opens the Race tab with that car.

### Improvements

- **Theme:** System, Dark or Light, under Settings (System follows Windows).
- **Setups:** each car's stock setups from the game are listed as *Game default*, and you can open, change and save them as your own.
- **Home:** a *Beat it* button on each record starts a practice session on that car and track straight away.
- **Telemetry:** an *Ideal line* toggle on the track map shows the game's own line (remembered); darker track edges.
- **Race:** a *Random conditions* checkbox next to Random (unticked keeps your conditions). One-click starts are a 90-minute Practice, because the game menu has no Hotlap.
- **Car & setup:** *Ask the AI engineer* opens the session's setup (or the car's game default) straight in the engineer.
- **Backups:** choose what a backup holds, with the size of each part; a restore brings back only what the backup holds.
- A Ko-fi link in the sidebar, for anyone who wants to support Paddock.

### Fixes

- Setup recognition: the right-hand wheels' camber is read with the correct sign.
- Paddock HUD: a restart in the game starts a fresh lap for the driving aids.

## 0.6.0-beta.1

### New: back to Paddock when the game closes

- When you close AC EVO, Paddock comes to the front on the session you just drove (its telemetry, report and laps). Nothing opens if no laps were saved while the game was open. Turn it off in Settings (*When the game closes*).
- Session and Compare pages: a bigger track map next to slightly narrower telemetry. A see-through race car icon, pointing the way you drive, always shows on the map (where the cursor last was), and **+ / −** zoom the map in up to 8×, following the car as you move along the charts.
- Telemetry: tick which charts to show (gap, speed, pedals, steering, gear, RPM, racing line) at the top of the card. Paddock remembers the choice.

### New: goals, challenges, achievements and race weekends

- **Development** page (sidebar, after Sessions): your goals and challenges, challenges suggested from your laps, a session planner, your achievements and your race weekends.
- **Goals** for each track and car: a lap time, laps close to a time in one session, valid laps in a row, or a consistency score. Paddock checks them against every lap you drive after setting one and tells you when one is met. A **challenge** is a goal with a deadline; Paddock suggests a few from your last 30 days of laps (and your training plan's lap target).
- **Achievements:** 28 milestones (laps, distance, variety, driving days, personal bests, clean runs, long stints, consistency, goals, race weekends), each with the day you reached it; locked ones show how far you are. Home shows the latest.
- **Session planner:** pick a car and track you drove, a goal and a Race tab preset (or hotlap / practice), and Paddock starts it in AC EVO.
- **Race weekend history:** race weekends started from Paddock, with the sessions you drove in them and their best laps.

### New: AI coach per track and car

- **Coach** page for each track and car (the *Coach* button on Sessions, or Ctrl K "coach …"): ask questions about your driving there. The coach gets a summary of your laps, session reports, driving style, setups and training plan; *What is sent to the AI?* shows it in full. Every answer rates its confidence. The chat is kept per track and car.
- **Training plan:** make a report's targets your plan (*Make these my training plan* on the report, or *Use as plan* on the Coach page). Every later session there is checked against it automatically: met or not met per session, on the Coach page and in each report.
- **AI braking points:** the coach suggests where to brake in each corner from your fastest and typical passes. Paddock checks each point (inside the corner, at most 15 m later than your fastest pass) and nothing changes until you tick points and apply them to your brake marks.
- Clearer AI errors: no key, no internet, and Gemini's free-tier limit each say what to do.

### New: setup history

- **Setup history** for each track and car: every setup you drove, each version of an edited setup apart, with its best and typical lap, spread, sessions and conditions.
- **Compare two setups:** lap times side by side, and exactly which values differ.
- The **AI setup engineer** now gets your laps split by setup, with the one it is working on marked.

### New: driving technique

- **Consistency** shows a **performance score** (pace, consistency and valid laps, with its formula), **corner rankings** (fastest, middle and slowest pass of every corner, with links) and a **driving technique** table: brake application, trail braking, brake release, apex to full throttle, throttle re-lifts, steering reversals and corrections, coasting. Each metric has its definition on hover.
- **Session report:** a **driving style** section compares your typical pass of each corner with your fastest one and names the habits that cost time. Older reports get it with *Regenerate*.
- **Telemetry:** the track map can show your **inputs** (braking, coasting, throttle) instead of where you gain and lose.
- **Home:** your records show the performance score of your last 10 laps.

### Honest data: what is measured and what is not

- Every reading now says where it comes from: **Measured** (checked against the game), **Unconfirmed** (read from shared memory, not checked yet), **Calculated**, **AI**, **Not available**.
- **Setups → Setup recognition → Checked against the game:** confirm each group separately (pit-box readings, temperatures, tyres, brakes, suspension) instead of one switch. An earlier "Readings match the game" still counts for the pit-box readings and temperatures.
- **Car & setup:** suggestions based on readings you have not checked are listed apart, under *Unconfirmed hints*, instead of as advice. Balance (understeer / oversteer) comes from slip angles, which the game does not show, so it is shown as an unconfirmed reading.
- **AI coach, debrief and setup engineer** now rate their confidence (high, medium, low) and say what it rests on; they are told which readings are not checked and must not state them as facts.

### New: backup, export, diagnostics, update check (Settings)

- **Backup and restore:** one zip with your laps, sessions, reports, brake points, AI answers, presets and settings (without your Gemini key and server passwords unless you ask). Restoring backs up your current data first and restarts Paddock.
- **Export** laps and sessions as CSV.
- **Diagnostics** to paste into a bug report, with private data taken out.
- **Update check:** once a day Paddock asks GitHub whether a newer version is out and shows a link. Nothing is downloaded. It can be switched off.

### New: Home

- Paddock opens on **Home**: what needs attention (HUD update waiting, readings not checked in game, no Gemini key, a newer Paddock…), your totals, recent sessions, the next practice targets from your latest reports, your best lap per day for the cars and tracks you drive most, and your records with the ideal lap. Everything comes from your own laps; nothing is estimated.
- Sessions is still one click away (and at the same address).

### New look: sidebar and search

- The pages are in a **sidebar** now (it collapses to icons with Ctrl+B, and by itself in narrow windows). The lime accent stays.
- **Search and commands (Ctrl+K):** pages, Settings sections, tracks, sessions, your car and track combos, cars with setups.
- **Keyboard shortcuts:** ? lists them; Alt+1…9 open the pages in sidebar order.
- Every page shows the same loading bar, and a clear message with *Try again* when something fails. Consistency without valid laps now says so instead of showing an error.

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
