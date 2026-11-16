// Wheel / button box / pad buttons, read straight from Windows (winmm joystick API), so they work while
// the game has the focus, in VR, and when Paddock runs from source. Used to mark brake points.
// winmm sees up to 32 buttons per device and only gives a generic driver name, so a device is identified
// by USB vendor/product id (+ which one, for two identical devices), and its product name comes from the
// registry (what the Windows "Game controllers" panel shows).
import koffi from 'koffi';

const JOY_RETURNBUTTONS = 0x80;
let api = null;
function lib() {
  if (api) return api;
  const w = koffi.load('winmm.dll');
  const INFO = koffi.struct('PaddockJOYINFOEX', {
    dwSize: 'uint32_t', dwFlags: 'uint32_t', x: 'uint32_t', y: 'uint32_t', z: 'uint32_t', r: 'uint32_t', u: 'uint32_t', v: 'uint32_t',
    dwButtons: 'uint32_t', dwButtonNumber: 'uint32_t', dwPOV: 'uint32_t', r1: 'uint32_t', r2: 'uint32_t',
  });
  const CAPS = koffi.struct('PaddockJOYCAPSW', {
    wMid: 'uint16_t', wPid: 'uint16_t', szPname: koffi.array('char16_t', 32, 'String'), rest: koffi.array('uint32_t', 19),
    szRegKey: koffi.array('char16_t', 32, 'String'), szOEMVxD: koffi.array('char16_t', 260, 'String'),
  });
  const adv = koffi.load('advapi32.dll');
  api = {
    INFO, CAPS,
    pos: w.func('uint32_t __stdcall joyGetPosEx(uint32_t id, _Inout_ PaddockJOYINFOEX *info)'),
    caps: w.func('uint32_t __stdcall joyGetDevCapsW(uint32_t id, _Out_ PaddockJOYCAPSW *caps, uint32_t size)'),
    regGet: adv.func('int32_t __stdcall RegGetValueW(intptr_t hkey, const char16_t *sub, const char16_t *value, uint32_t flags, void *type, _Out_ uint8_t *data, _Inout_ uint32_t *size)'),
  };
  return api;
}

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
const HKCU = -2147483647; // (HKEY)(LONG)0x80000001
const names = new Map();
function productName(vid, pid) {
  const k = `${vid}:${pid}`;
  if (!names.has(k)) {
    let name = null;
    try {
      const buf = Buffer.alloc(512), size = [buf.length];
      const sub = `System\\CurrentControlSet\\Control\\MediaProperties\\PrivateProperties\\Joystick\\OEM\\VID_${hex4(vid)}&PID_${hex4(pid)}`;
      if (lib().regGet(HKCU, sub, 'OEMName', 2 /* RRF_RT_REG_SZ */, null, buf, size) === 0) name = buf.toString('utf16le', 0, Math.max(0, size[0] - 2)).trim();
    } catch { /* keep the fallback */ }
    names.set(k, name || `Controller ${hex4(vid)}:${hex4(pid)}`);
  }
  return names.get(k);
}

/** buttons bitmask of device id, or null if it is not connected */
function buttons(id) {
  const a = lib(), info = { dwSize: koffi.sizeof(a.INFO), dwFlags: JOY_RETURNBUTTONS, x: 0, y: 0, z: 0, r: 0, u: 0, v: 0, dwButtons: 0, dwButtonNumber: 0, dwPOV: 0, r1: 0, r2: 0 };
  return a.pos(id, info) === 0 ? info.dwButtons >>> 0 : null;
}

/** connected devices: [{ id, vid, pid, nth, name }] (nth counts identical devices) */
export function devices() {
  const out = [];
  try {
    const a = lib();
    for (let id = 0; id < 16; id++) {
      if (buttons(id) == null) continue;
      const caps = {};
      if (a.caps(id, caps, koffi.sizeof(a.CAPS)) !== 0) continue;
      const vid = caps.wMid, pid = caps.wPid;
      out.push({ id, vid, pid, nth: out.filter((d) => d.vid === vid && d.pid === pid).length, name: productName(vid, pid) });
    }
  } catch { /* not Windows */ }
  return out;
}
const same = (d, b) => d.vid === b.vid && d.pid === b.pid && d.nth === (b.nth || 0);

/** Waits for a new button press on any device (for "press the button now"): {vid, pid, nth, button, name} or null. */
export function capture(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const devs = devices();
    if (!devs.length) return resolve(null);
    const before = new Map(devs.map((d) => [d.id, buttons(d.id) ?? 0]));
    const t0 = Date.now();
    const iv = setInterval(() => {
      for (const d of devs) {
        const now = buttons(d.id) ?? 0, pressed = (now & ~before.get(d.id)) >>> 0;
        before.set(d.id, now);
        if (pressed) {
          clearInterval(iv);
          return resolve({ vid: d.vid, pid: d.pid, nth: d.nth, name: d.name, button: 32 - Math.clz32(pressed & -pressed) });
        }
      }
      if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(null); }
    }, 30);
  });
}

/**
 * Watches one bound button and calls onPress on each new press. Polls only that device, and looks it up
 * again (at most every 5 s) when it is unplugged or the binding changes.
 */
export function watchButton(getBinding, onPress) {
  let id = null, key = null, was = true, nextFind = 0;
  setInterval(() => {
    const b = getBinding();
    if (!b?.button) { id = null; return; }
    const k = `${b.vid}:${b.pid}:${b.nth || 0}`;
    try {
      if (id == null || key !== k) {
        if (key === k && Date.now() < nextFind) return;
        key = k; nextFind = Date.now() + 5000; was = true; // a button already held is not a press
        id = devices().find((d) => same(d, b))?.id ?? null;
        if (id == null) return;
      }
      const bits = buttons(id);
      if (bits == null) { id = null; return; }
      const down = !!(bits & (1 << (b.button - 1)));
      if (down && !was) onPress();
      was = down;
    } catch { id = null; }
  }, 20);
}
