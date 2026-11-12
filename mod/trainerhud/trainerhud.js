/**
 * Paddock HUD -- AC EVO Paddock's in-game panel.
 *
 * Shows the live delta to your ALL-TIME best lap (or the ideal lap / session best), the predicted
 * lap, best / ideal / session / last times, how much the last corner gained or lost, the next
 * corner's reference brake point and minimum speed, brake / throttle cues, and the track-limit
 * state. Corners come from AC EVO's own track data. All numbers come from the AC EVO Paddock app
 * running on this PC, which keeps every lap you have ever driven.
 *
 * Two hosts, one file:
 *   - in game, loaded by the ACE UI App Loader (window.ACEUIAppLoader exists): data from the
 *     live0..7.json slot files, commands through the game log (see readSlot / sendCommand);
 *     on the menu / Solo / multiplayer pages it is the Race tab's launcher instead (see below);
 *   - outside the game, by Paddock's /hud.html page (desktop overlay or a second screen):
 *     data from http://127.0.0.1:8080/api/hud.
 *
 * If Paddock cannot be reached from inside the game, the panel falls back to the game's own
 * delta (window.ModelCurrentCar / window.ModelTiming) and says why in its bottom line.
 *
 * Which parts show, the size and the background opacity come with the data (cfg), set in Paddock
 * under Settings > Paddock HUD. hud.html?demo shows made-up numbers (the preview there).
 *
 * Cohtml rules followed: markup built once; per frame only textContent, classes and transforms.
 */
