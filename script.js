/* =============================================================
   ITUULI — script.js
   Modules (namespaced objects, no build step / no framework):
     Utils       -> small math helpers
     Config      -> ALL tunable thresholds live here in one place
     AudioFX     -> Web Audio beeps, no external/copyrighted audio
     Proximity   -> normalizes raw signal into a smoothed 0-100 heat score
     BluetoothIO -> real Web Bluetooth device discovery + advertisement RSSI
     DemoMode    -> pointer/touch based fallback that feeds the SAME
                    Proximity pipeline as real Bluetooth
     Game        -> timer, hot/cold change counter, found detection
     UI          -> screen switching + rendering the heat state
     Main        -> wires buttons to everything above
   ============================================================= */

/* ---------------------------------------------------------------
   Utils
   --------------------------------------------------------------- */
const Utils = {
  clamp(v, min, max) { return Math.max(min, Math.min(max, v)); },
  lerp(a, b, t) { return a + (b - a) * t; },
  formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  },
};

/* ---------------------------------------------------------------
   Config — every threshold and tunable constant lives here.
   Heat score is always 0 (ice cold) to 100 (found).
   --------------------------------------------------------------- */
const Config = {
  // Heat score bands -> visual/audio state name.
  // Edit these five numbers to retune the whole game feel.
  bands: [
    { max: 15, key: "verycold", emoji: "🥶", shout: "THANUPPU THANUPPU THANUPPU", caption: "Where did you even go bro?", cssClass: "heat-1" },
    { max: 35, key: "cold",     emoji: "❄️", shout: "THANUPPU...", caption: "Cold.", cssClass: "heat-2" },
    { max: 60, key: "warm",     emoji: "🌡️", shout: "CHUDU CHUDU 👀", caption: "Something is cooking…", cssClass: "heat-3" },
    { max: 80, key: "hot",      emoji: "🔥", shout: "CHUUUDE!", caption: "AYYO YOU'RE CLOSE", cssClass: "heat-4" },
    { max: 94, key: "veryhot",  emoji: "🔥🔥🔥", shout: "CHUUUDE CHUUUDE CHUUUDE", caption: "DA DEVICE IS BASICALLY BEHIND YOU 😭", cssClass: "heat-5" },
    { max: 100, key: "found",   emoji: "🚨🔥", shout: "FOUND IT!!!", caption: "ITUULI COMPLETE.", cssClass: "heat-found" },
  ],
  foundThreshold: 95,          // heat score that ends the game
  smoothingAlpha: 0.25,        // exponential smoothing factor (0-1, lower = smoother/laggier)
  hysteresis: 4,               // heat must move this many points before we re-render band changes
  rssiFloor: -95,              // dBm treated as "as far as it gets"
  rssiCeiling: -35,            // dBm treated as "basically found"
  demoRoomFoundRadiusPx: 34,   // how close the demo pointer must get to "find" the target (only used if Demo Mode is explicitly launched)
  beepMinIntervalMs: 900,      // slowest beep rate (very cold)
  beepMaxIntervalMs: 140,      // fastest beep rate (very hot)

  // --- Wander fallback (used whenever a real Bluetooth reading hasn't
  // arrived recently) ---
  wanderTriggerMs: 2500,       // how long without a REAL reading before wander takes over
  wanderMin: 8,                // wander never drifts colder than this
  wanderMax: 88,               // wander never drifts hotter than this — stays safely
                                // under foundThreshold so signal loss can never trigger FOUND
  wanderTargetChangeMs: 1800,  // how often wander picks a new "aim point"
  wanderStepAlpha: 0.05,       // how quickly wander drifts toward its aim point each frame (small = smooth, not jumpy)
};

/* ---------------------------------------------------------------
   AudioFX — simple original beeps via Web Audio API.
   No samples, no external files, nothing copyrighted.
   --------------------------------------------------------------- */
