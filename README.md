# AC EVO Paddock

[![Support AC EVO Paddock on Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/kulyk)

Local telemetry recorder, lap analysis, AI driving coach and setup engineer, setup editor, session launcher and mod manager for **Assetto Corsa EVO**.
Everything runs on your PC. The app is served at http://localhost:8080, or runs in its own window as a desktop app.

> **Beta.** This is an early public version. Expect rough edges, and please report bugs in [Issues](../../issues).
> It is an unofficial fan project and is not affiliated with or endorsed by Kunos Simulazioni or 505 Games.

## Download (Windows)

1. Download `AC-EVO-Paddock-<version>-win64.zip` from the [latest release](../../releases).
2. Unzip it anywhere (for example `D:\AC EVO Paddock`). It's portable: there's no installer and no Node.js needed.
3. Run `AC EVO Paddock.exe`. The build isn't code-signed yet, so Windows SmartScreen may warn you: click *More info → Run anyway*.
4. Your laps and settings are stored in the `data\` folder next to the `.exe`. To update, quit the app from the tray icon, then replace everything except `data\`.
5. For the in-game HUD, see [In-game HUD](#in-game-hud-paddock-hud) below. Install it from the tray menu.

## Run from source

**Requirements:** Windows, AC EVO from Steam, Node.js 22.5 or newer (the database uses the built-in `node:sqlite`).

- Double-click `start.bat` (installs the dependencies on first run and opens the browser), or run `npm start`.
- Start AC EVO and drive. Laps are saved automatically when you cross the line.
  Out laps, laps that pass through the pits and incomplete or restarted laps are discarded. Invalid laps are kept and marked.

Try it without the game:
- `npm run seed`: adds 10 demo laps on a fictional "mock ring".
- `npm run mock`: runs the server with a simulated car driving at 4× speed.

## Desktop app

Paddock also runs as a standalone Windows app (Electron) with its own window and a tray icon.
- `npm run dist` builds it and installs or updates `..\AC EVO Paddock\` (next to the project folder). The first install creates a desktop shortcut.
  The install's `data\` folder (laps, settings, caches, `logs\paddock.log`) is never touched by updates.
  Quit the app from the tray before updating. `npm run deploy -- "D:\Other\Folder"` installs elsewhere.
- Closing the window keeps the app in the tray, so laps are still recorded. Right-click the tray icon to quit.
- The tray menu also toggles the desktop overlay (Ctrl+Shift+H hides it), installs or removes the in-game HUD,
  and opens the data folder or the log.
- `npm run app` runs the app from source, using this project's `data\`.
- The app and `npm start` use the same port (8080), so run only one of them at a time.
- Shortcuts: F5 reload, F11 full screen, Ctrl +/−/0 zoom, F12 developer tools.
- `npm run make-icon` regenerates `desktop/icon.ico` and `icon.png`.

## Race tab

Set up a session, press Start, and the Paddock HUD sets it up and starts it inside the game, the way Content Manager does for AC1.
This works with the game closed (Paddock starts it through Steam) or running. If a session is already running, Paddock asks first, then the HUD quits that session.
The in-game HUD (see below) must be installed.

- **Solo:** pick a car in the garage (filters, variants, liveries and the game's own spec sheet) and a track and layout. Then choose the session type: *Practice*, *Hotlap*, *Quick race* or *Race weekend*.
  Next set the time of day and how fast it passes, the weather (static or dynamic) and the track grip. The session lengths, race length (laps or time) and your start position are set here too, along with the AI opponents: count, strength, behaviour, and whether the game picks their cars, uses your car or uses cars you choose.
  The values and limits are the game's own. Only layouts the game offers for the chosen session type can be picked.
- **Online:** save servers (address, port, password) and join one, with the car selected in the game or one you choose.
- **Presets:** save a setup and start it again in one click.
- **Quick picks:** your recent car/track combos, started with the conditions on the page.
- **🎲 Random:** any car and track, combos you've driven, or new combos only.
- For the chosen car and track it shows your best lap, ideal lap and lap count, with a link to *Progress*.
- Progress of a start shows at the top of the tab. An order the game has not carried out within 10 minutes expires.
- Cars and tracks are read from the game's files, including mod cars from `.kspkg` packs in `Saved Games\ACE\mods`.
  The game is also asked which layouts each session type offers and which cars the AI can drive. *Update from game* re-reads both, which is only needed after a game update.

## Setups tab

The setups you save in AC EVO's own setup screen are the library. They are files in `Saved Games\ACE\Car Setups\<car>\<track>\*.carsetup`. Setups are loaded and saved in the game; Paddock reads and edits the files.

- **Track first:** choose a track and its setups come first, then the other tracks' setups.
- **Values:** every value the game's setup screen offers for the car, with its range and the game's own help text (hover). Paddock reads the car's limits from the game files, so values stay inside what the game allows and on its step grid. A few settings the game shows as clicks (e.g. some anti-roll bars) can only be changed in the game.
- **Edit:** change values and *Save as new setup…* (or *Save* over the setup). In the game, the new setup is in the setup screen's *Load* list for that car and track. Paddock writes the file the way the game does and changes only the edited numbers.
- **AI setup engineer (Gemini):** describe what the car does; the engineer looks at the setup, the car's limits and your laps with this car on this track (lap times, and where your best lap loses time against your ideal lap), and proposes a few changes with reasons and what to try on track. Tick the ones you want, put them in the values, review, and save as a new setup. Nothing is saved before that.
- **Copy to track…:** the game lists only the current track's setups; a copy goes to the other track's folder as *"name [from track]"*.
- **Rename, notes, delete:** renaming and deleting change the game's file too.
- **Share:** *Share* exports the `.carsetup` file itself, named `<car> - <track> - <name>.carsetup`, which works even without Paddock (drop it into the matching `Car Setups` folder). *Import…* puts a shared file in the right folder; if the file name doesn't say the track, you pick it.

**Typical use:** save a setup in the game's setup screen → open it in Paddock, change values or ask the AI engineer → *Save as new setup…* → in the game's setup screen, *Load* it and drive.

### Limitations

- **Loading and saving happen in the game only.** Paddock does not change the car's setup while you drive and cannot pick a setup before a Race tab launch: load it in the game's setup screen. A setup edited in Paddock while a session runs is in the game's *Load* list (the game reads the folder when it lists setups); Paddock never changes the setup the car runs right now.
- **The game lists only the current track's setups.** Use *Copy to track…* to use a setup on another track.
- **Click settings:** some cars show a few settings as clicks (e.g. anti-roll bar 1–7) but store the real value (e.g. N/m) in the file. How clicks map to values is not in the setup files, so Paddock shows these as *change in game* and does not edit them.
- **Tyre compounds** are shown as *Compound 1, 2, 3* in the game's order; the files do not store their names.
- **Names of a few settings are inferred** from the file layout, the game's own setting names and their ranges (Kunos does not document the format). Unusual settings show as *Setting x.y*. Values the game works out by itself (e.g. static ride heights) are left as they were in the file; Paddock does not recalculate them.
- **The game's format may change** with a game update; Paddock checks every write by reading the file back, and refuses to edit setups of a car whose limits it cannot find.
- **Laps are not linked to setups.** The AI engineer uses all your laps with that car on that track, whichever setup they were driven on, and mainly relies on what you tell it about the car. It cannot see tyre temperatures, pressures or suspension travel yet.
- **AI advice is a suggestion.** Check the proposed changes before saving, and try them on track; the engineer explains each change so you can judge it.

## Laps tab

- **Lap list:** per track/layout/car, with your best lap, ideal lap and every session. Filter by track or car and sort.
- **Start hotlap:** starts that car and track in Hotlap mode with clear weather and optimum grip. Progress shows on the Race tab.
- **Compare:** up to 3 laps against a reference:
  - *my best lap*,
  - *ideal lap*, stitched together from your fastest corner segments across all sessions, or
  - any lap you choose.

  Includes delta, racing-line offset, speed, throttle, brake, steering and gear charts with a synced cursor, and drag-to-zoom (double-click resets).
- **Track map:** coloured by where you gain or lose time.
- **Corner table:** brake point, minimum speed, throttle-on point, exit speed, coasting, and line at turn-in/apex/exit against the reference. Click a corner to zoom the charts to it.
- **AI coach (Google Gemini, free tier):** add an API key under *Settings*. It sends only a compact per-corner summary, never raw telemetry. To see exactly what is sent, click "what is sent to the AI?". Follow-up questions are supported, and answers are saved per lap and reference.
- **Racing line replay** (the *Racing line replay* tab on the compare page): a camera that follows the cars, with your line drawn against the reference line. It shows:
  - the real track edges from AC EVO's track data (for tracks not in the game data: the width you have used)
  - cars drawn to scale
  - an option to colour the line by inputs (brake, partial throttle, full throttle, coast)
  - two modes: *same position* (compare inputs at the same spot) or *same time* (ghost race)

  Step one sample at a time with ← → (Shift: 10 samples), or play at 0.1×–4× speed. A compact panel shows time, delta, gap, speed, gear, RPM, pedals, steering and the line offset, plus a G-force circle and a rolling input strip.
  The ▶ next to each corner in the corner table opens the replay at that corner.
- **Racing line analysis:** for each corner, how much wider (+) or tighter (−) you were than the reference at turn-in, apex and exit. The AI coach gets these numbers too.
- **Progress** (button on each track/car): one point per day you drove it. It plots the day's best lap, plus the all-time best and ideal lap as they stood that day. It also shows how repeatable the day's clean laps were (valid laps within 7 % of the day's best).
- **Consistency** (button on each track/car): a lap-time trend and the lap-to-lap spread, per corner, of time, brake point, min speed, throttle-on, exit speed and line (one dot per lap). It also lists your "focus corners", where you lose the most time against your own fastest pass through that corner. Filter by session and include invalid laps if you want.
- **Export/import:** share `.lap.gz` files with friends and compare against their laps.

## Tracks tab and track data

Paddock reads AC EVO's own track data straight from the game's `content.kspkg`. It reads the archive in place, read-only, and never extracts or modifies it. The game folder is found through Steam, or you can set it in *Settings*. For every track and layout this gives:

- **Map:** the game's own map drawing, shown on the *Tracks* tab.
- **Track model:** the real left/right edges, the AI ideal line, the pit lane, the start/finish line and the sector lines. These come from the game's timing gates.
- **Corners:** found from the track's shape, so T1, T2… are the same in every car. They're used in compare, consistency, the ideal lap, the HUD's corner deltas, the compare map (real track surface) and the replay.

Click a track to see a large map with the corner table (direction, angle, tightest radius) and your laps on that layout.

The archive format is community-documented (see the ACECM project's FORMATS.md) and was verified on game 0.9.1. If a game update changes it, Paddock falls back to finding corners from your best lap and to the used-width band. Parsed models are cached in `data/trackcache`, and the car catalogue and thumbnails in `data/carcache`.

## Game tab

- **Status:** whether AC EVO is running and its version, and whether live telemetry is coming in. Also whether the ACE UI App Loader and the Paddock HUD are installed, and whether the HUD data feed is updating.
- **Start AC EVO:** launches the game through Steam.
- Shows the progress of a start from the Race tab or *Start hotlap*, with *Cancel*.

## Mods tab

Manages the mods in `Saved Games\ACE\mods` (plus the App Loader markers in `Saved Games\ACE\Video`).

- **Install:** drop or pick a `.zip` or `.kspkg`. Zips laid out as `mods\…` or `uiresources\…`, zips of `.kspkg` packs and bare App Loader apps are detected automatically. If files already exist, you're asked before they are replaced. Installers (`.exe`) are not run; you're told to run them yourself.
- **Disable / enable:** disabling moves a mod's files to Paddock's `data\mods-disabled\` and enabling puts them back. **Delete** removes them for good.
- Mods installed by hand are grouped by name ("detected"). Rename a group, or merge it into another to fix a wrong grouping.
- The ACE UI App Loader and the Paddock HUD are marked "Required by Paddock" and need an extra confirmation to disable or delete.
- Nothing is changed while AC EVO is running: the game crashes when a file it uses disappears.

## In-game HUD (Paddock HUD)

A panel inside AC EVO, fed by this app. It shows:

- **Delta:** live delta to your **all-time best** lap (click the top line or press F8 to switch to ideal lap or session best), a bar, and a glow when you are gaining or losing right now.
- **Lap times:** predicted lap, all-time best, session best and last lap.
- **Ideal lap:** your ideal lap and how much it could gain on your best.
- **Corners:** time gained or lost in the corner you just finished, plus the next corner's reference brake (or lift) point, minimum speed and gear.
- **Brake / throttle cues:** a countdown to where the reference lap braked or lifted. After the corner it shows how many metres earlier or later you braked and got back on the throttle.
- **Track limits:** VALID, INVALID, OUTLAP, PIT, or how many tyres are out.
- **Lap saved notice,** with "NEW BEST" when you set a new all-time best.

In the loader's settings you can change the reference key, the delta bar range (0.5/1/2 s), the next-corner line, the cues and where the brake countdown starts (100/200/300 m).
The same app also runs on the game's menu, Solo and multiplayer screens, where it carries out the Race tab's starts.

Install: nothing to do. Start Paddock, then the game.
- EVO has no official app support, so the HUD runs in the community [ACE UI App Loader](https://github.com/dreasgrech/ACEUIAppLoader) (MIT). Paddock ships that loader (`mod/ACEUIAppLoader`) and installs both by itself whenever the game is closed: when Paddock starts, every 15 s while it runs, and right before Paddock starts the game. The HUD is switched on by default; to hide it, switch "Paddock HUD" off in the loader's app drawer (mouse to the right edge of the screen).
- Paddock manages the loader: any `ACEUIAppLoader.kspkg` that isn't the bundled release (normal or alternate build) is replaced, and stray copies such as `ACEUIAppLoader (1).kspkg` are deleted. Each loader release is built for one game version, so if the game version (from the newest game log) differs from the one the bundled loader is for, Paddock leaves the loader alone and the *Game* and *Mods* tabs ask you to update Paddock.
- While the game is open, a pending install waits; the *Mods* tab shows it with a red dot. A HUD removed on purpose (tray menu *Remove*, or `npm run install-mod -- --remove`), or a loader disabled or deleted in the *Mods* tab, is not put back until you install it again (Mods tab button or tray menu).
- Paddock must be running.

How Paddock and the game talk: the game's UI can't make network calls; any `http://` request fails inside the engine. So Paddock writes data files in the HUD's folder, and the HUD reads them. Race tab starts travel in the same files.
In the other direction, the HUD writes tagged lines to the game log (`Saved Games\ACE\Logs`), which Paddock follows:
- `[TrainerHUD-cmd]` for button presses,
- `[TrainerHUD-launch]` for launch progress,
- `[TrainerHUD-cat]` for game data, reassembled into `data/game-catalogue.json`.

**Important:** if the game ever fails to open one of those files (for example while Paddock is writing it), AC EVO crashes. So reading and writing are time-slotted: there are 8 files, `live0.json` … `live7.json`, and time is cut into 50 ms windows. In window *w* the HUD reads only file *w mod 8*, and only in the first 20 ms. In the same window Paddock writes only file *(w+4) mod 8*. The constants must match in `src/gamebridge.js` and `mod/trainerhud/trainerhud.js`. Never delete those files, or reinstall the HUD, while the game is running.

If the panel says **"Paddock offline"**, start Paddock; meanwhile the panel shows the game's own delta. As an alternative to the in-game panel, use the **desktop overlay**: it's built into the desktop app (tray menu), or run `npm run overlay` next to `npm start`. It is a transparent, always-on-top window, and it only works when the game runs in borderless or windowed mode. Ctrl+Shift+H hides and shows it. You can also open `http://localhost:8080/hud.html` on a second screen.

## Data

Everything lives in `data\` (for the desktop app: next to the `.exe`; `ACEVO_DATA` overrides the location):

| File / folder | Contents |
| --- | --- |
| `telemetry.db` | laps, sessions and saved AI answers (SQLite) |
| `settings.json` | driver name, Gemini key and model, coach language, game folder, port |
| `race.json` | Race tab presets, saved servers and the last setup |
| `setup-meta.json` | Setups tab notes and where each setup came from (the setups themselves are the game's files in `Saved Games\ACE\Car Setups`) |
| `game-catalogue.json`, `game-applied.json` | what the HUD read in game: track lists per session type, AI cars, the last applied settings |
| `mods.json`, `mods-disabled\`, `mod-uploads\` | Mods tab manifest, disabled mods' files, uploads in progress |
| `trackcache\`, `carcache\` | parsed track models, car catalogue and thumbnails (safe to delete) |
| `logs\`, `window.json`, `electron\` | desktop app only: log, window position, browser cache |

## Checking shared memory

The shared-memory layout comes from the community (Kunos's official document is image-only).
Open **Settings → Telemetry debug → Show live raw values** while driving, and check that these look right:
- speed
- gas and brake (0–1)
- gear
- `lapTimeMs` counting up
- `npos` going from 0 to 1 over a lap
- `x`/`z` coordinates changing

If a value looks wrong, fix its offset in the `OFFSETS` table at the top of `src/shm.js`.
`npm run check-limits [laps]` prints the track-limit channels (tyres out, wheel positions, kerbs) of the most recent laps, to check those offsets.

## Project layout

| Path | What |
| --- | --- |
| `src/server.js` | HTTP server and API, 60 Hz telemetry loop |
| `src/shm.js`, `src/mock.js` | telemetry sources: game shared memory, simulated car |
| `src/recorder.js`, `src/db.js` | turning frames into laps, storage |
| `src/analysis.js`, `src/service.js`, `src/track.js` | resampling, corners, ideal lap, compare / consistency / progress |
| `src/trackdata.js`, `src/cars.js`, `src/kspkg.js`, `src/pb.js`, `src/bc7.js` | reading tracks, cars and thumbnails from the game's archives |
| `src/live.js`, `src/gamebridge.js` | HUD data and the file/log bridge to the game |
| `src/game.js`, `src/race.js` | game status, launch orders, Race tab |
| `src/mods.js`, `src/zip.js` | Mods tab |
| `src/setups.js`, `src/carsetup.js` | Setups tab: the game's setup files, reading / writing `.carsetup` with the car's limits |
| `src/ai.js` | Gemini coach and setup engineer |
| `public/` | browser app (no build step) |
| `mod/trainerhud/` | the in-game HUD and launcher (ACE UI App Loader app) |
| `mod/ACEUIAppLoader/` | the bundled ACE UI App Loader release (unmodified zips, MIT licence, `loader.json` = loader + game version) |
| `desktop/`, `overlay/` | Electron desktop app and standalone overlay |

## Privacy

Everything stays on your PC. The only data sent anywhere goes to Google Gemini, and only when you ask the AI coach or the AI setup engineer and have added your own API key: the compact per-corner summary of a lap, or a setup's values with your description of the car and a summary of your laps on that track. Your key is stored in `data\settings.json`, which is never part of the repository or the release.

## Contributing

Bug reports, ideas and pull requests are welcome. Please open an issue first for larger changes.
`npm run seed` and `npm run mock` let you work without the game.

## Support the project

Paddock is free and open source. If it helps you find time on track, you can support its development on **[Ko-fi ☕ ko-fi.com/kulyk](https://ko-fi.com/kulyk)**. Thank you!

## Credits

- Shared-memory layout: [dSyncro/acevo-shared-memory](https://github.com/dSyncro/acevo-shared-memory).
- `content.kspkg` archive format: the ACECM project's FORMATS.md.
- In-game UI apps: the community [ACE UI App Loader](https://github.com/dreasgrech/ACEUIAppLoader) by dreasgrech (Andreas Grech), MIT licence. Its release is bundled unmodified in `mod/ACEUIAppLoader` together with its licence. The file/log bridge pattern was inspired by the EvoForge mod.

## License

[GNU General Public License v3.0 or later](LICENSE). You may use, modify and share this software. Distributed modified versions must stay open source under the same license.

*Assetto Corsa EVO* is a trademark of its respective owners. This project uses no game assets; it reads track and car data from your own game installation at runtime.