const TrainerHud = (function () {

    const NAME = "trainerhud";
    const LOADER = window.ACEUIAppLoader || null;
    const me = LOADER ? LOADER.app(NAME) : null;

    const NO_DELTA_MS = 2147483647;
    const POLL_MS = 66;
    const TIMEOUT_MS = 1500;
    const EXTRAPOLATE_MAX_MS = 400;
    const RANGES = { "0.5 s": 500, "1 s": 1000, "2 s": 2000 };
    const PAD = new Array(2001).join("-"); // the game log cuts lines at about 2,090 characters
    const CUE_RANGES = { "100 m": 100, "200 m": 200, "300 m": 300 };

    const DEFAULTS = {
        host: "127.0.0.1:8080",
        refKey: "F8",
        range: "1 s",
        cueRange: "200 m"
    };

    const LABELS = { best: "ALL-TIME BEST", ideal: "IDEAL LAP", session: "SESSION BEST" };

    let opts = null;

    const opt = function (key) {
        if (opts && opts[key] !== undefined && opts[key] !== null && opts[key] !== "") {
            return opts[key];
        }
        return DEFAULTS[key];
    };

    const log = function (text) {
        if (me && me.log) {
            me.log(text);
        } else if (window.console) {
            window.console.log("[trainerhud] " + text);
        }
    };

    // ---- formatting ---------------------------------------------------------------

    const pad = function (n, w) {
        let s = String(n);
        while (s.length < w) {
            s = "0" + s;
        }
        return s;
    };

    const fmtLap = function (ms) {
        if (ms === null || ms === undefined || !(ms > 0) || ms > 3600000) {
            return "-:--.---";
        }
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return m + ":" + pad(s, 2) + "." + pad(Math.floor(ms % 1000), 3);
    };

    const fmtDelta = function (ms, decimals) {
        if (ms === null || ms === undefined || !isFinite(ms)) {
            return decimals === 2 ? "--.--" : "--.---";
        }
        const sign = ms < 0 ? "-" : "+";
        return sign + (Math.abs(ms) / 1000).toFixed(decimals);
    };

    // ---- networking ---------------------------------------------------------------

    /** One request at a time; done(error, json). POST bodies go as text/plain so no CORS preflight is needed. */
    const request = function (state, method, path, body, done) {
        let xhr = null;
        let finished = false;
        const finish = function (err, json) {
            if (finished) {
                return;
            }
            finished = true;
            done(err, json);
        };
        try {
            xhr = new XMLHttpRequest();
        } catch (e) {
            finish("no XMLHttpRequest", null);
            return;
        }
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) {
                return;
            }
            if (xhr.status === 200) {
                try {
                    finish(null, JSON.parse(xhr.responseText));
                } catch (e) {
                    finish("bad answer", null);
                }
            } else if (xhr.status === 0) {
                finish("unreachable", null);
            } else {
                let msg = "HTTP " + xhr.status;
                try {
                    msg = JSON.parse(xhr.responseText).error || msg;
                } catch (e) {
                    msg = "HTTP " + xhr.status;
                }
                finish(msg, null);
            }
        };
        try {
            xhr.open(method, "http://" + state.host + path, true);
            xhr.send(body ? JSON.stringify(body) : null);
        } catch (e) {
            finish("blocked: " + e.message, null);
            return;
        }
        setTimeout(function () {
            if (!finished) {
                try {
                    xhr.abort();
                } catch (e) {
                    log("abort failed");
                }
                finish("timeout", null);
            }
        }, TIMEOUT_MS);
    };

    /**
     * In game the UI engine cannot make HTTP requests (they fail inside Gameface). Paddock writes
     * live0..live7.json in this app's folder instead; files outside js/ are read afresh on every request.
     *
     * CRASH SAFETY: if the game cannot open a file (e.g. while Paddock is writing it), its resource
     * loader throws and AC EVO CRASHES. So reads are time-slotted on the shared system clock: in 50 ms
     * window w this reads ONLY live(w % 8).json and only starts in the first 20 ms of the window, while
     * Paddock, in window w, writes only slot (w + 4) % 8. Must match src/gamebridge.js.
     */
    const SLOTS = 8;
    const WINDOW_MS = 50;
    const READ_PHASE_MS = 20;
    let slotUnsafe = false;

    const readSlot = function (base, done) {
        if (slotUnsafe) {
            done("stopped: Paddock clock mismatch", null);
            return;
        }
        const now = Date.now();
        const phase = now % WINDOW_MS;
        if (phase >= READ_PHASE_MS) {
            setTimeout(function () {
                readSlot(base, done);
            }, WINDOW_MS - phase + 1);
            return;
        }
        const w = Math.floor(now / WINDOW_MS);
        let xhr = null;
        try {
            xhr = new XMLHttpRequest();
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) {
                    return;
                }
                let json = null;
                try {
                    json = xhr.responseText ? JSON.parse(xhr.responseText) : null;
                } catch (e) {
                    done("reading", null);
                    return;
                }
                if (json && json.window !== undefined && json.window > w) {
                    // Paddock is writing ahead of where it should be: never read again on this page
                    slotUnsafe = true;
                    log("slot clock mismatch (data window " + json.window + " > " + w + "), file reads stopped");
                    done("stopped: Paddock clock mismatch", null);
                } else if (!json || !json.now) {
                    done("Paddock not running", null);
                } else if (Date.now() - json.now > 3000) {
                    done("Paddock not running", null);
                } else {
                    done(null, json);
                }
            };
            xhr.open("GET", base + "live" + (w % SLOTS) + ".json", true);
            xhr.send(null);
        } catch (e) {
            done("cannot read: " + e.message, null);
        }
    };

    const readLive = function (state, done) {
        readSlot(state.liveBase, done);
    };

    /** Commands go out through the game log, which Paddock follows. Padding flushes the log's 4 KB block. */
    const sendCommand = function (state, cmd, arg, quiet) {
        state.cmdSeq += 1;
        const msg = { id: Date.now() + "-" + state.cmdSeq, at: Date.now(), cmd: cmd, arg: arg };
        if (window.console) {
            window.console.log("[TrainerHUD-cmd] " + JSON.stringify(msg));
            window.console.log("[TrainerHUD-pad] " + PAD);
            window.console.log("[TrainerHUD-pad] " + PAD);
        }
        if (!quiet) {
            state.flash = { text: "sent to Paddock...", at: Date.now(), bad: false };
        }
    };

    // ---- in-game settings window <-> Paddock ------------------------------------------------
    //
    // Which parts show, the size and the opacity can be set in two places: Paddock's Settings page
    // and, in game, the loader's settings window for this app (drawer, or right-click the strip).
    // Paddock keeps the one copy: a change in game is sent to Paddock (a "hud" command), and
    // Paddock's copy (cfg, with every data read) is written back into the window. A change made
    // in game is held for a few seconds, so the older copy still on its way does not undo it.

    const LOOK_KEYS = { hudScale: "scale", hudOpacity: "opacity" };
    const PENDING_MS = 4000;
    const sync = { applying: false, pending: {}, rev: 0, state: null };

    const partKey = function (p) {
        return "show_" + p;
    };

    /** The look as the in-game settings window holds it. */
    const cfgFromSettings = function () {
        const S = LOADER.settings;
        const parts = {};
        PARTS.forEach(function (p) {
            parts[p] = S.get(NAME, partKey(p)) !== false;
        });
        return { parts: parts, scale: S.get(NAME, "hudScale"), opacity: S.get(NAME, "hudOpacity") };
    };

    /** Paddock's copy arrived: bring the settings window in line (skipping changes still on their way). */
    const settingsFromPaddock = function (cfg) {
        if (!cfg || !LOADER || !LOADER.settings || !opts) {
            return;
        }
        const S = LOADER.settings;
        const now = Date.now();
        const want = {};
        PARTS.forEach(function (p) {
            if (cfg.parts && typeof cfg.parts[p] === "boolean") {
                want[partKey(p)] = cfg.parts[p];
            }
        });
        Object.keys(LOOK_KEYS).forEach(function (k) {
            if (typeof cfg[LOOK_KEYS[k]] === "number") {
                want[k] = cfg[LOOK_KEYS[k]];
            }
        });
        Object.keys(want).forEach(function (k) {
            const held = sync.pending[k];
            if (held) {
                if (held.value === want[k] || now - held.at > PENDING_MS) {
                    delete sync.pending[k];
                } else {
                    return;
                }
            }
            if (S.get(NAME, k) !== want[k]) {
                sync.applying = true;
                S.set(NAME, k, want[k]);
                sync.applying = false;
            }
        });
    };

    /** The player changed something in the settings window: tell Paddock. */
    const settingChanged = function (key, value) {
        sync.rev += 1;
        if (sync.applying || !sync.state) {
            return;
        }
        let arg = null;
        if (key.indexOf("show_") === 0) {
            arg = { parts: {} };
            arg.parts[key.slice(5)] = value;
        } else if (LOOK_KEYS[key]) {
            arg = {};
            arg[LOOK_KEYS[key]] = value;
        }
        if (arg) {
            sync.pending[key] = { value: value, at: Date.now() };
            sendCommand(sync.state, "hud", arg, true);
        }
    };

    // hud.html?demo (the preview in Paddock's Settings): made-up numbers so every part is visible,
    // with the real look (cfg) from Paddock, so changes show up straight away
    const DEMO = !LOADER && /[?&]demo\b/.test(window.location.search);

    const demoData = function (json) {
        const t = Date.now();
        const wave = Math.sin(t / 1800);
        const lapMs = 31200 + (t % 70000);
        const inM = 220 - ((t / 25) % 240);
        const phase = (t % 3000) / 3000;
        const braking = phase > 0.7;
        const rpm = braking ? 0.7 : 0.62 + 0.38 * Math.min(1, phase / 0.7);
        return {
            v: 1,
            now: t,
            game: "live",
            cfg: json && json.cfg,
            combo: { track: "demo" },
            lap: { timeMs: lapMs, timed: true, valid: true, inPit: false, tyresOut: 0, lapNumber: 7, speed: Math.round(196 + 38 * wave), gear: wave > 0.3 ? 6 : 5 },
            ref: { mode: "best", timeMs: 102318 },
            delta: { ms: -284 + 210 * wave, rate: 120 * Math.cos(t / 1800), predictedMs: 102034 + Math.round(210 * wave) },
            times: { bestMs: 102318, idealMs: 101642, sessionBestMs: 102790, lastMs: 103110 },
            corner: { last: { name: "T4", deltaMs: -41 }, next: { name: "T5", brakeInM: Math.max(0, Math.round(inM)), brakeKind: "brake", minSpeed: 98, minGear: 3 } },
            cue: { next: inM > -8 ? { corner: "T5", kind: "brake", inM: inM } : null, speedMs: 0, brake: inM <= -8 ? { corner: "T5", kind: "brake", deltaM: 6, ageMs: 0 } : null, throttle: null },
            car: { gas: braking ? 0 : Math.min(1, 0.55 + phase), brake: braking ? 0.95 - (phase - 0.7) * 2 : 0, tc: !braking && phase < 0.12, abs: braking && Math.floor(t / 120) % 3 === 0, rpmPct: rpm, shift: rpm >= 0.96 },
            ahead: { step: 5, speedMs: 0, thr: [braking ? 0 : 1], brk: [braking ? 0.85 : 0] },
            sectors: { n: 3, k: lapMs > 68502 ? 2 : 1, cur: lapMs > 68502 ? [31112, 37390] : [31112], prev: [31250, 37480, 33600], best: [31112, 37200, 33410], sess: [31180, 37390, 33500] },
            fuel: { l: 23.4, perLap: 2.31, lapsLeft: 10.1 },
            saved: null
        };
    };

    const poll = function (state, now) {
        // in game every read is a file open by the game's resource loader: keep it to 5 per second
        if (state.inFlight || now - state.lastPoll < (LOADER ? 200 : POLL_MS)) {
            return;
        }
        state.inFlight = true;
        state.lastPoll = now;
        const fetcher = LOADER ? function (cb) {
            readLive(state, cb);
        } : function (cb) {
            request(state, "GET", "/api/hud", null, cb);
        };
        fetcher(function (err, json) {
            state.inFlight = false;
            if (err) {
                if (state.netError !== err) {
                    log("Paddock: " + err);
                }
                state.netError = err;
                state.failures += 1;
                if (state.failures > 3) {
                    state.data = null;
                }
                state.lastPoll = Date.now() + Math.min(2000, state.failures * 250);
                return;
            }
            if (state.netError) {
                log("Paddock connected");
            }
            state.netError = null;
            state.failures = 0;
            state.data = DEMO ? demoData(json) : json;
            state.receivedAt = Date.now();
            if (LOADER) {
                settingsFromPaddock(json.cfg);
            }
            if (LOADER && json.order) {
                maybeExit(json.order);
            }
        });
    };

    const command = function (state, path, body) {
        request(state, "POST", path, body, function (err, json) {
            if (err) {
                state.flash = { text: err, at: Date.now(), bad: true };
                return;
            }
            state.data = json;
            state.receivedAt = Date.now();
        });
    };

    // ---- markup -------------------------------------------------------------------

    const cell = function (cls, label) {
        return "<div class=\"th-blk th-bg th-cell " + cls + "\"><div class=\"th-label\">" + label + "</div><div class=\"th-time\">-:--.---</div></div>";
    };

    const LEDS = 12;
    const led = function () {
        let s = "";
        let i = 0;
        for (i = 0; i < LEDS; i += 1) {
            s += "<div class=\"th-led th-led-" + (i < 5 ? "g" : (i < 9 ? "y" : "r")) + "\"></div>";
        }
        return s;
    };
    const pedal = function (cls) {
        return "<div class=\"th-pedal " + cls + "\"><div class=\"th-pfill\"></div><div class=\"th-pref\"></div></div>";
    };

    // Top strip: shift lights over a slim bar of blocks (lap, times, the delta in the middle, pedals)
    // with the sector times under it, then a line of small chips (lap state, brake cue, corners, ideal
    // lap, speed, fuel, status) that only show when they have something to say. Each part can be
    // switched off (Paddock's Settings > Paddock HUD, or the in-game settings window): the root gets
    // "th-hide-<part>".
    const MARKUP = ""
        + "<div class=\"th-col\">"
        + "<div class=\"th-leds\">" + led() + "</div>"
        + "<div class=\"th-strip\">"
        + "<div class=\"th-blk th-lapbox\"><div class=\"th-label\">LAP</div><div class=\"th-lapno\">-</div></div>"
        + cell("th-c-cur", "CURRENT")
        + cell("th-c-pred", "PREDICTED")
        + "<div class=\"th-blk th-center\">"
        + "<div class=\"th-bar\"><div class=\"th-fill th-left\"></div><div class=\"th-fill th-right\"></div><div class=\"th-mid\"></div></div>"
        + "<div class=\"th-ref th-btn\" data-act=\"ref\">vs ALL-TIME BEST</div>"
        + "<div class=\"th-delta\">--.---</div>"
        + "</div>"
        + cell("th-c-best", "BEST")
        + cell("th-c-sess", "SESSION")
        + cell("th-c-last", "LAST")
        + "<div class=\"th-blk th-bg th-inputs\">"
        + pedal("th-p-thr") + pedal("th-p-brk")
        + "<div class=\"th-aids\"><div class=\"th-aid th-aid-tc\">TC</div><div class=\"th-aid th-aid-abs\">ABS</div></div>"
        + "</div>"
        + "</div>"
        + "<div class=\"th-sectors\"></div>"
        + "</div>"
        + "<div class=\"th-line\">"
        + "<div class=\"th-chip th-bg th-tag th-empty\"></div>"
        + "<div class=\"th-chip th-bg th-pot th-empty\"><div class=\"th-ideal\"></div><div class=\"th-gap\"></div></div>"
        + "<div class=\"th-chip th-bg th-spd th-empty\"><div class=\"th-gear\"></div><div class=\"th-speed\"></div><div class=\"th-unit\">KM/H</div></div>"
        + "<div class=\"th-chip th-bg th-fuel th-empty\"><div class=\"th-fuel-l\"></div><div class=\"th-fuel-x\"></div></div>"
        + "<div class=\"th-chip th-bg th-nextc th-empty\"></div>"
        + "<div class=\"th-chip th-bg th-lastc th-empty\"></div>"
        + "<div class=\"th-chip th-bg th-cue th-off\"><div class=\"th-cue-fill\"></div><div class=\"th-cue-a\"></div><div class=\"th-cue-b\"></div></div>"
        + "<div class=\"th-chip th-bg th-foot th-empty\"><div class=\"th-link\"></div><div class=\"th-saved\"></div></div>"
        + "</div>";

    const q = function (root, sel) {
        return root.querySelector(sel);
    };

    const create = function (root) {
        root.classList.add("ace-trainerhud");
        if (!q(root, ".th-leds") || !q(root, ".th-inputs")) {
            root.innerHTML = MARKUP;
        }
        return {
            root: root,
            bgs: root.querySelectorAll(".th-bg"),
            leds: root.querySelectorAll(".th-led"),
            secBox: q(root, ".th-sectors"),
            secEls: [],
            secN: 0,
            pedals: {
                thrFill: q(root, ".th-p-thr .th-pfill"),
                thrRef: q(root, ".th-p-thr .th-pref"),
                brkFill: q(root, ".th-p-brk .th-pfill"),
                brkRef: q(root, ".th-p-brk .th-pref"),
                tc: q(root, ".th-aid-tc"),
                abs: q(root, ".th-aid-abs")
            },
            chips: {
                fuel: q(root, ".th-fuel"),
                tag: q(root, ".th-tag"),
                lastc: q(root, ".th-lastc"),
                nextc: q(root, ".th-nextc"),
                pot: q(root, ".th-pot"),
                spd: q(root, ".th-spd"),
                foot: q(root, ".th-foot")
            },
            el: {
                lapno: q(root, ".th-lapno"),
                curtime: q(root, ".th-c-cur .th-time"),
                gear: q(root, ".th-gear"),
                speed: q(root, ".th-speed"),
                ref: q(root, ".th-ref"),
                tag: q(root, ".th-tag"),
                left: q(root, ".th-left"),
                right: q(root, ".th-right"),
                delta: q(root, ".th-delta"),
                pred: q(root, ".th-c-pred .th-time"),
                best: q(root, ".th-c-best .th-time"),
                sess: q(root, ".th-c-sess .th-time"),
                last: q(root, ".th-c-last .th-time"),
                predCell: q(root, ".th-c-pred"),
                cue: q(root, ".th-cue"),
                cueA: q(root, ".th-cue-a"),
                cueB: q(root, ".th-cue-b"),
                cueFill: q(root, ".th-cue-fill"),
                ideal: q(root, ".th-ideal"),
                gap: q(root, ".th-gap"),
                lastc: q(root, ".th-lastc"),
                nextc: q(root, ".th-nextc"),
                link: q(root, ".th-link"),
                saved: q(root, ".th-saved"),
                fuelL: q(root, ".th-fuel-l"),
                fuelX: q(root, ".th-fuel-x")
            },
            host: opt("host"),
            liveBase: me && me.base ? me.base : "ACEUIAppLoader/trainerhud/",
            cmdSeq: 0,
            data: null,
            receivedAt: 0,
            lastPoll: 0,
            inFlight: false,
            failures: 0,
            netError: null,
            flash: null,
            cfgKey: "",
            texts: {},
            classes: {},
            transforms: {},
            listeners: [],
            panel: null,
            loop: null,
            unbindKey: null
        };
    };

    // ---- rendering ------------------------------------------------------------------

    const setText = function (state, key, text) {
        if (state.texts[key] !== text) {
            state.texts[key] = text;
            state.el[key].textContent = text;
        }
    };

    const setClass = function (state, el, key, cls, on) {
        const k = key + "|" + cls;
        if (state.classes[k] !== on) {
            state.classes[k] = on;
            if (on) {
                el.classList.add(cls);
            } else {
                el.classList.remove(cls);
            }
        }
    };

    const setTransform = function (state, key, value) {
        if (state.transforms[key] !== value) {
            state.transforms[key] = value;
            state.el[key].style.transform = value;
        }
    };

    /** The game's own numbers, used when Paddock cannot be reached. */
    const gameView = function () {
        const car = window.ModelCurrentCar;
        const timing = window.ModelTiming;
        const out = { delta: null, predicted: null, best: "", last: "" };
        if (car && car.delta_time_ms_ui !== undefined && car.delta_time_ms_ui !== NO_DELTA_MS) {
            out.delta = car.delta_time_ms_ui;
        }
        if (car && car.predicted_lap_time_ms > 0) {
            out.predicted = car.predicted_lap_time_ms;
        }
        if (timing) {
            out.best = timing.best || "";
            out.last = timing.last || "";
        }
        return out;
    };

    const cueWords = function (deltaM, early, late) {
        if (Math.abs(deltaM) <= 2) {
            return "on the mark";
        }
        return Math.abs(deltaM) + " m " + (deltaM > 0 ? late : early);
    };

    /**
     * Brake / throttle cues against the reference lap. On the approach: a countdown to the point where
     * the reference lap braked (or lifted), with a bar that fills up. After it: how many metres earlier
     * or later this lap braked, then the same for getting back on the throttle.
     * The countdown is brought up to the present with the car's speed: the data is up to 0.4 s old.
     */
    const renderCue = function (state, now) {
        const d = state.data;
        const cue = d ? d.cue : null;
        let a = "";
        let b = "";
        let fill = 0;
        let mode = "";
        let near = false;
        let thrCls = "";
        if (cue) {
            const range = CUE_RANGES[opt("cueRange")] || 200;
            let inM = null;
            if (cue.next) {
                const age = Math.min(1000, Math.max(0, now - d.now));
                inM = cue.next.inM - (cue.speedMs || 0) * age / 1000;
            }
            const fresh = (cue.brake && cue.brake.ageMs < 2500) || (cue.throttle && cue.throttle.ageMs < 2500);
            if (inM !== null && inM <= range && inM > -8 && !(fresh && inM > range * 0.6)) {
                mode = "count";
                a = cue.next.corner + (cue.next.kind === "lift" ? "  LIFT" : "  BRAKE");
                b = inM > 0 ? Math.round(inM) + " m" : "NOW";
                fill = Math.max(0, Math.min(1, 1 - inM / range));
                near = inM < range * 0.25;
            } else if (cue.brake || cue.throttle) {
                mode = "res";
                if (cue.brake) {
                    a = cue.brake.corner + "  " + (cue.brake.kind === "lift" ? "lifted " : "braked ") + cueWords(cue.brake.deltaM, "earlier", "later");
                }
                if (cue.throttle) {
                    b = "throttle " + cueWords(cue.throttle.deltaM, "earlier", "later");
                    thrCls = cue.throttle.deltaM < -2 ? "gain" : (cue.throttle.deltaM > 2 ? "lose" : "");
                }
            }
        }
        setText(state, "cueA", a);
        setText(state, "cueB", b);
        setClass(state, state.el.cue, "cue", "th-off", !d || (a === "" && b === ""));
        setTransform(state, "cueFill", "scaleX(" + fill.toFixed(3) + ")");
        setClass(state, state.el.cue, "cue", "th-count", mode === "count");
        setClass(state, state.el.cue, "cue", "th-near", near);
        setClass(state, state.el.cueB, "cueB", "gain", mode === "res" && thrCls === "gain");
        setClass(state, state.el.cueB, "cueB", "lose", mode === "res" && thrCls === "lose");
    };

    // ---- look: parts on/off, size, background (from Paddock's settings; kept while offline) ----------

    const PARTS = ["lap", "ref", "delta", "current", "speed", "predicted", "best", "session", "last", "cues", "ideal", "corners", "footer",
        "shift", "inputs", "sectors", "fuel"];
    const ROWS = { strip: ["lap", "current", "predicted", "delta", "best", "session", "last", "inputs"] };

    const applyCfg = function (state, cfg) {
        const key = cfg ? JSON.stringify(cfg) : "";
        if (!cfg || key === state.cfgKey) {
            return;
        }
        state.cfgKey = key;
        const parts = cfg.parts || {};
        state.parts = parts;
        const off = function (p) {
            return parts[p] === false;
        };
        PARTS.forEach(function (p) {
            setClass(state, state.root, "root", "th-hide-" + p, off(p));
        });
        Object.keys(ROWS).forEach(function (row) {
            setClass(state, state.root, "root", "th-hide-row-" + row, ROWS[row].every(off));
        });
        const scale = Math.max(60, Math.min(160, Number(cfg.scale) || 100));
        const alpha = Math.max(0, Math.min(100, cfg.opacity === undefined ? 85 : Number(cfg.opacity))) / 100;
        state.root.style.fontSize = (scale / 100).toFixed(2) + "rem";
        const bg = "rgba(10, 11, 14, " + alpha.toFixed(2) + ")";
        let i = 0;
        for (i = 0; i < state.bgs.length; i += 1) {
            state.bgs[i].style.backgroundColor = bg;
        }
        state.bgColor = bg;
        for (i = 0; i < state.secEls.length; i += 1) {
            state.secEls[i].box.style.backgroundColor = bg;
        }
    };

    // ---- shift lights, pedals, sectors, fuel ---------------------------------------------------

    const setTextEl = function (state, key, el, text) {
        if (state.texts[key] !== text) {
            state.texts[key] = text;
            el.textContent = text;
        }
    };

    const setTransformEl = function (state, key, el, value) {
        if (state.transforms[key] !== value) {
            state.transforms[key] = value;
            el.style.transform = value;
        }
    };

    /** In game: the game's own car model, read every frame (pedals, revs, fuel). Null elsewhere. */
    const gameCar = function () {
        const m = LOADER ? window.ModelCurrentCar : null;
        return m && m.gas_percent !== undefined ? m : null;
    };

    /** Interpolates a list of points `step` metres apart at `x` metres. */
    const along = function (arr, x) {
        if (!arr || !arr.length) {
            return null;
        }
        const i = Math.max(0, Math.min(arr.length - 1, x));
        const a = Math.floor(i);
        const b = Math.min(arr.length - 1, a + 1);
        return arr[a] + (arr[b] - arr[a]) * (i - a);
    };

    const renderCar = function (state, now) {
        const d = state.data;
        const m = gameCar();
        const c = d && d.car ? d.car : null;
        let gas = null;
        let brk = null;
        let tc = false;
        let abs = false;
        let pct = null;
        let shift = false;
        if (m) {
            gas = Number(m.gas_percent) || 0;
            brk = Number(m.brake_percent) || 0;
            tc = !!m.tc_active;
            abs = !!m.abs_active;
            pct = Number(m.rpm_percent);
            shift = !!m.is_change_up_rpm || pct >= 0.97;
        } else if (c) {
            gas = c.gas;
            brk = c.brake;
            tc = c.tc;
            abs = c.abs;
            pct = c.rpmPct;
            shift = c.shift;
        }

        // shift lights: green, yellow, red from 72 % of the revs; all of them flash at the shift point
        const lit = pct === null || !isFinite(pct) ? 0 : Math.max(0, Math.min(LEDS, Math.round(((pct - 0.72) / 0.25) * LEDS)));
        let i = 0;
        for (i = 0; i < state.leds.length; i += 1) {
            setClass(state, state.leds[i], "led" + i, "on", i < lit);
        }
        setClass(state, state.root, "root", "th-shiftnow", shift && Math.floor(now / 90) % 2 === 0);

        // pedals, and where the reference lap's pedals were at this point (moved on with the car's speed)
        const p = state.pedals;
        setTransformEl(state, "thrFill", p.thrFill, "scaleY(" + (gas === null ? 0 : Math.max(0, Math.min(1, gas))).toFixed(3) + ")");
        setTransformEl(state, "brkFill", p.brkFill, "scaleY(" + (brk === null ? 0 : Math.max(0, Math.min(1, brk))).toFixed(3) + ")");
        const ah = d && d.ahead ? d.ahead : null;
        let rt = null;
        let rb = null;
        if (ah) {
            const since = LOADER ? d.now : state.receivedAt;
            const age = Math.min(1000, Math.max(0, now - since)) / 1000;
            const x = (ah.speedMs || 0) * age / (ah.step || 5);
            rt = along(ah.thr, x);
            rb = along(ah.brk, x);
        }
        setClass(state, p.thrRef, "thrRef", "th-noref", rt === null);
        setClass(state, p.brkRef, "brkRef", "th-noref", rb === null);
        setTransformEl(state, "thrRef", p.thrRef, "translateY(" + ((1 - Math.max(0, Math.min(1, rt || 0))) * 100).toFixed(1) + "%)");
        setTransformEl(state, "brkRef", p.brkRef, "translateY(" + ((1 - Math.max(0, Math.min(1, rb || 0))) * 100).toFixed(1) + "%)");
        setClass(state, p.tc, "tc", "on", tc);
        setClass(state, p.abs, "abs", "on", abs);

        // fuel: the game's own numbers in game (fuel_liter_per_lap is its average), Paddock's elsewhere
        let litres = null;
        let perLap = null;
        if (m && Number(m.fuel_liter_current_quantity) > 0) {
            litres = Number(m.fuel_liter_current_quantity);
            perLap = Number(m.fuel_liter_per_lap) > 0 ? Number(m.fuel_liter_per_lap) : null;
        } else if (d && d.fuel) {
            litres = d.fuel.l;
            perLap = d.fuel.perLap;
        }
        if (litres === null) {
            setTextEl(state, "fuelL", state.el.fuelL, "");
            setTextEl(state, "fuelX", state.el.fuelX, "");
        } else {
            setTextEl(state, "fuelL", state.el.fuelL, "FUEL " + litres.toFixed(1) + " L");
            setTextEl(state, "fuelX", state.el.fuelX, perLap ? perLap.toFixed(2) + " L/LAP · " + (litres / perLap).toFixed(1) + " LAPS" : "");
        }
        setClass(state, state.chips.fuel, "fuelLow", "th-low", !!(litres !== null && perLap && litres / perLap < 2));
        setClass(state, state.chips.fuel, "chipFuel", "th-empty", litres === null);
    };

    const fmtSec = function (ms) {
        if (ms === null || ms === undefined || !(ms > 0)) {
            return "--.---";
        }
        if (ms >= 60000) {
            return fmtLap(ms);
        }
        return (ms / 1000).toFixed(3);
    };

    /** Sector boxes: this lap's (purple = all-time best sector, green = session best, yellow = slower),
     *  the running one, and the previous lap's (dimmed) until this lap gets there. */
    const renderSectors = function (state) {
        const s = state.data ? state.data.sectors : null;
        const n = s ? s.n : 0;
        if (n !== state.secN) {
            state.secN = n;
            let html = "";
            let k = 0;
            for (k = 0; k < n; k += 1) {
                html += "<div class=\"th-sec th-bg\"><div class=\"th-sec-n\">S" + (k + 1) + "</div><div class=\"th-sec-t\">--.---</div></div>";
            }
            state.secBox.innerHTML = html;
            state.secEls = [];
            const boxes = state.secBox.querySelectorAll(".th-sec");
            for (k = 0; k < boxes.length; k += 1) {
                state.secEls.push({ box: boxes[k], t: boxes[k].querySelector(".th-sec-t") });
                boxes[k].style.backgroundColor = state.bgColor || "";
            }
            Object.keys(state.texts).forEach(function (key) {
                if (key.indexOf("sec") === 0) {
                    delete state.texts[key];
                }
            });
            Object.keys(state.classes).forEach(function (key) {
                if (key.indexOf("sec") === 0) {
                    delete state.classes[key];
                }
            });
        }
        setClass(state, state.root, "root", "th-nosectors", !n);
        if (!n) {
            return;
        }
        const cur = s.cur || [];
        let done = 0;
        cur.forEach(function (v) {
            done += v || 0;
        });
        let k = 0;
        for (k = 0; k < n; k += 1) {
            let text = "--.---";
            let cls = "";
            if (cur[k] > 0) {
                text = fmtSec(cur[k]);
                cls = s.best && s.best[k] && cur[k] <= s.best[k] ? "pb" : (s.sess && s.sess[k] && cur[k] <= s.sess[k] ? "sb" : "slow");
            } else if (s.k === k && state.curMs > 0) {
                text = fmtSec(state.curMs - done);
                cls = "live";
            } else if (s.prev && s.prev[k] > 0) {
                text = fmtSec(s.prev[k]);
                cls = "old";
            }
            const e = state.secEls[k];
            setTextEl(state, "sec" + k, e.t, text);
            ["pb", "sb", "slow", "live", "old"].forEach(function (c) {
                setClass(state, e.box, "sec" + k, c, cls === c);
            });
        }
    };

    const gearText = function (g) {
        if (g === null || g === undefined) {
            return "-";
        }
        return g < 0 ? "R" : (g === 0 ? "N" : String(g));
    };

    const render = function (state, now) {
        const d = state.data;
        const root = state.root;
        const range = RANGES[opt("range")] || 1000;
        let deltaMs = null;
        let rate = 0;

        setClass(state, root, "root", "th-offline", !d);
        if (LOADER && opts) {
            // in game: the settings window's values (kept in line with Paddock's copy), also offline
            if (state.cfgRev !== sync.rev) {
                state.cfgRev = sync.rev;
                applyCfg(state, cfgFromSettings());
            }
        } else if (d) {
            applyCfg(state, d.cfg); // outside the game: Paddock's copy, as it comes
        }

        if (d) {
            // lap number, running lap clock (brought up to the present), speed and gear
            const lp = d.lap;
            setText(state, "lapno", lp && lp.lapNumber ? String(lp.lapNumber) : "-");
            if (lp && lp.timeMs > 0) {
                const since = LOADER ? d.now : state.receivedAt;
                const age = lp.inPit ? 0 : Math.min(1000, Math.max(0, now - since));
                state.curMs = lp.timeMs + age;
                setText(state, "curtime", fmtLap(state.curMs));
            } else {
                state.curMs = 0;
                setText(state, "curtime", "-:--.---");
            }
            setText(state, "speed", lp ? String(lp.speed || 0) : "");
            setText(state, "gear", lp ? gearText(lp.gear) : "");
            const ref = d.ref || {};
            setText(state, "ref", "vs " + (LABELS[ref.mode] || "BEST") + (ref.timeMs ? "  " + fmtLap(ref.timeMs) : "  (none yet)"));
            if (d.delta) {
                const age = Math.min(EXTRAPOLATE_MAX_MS, now - state.receivedAt);
                rate = d.delta.rate || 0;
                deltaMs = d.delta.ms + (rate * Math.max(0, age)) / 1000;
            }
            const t = d.times || {};
            setText(state, "pred", d.delta ? fmtLap(d.delta.predictedMs) : "-:--.---");
            setText(state, "best", fmtLap(t.bestMs));
            setText(state, "sess", fmtLap(t.sessionBestMs));
            setText(state, "last", fmtLap(t.lastMs));
            setText(state, "ideal", t.idealMs ? "IDEAL " + fmtLap(t.idealMs) : "");
            setText(state, "gap", t.idealMs && t.bestMs ? fmtDelta(t.idealMs - t.bestMs, 3) : "");
            setClass(state, state.el.predCell, "pred", "th-faster", !!(d.delta && t.bestMs && d.delta.predictedMs < t.bestMs));
            setClass(state, state.el.predCell, "pred", "th-slower", !!(d.delta && t.bestMs && d.delta.predictedMs >= t.bestMs));

            // lap state tag
            const lap = d.lap;
            let tag = "";
            let tagCls = "";
            if (!lap) {
                tag = d.game === "live" ? "" : String(d.game || "").toUpperCase();
            } else if (lap.inPit) {
                tag = "PIT";
            } else if (!lap.timed) {
                tag = "OUTLAP";
            } else if (!lap.valid) {
                tag = "INVALID";
                tagCls = "bad";
            } else if (lap.tyresOut > 0) {
                tag = lap.tyresOut + (lap.tyresOut === 1 ? " TYRE OUT" : " TYRES OUT");
                tagCls = "warn";
            } else {
                tag = "VALID";
                tagCls = "good";
            }
            setText(state, "tag", tag);
            setClass(state, state.el.tag, "tag", "bad", tagCls === "bad");
            setClass(state, state.el.tag, "tag", "warn", tagCls === "warn");
            setClass(state, state.el.tag, "tag", "good", tagCls === "good");

            // corners
            const c = d.corner || {};
            if (c.last) {
                setText(state, "lastc", c.last.name + "  " + fmtDelta(c.last.deltaMs, 3));
            } else {
                setText(state, "lastc", "");
            }
            setClass(state, state.el.lastc, "lastc", "gain", !!(c.last && c.last.deltaMs < 0));
            setClass(state, state.el.lastc, "lastc", "lose", !!(c.last && c.last.deltaMs > 0));
            if (c.next) {
                const n = c.next;
                let txt = "NEXT " + n.name;
                if (state.parts && state.parts.cues === false && n.brakeInM !== null && n.brakeInM !== undefined) {
                    txt += " · " + n.brakeKind + " in " + n.brakeInM + " m";
                }
                txt += " · " + Math.round(n.minSpeed) + " km/h · G" + n.minGear;
                setText(state, "nextc", txt);
            } else {
                setText(state, "nextc", "");
            }

            // footer
            if (d.saved) {
                setText(state, "saved", (d.saved.pb ? "NEW BEST " : "saved ") + fmtLap(d.saved.lapTimeMs) + (d.saved.valid ? "" : " (invalid)"));
            } else {
                setText(state, "saved", "");
            }
            setClass(state, state.el.saved, "saved", "pb", !!(d.saved && d.saved.pb));
            setText(state, "link", d.combo ? "" : "PADDOCK · waiting for track");
        } else {
            const g = gameView();
            deltaMs = g.delta;
            setText(state, "ref", "vs GAME REFERENCE");
            setText(state, "lapno", "-");
            state.curMs = 0;
            setText(state, "curtime", "-:--.---");
            setText(state, "speed", "");
            setText(state, "gear", "");
            setText(state, "pred", fmtLap(g.predicted));
            setText(state, "best", g.best || "-:--.---");
            setText(state, "sess", "-:--.---");
            setText(state, "last", g.last || "-:--.---");
            setText(state, "ideal", "");
            setText(state, "gap", "");
            setText(state, "tag", "");
            setText(state, "lastc", "");
            setText(state, "nextc", "");
            setText(state, "saved", "");
            let why = "Paddock offline (" + (state.netError || "connecting") + ") @ " + state.host;
            if (LOADER) {
                why = "Paddock offline: " + (state.netError || "connecting") + " - start it with start.bat";
            } else if (state.netError === "HTTP 404") {
                why = "Paddock is an old version - restart it (start.bat)";
            }
            setText(state, "link", why);
        }

        if (state.flash && now - state.flash.at < 4000) {
            setText(state, "saved", state.flash.text);
        }

        // the chip line: a chip only shows while it has something to say
        const tx = state.texts;
        setClass(state, state.chips.tag, "chipTag", "th-empty", !tx.tag);
        setClass(state, state.chips.lastc, "chipLastc", "th-empty", !tx.lastc);
        setClass(state, state.chips.nextc, "chipNextc", "th-empty", !tx.nextc);
        setClass(state, state.chips.pot, "chipPot", "th-empty", !tx.ideal);
        setClass(state, state.chips.spd, "chipSpd", "th-empty", !tx.speed);
        setClass(state, state.chips.foot, "chipFoot", "th-empty", !tx.link && !tx.saved);

        renderCue(state, now);
        renderCar(state, now);
        renderSectors(state);

        // delta figure and bar: time gained grows to the right, like the stock bar
        setText(state, "delta", fmtDelta(deltaMs, 3));
        const share = deltaMs === null ? 0 : Math.min(1, Math.abs(deltaMs) / range);
        setTransform(state, "right", "scaleX(" + (deltaMs !== null && deltaMs < 0 ? share.toFixed(4) : "0") + ")");
        setTransform(state, "left", "scaleX(" + (deltaMs !== null && deltaMs > 0 ? share.toFixed(4) : "0") + ")");
        setClass(state, root, "root", "th-ahead", deltaMs !== null && deltaMs < 0);
        setClass(state, root, "root", "th-behind", deltaMs !== null && deltaMs > 0);
        setClass(state, root, "root", "th-gain", rate < -15);
        setClass(state, root, "root", "th-lose", rate > 15);
        setClass(state, root, "root", "th-nodelta", deltaMs === null);
    };

    const tick = function (state, now) {
        if (state.panel && LOADER) {
            LOADER.panel.update(state.panel, now);
        }
        poll(state, now);
        if (LOADER && LOADER.hudHidden && LOADER.hudHidden()) {
            return;
        }
        render(state, now);
    };

    // ---- input ------------------------------------------------------------------------

    const act = function (state, what) {
        if (LOADER) {
            if (what === "ref") {
                sendCommand(state, "ref", "cycle");
            }
            return;
        }
        if (what === "ref") {
            command(state, "/api/hud/ref", { mode: "cycle" });
        }
    };

    const listen = function (state, target, type, fn) {
        target.addEventListener(type, fn);
        state.listeners.push([target, type, fn]);
    };

    const bindButtons = function (state) {
        const buttons = state.root.querySelectorAll(".th-btn");
        let i = 0;
        for (i = 0; i < buttons.length; i += 1) {
            const b = buttons[i];
            // keep the panel's drag from starting on a button
            listen(state, b, "mousedown", function (e) {
                e.stopPropagation();
            });
            listen(state, b, "click", function (e) {
                e.stopPropagation();
                act(state, b.getAttribute("data-act"));
            });
        }
    };

    const keyMatches = function (e, code) {
        return e.code === code || e.key === code;
    };

    // ---- standalone host (desktop overlay / browser) -----------------------------------

    const standalonePanel = function (state) {
        const root = state.root;
        const KEY = "trainerhud.pos";
        let drag = null;
        try {
            const p = DEMO ? null : JSON.parse(window.localStorage.getItem(KEY) || "null");
            if (p) {
                root.style.left = p.left + "px";
                root.style.top = p.top + "px";
            }
        } catch (e) {
            log("no stored position");
        }
        listen(state, root, "mousedown", function (e) {
            drag = { x: e.clientX - root.offsetLeft, y: e.clientY - root.offsetTop };
            root.classList.add("dragging");
        });
        listen(state, window, "mousemove", function (e) {
            if (!drag) {
                return;
            }
            root.style.left = (e.clientX - drag.x) + "px";
            root.style.top = (e.clientY - drag.y) + "px";
        });
        listen(state, window, "mouseup", function () {
            if (!drag) {
                return;
            }
            drag = null;
            root.classList.remove("dragging");
            if (DEMO) {
                return;
            }
            try {
                window.localStorage.setItem(KEY, JSON.stringify({ left: root.offsetLeft, top: root.offsetTop }));
            } catch (e) {
                log("position not stored");
            }
        });
        listen(state, window, "keydown", function (e) {
            if (keyMatches(e, opt("refKey"))) {
                act(state, "ref");
            }
        });
        // desktop overlay: clicks pass through to the game except over the panel
        if (window.trainerOverlay) {
            listen(state, root, "mouseenter", function () {
                window.trainerOverlay.setInteractive(true);
            });
            listen(state, root, "mouseleave", function () {
                if (!drag) {
                    window.trainerOverlay.setInteractive(false);
                }
            });
        }
        const loop = { running: true };
        const frame = function () {
            if (!loop.running) {
                return;
            }
            tick(state, Date.now());
            window.requestAnimationFrame(frame);
        };
        window.requestAnimationFrame(frame);
        return loop;
    };

    // ---- launcher (menu.html / singleplayer.html / multiplayer.html) ---------------------------
    //
    // Paddock's Race tab puts an order inside the live slot files and starts the game. Kinds:
    //   solo  - select the car (menu), open the Solo screen and run Paddock's steps there: session
    //           type, track, session settings, weather, AI grid, a last check, Start;
    //   scan / probe - read the game's car list (scan) and run steps that send the game's data back to
    //           Paddock as "[TrainerHUD-cat] {scan, part, i, n, d}" log chunks it reassembles;
    //   mp    - select the car, open the server list targeted at ip:port|password, press Join.
    // What to set and in which order is decided by Paddock (order.steps), so it can be changed
    // without restarting the game (the game caches this file at start).
    // Progress goes to the log as "[TrainerHUD-launch] {json}" lines.

    const PAGE = (window.location.pathname.split("/").pop() || "").toLowerCase();
    const LAUNCH_PAGES = { "menu.html": true, "singleplayer.html": true, "multiplayer.html": true, "ingame.html": true };
    const CHUNK = 1500;
    const LINE_MAX = 1750;

    /** The game log is written in 4 KB blocks and cuts lines at about 2,090 characters: two pads flush a block. */
    const flush = function () {
        if (window.console) {
            window.console.log("[TrainerHUD-pad] " + PAD);
            window.console.log("[TrainerHUD-pad] " + PAD);
        }
    };

    const emit = function (tag, obj) {
        if (window.console) {
            window.console.log("[" + tag + "] " + JSON.stringify(obj));
            flush();
        }
    };

    const report = function (step, msg, extra) {
        const o = { step: step, msg: msg || "" };
        if (extra) {
            o.extra = extra;
        }
        emit("TrainerHUD-launch", o);
    };

    /** Plain-data copy: no functions, no cycles, limited depth and array length. */
    const plain = function (v, depth, seen) {
        seen = seen || [];
        if (v === null || v === undefined) {
            return v;
        }
        if (typeof v === "function" || typeof v === "symbol") {
            return undefined;
        }
        if (typeof v === "bigint") {
            return String(v);
        }
        if (typeof v !== "object") {
            return v;
        }
        if (depth <= 0) {
            return "[depth]";
        }
        if (seen.indexOf(v) >= 0) {
            return "[cycle]";
        }
        seen.push(v);
        let out = null;
        try {
            if (Array.isArray(v) || (typeof v.length === "number" && typeof v !== "string" && v.length >= 0 && v[0] !== undefined)) {
                out = [];
                const n = Math.min(v.length, 600);
                let i = 0;
                for (i = 0; i < n; i += 1) {
                    out.push(plain(v[i], depth - 1, seen));
                }
            } else {
                out = {};
                Object.keys(v).forEach(function (k) {
                    let x;
                    try {
                        x = plain(v[k], depth - 1, seen);
                    } catch (e) {
                        x = "[error]";
                    }
                    if (x !== undefined) {
                        out[k] = x;
                    }
                });
            }
        } catch (e) {
            out = "[error]";
        }
        seen.pop();
        return out;
    };

    /** Write one catalogue part to the log, cut into chunks Paddock joins again. */
    const sendCat = function (scan, part, data) {
        let s = "";
        try {
            s = JSON.stringify(data, function (k, v) {
                return typeof v === "bigint" ? String(v) : v;
            });
        } catch (e) {
            s = JSON.stringify({ error: String(e) });
        }
        if (s === undefined) {
            s = "null";
        }
        // the log cuts long lines: every piece must stay under LINE_MAX once it is escaped inside the line's JSON
        const pieces = [];
        let p = 0;
        while (p < s.length) {
            let len = Math.min(CHUNK, s.length - p);
            while (len > 50 && JSON.stringify(s.substr(p, len)).length > LINE_MAX) {
                len = Math.floor(len * 0.8);
            }
            pieces.push(s.substr(p, len));
            p += len;
        }
        if (!pieces.length) {
            pieces.push("");
        }
        let i = 0;
        for (i = 0; i < pieces.length; i += 1) {
            if (window.console) {
                window.console.log("[TrainerHUD-cat] " + JSON.stringify({ scan: scan, part: part, i: i, n: pieces.length, d: pieces[i] }));
            }
        }
        flush();
    };

    const methods = function (o) {
        const out = [];
        let p = o;
        let guard = 0;
        while (p && p !== Object.prototype && guard < 4) {
            guard += 1;
            Object.getOwnPropertyNames(p).forEach(function (k) {
                try {
                    if (k !== "constructor" && typeof o[k] === "function" && out.indexOf(k) < 0) {
                        out.push(k);
                    }
                } catch (e) {
                    log("method " + k);
                }
            });
            p = Object.getPrototypeOf(p);
        }
        return out;
    };

    /** UI managers (VEHICLES, GAMEMODESELECTION...), models (Current*, Model*) and enums (e*) the page exposes. */
    const globalsInfo = function () {
        const managers = {};
        const models = {};
        const enums = {};
        Object.keys(window).forEach(function (k) {
            let v = null;
            try {
                v = window[k];
            } catch (e) {
                return;
            }
            if (!v || typeof v !== "object") {
                return;
            }
            if (/^[A-Z][A-Z0-9_]{2,}$/.test(k)) {
                managers[k] = { methods: methods(v), props: Object.keys(v).filter(function (x) {
                    return typeof v[x] !== "function";
                }) };
            } else if (/^(Current|Model)[A-Z]/.test(k)) {
                models[k] = plain(v, 3);
            } else if (/^e[A-Z]/.test(k)) {
                enums[k] = plain(v, 3);
            }
        });
        return { page: PAGE, managers: managers, models: models, enums: enums };
    };

    const flat = function (o, prefix, out, depth) {
        Object.keys(o || {}).forEach(function (k) {
            if (k.indexOf("__") === 0) {
                return;
            }
            const v = o[k];
            if (typeof v === "string") {
                if (v.length < 160) {
                    out[prefix + k] = v;
                }
            } else if (typeof v === "number" || typeof v === "boolean") {
                out[prefix + k] = v;
            } else if (typeof v === "bigint") {
                out[prefix + k] = String(v);
            } else if (v && typeof v === "object" && !Array.isArray(v) && depth > 0) {
                flat(v, prefix + k + ".", out, depth - 1);
            }
        });
        return out;
    };

    const carInfo = function (m) {
        const f = flat(m, "", {}, 1);
        const presets = m && m.__uimetadata && Array.isArray(m.__uimetadata.presets) ? m.__uimetadata.presets : [];
        const variants = [];
        [m].concat(presets).forEach(function (p) {
            const v = [(p && p.configuration && p.configuration.name) || "", (p && p.preset && p.preset.name) || ""];
            if (!variants.some(function (x) {
                return x[0] === v[0] && x[1] === v[1];
            })) {
                variants.push(v);
            }
        });
        return { f: f, v: variants };
    };

    const timeout = function (p, ms) {
        return Promise.race([Promise.resolve(p), new Promise(function (res, rej) {
            setTimeout(function () {
                rej(new Error("timeout"));
            }, ms);
        })]);
    };

    const norm = function (s) {
        return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    };

    /** Every string value of an object (2 levels deep): used when the order only has a display name. */
    const strings = function (o, depth, out) {
        out = out || [];
        if (!o || typeof o !== "object" || depth < 0) {
            return out;
        }
        Object.keys(o).forEach(function (k) {
            const v = o[k];
            if (typeof v === "string") {
                out.push(v);
            } else if (v && typeof v === "object" && !Array.isArray(v)) {
                strings(v, depth - 1, out);
            }
        });
        return out;
    };

    const nameScore = function (o, wanted) {
        const w = norm(wanted);
        let best = 0;
        strings(o, 1).forEach(function (s) {
            const n = norm(s);
            if (n === w) {
                best = 2;
            } else if (best < 1 && w.length >= 8 && (n.indexOf(w) === 0 || n.slice(-w.length) === w)) {
                best = 1;
            }
        });
        return best;
    };

    const waitFor = function (test, timeoutMs, done) {
        const t0 = Date.now();
        const check = function () {
            let v = null;
            try {
                v = test();
            } catch (e) {
                v = null;
            }
            if (v) {
                done(v);
            } else if (Date.now() - t0 > timeoutMs) {
                done(null);
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    };

    const wait = function (test, timeoutMs) {
        return new Promise(function (res) {
            waitFor(test, timeoutMs, res);
        });
    };

    const sleep = function (ms) {
        return new Promise(function (res) {
            setTimeout(res, ms);
        });
    };

    const notice = function (root, text) {
        root.style.display = "block";
        root.classList.add("th-launch");
        root.textContent = "AC EVO Paddock: " + text;
    };

    const errText = function (e) {
        return String(e && (e.message || e.response) || e);
    };

    /** The launch order travels inside the live slot files (same crash-safe time-slotted read). */
    const readOrder = function (done) {
        readSlot(me && me.base ? me.base : "ACEUIAppLoader/trainerhud/", function (err, data) {
            const o = !err && data ? data.order : null;
            done(o && o.issued && Date.now() - o.issued < (o.ttlMs || 300000) ? o : null);
        });
    };

    const flag = function (key, issued) {
        try {
            return window.localStorage.getItem("trainerhud.launch." + key) === String(issued);
        } catch (e) {
            return false;
        }
    };

    const setFlag = function (key, issued) {
        try {
            window.localStorage.setItem("trainerhud.launch." + key, String(issued));
        } catch (e) {
            log("storage");
        }
    };

    const once = function (key, issued) {
        if (flag(key, issued)) {
            return false;
        }
        setFlag(key, issued);
        return true;
    };

    /**
     * A new session was asked for while one is running, and the player confirmed ending it in Paddock:
     * leave the session the way the pause menu's "Quit session" does. The order is then carried out on the
     * menu / Solo screen the game returns to.
     */
    const maybeExit = function (order) {
        if (!order || !order.endSession || !order.issued || Date.now() - order.issued > (order.ttlMs || 300000)) {
            return;
        }
        if (!once("exit", order.issued)) {
            return;
        }
        report("menu", "ending the running session");
        try {
            window.ksUI.requestNoResponse("GameMode", "Exit");
        } catch (e) {
            report("error", "could not end the session: " + errText(e));
        }
    };

    const menuReady = function () {
        return window.VEHICLES && window.ksUI && typeof window.VEHICLES.getAllModels === "function";
    };

    // ---- menu: catalogue scan (cars) ----------------------------------------------------------

    const scanMenu = function (root, order) {
        notice(root, "reading the game's car list...");
        return wait(menuReady, 30000).then(function (ok) {
            if (!ok) {
                throw new Error("game menu managers not found");
            }
            report("scan", "reading the game catalogue");
            sendCat(order.issued, "globals:menu", globalsInfo());
            return timeout(window.VEHICLES.getAllModels(), 20000);
        }).then(function (list) {
            list = list || [];
            sendCat(order.issued, "cars", list.map(carInfo));
            sendCat(order.issued, "carsample", plain(list[0], 4));
            report("scan", list.length + " cars read");
        });
    };

    // ---- car selection (menu) ------------------------------------------------------------

    /** order.car = {id, mech, visual} (ids from the game files) or {display} (a name from shared memory). */
    const findCar = function (car) {
        return timeout(window.VEHICLES.getAllModels(), 20000).then(function (list) {
            list = (list || []).slice();
            list.slice().forEach(function (m) {
                if (m && m.__uimetadata && Array.isArray(m.__uimetadata.presets)) {
                    list = list.concat(m.__uimetadata.presets);
                }
            });
            if (Array.isArray(window.VEHICLES.allModels)) {
                list = list.concat(window.VEHICLES.allModels);
            }
            if (car.id) {
                const byName = function (m) {
                    return !!m && norm(m.name) === norm(car.id);
                };
                const byMech = function (m) {
                    return byName(m) && (!car.mech || norm(m.configuration && m.configuration.name) === norm(car.mech));
                };
                const byPair = function (m) {
                    return byMech(m) && (!car.visual || norm(m.preset && m.preset.name) === norm(car.visual));
                };
                return list.filter(byPair)[0] || list.filter(byMech)[0] || list.filter(byName)[0] || null;
            }
            let found = null;
            let score = 0;
            list.forEach(function (m) {
                const s = nameScore(m, car.display);
                if (s > score) {
                    score = s;
                    found = m;
                }
            });
            return found;
        });
    };

    const selectCar = function (root, order) {
        const car = order.car;
        const label = car.label || car.display || car.id;
        report("menu", "selecting car " + label);
        notice(root, "selecting " + label + "...");
        return wait(menuReady, 30000).then(function (ok) {
            if (!ok) {
                throw new Error("game menu managers not found");
            }
            return findCar(car);
        }).then(function (found) {
            if (!found) {
                throw new Error("car not found in the game: " + label);
            }
            const got = found.name + " / " + ((found.configuration && found.configuration.name) || "-") + " / " + ((found.preset && found.preset.name) || "-");
            report("menu", "car found: " + got);
            return timeout(window.VEHICLES.setCurrent(found), 15000).catch(function (e) {
                log("setCurrent " + errText(e));
            }).then(function () {
                return wait(function () {
                    return window.CurrentCar && window.CurrentCar.model && window.CurrentCar.model.name === found.name;
                }, 15000);
            });
        }).then(function (sel) {
            if (!sel) {
                throw new Error("the game did not take the car");
            }
        });
    };

    const launchMenu = function (root, order) {
        if (!once("menu", order.issued)) {
            return;
        }
        setFlag("exit", order.issued); // already out of any session: this order must never end one
        const next = function () {
            setFlag("car", order.issued);
            if (order.kind === "mp") {
                const s = order.server || {};
                report("menu", "opening the server list for " + s.ip + ":" + s.port);
                notice(root, "opening the server list...");
                window.ksUI.goTo("multiplayer.html", "multiplayer/serverlist/" + s.ip + ":" + s.port + "|" + (s.password || ""));
            } else {
                report("menu", "opening Solo");
                window.ksUI.goTo("singleplayer.html", "singleplayer/main");
            }
        };
        let first = null;
        if (order.kind === "scan") {
            first = scanMenu(root, order);
        } else if (order.car) {
            first = selectCar(root, order);
        } else {
            first = wait(menuReady, 30000);
        }
        first.then(next, function (e) {
            report("error", errText(e));
            notice(root, errText(e) + " - pick it yourself");
        });
    };

    // ---- Solo screen: Paddock's steps ------------------------------------------------------
    //
    // The Solo screen talks to the game through "GameModeSelectionClient" requests (see the game's own
    // uiresources/js/components.js): GameModeParameters, SetGameType, TrackList, SetTrack, SetWeather,
    // SetGameModeParameters, Opponents, Start. Paddock sends a list of steps; this runs them in order.

    const SINGLE = "ClientCommandsMode_SINGLEPLAYER";
    const RESP_OK = "ClientCommandsResponse_OK";

    const soloReady = function () {
        return window.GAMEMODESELECTION && window.GAMEMODESELECTION.Client && window.CurrentGameMode && window.CurrentGameMode.type
            && window.GAMEMODESELECTION.Current && window.GAMEMODESELECTION.Current.sessions
            && document.querySelector("ks-page-singleplayer-hub");
    };

    /** One request to the game; resolves with its answer. */
    const gameRequest = function (name, args, ms) {
        return timeout(new Promise(function (res) {
            if (args === undefined || args === null) {
                window.GAMEMODESELECTION.Client.request(name, res);
            } else {
                window.GAMEMODESELECTION.Client.request(name, args, res);
            }
        }), ms || 15000).catch(function (e) {
            throw new Error(name + ": " + errText(e));
        });
    };

    const current = function () {
        return window.GAMEMODESELECTION.Current;
    };

    /** Re-read the game's session settings (and the track shown on the Solo screen). */
    const refresh = function () {
        return timeout(window.GAMEMODESELECTION.getGameModeParameters(), 15000).then(function () {
            const page = document.querySelector("ks-page-singleplayer");
            try {
                if (page && typeof page.getCurrentTrack === "function") {
                    page.getCurrentTrack();
                }
            } catch (e) {
                log("track refresh");
            }
            return sleep(150);
        });
    };

    /** Set Current[path...] = value; the path must already exist (we never invent fields). */
    const setPath = function (obj, path, value) {
        let o = obj;
        let i = 0;
        for (i = 0; i < path.length - 1; i += 1) {
            if (!o || typeof o !== "object" || !(path[i] in o)) {
                return false;
            }
            o = o[path[i]];
        }
        if (!o || typeof o !== "object" || !(path[path.length - 1] in o)) {
            return false;
        }
        o[path[path.length - 1]] = value;
        return true;
    };

    const saveSessions = function () {
        const cur = current();
        return timeout(window.GAMEMODESELECTION.save(cur.mode, cur.sessions, cur.type), 20000).catch(function (e) {
            throw new Error("the game refused the session settings: " + errText(e));
        });
    };

    const sameTrack = function (item, step) {
        return !!item && norm(item.name) === norm(step.name) && (!step.layout || norm(item.layout) === norm(step.layout));
    };

    /** A custom grid, the way the Solo screen's own grid editor builds one. */
    const placeGrid = function (grid) {
        const cur = current();
        const sessions = (cur && cur.sessions) || [];
        const s0 = sessions[0];
        if (!s0) {
            return Promise.reject(new Error("no current session"));
        }
        const all = (s0.class_filter || []).map(function () {
            return true;
        });
        const cf = Array.isArray(s0.class_filter) && s0.class_filter.some(Boolean) ? s0.class_filter : all;
        return timeout(window.GAMEMODESELECTION.generateGrid(grid.count, false, cf, s0.aggressivness, s0.min_strength, s0.max_strength, s0.min_pi, s0.max_pi), 20000).then(function (data) {
            const proposed = (data && data.models) || [];
            const opps = (data && data.opponents) || [];
            if (!proposed.length || !opps.length) {
                throw new Error("the game proposed no grid");
            }
            const pool = (data && data.all_ai_models) || [];
            const models = [];
            const missing = [];
            let i = 0;
            for (i = 0; i < proposed.length; i += 1) {
                const want = grid.cars.length ? grid.cars[i % grid.cars.length] : null;
                let m = null;
                if (want) {
                    m = pool.filter(function (x) {
                        return norm(x.name) === norm(want.id) && (!want.mech || norm(x.configuration && x.configuration.name) === norm(want.mech));
                    })[0] || pool.filter(function (x) {
                        return norm(x.name) === norm(want.id);
                    })[0] || null;
                    if (!m && missing.indexOf(want.id) < 0) {
                        missing.push(want.id);
                    }
                }
                models.push(m ? Object.assign({}, m, { ballast: proposed[i].ballast || 0, restrictor: proposed[i].restrictor || 0 }) : proposed[i]);
            }
            if (!Array.isArray(s0.models)) {
                s0.models = [];
            }
            if (!Array.isArray(s0.opponents)) {
                s0.opponents = [];
            }
            s0.models.length = 0;
            Object.assign(s0.models, models);
            s0.opponents.length = 0;
            Object.assign(s0.opponents, opps.slice(0, models.length));
            s0.grid_type = "GameModeSelectionGridType_CUSTOM";
            s0.num_opponents = models.length;
            return { cars: models.length, missing: missing };
        });
    };

    const STEP = {
        /** Solo game mode (practice / quick race / race weekend). */
        type: function (step) {
            if (String(current().type) === step.type) {
                return Promise.resolve();
            }
            return gameRequest("SetGameType", { mode: SINGLE, type: step.type }).then(function (data) {
                if (!data || data.response !== RESP_OK) {
                    throw new Error("the game refused the session type (" + ((data && data.response) || "no answer") + ")");
                }
                return refresh();
            }).then(function () {
                if (String(current().type) !== step.type) {
                    throw new Error("the game stayed on " + String(current().type).replace(/^.*?_/, ""));
                }
            });
        },

        /** Track and layout, picked from the game's own list exactly as its track page does. */
        track: function (step) {
            return gameRequest("TrackList", { mode: SINGLE }).then(function (data) {
                const list = (data && data.track_item) || [];
                const hits = list.filter(function (t) {
                    return sameTrack(t, step) && t.is_enabled !== false;
                });
                if (!hits.length) {
                    throw new Error((step.label || step.name) + " is not in the game's track list");
                }
                const item = hits.filter(function (t) {
                    return step.event && norm(t.event_name) === norm(step.event);
                })[0] || hits[0];
                const s0 = current().sessions[0];
                const maxOpp = Math.max(0, (item.max_drivers || 1) - 1);
                if (s0 && s0.num_opponents > maxOpp) {
                    s0.num_opponents = maxOpp;
                }
                if (s0 && Array.isArray(s0.models) && s0.models.length > maxOpp) {
                    s0.models = s0.models.slice(0, maxOpp);
                    s0.opponents = (s0.opponents || []).slice(0, maxOpp);
                }
                window.GAMEMODESELECTION.Client.requestNoResponse("SetTrack", { mode: SINGLE, track_item: item });
                return sleep(500);
            }).then(refresh).then(function () {
                if (sameTrack(current().sessions[0] && current().sessions[0].track_item, step)) {
                    return null;
                }
                return sleep(1000).then(refresh).then(function () {
                    if (!sameTrack(current().sessions[0] && current().sessions[0].track_item, step)) {
                        throw new Error("the game did not take the track " + (step.label || step.name));
                    }
                });
            });
        },

        /** Values written into the game's session settings, then saved. */
        set: function (step) {
            const cur = current();
            const failed = [];
            (step.items || []).forEach(function (p) {
                if (!setPath(cur, p.path, p.value)) {
                    failed.push(p.path.join("."));
                }
            });
            if (failed.length) {
                report("warn", "not in this session type: " + failed.join(", "));
            }
            return saveSessions();
        },

        weather: function (step) {
            const cur = current();
            const base = (cur.weather_data || []).filter(function (w) {
                return w && w.type === step.type;
            })[0];
            if (!base) {
                throw new Error("the game has no weather " + step.type);
            }
            const w = Object.assign({}, base);
            if (step.behaviour) {
                w.behaviour = step.behaviour;
            }
            if (step.grip) {
                w.initial_grip = step.grip;
            }
            if (step.data) {
                w.weather_data = Object.assign({}, base.weather_data, step.data);
            }
            return gameRequest("SetWeather", { weather_data: w }).then(function (data) {
                if (data && data.response && data.response !== RESP_OK) {
                    throw new Error("the game refused the weather (" + data.response + ")");
                }
                return sleep(200);
            }).then(refresh);
        },

        grid: function (step) {
            return placeGrid(step).then(function (g) {
                report("solo", "AI grid placed: " + g.cars + " cars" + (g.missing.length ? " (not AI-drivable, game's car kept: " + g.missing.join(", ") + ")" : ""));
                return saveSessions();
            }, function (e) {
                report("warn", "custom grid failed (" + errText(e) + "), automatic grid kept");
            });
        },

        /** Send the game's current settings (or its track list) to Paddock. */
        dump: function (step, order) {
            const cur = current();
            sendCat(order.issued, step.part || "applied", {
                type: String(cur.type), current: plain(cur, 7),
                track: plain(window.CurrentTrack, 3), car: plain(window.CurrentCar && window.CurrentCar.model, 2)
            });
            return Promise.resolve();
        },

        tracks: function (step, order) {
            return gameRequest("TrackList", { mode: SINGLE }).then(function (data) {
                sendCat(order.issued, step.part || "tracks", { type: String(current().type), response: data && data.response, items: plain(data && data.track_item, 3) });
            });
        },

        /** Any other request of the game's Solo client; the answer goes to Paddock. */
        request: function (step, order) {
            if (step.noResponse) {
                window.GAMEMODESELECTION.Client.requestNoResponse(step.name, step.args);
                return sleep(step.wait || 400);
            }
            return gameRequest(step.name, step.args, step.ms).then(function (data) {
                sendCat(order.issued, step.part || ("request:" + step.name), plain(data, 6));
            }, function (e) {
                sendCat(order.issued, step.part || ("request:" + step.name), { error: errText(e) });
            });
        },

        refresh: function () {
            return refresh();
        },

        sleep: function (step) {
            return sleep(step.ms || 300);
        },

        /** Last look before Start: the game must show the session type, track and car that were asked for. */
        check: function (step) {
            const cur = current();
            const s0 = cur.sessions[0] || {};
            if (step.type && String(cur.type) !== step.type) {
                throw new Error("wrong session type in the game");
            }
            if (step.track && !sameTrack(s0.track_item, step.track)) {
                throw new Error("the game shows " + ((s0.track_item && (s0.track_item.name + " " + s0.track_item.layout)) || "no track") + ", not " + (step.track.label || step.track.name));
            }
            const m = window.CurrentCar && window.CurrentCar.model;
            if (step.car && (!m || norm(m.name) !== norm(step.car))) {
                throw new Error("the game shows " + ((m && m.name) || "no car") + ", not " + step.car);
            }
            return Promise.resolve();
        },

        start: function () {
            try {
                if (window.ksUI.setOriginAsReturnPage) {
                    window.ksUI.setOriginAsReturnPage();
                }
            } catch (e) {
                log("return page");
            }
            return Promise.resolve(window.GAMEMODESELECTION.start()).then(function () {
                report("started", "session loading");
            }, function (e) {
                throw new Error("the game refused to start (" + errText(e) + ")");
            });
        },

        done: function (step) {
            report(step.step || "done", step.msg || "");
            return Promise.resolve();
        }
    };

    const launchSolo = function (root, order) {
        if (!once("solo", order.issued)) {
            return;
        }
        setFlag("exit", order.issued);
        notice(root, "preparing the session...");
        let chain = wait(soloReady, 30000).then(function (ok) {
            if (!ok) {
                throw new Error("Solo screen not ready");
            }
            return sleep(400);
        });
        if (!flag("car", order.issued)) {
            // the order came while the game was already on this screen: the menu step is done here
            chain = chain.then(function () {
                if (order.kind === "scan") {
                    return scanMenu(root, order);
                }
                return order.car ? selectCar(root, order) : null;
            }).then(function () {
                setFlag("car", order.issued);
            });
        }
        (order.steps || []).forEach(function (step) {
            chain = chain.then(function () {
                const fn = STEP[step.op];
                if (!fn) {
                    report("warn", "unknown step " + step.op + " (the Paddock HUD is older than the Paddock app: reinstall it)");
                    return null;
                }
                if (step.say) {
                    report("solo", step.say);
                    notice(root, step.say + "...");
                }
                return fn(step, order);
            });
        });
        chain.then(function () {
            notice(root, order.kind === "solo" ? "starting..." : "done");
            if (order.kind !== "solo") {
                setTimeout(function () {
                    root.style.display = "none";
                }, 4000);
            }
        }, function (e) {
            report("error", errText(e));
            notice(root, errText(e) + " - finish on this screen yourself");
        });
    };

    // ---- multiplayer -----------------------------------------------------------------------

    /** Gameface components have no .click(): replay the pointer + mouse sequence a real click sends. */
    const press = function (el) {
        if (typeof el.click === "function") {
            try {
                el.click();
                return;
            } catch (e) {
                log("click fallback");
            }
        }
        ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (type) {
            let ev = null;
            try {
                ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
            } catch (e) {
                ev = null;
            }
            if (ev) {
                el.dispatchEvent(ev);
            }
        });
    };

    const launchMp = function (root, order) {
        if (order.kind !== "mp" || !flag("car", order.issued) || !once("mp", order.issued)) {
            return;
        }
        notice(root, "waiting for Join...");
        wait(function () {
            const b = document.querySelector("#btnJoin");
            return b && !b.hasAttribute("disabled") ? b : null;
        }, 30000).then(function (btn) {
            if (!btn) {
                report("error", "Join stayed disabled (car not allowed on this server, or server not listed)");
                notice(root, "Join stayed disabled - car not allowed, or server not found");
                return;
            }
            report("start", "joining " + order.server.ip + ":" + order.server.port);
            press(btn);
            report("started", "connecting");
        });
    };

    const launcherAttach = function (root) {
        root.style.display = "none";
        const state = { launcher: true, timer: null };
        // keep looking (1 read per second): an order may come while the player is already on this screen
        const check = function () {
            readOrder(function (order) {
                handleOrder(root, order);
            });
        };
        check();
        state.timer = setInterval(check, 1000);
        return state;
    };

    const handleOrder = function (root, order) {
        if (!order) {
            return;
        }
        if (PAGE === "ingame.html") {
            maybeExit(order);
        } else if (PAGE === "singleplayer.html" && order.kind !== "mp") {
            launchSolo(root, order);
        } else if (PAGE === "multiplayer.html" && order.kind === "mp" && flag("car", order.issued)) {
            launchMp(root, order);
        } else {
            // the menu, or another menu screen than the one this order needs: pick the car, go to the right one
            launchMenu(root, order);
        }
    };

    // ---- lifecycle --------------------------------------------------------------------

    const defineSettings = function () {
        if (!LOADER || !LOADER.settings || typeof LOADER.settings.define !== "function") {
            return;
        }
        // what to show: the same parts as Paddock's Settings > Paddock HUD, kept in line with it
        const show = function (part, label, on) {
            return { key: partKey(part), type: "toggle", label: label, value: on !== false };
        };
        opts = LOADER.settings.define(NAME, [
            { key: "secStrip", type: "section", label: "Strip", flow: "chips" },
            show("lap", "Lap"),
            show("current", "Current"),
            show("predicted", "Predicted"),
            show("best", "All-time best"),
            show("session", "Session best"),
            show("last", "Last lap"),
            show("inputs", "Pedals vs reference"),
            { key: "secAround", type: "section", label: "Above and below the strip", flow: "chips" },
            show("shift", "Shift lights"),
            show("sectors", "Sector times"),
            { key: "secDelta", type: "section", label: "Delta", flow: "chips" },
            show("delta", "Delta and bar"),
            show("ref", "Reference name"),
            { key: "secChips", type: "section", label: "Chips under the strip", flow: "chips" },
            show("cues", "Brake cues"),
            show("corners", "Corners"),
            show("ideal", "Ideal lap"),
            show("speed", "Speed and gear", false),
            show("fuel", "Fuel"),
            show("footer", "Status"),
            { key: "secLook", type: "section", label: "Look" },
            { key: "hudScale", type: "range", label: "Size %", value: 100, min: 60, max: 160, step: 10 },
            { key: "hudOpacity", type: "range", label: "Background %", value: 85, min: 0, max: 100, step: 5 },
            { key: "secMore", type: "section", label: "Controls", collapsed: true },
            { key: "refKey", type: "key", label: "Cycle reference key", value: DEFAULTS.refKey },
            { key: "range", type: "choice", label: "Delta bar range", value: DEFAULTS.range, options: ["0.5 s", "1 s", "2 s"] },
            { key: "cueRange", type: "choice", label: "Brake countdown from", value: DEFAULTS.cueRange, options: ["100 m", "200 m", "300 m"] }
        ], { width: "30rem" });
        LOADER.settings.onChange(NAME, settingChanged);
    };

    const attach = function (root) {
        if (LOADER && LAUNCH_PAGES[PAGE]) {
            return launcherAttach(root);
        }
        const state = create(root);
        sync.state = state;
        sync.rev += 1; // draw with the settings window's values from the first frame
        if (!LOADER) {
            const params = new URLSearchParams(window.location.search);
            state.host = params.get("host") || window.location.host || DEFAULTS.host;
        }
        bindButtons(state);
        if (LOADER) {
            // a right-click on the strip opens its settings window (what to show, size, keys) beside it
            state.panel = LOADER.panel.attach(root, {
                hudId: me.hudId,
                storageKey: me.storageKey,
                log: me.log,
                onRightClick: function () {
                    return Boolean(LOADER.settings && LOADER.settings.rightClick) && LOADER.settings.rightClick(NAME, root);
                }
            });
            state.loop = LOADER.loop.start(function (now) {
                tick(state, Date.now());
            });
            if (LOADER.keys && typeof LOADER.keys.bind === "function") {
                state.unbindKey = LOADER.keys.bind(function () {
                    return opt("refKey");
                }, function () {
                    act(state, "ref");
                });
            }
        } else {
            state.loop = standalonePanel(state);
        }
        log("attached, data from " + (LOADER ? state.liveBase + "live0-7.json (time-slotted)" : "http://" + state.host));
        return state;
    };

    const detach = function (state) {
        if (state.launcher) {
            if (state.timer) {
                clearInterval(state.timer);
            }
            return;
        }
        if (LOADER) {
            LOADER.loop.stop(state.loop);
            LOADER.panel.detach(state.panel);
            if (sync.state === state) {
                sync.state = null;
            }
        } else {
            state.loop.running = false;
        }
        if (typeof state.unbindKey === "function") {
            state.unbindKey();
        }
        state.listeners.forEach(function (l) {
            l[0].removeEventListener(l[1], l[2]);
        });
        state.listeners = [];
    };

    defineSettings();

    return {
        attach: attach,
        detach: detach,
        fmtLap: fmtLap,
        fmtDelta: fmtDelta
    };
}());

if (window.ACEUIAppLoader) {
    window.ACEUIAppLoader.app("trainerhud").mount(TrainerHud.attach, TrainerHud.detach);
} else if (document.getElementById("trainerhud")) {
    TrainerHud.attach(document.getElementById("trainerhud"));
}