const AudioFX = {
  ctx: null,
  enabled: false,
  _beepTimer: null,

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // browser has no Web Audio support; game still works silently
    this.ctx = new AC();
    this.enabled = true;
  },

  _beepOnce(freq, durationMs = 70, gainLevel = 0.05) {
    if (!this.enabled || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.value = gainLevel;
    osc.connect(gain).connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    gain.gain.setValueAtTime(gainLevel, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationMs / 1000);
    osc.start(now);
    osc.stop(now + durationMs / 1000);
  },

  // Called every animation frame with the current heat (0-100).
  // Schedules beeps that speed up and rise in pitch as heat rises.
  updateHeat(heat) {
    if (!this.enabled) return;
    const interval = Utils.lerp(Config.beepMinIntervalMs, Config.beepMaxIntervalMs, heat / 100);
    if (this._beepTimer && this._nextBeepAt && performance.now() < this._nextBeepAt) return;
    const freq = Utils.lerp(320, 920, heat / 100);
    this._beepOnce(freq, 60 + (1 - heat / 100) * 40, 0.04 + (heat / 100) * 0.05);
    this._nextBeepAt = performance.now() + interval;
  },

  foundFanfare() {
    if (!this.enabled) return;
    [520, 660, 880, 1040].forEach((f, i) => {
      setTimeout(() => this._beepOnce(f, 140, 0.07), i * 90);
    });
  },

  stop() {
    this._nextBeepAt = 0;
  },
};

/* ---------------------------------------------------------------
   Proximity — turns a raw 0-100 "closeness" reading (from either
   real RSSI or the demo room) into a smoothed heat score.
   Real Bluetooth RSSI is noisy (walls, orientation, interference) —
   the smoothing + hysteresis here is what keeps the UI from
   flickering between HOT and COLD every frame.
   --------------------------------------------------------------- */
const Proximity = {
  smoothedHeat: 0,
  lastRenderedBand: null,

  // rawCloseness: 0 (far) - 100 (right on top of it)
  pushReading(rawCloseness) {
    const clamped = Utils.clamp(rawCloseness, 0, 100);
    this.smoothedHeat = Utils.lerp(this.smoothedHeat, clamped, Config.smoothingAlpha);
    return this.smoothedHeat;
  },

  reset() {
    this.smoothedHeat = 0;
    this.lastRenderedBand = null;
  },

  bandFor(heat) {
    return Config.bands.find((b) => heat <= b.max) || Config.bands[Config.bands.length - 1];
  },

  // Applies hysteresis: only reports a NEW band if we've moved far
  // enough from the edge of the last one, so the UI doesn't stutter
  // right at a threshold boundary.
  stableBandFor(heat) {
    const band = this.bandFor(heat);
    if (!this.lastRenderedBand) { this.lastRenderedBand = band; return band; }
    if (band.key === this.lastRenderedBand.key) return band;
    const edge = this.lastRenderedBand.max;
    if (Math.abs(heat - edge) < Config.hysteresis) return this.lastRenderedBand;
    this.lastRenderedBand = band;
    return band;
  },

  rssiToCloseness(rssi) {
    const t = (rssi - Config.rssiFloor) / (Config.rssiCeiling - Config.rssiFloor);
    return Utils.clamp(t * 100, 0, 100);
  },
};

/* ---------------------------------------------------------------
   BluetoothIO — real Web Bluetooth.
   HONEST LIMITATION (read before assuming this "just works"):
   A normal page cannot passively list every BLE device nearby the
   way a phone's Bluetooth settings screen can — that would be a
   privacy nightmare, so browsers forbid it. `navigator.bluetooth
   .requestDevice()` always opens the BROWSER'S OWN chooser UI,
   triggered by a user gesture, and only surfaces devices the user
   picks there. Continuous RSSI while connected is not exposed by
   the standard GATT API at all. The only path to repeated RSSI
   readings is `navigator.bluetooth.requestLEScan()` with
   `advertisementreceived` events — an EXPERIMENTAL Chromium-only
   API (Chrome/Edge on Desktop + Android, behind the
   "Experimental Web Platform features" flag in some versions).
   Safari and Firefox do not support Web Bluetooth at all.
   We feature-detect all of this and fall back to Demo Mode
   whenever the real thing isn't available.
   --------------------------------------------------------------- */
