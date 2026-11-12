// Installs the Paddock HUD app for the ACE UI App Loader (the Mods tab does the same with one click).
// Usage: npm run install-mod            install / update
//        npm run install-mod -- --remove
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
  if (!s.loader) {
    console.warn(`\nWARNING: the ACE UI App Loader is not installed (${hud.LOADER} missing).
Download it from ${hud.LOADER_URL} and follow its install steps, otherwise the game will not load this app.`);
  }
  console.log('\nIn game: open the loader\'s app drawer and enable "Paddock HUD". Escape + resume reloads the HUD.');
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
