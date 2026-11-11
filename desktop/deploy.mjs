// Copies the packaged app (dist\win-unpacked) to its install folder, keeping that folder's data\ untouched.
// Default target: "AC EVO Paddock" next to the project folder. Override: npm run deploy -- "D:\Some\Folder"
// Creates a desktop shortcut on the first install.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'dist', 'win-unpacked');
const DEST = path.resolve(process.argv[2] || path.join(path.dirname(ROOT), 'AC EVO Paddock'));
const EXE = 'AC EVO Paddock.exe';

if (!fs.existsSync(path.join(SRC, EXE))) { console.error(`No build in ${SRC}. Run: npm run dist`); process.exit(1); }
if (DEST.toLowerCase() === ROOT.toLowerCase() || ROOT.toLowerCase().startsWith(DEST.toLowerCase() + path.sep)) {
  console.error(`Refusing to deploy into the project folder (${DEST}).`); process.exit(1);
}
const running = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
if (running.toLowerCase().includes(EXE.toLowerCase())) { console.error('AC EVO Paddock is running. Quit it from the tray icon first.'); process.exit(1); }

const firstInstall = !fs.existsSync(path.join(DEST, EXE));
fs.mkdirSync(DEST, { recursive: true });
// replace everything except data\ (laps, settings, caches)
for (const e of fs.readdirSync(DEST)) if (e.toLowerCase() !== 'data') fs.rmSync(path.join(DEST, e), { recursive: true, force: true });
for (const e of fs.readdirSync(SRC)) if (e.toLowerCase() !== 'data') fs.cpSync(path.join(SRC, e), path.join(DEST, e), { recursive: true });
console.log(`${firstInstall ? 'Installed' : 'Updated'}: ${path.join(DEST, EXE)}`);

if (firstInstall) {
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\AC EVO Paddock.lnk');` +
    `$s.TargetPath='${path.join(DEST, EXE).replace(/'/g, "''")}';$s.WorkingDirectory='${DEST.replace(/'/g, "''")}';$s.Save()`;
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }); console.log('Desktop shortcut created.'); }
  catch (e) { console.warn(`Could not create the desktop shortcut: ${e.message}`); }
}