const BluetoothIO = {
  device: null,
  scanAbortController: null,
  onReading: null, // callback(rawCloseness 0-100)
  onStatus: null,  // callback(message)

  isBasicallySupported() {
    return "bluetooth" in navigator;
  },

  isScanSupported() {
    return "bluetooth" in navigator && typeof navigator.bluetooth.requestLEScan === "function";
  },

  // Opens the browser's native device picker. Resolves with a device
  // the user chose, or throws if they cancelled / denied permission.
  async pickDevice() {
    if (!this.isBasicallySupported()) {
      throw new Error("unsupported");
    }
    // acceptAllDevices lets the user pick ANY nearby advertising device
    // in the browser's own picker (we can't pre-filter what we don't
    // know about), which matches "find my earbuds / any BLE thing".
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [],
    });
    this.device = device;
    return device;
  },

  // Starts continuous RSSI updates for the chosen device via LE scan,
  // if the browser supports it. Returns true if live tracking started.
  // KNOWN PLATFORM QUIRK: on some desktop Chrome/Edge builds (notably
  // Windows and Linux) the requestLEScan() promise can hang indefinitely
  // instead of rejecting, even with the experimental flag on. Without a
  // timeout, that would freeze the whole app on the loading step rather
  // than falling back — so we race it against a short timer.
  async startLiveTracking(deviceId) {
    if (!this.isScanSupported()) return false;
    const timeout = (ms) => new Promise((_, reject) =>
      setTimeout(() => reject(new Error("LE scan timed out")), ms));

    try {
      this.scanAbortController = new AbortController();
      await Promise.race([
        navigator.bluetooth.requestLEScan({
          acceptAllAdvertisements: true,
          signal: this.scanAbortController.signal,
        }),
        timeout(4000),
      ]);
      navigator.bluetooth.addEventListener("advertisementreceived", (event) => {
        if (event.device.id !== deviceId) return;
        if (typeof event.rssi !== "number") return;
        const closeness = Proximity.rssiToCloseness(event.rssi);
        if (this.onReading) this.onReading(closeness);
      });
      return true;
    } catch (err) {
      console.warn("LE scan unavailable or timed out:", err);
      if (this.scanAbortController) {
        this.scanAbortController.abort();
        this.scanAbortController = null;
      }
      return false;
    }
  },

  stop() {
    if (this.scanAbortController) {
      this.scanAbortController.abort();
      this.scanAbortController = null;
    }
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
  },
};

/* ---------------------------------------------------------------
   DemoMode — fully functional fallback. A hidden target sits at a
   random point inside a box; the user's mouse/touch position is
   converted to a distance, then fed into the SAME Proximity
   pipeline real Bluetooth uses, so the rest of the app can't tell
   the difference.
   --------------------------------------------------------------- */
const DemoMode = {
  targetX: 0.5,
  targetY: 0.5,
  boxEl: null,
  onReading: null,

  start(boxEl) {
    this.boxEl = boxEl;
    this.targetX = 0.15 + Math.random() * 0.7;
    this.targetY = 0.15 + Math.random() * 0.7;
    const targetEl = document.getElementById("demo-target");
    targetEl.style.left = `${this.targetX * 100}%`;
    targetEl.style.top = `${this.targetY * 100}%`;

    const handler = (evt) => this._handlePointer(evt);
    this.boxEl.addEventListener("pointermove", handler);
    this._handler = handler;
  },

  _handlePointer(evt) {
    const rect = this.boxEl.getBoundingClientRect();
    const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
    const px = Utils.clamp((clientX - rect.left) / rect.width, 0, 1);
    const py = Utils.clamp((clientY - rect.top) / rect.height, 0, 1);

    const playerEl = document.getElementById("demo-player");
    playerEl.style.left = `${px * 100}%`;
    playerEl.style.top = `${py * 100}%`;

    const dx = (px - this.targetX) * rect.width;
    const dy = (py - this.targetY) * rect.height;
    const distPx = Math.sqrt(dx * dx + dy * dy);
    const maxDist = Math.sqrt(rect.width ** 2 + rect.height ** 2);
    const closeness = Utils.clamp(100 - (distPx / maxDist) * 130, 0, 100);

    if (this.onReading) this.onReading(closeness);
    // Two independent ways to detect "found" so a lucky-but-brief close
    // pass isn't missed just because the smoothing filter hadn't caught
    // up yet: raw pixel proximity, OR an (almost) maxed-out raw reading.
    if ((distPx <= Config.demoRoomFoundRadiusPx || closeness >= 99) && Game.isRunning) {
      Game.forceFound();
    }
  },

  stop() {
    if (this.boxEl && this._handler) {
      this.boxEl.removeEventListener("pointermove", this._handler);
    }
  },
};

/* ---------------------------------------------------------------
   TutorialPreview — a self-contained landing-page widget, NOT tied to
   Game/Proximity/DemoMode in any way. It's purely a "here's the idea"
   preview for people who haven't started a real search yet. It reuses
   the same pointer-to-heat math and the same band list (so what you
   see here matches what the real game shows) but keeps its own local
   smoothing state, so it can never affect — or be affected by — an
   actual in-progress search.
   --------------------------------------------------------------- */
