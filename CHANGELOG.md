# Changelog

All notable changes to AC EVO Paddock. Newest first.

## Unreleased

Changes merged to `main` that are not in a release yet. Move them under a version heading when the next release is cut.

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
- **Restart Paddock** moved from the "Developer: restart" header button to a card on the Game page.
- **Wording:** text across the app (Laps, Compare, Consistency, Progress, Tracks, Garage, Setups, Race, Mods, Game, Settings) now uses plain sentences instead of `·` separators and shorthand like "vs", "+ =" and "−". Badges are capitalised ("Best", "Off", "Detected", "Imported").
- Gemini models in Settings are listed by name with the model ID in brackets.
- Accessibility: added labels to icon-only buttons (export, delete) and to the lap selection checkboxes.

## 0.4.0-beta.1

- Paddock HUD redesign: broadcast-style top strip, every part selectable.

## 0.3.0-beta.1

- ACE UI App Loader is bundled and managed automatically.
