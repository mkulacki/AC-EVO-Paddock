// PL9 HUD layouts and context profiles. A layout is a named look (which parts show, size, background); applying one
// replaces the current look (settings.hud), which the HUD gets with its next data read and the in-game settings window
// follows, exactly as a change on the Settings page. Context profiles apply a layout when a session of a given type
// starts; they are off until the driver switches them on (OD-PL-54). Built-in layouts: src/settings.js HUD_PRESETS.
import * as settings from './settings.js';

export class LayoutError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }

const stored = () => settings.normLayouts(settings.get().hudLayouts);
// own keys only: 'constructor' or 'toString' are not layouts (PL9 review)
const preset = (name) => (typeof name === 'string' && Object.hasOwn(settings.HUD_PRESETS, name) ? settings.HUD_PRESETS[name] : null);

/** For the Settings page: {presets: [name], list: [{name, parts, scale, opacity}], auto, byType, max}. */
export function view() {
  return { presets: Object.keys(settings.HUD_PRESETS), ...stored(), max: settings.MAX_LAYOUTS };
}

/** The current look saved under a name (a saved layout of that name is replaced; built-in names are taken). */
export function save(name) {
  const n = settings.cleanLayoutName(name);
  if (!n) throw new LayoutError('Give the layout a name');
  if (preset(n)) throw new LayoutError(`"${n}" is a built-in layout: choose another name`);
  const cur = stored(), h = settings.hudConfig();
  const list = cur.list.filter((l) => l.name !== n);
  if (list.length >= settings.MAX_LAYOUTS) throw new LayoutError(`At most ${settings.MAX_LAYOUTS} layouts can be saved: delete one first`);
  list.push({ name: n, parts: h.parts, scale: h.scale, opacity: h.opacity });
  settings.update({ hudLayouts: { ...cur, list } });
  return view();
}

/** Make a layout the current look. The cue timing (cueHoldMs) is not part of a layout and stays as it is. */
export function apply(name) {
  const l = preset(name) || stored().list.find((x) => x.name === name);
  if (!l) throw new LayoutError('No layout of that name', 404);
  const h = settings.hudConfig();
  settings.update({ hud: { ...h, parts: { ...l.parts }, scale: l.scale, opacity: l.opacity } });
  return settings.hudConfig();
}

export function remove(name) {
  const cur = stored();
  if (!cur.list.some((l) => l.name === name)) throw new LayoutError('No saved layout of that name', 404);
  // a context that used it falls back to "keep the current look"
  const byType = Object.fromEntries(Object.entries(cur.byType).map(([t, n]) => [t, n === name ? '' : n]));
  settings.update({ hudLayouts: { ...cur, list: cur.list.filter((l) => l.name !== name), byType } });
  return view();
}

/** Context profiles: auto on/off and the layout per session type ('' = keep the current look). */
export function setContexts({ auto, byType }) {
  const cur = stored();
  if (auto !== undefined && typeof auto !== 'boolean') throw new LayoutError('auto must be true or false');
  const next = { ...cur, auto: auto ?? cur.auto, byType: { ...cur.byType } };
  if (byType !== undefined) {
    if (!byType || typeof byType !== 'object' || Array.isArray(byType)) throw new LayoutError('byType must be an object');
    const names = new Set([...Object.keys(settings.HUD_PRESETS), ...cur.list.map((l) => l.name)]);
    for (const [t, n] of Object.entries(byType)) {
      if (!settings.SESSION_CONTEXTS.includes(t)) throw new LayoutError(`Unknown session type ${t}`);
      if (n !== '' && !names.has(n)) throw new LayoutError(`No layout named "${n}"`);
      next.byType[t] = n;
    }
  }
  settings.update({ hudLayouts: next });
  return view();
}

/** The layout to apply when a session of this type starts, or null (profiles off, none chosen, type unknown). */
export function forSession(sessionType) {
  const cur = stored();
  if (!cur.auto) return null;
  const n = cur.byType[String(sessionType)];
  return n || null;
}