const TutorialPreview = {
  targetX: 0.5,
  targetY: 0.5,
  boxEl: null,
  smoothedHeat: 0,
  running: false,
  _handler: null,
  _resumeTimer: null,

  start() {
    this.boxEl = document.getElementById("tutorial-box");
    if (!this.boxEl) return;
    this.smoothedHeat = 0;
    this.running = true;
    this._randomizeTarget();
    this._handler = (evt) => this._onPointer(evt);
    this.boxEl.addEventListener("pointermove", this._handler);
  },

  stop() {
    clearTimeout(this._resumeTimer);
    this.running = false;
    if (this.boxEl && this._handler) {
      this.boxEl.removeEventListener("pointermove", this._handler);
    }
  },

  _randomizeTarget() {
    this.targetX = 0.15 + Math.random() * 0.7;
    this.targetY = 0.2 + Math.random() * 0.6;
    const targetEl = document.getElementById("tutorial-target");
    if (targetEl) {
      targetEl.style.left = `${this.targetX * 100}%`;
      targetEl.style.top = `${this.targetY * 100}%`;
    }
  },

  _onPointer(evt) {
    if (!this.running || !this.boxEl) return;
    const rect = this.boxEl.getBoundingClientRect();
    const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
    const px = Utils.clamp((clientX - rect.left) / rect.width, 0, 1);
    const py = Utils.clamp((clientY - rect.top) / rect.height, 0, 1);

    const playerEl = document.getElementById("tutorial-player");
    if (playerEl) {
      playerEl.style.left = `${px * 100}%`;
      playerEl.style.top = `${py * 100}%`;
    }

    const dx = (px - this.targetX) * rect.width;
    const dy = (py - this.targetY) * rect.height;
    const distPx = Math.sqrt(dx * dx + dy * dy);
    const maxDist = Math.sqrt(rect.width ** 2 + rect.height ** 2);
    const closeness = Utils.clamp(100 - (distPx / maxDist) * 130, 0, 100);

    this.smoothedHeat = Utils.lerp(this.smoothedHeat, closeness, 0.3);
    const band = Proximity.bandFor(this.smoothedHeat); // pure lookup — doesn't touch real game state
    const emojiEl = document.getElementById("tutorial-emoji");
    const shoutEl = document.getElementById("tutorial-shout");
    if (emojiEl) emojiEl.textContent = band.emoji;
    if (shoutEl) shoutEl.textContent = band.shout;

    if (distPx <= 26 || closeness >= 99) this._onPreviewFound();
  },

  // Unlike the real game, the tutorial never "ends" — it flashes a quick
  // congratulation, then quietly picks a new hiding spot so people can
  // keep playing with it as long as the panel is open.
  _onPreviewFound() {
    if (!this.running) return;
    this.running = false;
    const flash = document.getElementById("tutorial-flash");
    if (flash) flash.hidden = false;
    this._resumeTimer = setTimeout(() => {
      if (flash) flash.hidden = true;
      this.smoothedHeat = 0;
      this._randomizeTarget();
      this.running = true;
    }, 1200);
  },
};

/* ---------------------------------------------------------------
   Game — timer, hot/cold change counter, found detection/rating.
   --------------------------------------------------------------- */
