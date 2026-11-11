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
        nextCorner: true,
        cues: true,
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
    const sendCommand = function (state, cmd, arg) {
        state.cmdSeq += 1;
        const msg = { id: Date.now() + "-" + state.cmdSeq, at: Date.now(), cmd: cmd, arg: arg };
        if (window.console) {
            window.console.log("[TrainerHUD-cmd] " + JSON.stringify(msg));
            window.console.log("[TrainerHUD-pad] " + PAD);
            window.console.log("[TrainerHUD-pad] " + PAD);
        }
        state.flash = { text: "sent to Paddock...", at: Date.now(), bad: false };
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
            state.data = json;
            state.receivedAt = Date.now();
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
        return "<div class=\"th-cell " + cls + "\"><div class=\"th-time\">-:--.---</div><div class=\"th-label\">" + label + "</div></div>";
    };

    const MARKUP = ""
        + "<div class=\"th-top\">"
        + "<div class=\"th-ref th-btn\" data-act=\"ref\">vs ALL-TIME BEST</div>"
        + "<div class=\"th-tag\"></div>"
        + "</div>"
        + "<div class=\"th-stack\">"
        + "<div class=\"th-bar\"><div class=\"th-fill th-left\"></div><div class=\"th-fill th-right\"></div><div class=\"th-mid\"></div></div>"
        + "<div class=\"th-main\"><div class=\"th-delta\">--.---</div></div>"
        + "</div>"
        + "<div class=\"th-cells\">"
        + cell("th-c-pred", "PREDICTED")
        + cell("th-c-best", "ALL-TIME BEST")
        + cell("th-c-sess", "SESSION BEST")
        + cell("th-c-last", "LAST LAP")
        + "</div>"
        + "<div class=\"th-row th-cue\"><div class=\"th-cue-a\"></div><div class=\"th-cue-track\"><div class=\"th-cue-fill\"></div></div><div class=\"th-cue-b\"></div></div>"
        + "<div class=\"th-row th-pot\"><div class=\"th-ideal\">IDEAL -:--.---</div><div class=\"th-gap\"></div></div>"
        + "<div class=\"th-row th-corner\"><div class=\"th-lastc\"></div><div class=\"th-nextc\"></div></div>"
        + "<div class=\"th-row th-foot\"><div class=\"th-link\"></div><div class=\"th-saved\"></div></div>";

    const q = function (root, sel) {
        return root.querySelector(sel);
    };

    const create = function (root) {
        root.classList.add("ace-trainerhud");
        if (!q(root, ".th-stack") || !q(root, ".th-cue")) {
            root.innerHTML = MARKUP;
        }
        return {
            root: root,
            el: {
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
                saved: q(root, ".th-saved")
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
        const cue = d && opt("cues") ? d.cue : null;
        let a = "";
        let b = "";
        let fill = 0;
        let mode = "";
        let near = false;
        let thrCls = "";
        setClass(state, state.el.cue, "cue", "th-off", !opt("cues") || !d);
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
        setTransform(state, "cueFill", "scaleX(" + fill.toFixed(3) + ")");
        setClass(state, state.el.cue, "cue", "th-count", mode === "count");
        setClass(state, state.el.cue, "cue", "th-near", near);
        setClass(state, state.el.cueB, "cueB", "gain", mode === "res" && thrCls === "gain");
        setClass(state, state.el.cueB, "cueB", "lose", mode === "res" && thrCls === "lose");
    };

    const render = function (state, now) {
        const d = state.data;
        const root = state.root;
        const range = RANGES[opt("range")] || 1000;
        let deltaMs = null;
        let rate = 0;

        setClass(state, root, "root", "th-offline", !d);

        if (d) {
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
            setText(state, "ideal", "IDEAL " + fmtLap(t.idealMs));
            setText(state, "gap", t.idealMs && t.bestMs ? "potential " + fmtDelta(t.idealMs - t.bestMs, 3) + " vs best" : "");
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
            if (c.next && opt("nextCorner")) {
                const n = c.next;
                let txt = n.name;
                if (!opt("cues") && n.brakeInM !== null && n.brakeInM !== undefined) {
                    txt += " · " + n.brakeKind + " in " + n.brakeInM + " m";
                }
                txt += " · min " + Math.round(n.minSpeed) + " km/h · G" + n.minGear;
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
            setText(state, "link", d.combo ? "PADDOCK" : "PADDOCK - waiting for track");
        } else {
            const g = gameView();
            deltaMs = g.delta;
            setText(state, "ref", "vs GAME REFERENCE");
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

        renderCue(state, now);

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
            const p = JSON.parse(window.localStorage.getItem(KEY) || "null");
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
        opts = LOADER.settings.define(NAME, [
            { key: "refKey", type: "key", label: "Cycle reference key", value: DEFAULTS.refKey },
            { key: "range", type: "choice", label: "Delta bar range", value: DEFAULTS.range, options: ["0.5 s", "1 s", "2 s"] },
            { key: "nextCorner", type: "toggle", label: "Show next corner", value: DEFAULTS.nextCorner },
            { key: "cues", type: "toggle", label: "Brake / throttle cues", value: DEFAULTS.cues },
            { key: "cueRange", type: "choice", label: "Brake countdown from", value: DEFAULTS.cueRange, options: ["100 m", "200 m", "300 m"] }
        ]);
    };

    const attach = function (root) {
        if (LOADER && LAUNCH_PAGES[PAGE]) {
            return launcherAttach(root);
        }
        const state = create(root);
        if (!LOADER) {
            const params = new URLSearchParams(window.location.search);
            state.host = params.get("host") || window.location.host || DEFAULTS.host;
        }
        bindButtons(state);
        if (LOADER) {
            state.panel = LOADER.panel.attach(root, { hudId: me.hudId, storageKey: me.storageKey, log: me.log });
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
