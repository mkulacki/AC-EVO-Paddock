# CLAUDE.md: AC EVO Paddock

Notes for Claude Code sessions on this repo. The README covers features and architecture; this file covers **how to cut a release** and what must never be published.

- Repo: https://github.com/mkulacki/AC-EVO-Paddock (public, GPL-3.0-or-later)
- First release: `v0.1.0-beta.1` (2026-11-11), a GitHub **pre-release** with a portable win64 zip.

## Never publish

- `data/` holds laps (`telemetry.db`), `settings.json` (the user's **Gemini API key** and driver name), `race.json` (saved online server **passwords**) and caches. It is gitignored. Never force-add it, and never let it end up inside `dist/` or the release zip.
- `node_modules/`, `dist/`, `release/`, `*.log`, `.env*`, `.vscode/` and `.claude/` are gitignored too.
- Commits use the GitHub noreply email `5887982+mkulacki@users.noreply.github.com` (set in the repo-local git config). Never use a personal email.

## Names to keep (protocol IDs)

The app was renamed from "AC EVO Trainer" to **AC EVO Paddock**, but these identifiers stay, so installed HUDs and old exports keep working:
`trainerhud` (mod folder/ID), the `[TrainerHUD-cmd|launch|cat]` log tags, the `ace-trainerhud` CSS class, `window.trainerOverlay`, `__trainerRelaunch`, `TRAINER_SUPERVISED`, the `acevo-trainer-lap` export format, and `ACEVO_DATA`.
User-facing text says "AC EVO Paddock" / "Paddock" / "Paddock HUD".

## Release checklist

Ask the user before pushing, tagging or publishing. Each of those is public.

1. **Version:** bump `version` in `package.json` and in both top-level entries of `package-lock.json` (semver; betas are `0.x.y-beta.N`). If the in-game HUD changed, also bump `mod/trainerhud/app.json` `version`.
2. **Syntax check:** `for f in desktop/*.cjs desktop/*.mjs overlay/*.cjs src/*.js src/tools/*.js public/*.js mod/trainerhud/*.js; do node --check "$f" || echo FAIL $f; done`
3. **Secret scan of what will be committed:**
   - `git diff --cached --name-only | grep -iE "^data/|node_modules|^dist/|\.db$|settings\.json|\.log$"` must print nothing.
   - `git grep --cached -nIE "AIza[0-9A-Za-z_-]{20,}|AQ\.[A-Za-z0-9_-]{20,}|ghp_|gho_|sk-[A-Za-z0-9]{20,}"` must print nothing.
4. **Commit** (end with the Co-Authored-By line from the session's attribution instructions) and push `main`.
5. **Build:** `rm -rf dist && npx electron-builder --win dir`, which gives `dist/win-unpacked/AC EVO Paddock.exe`. Use the build only, not `npm run dist`, which also deploys locally.
6. **Smoke test** with a throwaway data dir, so nothing is written into the build:
   - PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE`; set `$env:ACEVO_DATA` to a scratch folder; start the exe; `Invoke-WebRequest http://localhost:8080/` should give 200 with title "AC EVO Paddock"; check `<scratch>\logs\paddock.log`; then `Stop-Process -Name "AC EVO Paddock"`.
   - Port 8080 must be free, so quit the user's running app first.
   - The Claude session has `ELECTRON_RUN_AS_NODE=1` set, so it must be cleared or Electron runs as plain Node.
   - Then confirm `dist/win-unpacked/data` does **not** exist.
7. **Zip:** copy `dist/win-unpacked` to a staging folder named `AC EVO Paddock`, then use PowerShell's `tar.exe -a -c -f release\AC-EVO-Paddock-v<ver>-win64.zip -C <stage-parent> "AC EVO Paddock"`.
   - Verify with .NET `System.IO.Compression.ZipFile.OpenRead`, because Git Bash's `tar` can't read zip files. There should be no `/data/`, `settings.json` or `.db` entries.
   - grep the staged folder for the API key prefix and the driver name.
   - Get the SHA-256 with `Get-FileHash`.
8. **Tag and release:**
   ```
   git tag -a v<ver> -m "v<ver>" && git push origin v<ver>
   gh release create v<ver> release/AC-EVO-Paddock-v<ver>-win64.zip -R mkulacki/ac-evo-paddock --prerelease --title "AC EVO Paddock v<ver>" --notes-file <notes.md>
   ```
   Drop `--prerelease` for a stable release. Check the asset with `gh release view v<ver> --json assets` (state should be `uploaded`).
9. **Local install (optional):** `node desktop/deploy.mjs` updates `..\AC EVO Paddock\`. It keeps that folder's `data\` and refuses to run while the app is open. Quit the app from the tray first.

10. **overtake.gg (optional):** the beta is also listed on overtake.gg (ACE Apps). It needs the zip uploaded there too, through "Post an update". How to do it, the browser/Cloudflare setup and form quirks are in `.claude/overtake/README.md` (gitignored, local only).

### Release notes template

Sections: what's new, Install (unzip anywhere → run `AC EVO Paddock.exe`; SmartScreen: *More info → Run anyway* because the build is unsigned; data lives in `data\` next to the exe; to update, replace everything except `data\`), Known limitations (Windows only; the AC EVO version it was tested on; unofficial, not affiliated with Kunos Simulazioni / 505 Games), and the SHA-256 of the zip.

## Tooling notes

- `gh` is installed at `C:\Program Files\GitHub CLI\gh.exe` and logged in as `mkulacki` (HTTPS). It may be missing from PATH in old shells; in Git Bash use `export PATH="$PATH:/c/Program Files/GitHub CLI"`.
- The build is unsigned (`no code signing certificate configured`) and has `asar: false`. Both are known and accepted for now.
- `npm start` / `start.bat` (source) and the desktop app both use port 8080, and they keep **separate** `data\` folders.