const Game = {
  isRunning: false,
  startedAt: 0,
  changeCount: 0,
  lastBandKey: null,
  targetLabel: "",
  usingRealBluetooth: false,
  _rafId: null,

  // Wander fallback state — Bluetooth is only ever an optional signal
  // source for the running game, never a condition for whether it runs.
  lastRealReadingAt: -Infinity,
  everHadLiveSignal: false,
  wanderValue: 20,
  wanderTarget: 20,
  lastWanderTargetAt: 0,

  start(targetLabel, usingRealBluetooth) {
    this.isRunning = true;
    this.startedAt = performance.now();
    this.changeCount = 0;
    this.lastBandKey = null;
    this.targetLabel = targetLabel;
    this.usingRealBluetooth = usingRealBluetooth;

    // No real reading exists yet the instant the game starts, so wander
    // takes over immediately and hands off to real Bluetooth the moment
    // (if ever) a reading actually arrives.
    this.lastRealReadingAt = -Infinity;
    this.everHadLiveSignal = false;
    this.wanderValue = 20;
    this.wanderTarget = 20;
    this.lastWanderTargetAt = performance.now();

    Proximity.reset();
    UI.setSignalStatus("searching");
    this._tick();
  },

  _tick() {
    if (!this.isRunning) return;
    const now = performance.now();
    UI.setTimer(now - this.startedAt);

    const hasLiveSignal = (now - this.lastRealReadingAt) <= Config.wanderTriggerMs;
    if (!hasLiveSignal) {
      this._advanceWander(now);
    }
    UI.setSignalStatus(hasLiveSignal ? "live" : (this.everHadLiveSignal ? "lost" : "searching"));

    this._rafId = requestAnimationFrame(() => this._tick());
  },

  // Smoothly random-walks a heat value so the game keeps producing
  // hot/cold feedback even with zero Bluetooth data. Never activates
  // the Demo Room and is capped well under the found threshold.
  _advanceWander(now) {
    if (now - this.lastWanderTargetAt > Config.wanderTargetChangeMs) {
      this.wanderTarget = Config.wanderMin + Math.random() * (Config.wanderMax - Config.wanderMin);
      this.lastWanderTargetAt = now;
    }
    this.wanderValue = Utils.lerp(this.wanderValue, this.wanderTarget, Config.wanderStepAlpha);
    this.registerReading(this.wanderValue, false);
  },

  // isReal defaults true so existing call sites (real Bluetooth readings)
  // don't need to change; wander explicitly passes false.
  registerReading(rawCloseness, isReal = true) {
    if (!this.isRunning) return;
    if (isReal) {
      this.lastRealReadingAt = performance.now();
      this.everHadLiveSignal = true;
    }

    const heat = Proximity.pushReading(rawCloseness);
    const band = Proximity.stableBandFor(heat);
    if (band.key !== this.lastBandKey) {
      if (this.lastBandKey !== null) this.changeCount += 1;
      this.lastBandKey = band.key;
    }
    UI.renderHeat(heat, band, this.changeCount);
    AudioFX.updateHeat(heat);
    // Wander is capped below Config.foundThreshold (see Config), so only
    // a genuine real reading can ever cross it — signal loss can't
    // accidentally end the game.
    if (heat >= Config.foundThreshold) this.forceFound();
  },

  forceFound() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    const elapsed = performance.now() - this.startedAt;
    AudioFX.foundFanfare();
    UI.showFound({
      target: this.targetLabel,
      heat: Math.round(Proximity.smoothedHeat),
      elapsedMs: elapsed,
      changes: this.changeCount,
    });
  },

  stop() {
    this.isRunning = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
  },
};

/* ---------------------------------------------------------------
   UI — screen switching and rendering.
   --------------------------------------------------------------- */
