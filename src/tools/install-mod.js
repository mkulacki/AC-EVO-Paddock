// Installs the Paddock HUD app, and the ACE UI App Loader it runs in, into the game (Paddock also does this
// by itself whenever the game is closed; the Mods tab has the same button).
// Usage: npm run install-mod            install / update
//        npm run install-mod -- --remove   (removes the HUD only; the loader may host other apps)
// ACE_DIR overrides the "Saved Games\ACE" folder. --force installs even while the game runs (can crash it).
import * as hud from '../hudinstall.js';
import { APP_DIR } from '../gamebridge.js';

try {
  if (process.argv.includes('--remove')) {
    hud.remove();
    console.log(`Removed ${APP_DIR} and its loader marker`);
    process.exit(0);
  }
  const s = hud.install({ force: process.argv.includes('--force') });
  console.log(`Installed Paddock HUD ${s.installed}\n  app: ${APP_DIR}`);
  const l = s.loaderInfo;
  if (l.state === 'current') console.log(`ACE UI App Loader ${l.bundled}${l.variant === 'alternate' ? ' (alternate build)' : ''}: installed\n  ${hud.LOADER}`);
  else if (l.gameMatch === false) {
    console.warn(`\nWARNING: the ACE UI App Loader in this Paddock (${l.bundled}) is built for AC EVO ${l.builtFor}, but the game is ${l.game}.
Update Paddock, or install the loader release for this game version from ${hud.LOADER_URL}.`);
  } else console.warn(`\nWARNING: the ACE UI App Loader could not be installed${l.autoError ? `: ${l.autoError}` : ''}.`);
  console.log('\nThe HUD shows in game the next time AC EVO starts (switch it off in the loader\'s app drawer at the right edge of the screen).');
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