const UI = {
  els: {},

  cacheEls() {
    this.els = {
      screens: document.querySelectorAll(".screen"),
      toast: document.getElementById("toast"),
      howBtn: document.getElementById("btn-how"),
      howPanel: document.getElementById("how-it-works"),
      supportNote: document.getElementById("support-note"),
      deviceList: document.getElementById("device-list"),
      lockBanner: document.getElementById("lock-banner"),
      lockDeviceName: document.getElementById("lock-device-name"),
      modePill: document.getElementById("mode-pill"),
      targetName: document.getElementById("target-name"),
      heatStage: document.getElementById("heat-stage"),
      heatEmoji: document.getElementById("heat-emoji"),
      heatShout: document.getElementById("heat-shout"),
      heatCaption: document.getElementById("heat-caption"),
      heatMeterFill: document.getElementById("heat-meter-fill"),
      heatLabel: document.getElementById("heat-label"),
      demoRoom: document.getElementById("demo-room"),
      statTime: document.getElementById("stat-time"),
      statChanges: document.getElementById("stat-changes"),
      fsTarget: document.getElementById("fs-target"),
      fsSense: document.getElementById("fs-sense"),
      fsTime: document.getElementById("fs-time"),
      fsChanges: document.getElementById("fs-changes"),
      fsRating: document.getElementById("fs-rating"),
    };
  },

  showScreen(name) {
    this.els.screens.forEach((s) => s.classList.toggle("is-active", s.dataset.screen === name));
  },

  toast(msg, ms = 3200) {
    this.els.toast.textContent = msg;
    this.els.toast.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.els.toast.hidden = true; }, ms);
  },

  toggleHow() {
    const open = this.els.howPanel.hidden;
    this.els.howPanel.hidden = !open;
    this.els.howBtn.setAttribute("aria-expanded", String(open));
    this.els.howBtn.textContent = open ? "Hide the nerdy explanation ↑" : "How does this actually work? ↓";
    if (open) {
      TutorialPreview.start();
    } else {
      TutorialPreview.stop();
    }
  },

  renderDeviceList(devices) {
    this.els.deviceList.hidden = devices.length === 0;
    this.els.deviceList.innerHTML = "";
    devices.forEach((d) => {
      const card = document.createElement("div");
      card.className = "device-card";
      card.innerHTML = `
        <div class="device-info">
          <span class="device-name">${d.name}</span>
          <span class="device-meta">${d.meta}</span>
        </div>
        <button class="device-select-btn">SELECT</button>
      `;
      card.querySelector(".device-select-btn").addEventListener("click", () => Main.onDeviceChosen(d));
      this.els.deviceList.appendChild(card);
    });
  },

  showLocked(name) {
    this.els.lockDeviceName.textContent = name;
    this.els.lockBanner.hidden = false;
  },

  setMode(usingReal) {
    // Kept for compatibility; setSignalStatus is the live/lost/searching
    // tri-state now driving the pill during gameplay.
    this.setSignalStatus(usingReal ? "live" : "searching");
  },

  setSignalStatus(state) {
    const pill = this.els.modePill;
    pill.classList.toggle("is-lost", state === "lost");
    if (state === "live") pill.textContent = "LIVE BLUETOOTH";
    else if (state === "lost") pill.textContent = "SIGNAL LOST — KEEP SEARCHING";
    else pill.textContent = "SEARCHING…";
  },

  setTarget(name) {
    this.els.targetName.textContent = name;
  },

  showDemoRoom(show) {
    this.els.demoRoom.hidden = !show;
  },

  renderHeat(heat, band, changeCount) {
    this.els.heatStage.className = `heat-stage ${band.cssClass}`;
    this.els.heatEmoji.textContent = band.emoji;
    this.els.heatShout.textContent = band.shout;
    this.els.heatCaption.textContent = band.caption;
    this.els.heatMeterFill.style.width = `${Math.round(heat)}%`;
    this.els.heatLabel.innerHTML = `Bluetooth Heat: ${Math.round(heat)}% <span class="heat-label-note">(signal estimate, not exact distance)</span>`;
    this.els.statChanges.textContent = String(changeCount);
  },

  setTimer(elapsedMs) {
    this.els.statTime.textContent = Utils.formatTime(elapsedMs);
  },

  showFound({ target, heat, elapsedMs, changes }) {
    this.els.fsTarget.textContent = target;
    this.els.fsSense.textContent = `${heat}%`;
    this.els.fsTime.textContent = Utils.formatTime(elapsedMs);
    this.els.fsChanges.textContent = String(changes);
    this.els.fsRating.textContent = Main.rateRun(heat, elapsedMs, changes);
    this.showScreen("found");
  },
};

/* ---------------------------------------------------------------
   Main — wires everything together.
   --------------------------------------------------------------- */
const Main = {
  chosenDeviceLabel: "🎧 AirPods",
  usingRealBluetooth: false,
  realDevice: null,

  init() {
    UI.cacheEls();
    document.getElementById("btn-start").addEventListener("click", () => UI.showScreen("select"));
    document.getElementById("btn-how").addEventListener("click", () => UI.toggleHow());
    document.getElementById("btn-scan").addEventListener("click", () => this.onScanClicked());
    document.getElementById("btn-go-search").addEventListener("click", () => this.beginSearch());
    document.getElementById("btn-abandon").addEventListener("click", () => this.goHome());
    document.getElementById("btn-play-again").addEventListener("click", () => this.playAgain());
    document.getElementById("btn-home").addEventListener("click", () => this.goHome());

    this.reportSupport();
  },

  async reportSupport() {
    if (!BluetoothIO.isBasicallySupported()) {
      UI.els.supportNote.textContent =
        "This browser doesn't expose Web Bluetooth at all (common on Safari/iOS/Firefox) — Ituuli will still run, just without a live signal.";
      return;
    }

    // getAvailability() tells us whether the OS/browser sees ANY Bluetooth
    // radio at all — this is the single most useful diagnostic for "why
    // don't I see devices", since it separates "no adapter" from
    // "adapter fine, just no live-scan support" from "should just work".
    let adapterPresent = null;
    if (typeof navigator.bluetooth.getAvailability === "function") {
      try {
        adapterPresent = await navigator.bluetooth.getAvailability();
      } catch (err) {
        adapterPresent = null;
      }
    }

    if (adapterPresent === false) {
      UI.els.supportNote.textContent =
        "⚠️ This browser can't find any Bluetooth adapter on this computer. Check that Bluetooth is turned on at the OS level (Windows Settings → Bluetooth & devices) — Ituuli will still run either way, just without a live signal until that's on.";
      return;
    }

    if (!BluetoothIO.isScanSupported()) {
      UI.els.supportNote.textContent =
        "Bluetooth adapter found. This browser can pick a device but can't stream live signal strength yet — enable chrome://flags/#enable-experimental-web-platform-features and relaunch for a chance at live tracking. Ituuli runs fine without it either way.";
    } else {
      UI.els.supportNote.textContent =
        "Bluetooth adapter found and live signal scanning looks supported here. Real Bluetooth heat tracking will be attempted.";
    }

    // Keep the note honest if the user toggles Bluetooth off/on mid-session.
    if (typeof navigator.bluetooth.addEventListener === "function") {
      navigator.bluetooth.addEventListener("availabilitychanged", (event) => {
        if (event.value === false) {
          UI.els.supportNote.textContent =
            "⚠️ Bluetooth adapter is no longer available to this browser — check your OS Bluetooth setting. Ituuli keeps running regardless.";
        } else {
          this.reportSupport();
        }
      });
    }
  },

  async onScanClicked() {
    if (!BluetoothIO.isBasicallySupported()) {
      UI.toast("This browser doesn't support Bluetooth scanning — Ituuli will still run, just without a live signal.");
      this.onDeviceChosen({ name: "🔍 Unknown Signal", meta: "No Bluetooth on this browser", isDemo: true });
      return;
    }
    try {
      const device = await BluetoothIO.pickDevice();
      this.onDeviceChosen({
        name: `📶 ${device.name || "Unnamed BLE device"}`,
        meta: device.id ? "Connected via browser picker" : "",
        isDemo: false,
        raw: device,
      });
    } catch (err) {
      if (err && err.name === "NotFoundError") {
        UI.toast("No device picked — Ituuli will still run without a live signal.");
      } else {
        UI.toast("Bluetooth permission denied or unavailable — Ituuli will still run without a live signal.");
        console.warn(err);
      }
      this.onDeviceChosen({ name: "🔍 Unknown Signal", meta: "No live Bluetooth signal", isDemo: true });
    }
  },

  onDeviceChosen(d) {
    this.chosenDeviceLabel = d.name;
    this.usingRealBluetooth = !d.isDemo;
    this.realDevice = d.raw || null;
    UI.renderDeviceList([]); // clear list, only one pick allowed per round
    UI.showLocked(d.name);
  },

  // The Ituuli game NEVER waits on or depends on Bluetooth. It starts the
  // instant the user presses START SEARCHING; a real Bluetooth reading
  // (if one ever arrives) simply steers the heat value while it's fresh.
  // If it's stale or never arrives, Game's built-in wander fallback keeps
  // producing hot/cold feedback on its own — the Demo Room is never
  // shown as part of this flow.
  async beginSearch() {
    UI.setTarget(this.chosenDeviceLabel);
    AudioFX.init();

    UI.showDemoRoom(false);
    UI.showScreen("search");
    Game.start(this.chosenDeviceLabel, this.usingRealBluetooth);

    if (this.usingRealBluetooth && this.realDevice) {
      BluetoothIO.onReading = (closeness) => Game.registerReading(closeness, true);
      // Fire-and-forget: attempting the live scan never blocks or gates
      // the game, which is already running above.
      BluetoothIO.startLiveTracking(this.realDevice.id);
    }
  },

  rateRun(heat, elapsedMs, changes) {
    const seconds = elapsedMs / 1000;
    if (seconds < 8 && changes <= 3) return "Certified Device Hunter";
    if (seconds < 20) return "Professional Signal Tracker";
    if (changes > 10) return "Chaotic Good Energy";
    return "Patient Persistence Award";
  },

  playAgain() {
    Game.stop();
    BluetoothIO.stop();
    UI.showScreen("select");
  },

  goHome() {
    Game.stop();
    BluetoothIO.stop();
    UI.showScreen("landing");
  },
};

document.addEventListener("DOMContentLoaded", () => Main.init());
 
