// ============================================================================
// ATTRACT MODE — a meta space-invaders → orbital defense game
// One continuous Three.js scene: arcade cabinet → ship rec deck → Earth orbit.
// ============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------
const CFG = {
  earthR: 600,
  cloudR: 600 * 1.005,
  hazeR: 600 * 1.012,
  atmoR: 600 * 1.035,
  atmoEntry: 645,          // enemies start burning here
  impactR: 604,            // surface impact
  bandMin: 700, bandMax: 900,
  hardMin: 660, hardMax: 1180,
  spawnR: 1100,
  shipStartDist: 9500,
  moonDist: 7600, moonR: 162,
  starR: 15000,
  sunDir: new THREE.Vector3(-0.55, 0.22, 0.80).normalize(),
  shipDir: new THREE.Vector3(0.60, 0.10, 0.79).normalize(), // ship spawn bearing from Earth
  earthSpinRate: (Math.PI * 2) / 480,   // 1 rev / 8 min
  cloudSpinRate: (Math.PI * 2) / 480 * 1.35,
  arc: { W: 256, H: 224 },
  maxImpacts: 24,
};
const TAU = Math.PI * 2;

// ----------------------------------------------------------------------------
// Small utils (zero-alloc temps live here too)
// ----------------------------------------------------------------------------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();
const _v7 = new THREE.Vector3(), _v8 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _c1 = new THREE.Color();

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const easeIO = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const easeOut = t => 1 - Math.pow(1 - t, 3);

function makeRNG(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const rng = makeRNG(0xC0FFEE);

// value noise + fbm (for canvas texture generation)
const _perm = new Uint8Array(512);
{ const r = makeRNG(1337); const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) _perm[i] = p[i & 255]; }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const aa = _perm[(_perm[xi & 255] + yi) & 255] / 255;
  const ba = _perm[(_perm[(xi + 1) & 255] + yi) & 255] / 255;
  const ab = _perm[(_perm[xi & 255] + yi + 1) & 255] / 255;
  const bb = _perm[(_perm[(xi + 1) & 255] + yi + 1) & 255] / 255;
  return lerp(lerp(aa, ba, u), lerp(ab, bb, u), v);
}
function fbm(x, y, oct = 5, lac = 2.02, gain = 0.5) {
  let a = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { a += vnoise(x * f, y * f) * amp; norm += amp; amp *= gain; f *= lac; }
  return a / norm;
}
// fbm that wraps horizontally (for equirect maps) — samples on a cylinder
function fbmWrap(u, v, scale, oct) {
  const a = u * TAU;
  return fbm(100 + Math.cos(a) * scale, 100 + Math.sin(a) * scale * 0.5 + v * scale * 2, oct);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}
// lat/lon (deg) → unit vector matching THREE.SphereGeometry equirect UVs
function latLonToV3(lat, lon, out) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  out.set(-Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
  return out;
}
const $ = id => document.getElementById(id);

// ----------------------------------------------------------------------------
// Global state
// ----------------------------------------------------------------------------
const S = {
  mode: 'BOOT',          // BOOT | ARCADE | REVEAL | ROAM | SIT | DEFENSE | FALLEN
  now: 0,                // world-clock seconds since page load (never pauses)
  arcT: -1,              // seconds since arcade game started (-1 = not started)
  revealT: 0, sitT: 0,
  paused: false,
  hitstop: 0, slowmo: 0,
  shake: 0,
  earthDist: CFG.shipStartDist,   // current ship distance from Earth center (pre-flight rail)
  approachBurn: false, burnT: 0, burnFrom: 0,
  integrity: 100,
  hull: 100, shield: 0, lastHullHit: -99,
  score: 0, best: 0, kills: 0, shots: 0, hits: 0,
  wave: 0, waveState: 'idle', waveT: 0,   // idle | spawning | active | intermission
  combo: 1, comboT: 0,
  missiles: 2, missileCap: 2, missileRegen: 0,
  upg: { fireMul: 1, barrels: 2, shieldRegen: false, slowmo: false },
  slowmoCD: 0,
  thirdPerson: false,
  overlayOn: false,
  defenseT: 0,
  startedAt: 0,
  fpsEMA: 60, lowFPSTime: 0, degraded: false,
};
try { S.best = parseInt(localStorage.getItem('attractmode.best') || '0', 10) || 0; } catch (e) { S.best = 0; }

// grab-bag for cross-module objects, assembled during init
const G = {};

// ----------------------------------------------------------------------------
// Input
// ----------------------------------------------------------------------------
const IN = {
  keys: Object.create(null),
  pressed: Object.create(null),   // true for one frame
  mdx: 0, mdy: 0,
  lmb: false, rmb: false, rmbPressed: false, rmbReleased: false,
  locked: false,
};
window.addEventListener('keydown', e => {
  if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
  if (!e.repeat) IN.pressed[e.code] = true;
  IN.keys[e.code] = true;
});
window.addEventListener('keyup', e => { IN.keys[e.code] = false; });
window.addEventListener('mousemove', e => {
  if (IN.locked) { IN.mdx += e.movementX; IN.mdy += e.movementY; }
});
window.addEventListener('mousedown', e => {
  if (e.button === 0) IN.lmb = true;
  if (e.button === 2) { IN.rmb = true; IN.rmbPressed = true; }
});
window.addEventListener('mouseup', e => {
  if (e.button === 0) IN.lmb = false;
  if (e.button === 2) { IN.rmb = false; IN.rmbReleased = true; }
});
window.addEventListener('contextmenu', e => e.preventDefault());
// focus loss swallows keyup events — clear all held-key state
function clearHeldInput() {
  for (const k in IN.keys) IN.keys[k] = false;
  IN.lmb = IN.rmb = false;
}
window.addEventListener('blur', clearHeldInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearHeldInput(); });
document.addEventListener('pointerlockchange', () => {
  IN.locked = document.pointerLockElement === document.body;
  if (!IN.locked && (S.mode === 'ROAM' || S.mode === 'DEFENSE')) {
    S.paused = true;
    uiPrompt('CLICK TO RESUME', '');
  }
});
function requestLock() {
  try {
    const p = document.body.requestPointerLock();
    if (p && typeof p.catch === 'function') p.catch(() => { });
  } catch (e) { /* pointer lock unavailable — clicks will retry */ }
}
function endFrameInput() {
  for (const k in IN.pressed) IN.pressed[k] = false;
  IN.rmbPressed = false; IN.rmbReleased = false;
  IN.mdx = 0; IN.mdy = 0;
}

// ----------------------------------------------------------------------------
// UI helpers
// ----------------------------------------------------------------------------
let _toastTimer = 0;
function uiToast(msg, secs = 1.8) {
  const t = $('toast'); t.textContent = msg; t.style.opacity = '1';
  _toastTimer = secs;
}
function uiPrompt(main, sub) {
  const p = $('prompt'), s = $('subprompt');
  if (main) { p.textContent = main; p.classList.remove('hidden'); } else p.classList.add('hidden');
  if (sub) { s.textContent = sub; s.classList.remove('hidden'); } else s.classList.add('hidden');
}
// ============================================================================
// AUDIO — everything synthesized, no files
// ============================================================================
const AUD = {
  ctx: null, ok: false,
  master: null, sfx: null, music: null, world: null, arcadeBus: null,
  verb: null, verbSend: null,
  noiseBuf: null,
  listener: null, cabAudio: null,
  // sequencer
  musicMode: 'none', bossLayer: false, step: 0, nextT: 0, bar: 0,
  // ambience timers
  klaxonT: 0, creakT: 8, heartT: 0, muffle: null,
  engine: null, engineGain: null, engineNoiseGain: null, engineSub: null,
  lockOscT: 0,

  init() {
    if (this.ok) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    THREE.AudioContext.setContext(this.ctx);
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = 0.85;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22; comp.ratio.value = 5;
    this.master.connect(comp); comp.connect(c.destination);
    this.sfx = c.createGain(); this.sfx.gain.value = 0.72; this.sfx.connect(this.master);
    this.music = c.createGain(); this.music.gain.value = 0.0; this.music.connect(this.master);
    this.world = c.createGain(); this.world.gain.value = 0.0; this.world.connect(this.master);
    this.arcadeBus = c.createGain(); this.arcadeBus.gain.value = 0.55; this.arcadeBus.connect(this.master);
    // procedural impulse reverb
    const len = (c.sampleRate * 1.6) | 0;
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8) * 0.5; }
    this.verb = c.createConvolver(); this.verb.buffer = ir;
    const vg = c.createGain(); vg.gain.value = 0.55;
    this.verb.connect(vg); vg.connect(this.master);
    this.verbSend = c.createGain(); this.verbSend.gain.value = 1; this.verbSend.connect(this.verb);
    // noise buffer
    const nb = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;
    // listener on camera — route its output through master so positional audio
    // (the cabinet) also passes the master gain + compressor
    this.listener = new THREE.AudioListener();
    try {
      this.listener.gain.disconnect();
      this.listener.gain.connect(this.master);
    } catch (e) { /* keep default routing */ }
    G.camera.add(this.listener);
    this.ok = true;
    this.nextT = c.currentTime;
  },

  // ------- primitive voices -------
  osc(type, f0, t0, dur, vol, dest, o = {}) {
    const c = this.ctx, os = c.createOscillator(), g = c.createGain();
    os.type = type; os.frequency.setValueAtTime(f0, t0);
    if (o.f1 !== undefined) os.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + (o.fT || dur));
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + (o.a || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    os.connect(g);
    let out = g;
    if (o.lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; f.Q.value = o.q || 0.8; out.connect(f); out = f; }
    out.connect(dest || this.sfx);
    if (o.verb) { const vs = c.createGain(); vs.gain.value = o.verb; out.connect(vs); vs.connect(this.verbSend); }
    os.start(t0); os.stop(t0 + dur + 0.05);
    return os;
  },
  noise(t0, dur, vol, dest, o = {}) {
    const c = this.ctx, src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + (o.a || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let head = src;
    if (o.bp) { const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(o.bp, t0);
      if (o.bp1) f.frequency.exponentialRampToValueAtTime(o.bp1, t0 + dur); f.Q.value = o.q || 1; head.connect(f); head = f; }
    if (o.lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(o.lp, t0);
      if (o.lp1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.lp1), t0 + dur); head.connect(f); head = f; }
    if (o.hp) { const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = o.hp; head.connect(f); head = f; }
    head.connect(g); g.connect(dest || this.sfx);
    if (o.verb) { const vs = c.createGain(); vs.gain.value = o.verb; g.connect(vs); vs.connect(this.verbSend); }
    src.start(t0); src.stop(t0 + dur + 0.05);
  },

  // ------- arcade SFX (routed via arcadeBus so they can become positional) -------
  arcStep(i) { if (!this.ok) return; const f = [82.4, 77.8, 73.4, 69.3][i & 3];
    this.osc('square', f, this.ctx.currentTime, 0.09, 0.30, this.arcadeBus, { lp: 500 }); },
  arcPew() { if (!this.ok) return;
    this.osc('square', 980, this.ctx.currentTime, 0.16, 0.16, this.arcadeBus, { f1: 120, lp: 2600 }); },
  arcBoom() { if (!this.ok) return; const t = this.ctx.currentTime;
    this.noise(t, 0.22, 0.30, this.arcadeBus, { lp: 900, lp1: 120 }); },
  arcPlayerDeath() { if (!this.ok) return; const t = this.ctx.currentTime;
    this.noise(t, 0.55, 0.40, this.arcadeBus, { lp: 1400, lp1: 90 });
    this.osc('sawtooth', 220, t, 0.5, 0.22, this.arcadeBus, { f1: 30, lp: 800 }); },
  arcUI() { if (!this.ok) return;
    this.osc('square', 660, this.ctx.currentTime, 0.07, 0.10, this.arcadeBus); },

  // move arcade audio into the world (positional, tinny)
  attachArcadeToCabinet(mesh) {
    if (!this.ok || this.cabAudio) return;
    const c = this.ctx;
    this.arcadeBus.disconnect();
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.7;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 320;
    this.arcadeBus.connect(hp); hp.connect(lp);
    const pa = new THREE.PositionalAudio(this.listener);
    pa.setNodeSource(lp);
    pa.setRefDistance(1.1); pa.setRolloffFactor(2.2);
    mesh.add(pa);
    this.cabAudio = pa;
    this.arcadeBus.gain.value = 0.8;
    // tiny reverb send: the room
    const vs = c.createGain(); vs.gain.value = 0.25; lp.connect(vs); vs.connect(this.verbSend);
  },

  // ------- world / cinematic -------
  startWorldAmbience() {
    if (!this.ok || this._amb) return; this._amb = true;
    const c = this.ctx, t = c.currentTime;
    this.world.gain.cancelScheduledValues(t);
    this.world.gain.setValueAtTime(Math.max(0.0001, this.world.gain.value), t);
    this.world.gain.exponentialRampToValueAtTime(0.55, t + 5);
    // 55 Hz engine drone
    const d1 = c.createOscillator(); d1.type = 'sawtooth'; d1.frequency.value = 55;
    const d2 = c.createOscillator(); d2.type = 'sine'; d2.frequency.value = 41.2;
    const dg = c.createGain(); dg.gain.value = 0.16;
    const dl = c.createBiquadFilter(); dl.type = 'lowpass'; dl.frequency.value = 150;
    d1.connect(dl); d2.connect(dg); dl.connect(dg); dg.connect(this.world);
    d1.start(); d2.start();
    // air recycler hiss
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const bf = c.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 3400; bf.Q.value = 0.4;
    const ng = c.createGain(); ng.gain.value = 0.016;
    src.connect(bf); bf.connect(ng); ng.connect(this.world);
    src.start();
  },
  klaxon(muffled) {
    if (!this.ok) return; const c = this.ctx, t = c.currentTime;
    const lp = muffled ? 420 : 2200;
    this.osc('sawtooth', 392, t, 0.42, 0.14, this.world, { lp, a: 0.06, verb: 0.5 });
    this.osc('sawtooth', 294, t + 0.46, 0.42, 0.14, this.world, { lp, a: 0.06, verb: 0.5 });
  },
  creak() { if (!this.ok) return; const t = this.ctx.currentTime;
    this.noise(t, 0.9, 0.05, this.world, { bp: 140 + Math.random() * 200, bp1: 60, q: 9, a: 0.25, verb: 0.8 }); },
  footstep() { if (!this.ok) return; const t = this.ctx.currentTime;
    this.noise(t, 0.09, 0.18, this.sfx, { lp: 240, lp1: 90 });
    this.osc('sine', 70, t, 0.08, 0.12, this.sfx, { f1: 45 }); },
  servo(dur = 2.4) { if (!this.ok) return; const t = this.ctx.currentTime;
    this.osc('sawtooth', 70, t, dur, 0.10, this.sfx, { f1: 48, fT: dur, lp: 320, a: 0.2, verb: 0.6 });
    this.noise(t, dur, 0.05, this.sfx, { bp: 900, q: 2, a: 0.3 });
    this.osc('sine', 36, t + dur - 0.18, 0.3, 0.25, this.sfx, { f1: 24 }); }, // clunk
  uiBlip(f = 880) { if (!this.ok) return;
    this.osc('square', f, this.ctx.currentTime, 0.05, 0.06, this.sfx, { lp: 4000 }); },
  bootBlip(i) { if (!this.ok) return;
    this.osc('square', 520 + i * 60, this.ctx.currentTime, 0.045, 0.05, this.sfx, { lp: 3000 }); },
  upgradeChime() { if (!this.ok) return; const t = this.ctx.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => this.osc('triangle', f, t + i * 0.07, 0.3, 0.10, this.sfx, { verb: 0.6 })); },

  // ------- combat SFX -------
  laser() { if (!this.ok) return; const t = this.ctx.currentTime;
    this.osc('sawtooth', 1450, t, 0.11, 0.10, this.sfx, { f1: 320, lp: 3800 });
    this.noise(t, 0.05, 0.05, this.sfx, { hp: 2400 }); },
  plasma() { if (!this.ok) return; const t = this.ctx.currentTime;
    this.osc('square', 240, t, 0.25, 0.09, this.sfx, { f1: 90, lp: 1200 }); },
  boom(size = 1, pan = 0) { if (!this.ok) return; const t = this.ctx.currentTime;
    const v = clamp(0.14 * size, 0.06, 0.5);
    this.noise(t, 0.5 * size, v, this.sfx, { lp: 2600, lp1: 100, verb: 0.7 });
    this.osc('sine', 110 * Math.min(1.5, size), t, 0.4 * size, v * 0.9, this.sfx, { f1: 28 }); },
  hitSpark() { if (!this.ok) return;
    this.noise(this.ctx.currentTime, 0.06, 0.08, this.sfx, { bp: 3300, q: 2 }); },
  deflect() { if (!this.ok) return;
    this.osc('triangle', 1900, this.ctx.currentTime, 0.12, 0.07, this.sfx, { f1: 700 }); },
  lockTick(p) { if (!this.ok) return;
    this.osc('square', 700 + 700 * p, this.ctx.currentTime, 0.045, 0.06, this.sfx); },
  lockOn() { if (!this.ok) return; const t = this.ctx.currentTime;
    this.osc('square', 1560, t, 0.09, 0.09, this.sfx); this.osc('square', 1560, t + 0.11, 0.09, 0.09, this.sfx); },
  missile() { if (!this.ok) return; const t = this.ctx.currentTime;
    this.noise(t, 1.0, 0.16, this.sfx, { lp: 1800, lp1: 300, a: 0.02 });
    this.osc('sawtooth', 180, t, 0.8, 0.08, this.sfx, { f1: 60, lp: 700 }); },
  alarm() { if (!this.ok) return; const t = this.ctx.currentTime;
    this.osc('square', 820, t, 0.12, 0.10, this.sfx, { lp: 2000 });
    this.osc('square', 620, t + 0.15, 0.12, 0.10, this.sfx, { lp: 2000 }); },
  bigImpact() { if (!this.ok) return; const t = this.ctx.currentTime;
    this.noise(t, 1.4, 0.3, this.sfx, { lp: 700, lp1: 60, verb: 0.9 });
    this.osc('sine', 60, t, 1.1, 0.3, this.sfx, { f1: 22 }); },
  comboUp(n) { if (!this.ok) return;
    this.osc('triangle', 600 + n * 120, this.ctx.currentTime, 0.1, 0.08, this.sfx); },
  hullHit() { if (!this.ok) return; const t = this.ctx.currentTime;
    this.noise(t, 0.3, 0.22, this.sfx, { lp: 1500, lp1: 200 });
    this.osc('sine', 90, t, 0.25, 0.2, this.sfx, { f1: 40 }); },

  // ------- ship engine loop (defense) -------
  startEngine() {
    if (!this.ok || this.engine) return;
    const c = this.ctx;
    const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 62;
    const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = 46;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 240;
    const g = c.createGain(); g.gain.value = 0.0;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const nf = c.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 420; nf.Q.value = 0.6;
    const ng = c.createGain(); ng.gain.value = 0.0;
    o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(this.sfx);
    src.connect(nf); nf.connect(ng); ng.connect(this.sfx);
    o1.start(); o2.start(); src.start();
    this.engine = o1; this.engineSub = o2; this.engineGain = g; this.engineNoiseGain = ng; this._engLP = lp; this._engNF = nf;
  },
  setEngine(thr, boost) {
    if (!this.engine) return;
    const c = this.ctx, t = c.currentTime, k = boost ? 1.6 : 1;
    const off = thr <= 0 && !boost;        // allow true silence (e.g. EARTH HAS FALLEN)
    this.engine.frequency.setTargetAtTime(62 * (1 + thr * 0.9) * k, t, 0.1);
    this.engineSub.frequency.setTargetAtTime(46 * (1 + thr * 0.5) * k, t, 0.1);
    this._engLP.frequency.setTargetAtTime(240 + thr * 700 + (boost ? 600 : 0), t, 0.1);
    this.engineGain.gain.setTargetAtTime(off ? 0 : 0.05 + thr * 0.09 + (boost ? 0.05 : 0), t, off ? 0.5 : 0.12);
    this.engineNoiseGain.gain.setTargetAtTime(off ? 0 : 0.012 + thr * 0.035 + (boost ? 0.05 : 0), t, off ? 0.5 : 0.12);
    this._engNF.frequency.setTargetAtTime(420 + thr * 900 + (boost ? 1400 : 0), t, 0.15);
  },

  // ------- music sequencer -------
  setMusic(mode) {
    if (!this.ok) return;
    if (this.musicMode === mode) return;
    this.musicMode = mode;
    const t = this.ctx.currentTime;
    this.music.gain.cancelScheduledValues(t);
    this.music.gain.setValueAtTime(Math.max(0.0001, this.music.gain.value), t);
    const target = mode === 'none' ? 0.0001 : mode === 'combat' ? 0.40 : mode === 'somber' ? 0.34 : 0.26;
    this.music.gain.exponentialRampToValueAtTime(Math.max(0.0001, target), t + 2.5);
    this.step = 0; this.bar = 0; this.nextT = t + 0.05;
  },
  update(dt) {
    if (!this.ok) return;
    const c = this.ctx, now = c.currentTime;
    // ambience pulses
    if (this._amb) {
      this.klaxonT -= dt;
      if (this.klaxonT <= 0 && (S.mode === 'REVEAL' || S.mode === 'ROAM')) {
        this.klaxon(false); this.klaxonT = 4.2;
      }
      this.creakT -= dt;
      if (this.creakT <= 0) { this.creak(); this.creakT = 8 + Math.random() * 14; }
    }
    // sequencer
    if (this.musicMode === 'none') return;
    const bpm = this.musicMode === 'combat' ? 112 : 46;
    const sixteenth = 60 / bpm / 4;
    // resync after tab was backgrounded — never replay stale steps
    if (now - this.nextT > 0.3) this.nextT = now + 0.05;
    while (this.nextT < now + 0.18) {
      this.schedStep(this.step, this.nextT);
      this.nextT += sixteenth;
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar = (this.bar + 1) % 4;
    }
  },
  schedStep(st, t) {
    const M = this.music;
    if (this.musicMode === 'ambient') {
      // slow heartbeat + sparse low pad
      if (st === 0) { this.osc('sine', 52, t, 0.18, 0.30, M, { f1: 38 }); this.osc('sine', 52, t + 0.34, 0.16, 0.22, M, { f1: 36 }); }
      if (st === 8 && this.bar % 2 === 0) this.osc('sine', 110, t, 2.2, 0.05, M, { a: 0.9, lp: 300, verb: 0.7 });
      return;
    }
    if (this.musicMode === 'somber') {
      if (st === 0) { const r = [110, 98, 87.3, 103.8][this.bar];
        this.osc('sawtooth', r, t, 4.4, 0.07, M, { a: 1.6, lp: 420, verb: 1.2 });
        this.osc('sawtooth', r * 1.19, t, 4.4, 0.05, M, { a: 1.8, lp: 380, verb: 1.2 }); }
      return;
    }
    // combat synthwave
    const roots = [55, 43.65, 65.41, 49.0];
    const root = roots[this.bar];
    const arp = [0, 12, 0, 0, 7, 0, 12, 0, 0, 12, 0, 7, 10, 7, 3, 0];
    // bass pluck every 16th
    const semi = arp[st];
    const f = root * Math.pow(2, semi / 12);
    this.osc('sawtooth', f * 2, t, 0.14, 0.13, M, { lp: 750, q: 6 });
    // kick on quarters
    if (st % 4 === 0) this.osc('sine', 130, t, 0.14, 0.34, M, { f1: 38 });
    // offbeat hats
    if (st % 4 === 2) this.noise(t, 0.035, 0.05, M, { hp: 7000 });
    // pad at bar start
    if (st === 0) {
      this.osc('sawtooth', root * 4, t, 1.9, 0.030, M, { a: 0.5, lp: 1000, verb: 0.8 });
      this.osc('sawtooth', root * 4 * 1.189, t, 1.9, 0.026, M, { a: 0.5, lp: 1000, verb: 0.8 });
    }
    if (this.bossLayer) {
      const lead = [12, 15, 19, 24, 19, 15, 12, 10, 12, 15, 19, 22, 24, 22, 19, 15][st];
      this.osc('square', root * 4 * Math.pow(2, lead / 12), t, 0.11, 0.045, M, { lp: 2600, verb: 0.5 });
      if (st % 2 === 1) this.noise(t, 0.03, 0.035, M, { hp: 8000 });
    }
  },
};
// ============================================================================
// ARCADE — pixel font, sprites, and the full Space Invaders clone
// ============================================================================
const FONT = {
  'A':[0x7E,0x11,0x11,0x11,0x7E],'B':[0x7F,0x49,0x49,0x49,0x36],'C':[0x3E,0x41,0x41,0x41,0x22],
  'D':[0x7F,0x41,0x41,0x22,0x1C],'E':[0x7F,0x49,0x49,0x49,0x41],'F':[0x7F,0x09,0x09,0x09,0x01],
  'G':[0x3E,0x41,0x49,0x49,0x7A],'H':[0x7F,0x08,0x08,0x08,0x7F],'I':[0x00,0x41,0x7F,0x41,0x00],
  'J':[0x20,0x40,0x41,0x3F,0x01],'K':[0x7F,0x08,0x14,0x22,0x41],'L':[0x7F,0x40,0x40,0x40,0x40],
  'M':[0x7F,0x02,0x0C,0x02,0x7F],'N':[0x7F,0x04,0x08,0x10,0x7F],'O':[0x3E,0x41,0x41,0x41,0x3E],
  'P':[0x7F,0x09,0x09,0x09,0x06],'Q':[0x3E,0x41,0x51,0x21,0x5E],'R':[0x7F,0x09,0x19,0x29,0x46],
  'S':[0x46,0x49,0x49,0x49,0x31],'T':[0x01,0x01,0x7F,0x01,0x01],'U':[0x3F,0x40,0x40,0x40,0x3F],
  'V':[0x1F,0x20,0x40,0x20,0x1F],'W':[0x3F,0x40,0x38,0x40,0x3F],'X':[0x63,0x14,0x08,0x14,0x63],
  'Y':[0x07,0x08,0x70,0x08,0x07],'Z':[0x61,0x51,0x49,0x45,0x43],
  '0':[0x3E,0x51,0x49,0x45,0x3E],'1':[0x00,0x42,0x7F,0x40,0x00],'2':[0x42,0x61,0x51,0x49,0x46],
  '3':[0x21,0x41,0x45,0x4B,0x31],'4':[0x18,0x14,0x12,0x7F,0x10],'5':[0x27,0x45,0x45,0x45,0x39],
  '6':[0x3C,0x4A,0x49,0x49,0x30],'7':[0x01,0x71,0x09,0x05,0x03],'8':[0x36,0x49,0x49,0x49,0x36],
  '9':[0x06,0x49,0x49,0x29,0x1E],
  '-':[0x08,0x08,0x08,0x08,0x08],'<':[0x08,0x14,0x22,0x41,0x00],'>':[0x00,0x41,0x22,0x14,0x08],
  '=':[0x14,0x14,0x14,0x14,0x14],'.':[0x00,0x60,0x60,0x00,0x00],'!':[0x00,0x00,0x5F,0x00,0x00],
  '*':[0x2A,0x1C,0x7F,0x1C,0x2A],'/':[0x20,0x10,0x08,0x04,0x02],':':[0x00,0x36,0x36,0x00,0x00],
  ' ':[0,0,0,0,0],
};

function parseSprite(rows) {
  const h = rows.length, w = rows[0].length, bits = [];
  for (let y = 0; y < h; y++) { let b = 0;
    for (let x = 0; x < w; x++) if (rows[y][x] === '#') b |= (1 << x);
    bits.push(b); }
  return { w, h, bits, rows };
}
const SPR = {
  squidA: parseSprite([
    '...##...','..####..','.######.','##.##.##','########','..#..#..','.#.##.#.','#.#..#.#']),
  squidB: parseSprite([
    '...##...','..####..','.######.','##.##.##','########','.#.##.#.','#......#','.#....#.']),
  crabA: parseSprite([
    '..#.....#..','...#...#...','..#######..','.##.###.##.','###########','#.#######.#','#.#.....#.#','...##.##...']),
  crabB: parseSprite([
    '..#.....#..','#..#...#..#','#.#######.#','###.###.###','###########','.#########.','..#.....#..','.#.......#.']),
  octA: parseSprite([
    '....####....','.##########.','############','###..##..###','############','...##..##...','..##.##.##..','##........##']),
  octB: parseSprite([
    '....####....','.##########.','############','###..##..###','############','..###..###..','.##..##..##.','..##....##..']),
  player: parseSprite([
    '......#......','.....###.....','.....###.....','.############','#############','#############','#############','#############']),
  boomA: parseSprite([
    '#..#..#..#','.#..##..#.','..######..','.########.','..######..','.#..##..#.','#..#..#..#','..........']),
  boomB: parseSprite([
    '....#.....','#..###..#.','.#.....#..','..##.##...','#...#...##','..#...#...','.#..#..#..','#....#...#']),
};

class ArcadeGame {
  constructor() {
    const [c, x] = makeCanvas(CFG.arc.W, CFG.arc.H);
    this.canvas = c; this.ctx = x;
    x.imageSmoothingEnabled = false;
    this.state = 'TITLE'; // TITLE | PLAY | GAMEOVER | ATTRACT
    this.t = 0; this.acc = 0; this.frame = 0;
    this.onFinalDeath = null;
    this.resetGame();
    this.attractT = 0; this.attractPage = 0;
    this.flash = 0;
    this.draw();
  }
  resetGame() {
    this.score = 0; this.lives = 3;
    this.playerX = 120; this.playerVX = 0; this.playerAlive = true; this.respawnT = 0;
    this.pBullet = null;
    this.eBullets = [];
    this.explosions = [];
    this.gridDir = 1; this.stepTimer = 0; this.noteI = 0;
    this.fireTimer = 1.2;
    this.rig = { level: 0, nextEsc: 5.0, wave2: false, failsafeT: 8.0 };
    this.deadTime = -1; this.goBlink = 0;
    this.invaders = [];
    const types = [0, 1, 1, 2, 2]; // squid / crab / crab / oct / oct
    for (let r = 0; r < 5; r++) for (let c2 = 0; c2 < 11; c2++)
      this.invaders.push({ type: types[r], x: 26 + c2 * 16, y: 38 + r * 13, alive: true, col: c2 });
    this.bunkers = [];
    for (let b = 0; b < 4; b++) {
      const g = []; const W = 22, H = 14;
      for (let y = 0; y < H; y++) { const row = [];
        for (let x2 = 0; x2 < W; x2++) {
          let on = true;
          if (y < 4 && (x2 < 4 - y || x2 >= W - (4 - y))) on = false;       // sloped shoulders
          if (y >= H - 5 && x2 >= 7 && x2 < W - 7 && y >= H - (x2 < 11 ? (x2 - 4) : (W - 5 - x2))) on = false;
          if (y >= H - 4 && x2 >= 8 && x2 < W - 8) on = false;              // doorway notch
          row.push(on); }
        g.push(row); }
      this.bunkers.push({ x: 30 + b * 54, y: 168, g, W, H });
    }
  }
  start() { this.state = 'PLAY'; this.t = 0; this.resetGame(); }

  // ---- helpers ----
  sprite(inv) {
    const f = this.frame & 1;
    if (inv.type === 0) return f ? SPR.squidB : SPR.squidA;
    if (inv.type === 1) return f ? SPR.crabB : SPR.crabA;
    return f ? SPR.octB : SPR.octA;
  }
  aliveCount() { let n = 0; for (const i of this.invaders) if (i.alive) n++; return n; }
  stepInterval() {
    const base = clamp(this.aliveCount() * 0.016 + 0.04, 0.07, 0.95);
    return base * Math.pow(0.6, this.rig.level);
  }
  bulletSpeed() { return 62 * Math.pow(1.25, this.rig.level); }
  maxEB() { return 3 + this.rig.level * 4; }

  update(dt) {
    this.t += dt; this.acc += dt;
    const T = 1 / 60;
    while (this.acc >= T) { this.acc -= T; this.tick(T); }
    this.draw();
  }

  tick(T) {
    if (this.state === 'TITLE') return;
    if (this.state === 'ATTRACT') { this.attractT += T; return; }
    if (this.state === 'GAMEOVER') {
      this.goBlink += T;
      if (this.goBlink > 2.5) { this.state = 'ATTRACT'; this.attractT = 0; }
      this.updExplosions(T);
      return;
    }
    // ---- PLAY ----
    const t = this.t;
    // rig escalation
    if (t >= this.rig.nextEsc && this.rig.level < 6) { this.rig.level++; this.rig.nextEsc += 0.75; }
    // quietly rig the lives so the FINAL death always lands in the 7–9s window
    if (t >= 7.0 && this.lives > 2) this.lives = 2;
    if (t >= 8.0 && this.lives > 1) this.lives = 1;
    if (t >= 6.5 && !this.rig.wave2) {
      this.rig.wave2 = true;
      for (let r = 0; r < 2; r++) for (let c = 0; c < 11; c++)
        this.invaders.push({ type: r === 0 ? 1 : 2, x: 26 + c * 16, y: 112 + r * 13, alive: true, col: c });
    }
    // player move
    let vx = 0;
    if (IN.keys['ArrowLeft'] || IN.keys['KeyA']) vx -= 78;
    if (IN.keys['ArrowRight'] || IN.keys['KeyD']) vx += 78;
    this.playerVX = vx;
    if (this.playerAlive) {
      this.playerX = clamp(this.playerX + vx * T, 10, 233);
      if ((IN.keys['Space'] || IN.keys['ArrowUp']) && !this.pBullet) {
        this.pBullet = { x: this.playerX + 6, y: 198 };
        AUD.arcPew();
      }
    } else if (this.lives > 0) {
      this.respawnT -= T;
      if (this.respawnT <= 0) { this.playerAlive = true; this.playerX = 120; }
    }
    // grid stepping
    this.stepTimer -= T;
    if (this.stepTimer <= 0) {
      this.stepTimer = this.stepInterval();
      let minX = 999, maxX = -999, maxY = -999;
      for (const i of this.invaders) if (i.alive) {
        minX = Math.min(minX, i.x); maxX = Math.max(maxX, i.x + this.sprite(i).w); maxY = Math.max(maxY, i.y);
      }
      if (minX > 900) { /* none left */ } else {
        const dx = 2 * this.gridDir;
        if ((this.gridDir > 0 && maxX + dx > 248) || (this.gridDir < 0 && minX + dx < 8)) {
          this.gridDir *= -1;
          for (const i of this.invaders) if (i.alive) i.y += 8;
        } else for (const i of this.invaders) if (i.alive) i.x += dx;
        this.frame++;
        AUD.arcStep(this.noteI++);
        // invader reaches player line or bunkers
        for (const i of this.invaders) if (i.alive) {
          if (i.y + 8 >= 196 && this.playerAlive) this.killPlayer();
          for (const b of this.bunkers) this.erodeRect(b, i.x, i.y, this.sprite(i).w, 8);
        }
      }
    }
    // enemy fire
    this.fireTimer -= T;
    const liveEB = this.eBullets.filter(b => b.live).length;
    if (this.fireTimer <= 0 && liveEB < this.maxEB()) {
      this.fireTimer = clamp(0.85 * Math.pow(0.62, this.rig.level), 0.08, 0.9);
      this.enemyFire(t >= 5 && Math.random() < 0.7);
    }
    // failsafe — perfectly led volley from real, nearby invaders
    if (t >= this.rig.failsafeT && this.playerAlive) {
      this.rig.failsafeT = t + 0.3;
      const spd = Math.max(this.bulletSpeed(), 210);
      for (const off of [-26, 0, 26]) {
        const src = this.bottomInvaderNearest(this.predictX(spd) + off);
        if (src) this.spawnEB(src, spd);
      }
    }
    // player bullet
    if (this.pBullet) {
      this.pBullet.y -= 330 * T;
      const pb = this.pBullet;
      if (pb.y < 26) this.pBullet = null;
      else {
        for (const i of this.invaders) {
          if (!i.alive) continue;
          const s = this.sprite(i);
          if (pb.x >= i.x && pb.x < i.x + s.w && pb.y >= i.y && pb.y < i.y + 8) {
            i.alive = false; this.pBullet = null;
            this.score += i.type === 0 ? 30 : i.type === 1 ? 20 : 10;
            this.explosions.push({ x: i.x, y: i.y, t: 0.25 });
            AUD.arcBoom();
            break;
          }
        }
        if (this.pBullet) for (const b of this.bunkers)
          if (this.hitBunker(b, pb.x, pb.y, 2)) { this.pBullet = null; break; }
      }
    }
    // enemy bullets
    for (const b of this.eBullets) {
      if (!b.live) continue;
      b.y += b.vy * T; b.zig += T * 14;
      if (b.y > 214) { b.live = false; continue; }
      let blocked = false;
      for (const bk of this.bunkers) if (this.hitBunker(bk, b.x, b.y + 3, 2)) { b.live = false; blocked = true; break; }
      if (blocked) continue;
      if (this.playerAlive && b.y + 4 >= 198 && b.y <= 207 && b.x >= this.playerX && b.x <= this.playerX + 13) {
        b.live = false; this.killPlayer();
      }
    }
    this.updExplosions(T);
  }
  updExplosions(T) {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      this.explosions[i].t -= T;
      if (this.explosions[i].t <= 0) this.explosions.splice(i, 1);
    }
    if (this.flash > 0) this.flash -= T;
  }
  predictX(spd) {
    const travel = (200 - 130) / spd;
    return clamp(this.playerX + 6 + this.playerVX * travel, 12, 244);
  }
  bottomInvaderNearest(px) {
    const bottoms = new Map();
    for (const i of this.invaders) if (i.alive) {
      const k = Math.round(i.x / 4);
      const cur = bottoms.get(k);
      if (!cur || i.y > cur.y) bottoms.set(k, i);
    }
    let best = null, bd = 1e9;
    for (const i of bottoms.values()) {
      const d = Math.abs(i.x + 5 - px);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  enemyFire(aimed) {
    let src = null;
    if (aimed) src = this.bottomInvaderNearest(this.predictX(this.bulletSpeed()));
    else {
      const alive = this.invaders.filter(i => i.alive);
      if (!alive.length) return;
      const pick = alive[(Math.random() * alive.length) | 0];
      src = this.bottomInvaderNearest(pick.x + 5);
    }
    if (src) this.spawnEB(src, this.bulletSpeed());
  }
  spawnEB(src, spd) {
    let b = this.eBullets.find(b2 => !b2.live);
    if (!b) { b = {}; this.eBullets.push(b); }
    b.live = true; b.x = src.x + Math.floor(this.sprite(src).w / 2); b.y = src.y + 9; b.vy = spd; b.zig = Math.random() * 9;
  }
  hitBunker(b, x, y, blast) {
    const lx = Math.floor(x - b.x), ly = Math.floor(y - b.y);
    if (lx < 0 || lx >= b.W || ly < 0 || ly >= b.H || !b.g[ly][lx]) return false;
    for (let dy = -blast; dy <= blast + 1; dy++) for (let dx = -blast - 1; dx <= blast + 1; dx++) {
      const X = lx + dx, Y = ly + dy;
      if (X >= 0 && X < b.W && Y >= 0 && Y < b.H && Math.random() < 0.82) b.g[Y][X] = false;
    }
    return true;
  }
  erodeRect(b, x, y, w, h) {
    const x0 = Math.max(0, Math.floor(x - b.x)), x1 = Math.min(b.W, Math.ceil(x + w - b.x));
    const y0 = Math.max(0, Math.floor(y - b.y)), y1 = Math.min(b.H, Math.ceil(y + h - b.y));
    for (let Y = y0; Y < y1; Y++) for (let X = x0; X < x1; X++) b.g[Y][X] = false;
  }
  killPlayer() {
    if (!this.playerAlive) return;
    this.playerAlive = false;
    this.lives--;
    // a careless player can't burn the last life before the invasion moment
    if (this.lives <= 0 && this.t < 6.8) this.lives = 1;
    this.explosions.push({ x: this.playerX, y: 198, t: 0.8, player: true });
    this.flash = 0.09;
    AUD.arcPlayerDeath();
    if (this.lives <= 0) {
      this.state = 'GAMEOVER'; this.goBlink = 0; this.deadTime = this.t;
      if (this.onFinalDeath) { const f = this.onFinalDeath; this.onFinalDeath = null; f(); }
    } else this.respawnT = this.t >= 7 ? 0.25 : 0.7;
  }

  // ---- drawing ----
  px(x, y, w, h, col) { this.ctx.fillStyle = col; this.ctx.fillRect(x | 0, y | 0, w, h); }
  drawSprite(s, x, y, col) {
    this.ctx.fillStyle = col;
    for (let r = 0; r < s.h; r++) { const bits = s.bits[r];
      for (let c = 0; c < s.w; c++) if (bits & (1 << c)) this.ctx.fillRect((x + c) | 0, (y + r) | 0, 1, 1); }
  }
  text(str, x, y, col) {
    this.ctx.fillStyle = col;
    for (let i = 0; i < str.length; i++) {
      const g = FONT[str[i].toUpperCase()] || FONT[' '];
      for (let c = 0; c < 5; c++) { const bits = g[c];
        for (let r = 0; r < 7; r++) if (bits & (1 << r)) this.ctx.fillRect(x + i * 6 + c, y + r, 1, 1); }
    }
  }
  textC(str, y, col) { this.text(str, Math.floor((256 - str.length * 6) / 2), y, col); }
  draw() {
    const x = this.ctx;
    x.fillStyle = '#000'; x.fillRect(0, 0, 256, 224);
    const W = '#dff2ff', GRN = '#52ff70', RED = '#ff5a4e', CYN = '#7adfff', AMB = '#ffb454';
    // HUD
    this.text('SCORE<1>', 8, 2, W); this.text('HI-SCORE', 100, 2, W); this.text('SCORE<2>', 192, 2, W);
    this.text(String(this.score).padStart(4, '0'), 16, 12, GRN);
    this.text('999999', 106, 12, W);
    this.text('0000', 200, 12, W);
    if (this.state === 'TITLE') {
      this.textC('COSMIC INVADERS', 64, CYN);
      this.drawSprite(SPR.squidA, 92, 88, W); this.drawSprite(SPR.crabA, 120, 88, W); this.drawSprite(SPR.octA, 150, 88, W);
      if (Math.floor(performance.now() / 480) % 2 === 0) this.textC('CLICK TO START', 130, AMB);
      this.textC('CREDIT 00', 208, W);
      return;
    }
    if (this.state === 'ATTRACT') { this.drawAttract(); return; }
    // bunkers
    for (const b of this.bunkers) {
      x.fillStyle = GRN;
      for (let r = 0; r < b.H; r++) for (let c = 0; c < b.W; c++)
        if (b.g[r][c]) x.fillRect(b.x + c, b.y + r, 1, 1);
    }
    // invaders
    for (const i of this.invaders) if (i.alive)
      this.drawSprite(this.sprite(i), i.x, i.y, i.y < 60 ? W : i.y < 100 ? W : W);
    // player
    if (this.playerAlive) this.drawSprite(SPR.player, this.playerX, 198, GRN);
    // bullets
    if (this.pBullet) this.px(this.pBullet.x, this.pBullet.y, 1, 4, W);
    x.fillStyle = W;
    for (const b of this.eBullets) if (b.live) {
      const zx = Math.round(Math.sin(b.zig) * 1.5);
      x.fillRect(b.x + zx, b.y, 1, 2); x.fillRect(b.x - zx, b.y + 2, 1, 2);
    }
    // explosions
    for (const e of this.explosions) {
      const s = (Math.floor(e.t * 16) & 1) ? SPR.boomA : SPR.boomB;
      this.drawSprite(s, e.x, e.y, e.player ? RED : W);
    }
    // ground + lives
    x.fillStyle = GRN; x.fillRect(0, 214, 256, 1);
    this.text(String(Math.max(0, this.lives)), 8, 216, W);
    for (let l = 0; l < Math.max(0, this.lives - 1); l++) this.drawSprite(SPR.player, 22 + l * 16, 216, GRN);
    this.text('CREDIT 00', 196, 216, W);
    if (this.state === 'GAMEOVER' && (Math.floor(this.goBlink * 3) % 2 === 0))
      this.textC('GAME OVER', 92, RED);
    if (this.flash > 0) { x.fillStyle = 'rgba(255,255,255,0.55)'; x.fillRect(0, 0, 256, 224); }
  }
  drawAttract() {
    const W = '#dff2ff', GRN = '#52ff70', CYN = '#7adfff', AMB = '#ffb454';
    const page = Math.floor(this.attractT / 5.5) % 3;
    const blink = Math.floor(this.attractT * 2) % 2 === 0;
    if (page === 0) {
      this.textC('COSMIC INVADERS', 56, CYN);
      this.textC('TRAINING SIMULATOR', 70, W);
      const bob = Math.floor(Math.sin(this.attractT * 2.2) * 2);
      this.drawSprite((Math.floor(this.attractT * 2) & 1) ? SPR.squidB : SPR.squidA, 90, 96 + bob, W);
      this.drawSprite((Math.floor(this.attractT * 2) & 1) ? SPR.crabB : SPR.crabA, 120, 96 - bob, W);
      this.drawSprite((Math.floor(this.attractT * 2) & 1) ? SPR.octB : SPR.octA, 152, 96 + bob, W);
      if (blink) this.textC('INSERT COIN', 150, AMB);
    } else if (page === 1) {
      this.textC('*HI-SCORES*', 48, CYN);
      const rows = [['AAA', '999999'], ['KOA', '124850'], ['VEGA', '098210'], ['RIN', '087400'], ['JUN', '051200']];
      rows.forEach((r2, i) => {
        const col = i === 0 ? AMB : W;
        this.text(String(i + 1), 70, 70 + i * 14, col);
        this.text(r2[0], 92, 70 + i * 14, col);
        this.text(r2[1], 140, 70 + i * 14, col);
      });
      if (blink) this.textC('INSERT COIN', 160, AMB);
    } else {
      this.textC('*SCORE ADVANCE TABLE*', 50, CYN);
      this.drawSprite(SPR.squidA, 86, 76, W); this.text('=30 POINTS', 104, 77, W);
      this.drawSprite(SPR.crabA, 84, 96, W); this.text('=20 POINTS', 104, 97, W);
      this.drawSprite(SPR.octA, 84, 116, W); this.text('=10 POINTS', 104, 117, W);
      if (blink) this.textC('INSERT COIN', 160, AMB);
    }
    this.text('CREDIT 00', 196, 216, '#dff2ff');
  }
}
// ============================================================================
// RENDERER / SCENE / SKY
// ============================================================================
// kept as semantic markers; lighting separation is done via sun-intensity
// choreography (sun stays low until the canopy opens), not via layers —
// three.js light.layers gates lights against the camera, not per object.
function sunlit(obj) { return obj; }

function initRenderer() {
  const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  r.setSize(window.innerWidth, window.innerHeight);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.05;
  r.domElement.classList.add('webgl');
  document.body.prepend(r.domElement);
  G.renderer = r;

  G.scene = new THREE.Scene();
  G.scene.background = new THREE.Color(0x000000);

  G.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 40000);

  // ship rig: rig (steering frame) → bank (cosmetic roll) → room + camera
  G.shipRig = new THREE.Object3D();
  G.bank = new THREE.Object3D();
  G.shipRig.add(G.bank);
  G.camShake = new THREE.Object3D();
  G.bank.add(G.camShake);
  G.camShake.add(G.camera);
  G.scene.add(G.shipRig);
  G.shipRig.position.copy(CFG.shipDir).multiplyScalar(CFG.shipStartDist);
  // orient ship so Earth lies off the port side (local -X), forward tangent to orbit
  const eDir = _v1.copy(CFG.shipDir).negate();                  // toward Earth
  const xAxis = _v2.copy(eDir).negate().normalize();            // local +X away from Earth
  const zAxis = _v3.crossVectors(xAxis, _v4.set(0, 1, 0)).normalize();
  const yAxis = _v5.crossVectors(zAxis, xAxis).normalize();
  _m1.makeBasis(xAxis, yAxis, zAxis);
  G.shipRig.quaternion.setFromRotationMatrix(_m1);

  // sun — starts faint (sealed interior), floods in when the canopy opens
  const sun = new THREE.DirectionalLight(0xfff2dd, 0.3);
  sun.position.copy(CFG.sunDir).multiplyScalar(8000);
  sun.target.position.set(0, 0, 0);
  G.scene.add(sun); G.scene.add(sun.target);
  G.sunLight = sun;
  const spaceAmb = new THREE.AmbientLight(0x36465e, 0.42);
  G.scene.add(spaceAmb);

  // composer
  const w = window.innerWidth, h = window.innerHeight;
  G.composer = new EffectComposer(r);
  G.composer.addPass(new RenderPass(G.scene, G.camera));
  G.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.75, 0.42, 0.85);
  G.composer.addPass(G.bloom);
  G.composer.addPass(new OutputPass());
  // patch the stock FXAA shader's -100.0 sample bias (D3D/ANGLE warns; -16 is the clamp anyway)
  G.fxaa = new ShaderPass({
    name: FXAAShader.name,
    uniforms: FXAAShader.uniforms,
    vertexShader: FXAAShader.vertexShader,
    fragmentShader: FXAAShader.fragmentShader.split('-100.0').join('-16.0'),
  });
  G.composer.addPass(G.fxaa);
  setFXAARes();
  window.addEventListener('resize', onResize);
}
function setFXAARes() {
  const pr = G.renderer.getPixelRatio();
  G.fxaa.material.uniforms['resolution'].value.set(1 / (window.innerWidth * pr), 1 / (window.innerHeight * pr));
}
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  G.camera.aspect = w / h;
  G.camera.updateProjectionMatrix();
  G.renderer.setSize(w, h);
  G.composer.setSize(w, h);
  setFXAARes();
  if (S.mode === 'BOOT' || S.mode === 'ARCADE') placeArcadeCamera();
}

// ---- starfield / nebula / moon / sun sprite ----
function buildSky() {
  const N = 6500, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), siz = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = rng() * 2 - 1, a = rng() * TAU, rr = CFG.starR * (0.9 + rng() * 0.25);
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = s * Math.cos(a) * rr; pos[i * 3 + 1] = u * rr; pos[i * 3 + 2] = s * Math.sin(a) * rr;
    const giant = i < 42;
    const t = rng();
    let cr, cg, cb;
    if (giant) { if (t < 0.4) { cr = 1; cg = 0.55; cb = 0.4; } else if (t < 0.7) { cr = 0.6; cg = 0.75; cb = 1; } else { cr = 1; cg = 0.92; cb = 0.6; } }
    else if (t < 0.75) { cr = cg = cb = 0.85 + rng() * 0.15; }
    else if (t < 0.9) { cr = 0.75; cg = 0.85; cb = 1; }
    else { cr = 1; cg = 0.9; cb = 0.78; }
    const b = giant ? 1 : 0.4 + rng() * 0.6;
    col[i * 3] = cr * b; col[i * 3 + 1] = cg * b; col[i * 3 + 2] = cb * b;
    siz[i] = giant ? 120 + rng() * 110 : 26 + rng() * 46;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute vec3 aCol; attribute float aSize;
      varying vec3 vC; varying float vTw;
      uniform float uTime;
      void main(){
        vC = aCol;
        vTw = 0.78 + 0.22 * sin(uTime * (1.5 + fract(aSize) * 4.0) + position.x);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (2200.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vC; varying float vTw;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.08, d);
        gl_FragColor = vec4(vC * vTw, a);
      }`,
  });
  G.starMat = m;
  const stars = new THREE.Points(g, m);
  stars.frustumCulled = false;
  G.scene.add(stars);

  // nebula sprites
  for (let i = 0; i < 5; i++) {
    const [c, x] = makeCanvas(256, 256);
    const img = x.createImageData(256, 256);
    const hue = [[80, 60, 140], [40, 90, 130], [130, 60, 100], [60, 110, 90], [90, 70, 150]][i];
    for (let p = 0, j = 0; p < 256 * 256; p++, j += 4) {
      const px2 = p % 256, py = (p / 256) | 0;
      const dx = px2 / 256 - 0.5, dy = py / 256 - 0.5;
      const fall = Math.max(0, 1 - 2.2 * Math.sqrt(dx * dx + dy * dy));
      const n = Math.pow(fbm(px2 / 64 + i * 37, py / 64, 5), 2.2) * fall;
      img.data[j] = hue[0]; img.data[j + 1] = hue[1]; img.data[j + 2] = hue[2];
      img.data[j + 3] = n * 255;
    }
    x.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sm = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending });
    const sp = new THREE.Sprite(sm);
    const u = rng() * 2 - 1, a = rng() * TAU, s = Math.sqrt(1 - u * u);
    sp.position.set(s * Math.cos(a), u, s * Math.sin(a)).multiplyScalar(13000);
    sp.scale.setScalar(7000 + rng() * 5000);
    G.scene.add(sp);
  }

  // moon
  const [mc, mx] = makeCanvas(512, 256);
  const mi = mx.createImageData(512, 256);
  for (let p = 0, j = 0; p < 512 * 256; p++, j += 4) {
    const px2 = p % 512, py = (p / 512) | 0;
    let v = 0.55 + 0.4 * fbm(px2 / 50, py / 50, 5);
    // craters
    const cr = fbm(px2 / 14 + 80, py / 14 + 80, 3);
    if (cr > 0.62) v *= 0.78;
    if (cr > 0.7) v *= 0.82;
    const g8 = clamp(v * 200, 30, 235);
    mi.data[j] = g8; mi.data[j + 1] = g8; mi.data[j + 2] = g8 * 0.98; mi.data[j + 3] = 255;
  }
  mx.putImageData(mi, 0, 0);
  const mtex = new THREE.CanvasTexture(mc); mtex.colorSpace = THREE.SRGBColorSpace;
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(CFG.moonR, 48, 32),
    new THREE.MeshStandardMaterial({ map: mtex, bumpMap: mtex, bumpScale: 2.5, roughness: 0.95, metalness: 0 }));
  moon.position.set(-0.78, 0.16, -0.55).normalize().multiplyScalar(CFG.moonDist);
  sunlit(moon);
  G.scene.add(moon);

  // sun disc sprite
  const [sc, sx] = makeCanvas(128, 128);
  const grd = sx.createRadialGradient(64, 64, 2, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,252,240,1)'); grd.addColorStop(0.12, 'rgba(255,244,210,1)');
  grd.addColorStop(0.3, 'rgba(255,210,140,0.35)'); grd.addColorStop(1, 'rgba(255,190,120,0)');
  sx.fillStyle = grd; sx.fillRect(0, 0, 128, 128);
  const stex = new THREE.CanvasTexture(sc); stex.colorSpace = THREE.SRGBColorSpace;
  const sunSp = new THREE.Sprite(new THREE.SpriteMaterial({ map: stex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  sunSp.position.copy(CFG.sunDir).multiplyScalar(20000);
  sunSp.scale.setScalar(2600);
  G.scene.add(sunSp);
  G.sunSprite = sunSp;
}

// project world point to screen px; returns false if behind camera
const _proj = new THREE.Vector3();
function worldToScreen(wp, out) {
  _proj.copy(wp).project(G.camera);
  out.x = (_proj.x * 0.5 + 0.5) * window.innerWidth;
  out.y = (-_proj.y * 0.5 + 0.5) * window.innerHeight;
  out.z = _proj.z;
  return _proj.z < 1 && Math.abs(_proj.x) < 1.4 && Math.abs(_proj.y) < 1.4;
}
const _flarePos = { x: 0, y: 0, z: 0 };
const _flareEls = [null, null, null];
const _flareK = [0, 0.45, 0.95];
const _flareA = [0.8, 0.35, 0.3];
let _flareWasZero = false;
function updateFlares() {
  // DOM lens flare along sun→center axis
  if (!_flareEls[0]) { _flareEls[0] = $('fl0'); _flareEls[1] = $('fl1'); _flareEls[2] = $('fl2'); }
  G.camera.getWorldDirection(_v1);
  const d = _v1.dot(CFG.sunDir);
  let vis = 0;
  if (d > 0.55 && (S.mode === 'SIT' || S.mode === 'DEFENSE' || S.mode === 'FALLEN')) {
    if (worldToScreen(G.sunSprite.position, _flarePos)) vis = smooth(clamp((d - 0.55) / 0.3, 0, 1)) * (S.flareBoost || 1);
  }
  if (vis === 0) {
    if (_flareWasZero) return;            // nothing to do, DOM already cleared
    _flareWasZero = true;
  } else _flareWasZero = false;
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  for (let i = 0; i < 3; i++) {
    const px2 = _flarePos.x + (cx - _flarePos.x) * _flareK[i] * 2;
    const py = _flarePos.y + (cy - _flarePos.y) * _flareK[i] * 2;
    _flareEls[i].style.opacity = (vis * _flareA[i]).toFixed(3);
    if (vis > 0) _flareEls[i].style.transform = `translate(${px2}px,${py}px) translate(-50%,-50%)`;
  }
}
// ============================================================================
// EARTH — the centerpiece
// ============================================================================
const CITIES = [
  ['NEW YORK', 40.7, -74.0], ['LOS ANGELES', 34.0, -118.2], ['CHICAGO', 41.9, -87.6],
  ['HOUSTON', 29.8, -95.4], ['MIAMI', 25.8, -80.2], ['SEATTLE', 47.6, -122.3],
  ['VANCOUVER', 49.3, -123.1], ['TORONTO', 43.7, -79.4], ['MEXICO CITY', 19.4, -99.1],
  ['BOGOTA', 4.7, -74.1], ['LIMA', -12.0, -77.0], ['SANTIAGO', -33.4, -70.7],
  ['BUENOS AIRES', -34.6, -58.4], ['SAO PAULO', -23.55, -46.6], ['RIO', -22.9, -43.2],
  ['REYKJAVIK', 64.1, -21.9], ['LONDON', 51.5, -0.1], ['PARIS', 48.9, 2.35],
  ['MADRID', 40.4, -3.7], ['CASABLANCA', 33.6, -7.6], ['LAGOS', 6.5, 3.4],
  ['BERLIN', 52.5, 13.4], ['ROME', 41.9, 12.5], ['STOCKHOLM', 59.3, 18.1],
  ['CAPE TOWN', -33.9, 18.4], ['JOHANNESBURG', -26.2, 28.0], ['CAIRO', 30.0, 31.2],
  ['ISTANBUL', 41.0, 28.9], ['KYIV', 50.45, 30.5], ['MOSCOW', 55.8, 37.6],
  ['NAIROBI', -1.3, 36.8], ['RIYADH', 24.7, 46.7], ['TEHRAN', 35.7, 51.4],
  ['DUBAI', 25.2, 55.3], ['KARACHI', 24.9, 67.0], ['MUMBAI', 19.1, 72.9],
  ['DELHI', 28.6, 77.2], ['DHAKA', 23.8, 90.4], ['BANGKOK', 13.8, 100.5],
  ['SINGAPORE', 1.35, 103.8], ['JAKARTA', -6.2, 106.8], ['HONG KONG', 22.3, 114.2],
  ['BEIJING', 39.9, 116.4], ['MANILA', 14.6, 121.0], ['SHANGHAI', 31.2, 121.5],
  ['SEOUL', 37.6, 127.0], ['TOKYO', 35.7, 139.7], ['SYDNEY', -33.9, 151.2],
  ['MELBOURNE', -37.8, 145.0], ['AUCKLAND', -36.8, 174.8], ['HONOLULU', 21.3, -157.9],
  ['ANCHORAGE', 61.2, -149.9],
];
const EARTH = {
  tilt: null, spin: null, mesh: null, mat: null, clouds: null, cloudSpin: 0,
  overlay: null, coast: null, grat: null, cityPts: null, traj: null, trajPos: null, trajCol: null,
  cities: [], impactArr: null, impactN: 0, impactCursor: 0,
  landSampler: null, landW: 0, landH: 0,
};

function imgXY(lat, lon, W, H) { return [((lon + 180) / 360) * W, ((90 - lat) / 180) * H]; }

// ---------- procedural fallback maps ----------
function genProceduralEarth() {
  const W = 1024, H = 512;
  const land = new Uint8Array(W * H);
  const elev = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = y / H, lat = 90 - v * 180;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      let n = fbmWrap(u, v, 2.6, 6);
      n += 0.12 * fbmWrap(u + 0.33, v, 7.0, 4) - 0.06;
      const polar = Math.abs(lat) > 74 ? 1 : 0;
      const isLand = n > 0.535 || polar;
      land[y * W + x] = isLand ? 1 : 0;
      elev[y * W + x] = isLand ? clamp((n - 0.535) * 4 + 0.2 + 0.35 * fbmWrap(u + 0.7, v, 11, 4), 0, 1) : 0;
    }
  }
  // day
  const [dc, dx] = makeCanvas(W, H); const di = dx.createImageData(W, H);
  // night
  const [nc, nx] = makeCanvas(W, H); nx.fillStyle = '#000'; nx.fillRect(0, 0, W, H);
  // topo
  const [tc, tx] = makeCanvas(W, H); const ti = tx.createImageData(W, H);
  // water
  const [wc, wx] = makeCanvas(W, H); const wi = wx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = y / H, lat = 90 - v * 180;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, j = i * 4, u = x / W;
      const L = land[i], e = elev[i];
      let r, g, b;
      if (Math.abs(lat) > 72 && L) { r = 225; g = 233; b = 240; }       // ice
      else if (L) {
        const dry = fbmWrap(u + 0.21, v, 5.0, 4);
        const deslat = Math.exp(-Math.pow((Math.abs(lat) - 23) / 12, 2));
        if (dry > 0.52 && deslat > 0.4) { r = 168; g = 138; b = 92; }   // desert
        else if (Math.abs(lat) > 55) { r = 70 + e * 60; g = 90 + e * 50; b = 62; } // taiga
        else { r = 44 + e * 70; g = 88 + e * 60; b = 38 + e * 30; }     // forest/plain
        if (e > 0.75) { r = 130 + e * 60; g = 125 + e * 60; b = 120 + e * 60; } // mountains
      } else {
        const depth = clamp(0.5 - (fbmWrap(u, v, 2.6, 6) - 0.535), 0.04, 0.5) * 2;
        r = 8 + 14 * (1 - depth); g = 28 + 42 * (1 - depth); b = 70 + 80 * (1 - depth);
      }
      di.data[j] = r; di.data[j + 1] = g; di.data[j + 2] = b; di.data[j + 3] = 255;
      const t8 = L ? 40 + e * 200 : 18;
      ti.data[j] = ti.data[j + 1] = ti.data[j + 2] = t8; ti.data[j + 3] = 255;
      const w8 = L ? 0 : 255;
      wi.data[j] = wi.data[j + 1] = wi.data[j + 2] = w8; wi.data[j + 3] = 255;
    }
  }
  dx.putImageData(di, 0, 0); tx.putImageData(ti, 0, 0); wx.putImageData(wi, 0, 0);
  // night lights: city clusters + sprinkles on land
  nx.fillStyle = '#000';
  const dot = (x, y, r, a) => {
    const g2 = nx.createRadialGradient(x, y, 0, x, y, r);
    g2.addColorStop(0, `rgba(255,214,150,${a})`); g2.addColorStop(1, 'rgba(255,190,120,0)');
    nx.fillStyle = g2; nx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  for (const [, lat, lon] of CITIES) {
    const [cx, cy] = imgXY(lat, lon, W, H);
    dot(cx, cy, 7, 0.95);
    for (let k = 0; k < 26; k++)
      dot(cx + (rng() - 0.5) * 26, cy + (rng() - 0.5) * 15, 1.5 + rng() * 2.5, 0.5);
  }
  for (let k = 0; k < 2600; k++) {
    const x = (rng() * W) | 0, y = (rng() * (H * 0.86) + H * 0.07) | 0;
    if (land[y * W + x]) dot(x, y, 0.8 + rng() * 1.6, 0.20 + rng() * 0.25);
  }
  // clouds
  const CW = 1024, CH = 512;
  const [cc, cx2] = makeCanvas(CW, CH);
  const ci = cx2.createImageData(CW, CH);
  for (let y = 0; y < CH; y++) {
    const v = y / CH, lat = 90 - v * 180;
    const band = 0.55 + 0.45 * Math.sin(lat / 16) * Math.cos(lat / 31);
    for (let x = 0; x < CW; x++) {
      const u = x / CW, j = (y * CW + x) * 4;
      let n = fbmWrap(u + 0.5, v + 0.3, 3.4, 6);
      n = clamp((n - 0.46) * 2.6, 0, 1) * band;
      n += clamp((fbmWrap(u + 0.9, v + 0.6, 9.0, 4) - 0.58) * 2.0, 0, 1) * 0.5;
      const a = clamp(n, 0, 1);
      ci.data[j] = 255; ci.data[j + 1] = 255; ci.data[j + 2] = 255; ci.data[j + 3] = a * 255;
    }
  }
  cx2.putImageData(ci, 0, 0);
  // land sampler for coastlines (v=1 → north)
  EARTH.landW = W; EARTH.landH = H;
  EARTH.landSampler = (x, y) => land[y * W + x] === 1;   // image coords, row 0 = north
  return { day: dc, night: nc, topo: tc, water: wc, clouds: cc };
}

function canvasTex(c, srgb) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, G.renderer.capabilities.getMaxAnisotropy());
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

function buildEarth() {
  const maps = genProceduralEarth();
  const dayT = canvasTex(maps.day, true), nightT = canvasTex(maps.night, true);
  EARTH.nightCanvas = maps.night;
  EARTH.nightTex = nightT;
  const topoT = canvasTex(maps.topo, false), waterT = canvasTex(maps.water, false);
  const cloudT = canvasTex(maps.clouds, true);

  EARTH.tilt = new THREE.Object3D();
  EARTH.tilt.rotation.z = THREE.MathUtils.degToRad(23.4);
  EARTH.spin = new THREE.Object3D();
  EARTH.tilt.add(EARTH.spin);
  G.scene.add(EARTH.tilt);

  EARTH.impactArr = [];
  for (let i = 0; i < CFG.maxImpacts; i++) EARTH.impactArr.push(new THREE.Vector4(0, 1, 0, 0.001));

  EARTH.mat = new THREE.ShaderMaterial({
    uniforms: {
      uDay: { value: dayT }, uNight: { value: nightT },
      uTopo: { value: topoT }, uWater: { value: waterT },
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      uCamPos: { value: new THREE.Vector3(0, 0, 1000) },
      uTime: { value: 0 },
      uImpacts: { value: EARTH.impactArr }, uImpactN: { value: 0 },
      uWaterInvert: { value: 0 }, uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 512) },
      uBumpAmp: { value: 14.0 },
    },
    vertexShader: `
      varying vec3 vN; varying vec3 vP; varying vec2 vUv;
      void main(){ vN = normal; vP = position; vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D uDay; uniform sampler2D uNight; uniform sampler2D uTopo; uniform sampler2D uWater;
      uniform vec3 uSunDir; uniform vec3 uCamPos; uniform float uTime;
      uniform vec4 uImpacts[${CFG.maxImpacts}]; uniform int uImpactN;
      uniform float uWaterInvert; uniform vec2 uTexel; uniform float uBumpAmp;
      varying vec3 vN; varying vec3 vP; varying vec2 vUv;
      void main(){
        vec3 n = normalize(vN);
        vec3 sd = normalize(uSunDir);
        float h0 = texture2D(uTopo, vUv).r;
        float hx = texture2D(uTopo, vUv + vec2(uTexel.x, 0.0)).r;
        float hy = texture2D(uTopo, vUv + vec2(0.0, uTexel.y)).r;
        vec3 tang = cross(vec3(0.0, 1.0, 0.0), n);
        float tl = length(tang);
        tang = tl < 1e-4 ? vec3(1.0, 0.0, 0.0) : tang / tl;   // poles: avoid normalize(0) → NaN
        vec3 bita = normalize(cross(n, tang));
        vec3 nb = normalize(n + (tang * (h0 - hx) + bita * (h0 - hy)) * uBumpAmp);
        float sunGeo = dot(n, sd);
        float dayMix = smoothstep(-0.06, 0.18, sunGeo);
        vec3 day = texture2D(uDay, vUv).rgb;
        vec3 nightT = texture2D(uNight, vUv).rgb;
        float water = texture2D(uWater, vUv).r;
        water = mix(water, 1.0 - water, uWaterInvert);
        float diff = max(dot(nb, sd), 0.0);
        vec3 col = day * (0.05 + 1.95 * diff) * dayMix;
        col += day * 0.018;
        float lum = max(nightT.r, max(nightT.g, nightT.b));
        float dim = 1.0;
        for (int i = 0; i < ${CFG.maxImpacts}; i++) {
          if (i >= uImpactN) break;
          float ang = acos(clamp(dot(n, uImpacts[i].xyz), -1.0, 1.0));
          dim *= mix(0.05, 1.0, smoothstep(uImpacts[i].w * 0.45, uImpacts[i].w, ang));
        }
        col += pow(max(lum, 1e-5), 1.15) * vec3(1.0, 0.81, 0.52) * 3.4 * (1.0 - dayMix) * dim;
        vec3 v = normalize(uCamPos - vP);
        vec3 hv = normalize(sd + v);
        float spec = pow(max(dot(nb, hv), 1e-4), 150.0) * water;
        col += vec3(1.0, 0.95, 0.85) * spec * 0.45 * dayMix;
        float fres = pow(max(1.0 - max(dot(n, v), 0.0), 1e-4), 2.8);
        col += vec3(0.16, 0.38, 0.95) * fres * (0.10 + 0.5 * dayMix);
        float term = exp(-pow(sunGeo * 7.5, 2.0));
        col += day * vec3(1.0, 0.5, 0.22) * term * 0.35;
        gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
      }`,
  });
  EARTH.mesh = new THREE.Mesh(new THREE.SphereGeometry(CFG.earthR, 160, 120), EARTH.mat);
  EARTH.spin.add(EARTH.mesh);

  // clouds
  EARTH.cloudMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uMap: { value: cloudT }, uSunDir: { value: new THREE.Vector3(0, 0, 1) } },
    vertexShader: `
      varying vec3 vN; varying vec2 vUv;
      void main(){ vN = normal; vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D uMap; uniform vec3 uSunDir;
      varying vec3 vN; varying vec2 vUv;
      void main(){
        vec4 t = texture2D(uMap, vUv);
        float lum = max(t.r, max(t.g, t.b));
        float a = lum * t.a;
        vec3 n = normalize(vN);
        float li = clamp(dot(n, normalize(uSunDir)) * 1.25 + 0.06, 0.012, 1.1);
        gl_FragColor = vec4(vec3(1.0, 1.0, 1.02) * li, a * 0.92);
      }`,
  });
  EARTH.clouds = new THREE.Mesh(new THREE.SphereGeometry(CFG.cloudR, 128, 96), EARTH.cloudMat);
  EARTH.tilt.add(EARTH.clouds);

  // inner limb haze (front side)
  const hazeMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uSunDir: { value: CFG.sunDir }, uCamPos: { value: new THREE.Vector3() } },
    vertexShader: `varying vec3 vN; varying vec3 vP;
      void main(){ vN = normal; vP = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uSunDir; uniform vec3 uCamPos;
      varying vec3 vN; varying vec3 vP;
      void main(){
        vec3 n = normalize(vN);
        vec3 v = normalize(uCamPos - vP);
        float f = pow(max(1.0 - max(dot(n, v), 0.0), 1e-4), 3.4);
        float sun = 0.25 + 0.85 * smoothstep(-0.3, 0.3, dot(n, normalize(uSunDir)));
        gl_FragColor = vec4(vec3(0.30, 0.55, 1.0) * f * sun, f * 0.6);
      }`,
  });
  const haze = new THREE.Mesh(new THREE.SphereGeometry(CFG.hazeR, 96, 72), hazeMat);
  G.scene.add(haze);
  EARTH.hazeMat = hazeMat;

  // outer atmosphere glow (back side)
  const atmoMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
    uniforms: { uSunDir: { value: CFG.sunDir }, uCamPos: { value: new THREE.Vector3() } },
    vertexShader: `varying vec3 vN; varying vec3 vP;
      void main(){ vN = normal; vP = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uSunDir; uniform vec3 uCamPos;
      varying vec3 vN; varying vec3 vP;
      void main(){
        vec3 n = normalize(vN);
        vec3 v = normalize(uCamPos - vP);
        float rim = pow(clamp(1.0 + dot(v, n), 1e-4, 1.0), 3.2);
        float sun = 0.22 + 0.9 * smoothstep(-0.35, 0.3, dot(n, normalize(uSunDir)));
        float termBoost = 1.0 + 0.8 * exp(-abs(dot(n, normalize(uSunDir))) * 2.6);
        gl_FragColor = vec4(vec3(0.25, 0.5, 1.0) * rim * sun * termBoost, rim * 0.85);
      }`,
  });
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(CFG.atmoR, 96, 72), atmoMat);
  G.scene.add(atmo);
  EARTH.atmoMat = atmoMat;

  // halo sprite
  const [hc, hx] = makeCanvas(128, 128);
  const hg = hx.createRadialGradient(64, 64, 30, 64, 64, 64);
  hg.addColorStop(0, 'rgba(70,130,255,0.28)'); hg.addColorStop(0.55, 'rgba(60,110,230,0.10)'); hg.addColorStop(1, 'rgba(40,80,200,0)');
  hx.fillStyle = hg; hx.fillRect(0, 0, 128, 128);
  const haloT = new THREE.CanvasTexture(hc); haloT.colorSpace = THREE.SRGBColorSpace;
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.scale.setScalar(CFG.earthR * 3.4);
  G.scene.add(halo);

  buildOverlay();
  loadCDNEarth();
}

// ---------- tactical overlay ----------
function buildOverlay() {
  if (EARTH.overlay) {
    EARTH.spin.remove(EARTH.overlay);
    EARTH.overlay.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
  const ov = new THREE.Group();
  ov.visible = false;
  EARTH.overlay = ov;
  EARTH.spin.add(ov);

  // coastlines via marching squares on the land mask
  const W = EARTH.landW, H = EARTH.landH, samp = EARTH.landSampler;
  const step = Math.max(1, Math.floor(W / 360));
  const pts = [];
  const gw = Math.floor(W / step), gh = Math.floor(H / step);
  const lat = y => 90 - ((y * step + step * 0.5) / H) * 180;
  const lon = x => ((x * step + step * 0.5) / W) * 360 - 180;
  const push = (la, lo) => { latLonToV3(la, lo, _v1).multiplyScalar(CFG.earthR * 1.004); pts.push(_v1.x, _v1.y, _v1.z); };
  const E = { T: 0, R: 1, B: 2, L: 3 };
  const CASES = [null, [[E.L, E.B]], [[E.B, E.R]], [[E.L, E.R]], [[E.T, E.R]], [[E.T, E.R], [E.L, E.B]],
    [[E.T, E.B]], [[E.L, E.T]], [[E.T, E.L]], [[E.T, E.B]], [[E.T, E.L], [E.B, E.R]],
    [[E.T, E.R]], [[E.L, E.R]], [[E.B, E.R]], [[E.L, E.B]], null];
  for (let y = 0; y < gh - 1; y++) for (let x = 0; x < gw - 1; x++) {
    const tl = samp(x * step, y * step) ? 1 : 0, tr = samp((x + 1) * step, y * step) ? 1 : 0;
    const bl = samp(x * step, (y + 1) * step) ? 1 : 0, br = samp((x + 1) * step, (y + 1) * step) ? 1 : 0;
    const id = tl * 8 + tr * 4 + br * 2 + bl;
    const segs = CASES[id];
    if (!segs) continue;
    for (const [a, b] of segs) {
      for (const e of [a, b]) {
        if (e === E.T) push(lat(y), lon(x + 0.5));
        else if (e === E.B) push(lat(y + 1), lon(x + 0.5));
        else if (e === E.L) push(lat(y + 0.5), lon(x));
        else push(lat(y + 0.5), lon(x + 1));
      }
    }
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  EARTH.coast = new THREE.LineSegments(cg,
    new THREE.LineBasicMaterial({ color: 0x46ff9a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  ov.add(EARTH.coast);

  // graticule
  const gp = [];
  const gpush = (la, lo) => { latLonToV3(la, lo, _v1).multiplyScalar(CFG.earthR * 1.0025); gp.push(_v1.x, _v1.y, _v1.z); };
  for (let la = -60; la <= 60; la += 20) for (let lo = -180; lo < 180; lo += 4) { gpush(la, lo); gpush(la, lo + 4); }
  for (let lo = -180; lo < 180; lo += 20) for (let la = -84; la < 84; la += 4) { gpush(la, lo); gpush(la + 4, lo); }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gp), 3));
  EARTH.grat = new THREE.LineSegments(gg,
    new THREE.LineBasicMaterial({ color: 0x2a9a64, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false }));
  ov.add(EARTH.grat);

  // city markers + labels
  if (!EARTH.cities.length) {
    for (const [name, la, lo] of CITIES) {
      const dir = latLonToV3(la, lo, new THREE.Vector3()).clone();
      EARTH.cities.push({ name, lat: la, lon: lo, dir, label: null, lost: false });
    }
  }
  const cp = new Float32Array(EARTH.cities.length * 3), cc = new Float32Array(EARTH.cities.length * 3);
  EARTH.cities.forEach((c, i) => {
    _v1.copy(c.dir).multiplyScalar(CFG.earthR * 1.006);
    cp[i * 3] = _v1.x; cp[i * 3 + 1] = _v1.y; cp[i * 3 + 2] = _v1.z;
    cc[i * 3] = 0.35; cc[i * 3 + 1] = 1; cc[i * 3 + 2] = 0.62;
  });
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(cp, 3));
  pg.setAttribute('color', new THREE.BufferAttribute(cc, 3));
  EARTH.cityPts = new THREE.Points(pg, new THREE.PointsMaterial({
    size: 7, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  ov.add(EARTH.cityPts);
  for (const c of EARTH.cities) {
    if (c.label) { ov.add(c.label); continue; }
    const [lc, lx] = makeCanvas(192, 40);
    lx.font = '700 19px ui-monospace, Consolas, monospace';
    lx.fillStyle = c.lost ? '#7a2a22' : '#5dffa0';
    lx.shadowColor = 'rgba(90,255,160,0.8)'; lx.shadowBlur = 7;
    lx.fillText(c.name, 5, 27);
    const t = new THREE.CanvasTexture(lc); t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: true, opacity: 0.85 }));
    sp.position.copy(c.dir).multiplyScalar(CFG.earthR * 1.035);
    sp.scale.set(33, 6.9, 1);
    sp.visible = false;
    c.label = sp;
    ov.add(sp);
  }

  // enemy trajectory lines (world space, sibling of earth)
  if (!EARTH.traj) {
    const MAXV = 64 * 16 * 2;
    EARTH.trajPos = new Float32Array(MAXV * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(EARTH.trajPos, 3));
    tg.setDrawRange(0, 0);
    EARTH.traj = new THREE.LineSegments(tg,
      new THREE.LineBasicMaterial({ color: 0xff5a3a, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    EARTH.traj.frustumCulled = false;
    EARTH.traj.visible = false;
    G.scene.add(EARTH.traj);
  }
}

function setOverlay(on) {
  S.overlayOn = on;
  EARTH.overlay.visible = on;
  EARTH.traj.visible = on;
  AUD.uiBlip(on ? 1100 : 700);
}

// bake an evicted impact's blackout permanently into the night canvas
function bakeImpactToNight(v4) {
  if (!EARTH.nightCanvas) return;
  const W = EARTH.nightCanvas.width, H = EARTH.nightCanvas.height;
  const lat = Math.asin(clamp(v4.y, -1, 1)) * 180 / Math.PI;
  const theta = Math.atan2(v4.z, -v4.x);
  const lon = ((theta * 180 / Math.PI) - 180 + 540) % 360 - 180;
  const [bx, by] = imgXY(lat, lon, W, H);
  const r = Math.max(6, v4.w / TAU * W);
  const x = EARTH.nightCanvas.getContext('2d');
  x.save();
  x.globalCompositeOperation = 'destination-out';
  const g = x.createRadialGradient(bx, by, 0, bx, by, r);
  g.addColorStop(0, 'rgba(0,0,0,0.96)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.8)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(bx - r, by - r, r * 2, r * 2);
  x.restore();
  if (EARTH.nightTex) EARTH.nightTex.needsUpdate = true;
}
// world position → permanent night-light blackout + nearest city goes dark
function earthAddImpact(worldPos, radiusRad) {
  EARTH.mesh.updateWorldMatrix(true, false);
  _m1.copy(EARTH.mesh.matrixWorld).invert();
  _v1.copy(worldPos).applyMatrix4(_m1).normalize();
  const slot = EARTH.impactCursor % CFG.maxImpacts;
  if (EARTH.impactCursor >= CFG.maxImpacts) bakeImpactToNight(EARTH.impactArr[slot]);
  EARTH.impactArr[slot].set(_v1.x, _v1.y, _v1.z, radiusRad);
  EARTH.impactCursor++;
  EARTH.impactN = Math.min(CFG.maxImpacts, EARTH.impactCursor);
  EARTH.mat.uniforms.uImpactN.value = EARTH.impactN;
  // nearest surviving city within ~radius*2.2
  let best = null, bd = 1e9;
  for (const c of EARTH.cities) {
    if (c.lost) continue;
    const a = Math.acos(clamp(c.dir.dot(_v1), -1, 1));
    if (a < bd) { bd = a; best = c; }
  }
  if (best && bd < Math.max(0.22, radiusRad * 2.2)) {
    best.lost = true;
    if (best.label) best.label.material.color.setHex(0x66261f);
    const ci = EARTH.cities.indexOf(best);
    const colAttr = EARTH.cityPts.geometry.getAttribute('color');
    colAttr.setXYZ(ci, 0.45, 0.1, 0.06);
    colAttr.needsUpdate = true;
  }
}

// ---------- CDN upgrade with silent fallback ----------
async function fetchTex(url, srgb, timeoutMs = 18000) {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { mode: 'cors', signal: ctl.signal });
    clearTimeout(to);
    if (!res.ok) return null;
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY' });
    const t = new THREE.Texture(bmp);
    t.flipY = false;
    t.needsUpdate = true;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, G.renderer.capabilities.getMaxAnisotropy());
    t.wrapS = THREE.RepeatWrapping;
    return t;
  } catch (e) { return null; }
}
async function loadCDNEarth() {
  const base = 'https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/';
  const [day, night, topo, water, clouds] = await Promise.all([
    fetchTex(base + 'earth-blue-marble.jpg', true),
    fetchTex(base + 'earth-night.jpg', true),
    fetchTex(base + 'earth-topology.png', false),
    fetchTex(base + 'earth-water.png', false),
    fetchTex('https://cdn.jsdelivr.net/gh/turban/webgl-earth@master/images/fair_clouds_4k.png', true),
  ]);
  const U = EARTH.mat.uniforms;
  if (day) { U.uDay.value = day; }
  if (night) {
    // keep night lights on a canvas so landings can be baked in permanently
    try {
      const NW = 2048, NH = 1024;
      const [nc3, nx3] = makeCanvas(NW, NH);
      nx3.save();
      nx3.scale(1, -1);                                 // un-flip the flipY bitmap
      nx3.drawImage(night.image, 0, -NH, NW, NH);
      nx3.restore();
      EARTH.nightCanvas = nc3;
      EARTH.nightTex = canvasTex(nc3, true);
      U.uNight.value = EARTH.nightTex;
    } catch (e) { U.uNight.value = night; }
  }
  if (topo) {
    U.uTopo.value = topo;
    const img = topo.image;
    U.uTexel.value.set(1 / (img.width || 2048), 1 / (img.height || 1024));
    U.uBumpAmp.value = 9.0;
  }
  if (clouds) EARTH.cloudMat.uniforms.uMap.value = clouds;
  if (water) {
    U.uWater.value = water;
    // read pixels to rebuild coastlines + detect polarity (bitmap rows are flipped → row 0 = south)
    try {
      const W = 512, H = 256;
      const [c, x] = makeCanvas(W, H);
      x.drawImage(water.image, 0, 0, W, H);
      const px = x.getImageData(0, 0, W, H).data;
      // mid-Pacific: lat 0, lon -150
      const [sx, syN] = imgXY(0, -150, W, H);
      const sy = H - 1 - Math.floor(syN);     // flipped
      const pac = px[(sy * W + Math.floor(sx)) * 4];
      const whiteIsWater = pac > 127;
      U.uWaterInvert.value = whiteIsWater ? 0 : 1;
      EARTH.landW = W; EARTH.landH = H;
      EARTH.landSampler = (ix, iyNorthTop) => {
        const iy = H - 1 - iyNorthTop;        // sampler API: row 0 = north
        const v = px[(iy * W + ix) * 4];
        return whiteIsWater ? v < 127 : v > 127;
      };
      const wasOn = S.overlayOn;
      buildOverlay();
      EARTH.overlay.visible = wasOn;
    } catch (e) { /* keep procedural coastlines */ }
  }
}

// ---------- per-frame ----------
function updateEarth(dt) {
  EARTH.spin.rotation.y += CFG.earthSpinRate * dt;
  EARTH.clouds.rotation.y += CFG.cloudSpinRate * dt;
  EARTH.mesh.updateWorldMatrix(true, false);
  EARTH.clouds.updateWorldMatrix(true, false);
  G.camera.getWorldPosition(_v2);
  // earth shader (object space)
  _m1.copy(EARTH.mesh.matrixWorld).invert();
  EARTH.mat.uniforms.uSunDir.value.copy(CFG.sunDir).transformDirection(_m1);
  EARTH.mat.uniforms.uCamPos.value.copy(_v2).applyMatrix4(_m1);
  EARTH.mat.uniforms.uTime.value = S.now;
  // clouds
  _m1.copy(EARTH.clouds.matrixWorld).invert();
  EARTH.cloudMat.uniforms.uSunDir.value.copy(CFG.sunDir).transformDirection(_m1);
  // atmosphere shells (world == object at origin)
  EARTH.hazeMat.uniforms.uCamPos.value.copy(_v2);
  EARTH.atmoMat.uniforms.uCamPos.value.copy(_v2);
  // city labels — face-side visibility @ ~4 Hz
  if (S.overlayOn && (S.frame & 15) === 0) {
    EARTH.spin.updateWorldMatrix(true, false);
    _v3.copy(_v2).normalize();
    for (const c of EARTH.cities) {
      _v4.copy(c.dir).transformDirection(EARTH.spin.matrixWorld);
      c.label.visible = _v4.dot(_v3) > 0.32;
    }
  }
}
// ============================================================================
// ROOM — ship rec deck + arcade cabinet (CRT) + seat/console + canopy
// ============================================================================
const ROOM = {
  group: null, cab: null, screen: null, screenMat: null,
  seatHead: new THREE.Vector3(0, 1.24, -2.45),
  seatPos: new THREE.Vector3(0, 0, -2.55),
  arcadePos: new THREE.Vector3(2.05, 1.0, 1.3),
  shutters: [], shutterT: -1,
  chevron: null, lights: {}, windowMat: null,
  ledMesh: null, ledPhase: null, dust: null,
  colliders: [
    { x0: 1.35, x1: 2.85, z0: 0.55, z1: 2.1 },    // cabinet
    { x0: -1.7, x1: 1.7, z0: -3.85, z1: -3.0 },   // console
    { x0: -0.5, x1: 0.5, z0: -3.0, z1: -2.1 },    // seat
  ],
};
function roomLit(o) { o.layers.enable(2); return o; }

function drawSpriteTo(x, spr, ox, oy, px, color, glowColor, glowBlur) {
  x.save();
  if (glowColor) { x.shadowColor = glowColor; x.shadowBlur = glowBlur || 12; }
  x.fillStyle = color;
  for (let r = 0; r < spr.h; r++) for (let c = 0; c < spr.w; c++)
    if (spr.bits[r] & (1 << c)) x.fillRect(ox + c * px, oy + r * px, px, px);
  x.restore();
}

function buildRoom() {
  const RG = new THREE.Group();
  ROOM.group = RG;
  G.bank.add(RG);
  const R = 3.4, CY = 1.3, LEN = 9;

  // ---------- textures ----------
  const [fc, fx] = makeCanvas(256, 256);
  fx.fillStyle = '#171c22'; fx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) { const v = 18 + rng() * 26;
    fx.fillStyle = `rgb(${v},${v + 3},${v + 7})`; fx.fillRect(rng() * 256, rng() * 256, 2, 2); }
  fx.strokeStyle = '#070a0d'; fx.lineWidth = 5;
  for (let i = 0; i <= 4; i++) { fx.beginPath(); fx.moveTo(i * 64, 0); fx.lineTo(i * 64, 256); fx.stroke();
    fx.beginPath(); fx.moveTo(0, i * 64); fx.lineTo(256, i * 64); fx.stroke(); }
  fx.fillStyle = '#0a0e12';
  for (let gx = 0; gx < 4; gx++) for (let gy = 0; gy < 4; gy++)
    for (let h = 0; h < 3; h++) fx.fillRect(gx * 64 + 14, gy * 64 + 12 + h * 16, 36, 7);
  fx.strokeStyle = 'rgba(120,140,160,0.10)';
  for (let i = 0; i < 40; i++) { fx.beginPath(); const sx = rng() * 256, sy = rng() * 256;
    fx.moveTo(sx, sy); fx.lineTo(sx + (rng() - 0.5) * 70, sy + (rng() - 0.5) * 18); fx.stroke(); }
  const floorT = canvasTex(fc, true); floorT.wrapS = floorT.wrapT = THREE.RepeatWrapping; floorT.repeat.set(5, 7);

  const [wc2, wx2] = makeCanvas(512, 512);
  wx2.fillStyle = '#1d242d'; wx2.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) { const v = 24 + rng() * 22;
    wx2.fillStyle = `rgba(${v},${v + 4},${v + 9},0.5)`; wx2.fillRect(rng() * 512, rng() * 512, 2, 2); }
  wx2.strokeStyle = '#0d1116'; wx2.lineWidth = 3;
  let py = 0;
  while (py < 512) { const ph = 60 + rng() * 90; let px2 = 0;
    while (px2 < 512) { const pw = 80 + rng() * 120;
      wx2.strokeRect(px2 + 2, py + 2, pw - 4, ph - 4);
      wx2.fillStyle = 'rgba(150,170,190,0.07)'; wx2.fillRect(px2 + 4, py + 4, pw - 8, 5);
      wx2.fillStyle = '#10151b';
      wx2.fillRect(px2 + 6, py + ph - 12, 4, 4); wx2.fillRect(px2 + pw - 12, py + ph - 12, 4, 4);
      px2 += pw; }
    py += ph; }
  const wallT = canvasTex(wc2, true); wallT.wrapT = THREE.RepeatWrapping; wallT.repeat.set(4, 2);

  const matFloor = new THREE.MeshStandardMaterial({ map: floorT, bumpMap: floorT, bumpScale: 1.6, roughness: 0.82, metalness: 0.55 });
  const matWall = new THREE.MeshStandardMaterial({ map: wallT, roughness: 0.88, metalness: 0.35, side: THREE.BackSide });
  const matDark = new THREE.MeshStandardMaterial({ color: 0x141a21, roughness: 0.7, metalness: 0.5 });
  const matTrim = new THREE.MeshStandardMaterial({ color: 0x2a323d, roughness: 0.55, metalness: 0.75 });

  // ---------- shell ----------
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R, LEN, 40, 1, true), matWall);
  wall.rotation.x = Math.PI / 2; wall.position.y = CY;
  roomLit(RG.add(wall) && wall);
  const floorHW = Math.sqrt(R * R - CY * CY) * 0.985;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorHW * 2, LEN), matFloor);
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0.001;
  roomLit(floor); RG.add(floor);
  // rear cap + door
  const rear = new THREE.Mesh(new THREE.CircleGeometry(R, 40), matWall.clone());
  rear.material.side = THREE.FrontSide; rear.material.map = wallT;
  rear.position.set(0, CY, LEN / 2); rear.rotation.y = Math.PI;
  roomLit(rear); RG.add(rear);
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.15, 0.08), matDark);
  door.position.set(0, 1.075, LEN / 2 - 0.05);
  roomLit(door); RG.add(door);
  const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.4, 0.1), matTrim);
  doorFrame.position.set(0, 1.18, LEN / 2 - 0.02);
  roomLit(doorFrame); RG.add(doorFrame);

  // ---------- canopy (front cap): rim, glass, struts, shutters ----------
  const rim = new THREE.Mesh(new THREE.TorusGeometry(2.78, 0.22, 12, 48), matTrim);
  rim.position.set(0, CY + 0.2, -LEN / 2 + 0.1);
  roomLit(rim); RG.add(rim);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(2.7, 48),
    new THREE.MeshPhysicalMaterial({ color: 0x9fcfff, transparent: true, opacity: 0.07, roughness: 0.05, metalness: 0, depthWrite: false }));
  glass.position.set(0, CY + 0.2, -LEN / 2 + 0.12);
  RG.add(glass);
  // corner braces only — keep the pilot's sightline clear
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.5, 0.1), matTrim);
    strut.position.set(Math.cos(a) * 2.0, CY + 0.2 + Math.sin(a) * 2.0, -LEN / 2 + 0.16);
    strut.rotation.z = a + Math.PI / 2;
    roomLit(strut); RG.add(strut);
  }
  for (let i = 0; i < 6; i++) {
    const sl = new THREE.Mesh(new THREE.BoxGeometry(5.7, 0.95, 0.06), matDark.clone());
    const yc = (i - 2.5) * 0.952;
    sl.position.set(0, CY + 0.2 + yc, -LEN / 2 + 0.2);
    sl.userData.y0 = sl.position.y; sl.userData.dir = Math.sign(yc) || 1; sl.userData.off = Math.abs(yc);
    roomLit(sl); RG.add(sl);
    ROOM.shutters.push(sl);
  }
  // exterior nose wedge (sunlit, seen below the glass)
  const nose = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.6, 2.4), new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.5, metalness: 0.8 }));
  nose.position.set(0, 0.35, -LEN / 2 - 1.1); nose.scale.z = 1.4; nose.rotation.x = 0.09;
  sunlit(nose); RG.add(nose);

  // ---------- greebles + pipes ----------
  const gN = 64;
  const greeb = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), matTrim, gN);
  let gi = 0;
  while (gi < gN) {
    const phi = rng() * TAU;
    const px3 = Math.cos(phi) * (R - 0.01), py3 = CY + Math.sin(phi) * (R - 0.01);
    if (py3 < 0.35) continue;
    if (px3 < -2.5 && py3 > 1.1 && py3 < 2.2) continue;   // keep window strip clear
    const z = -3.9 + rng() * 7.8;
    _v1.set(px3, py3, z);
    _v2.set(-Math.cos(phi), -Math.sin(phi), 0);            // inward normal
    _m1.lookAt(_v1, _v3.copy(_v1).add(_v2), _v4.set(0, 0, 1));
    _q1.setFromRotationMatrix(_m1);
    _m1.compose(_v1, _q1, _v5.set(0.2 + rng() * 0.7, 0.15 + rng() * 0.5, 0.05 + rng() * 0.1));
    greeb.setMatrixAt(gi, _m1);
    gi++;
  }
  greeb.instanceMatrix.needsUpdate = true;
  roomLit(greeb); RG.add(greeb);
  for (const phi of [0.45 * Math.PI, 0.62 * Math.PI, 0.38 * Math.PI]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, LEN - 0.4, 8), matTrim);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(Math.cos(phi) * (R - 0.14), CY + Math.sin(phi) * (R - 0.14), 0);
    roomLit(pipe); RG.add(pipe);
  }

  // ---------- viewport strip (shader-driven space view) ----------
  ROOM.windowMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uEarth: { value: 0.18 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uTime; uniform float uEarth;
      varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){
        vec2 uv = vUv;
        vec3 col = vec3(0.004, 0.006, 0.012);
        // stars (two parallax layers)
        for (int L = 0; L < 2; L++) {
          float sc = L == 0 ? 60.0 : 110.0;
          vec2 p = uv * vec2(sc, sc * 0.12) + vec2(uTime * (L == 0 ? 0.020 : 0.045), 0.0);
          vec2 cell = floor(p), f = fract(p);
          float h = hash(cell);
          if (h > 0.82) {
            vec2 sp = vec2(fract(h * 13.7), fract(h * 7.3));
            float d = length((f - sp) * vec2(1.0, 8.0 / sc * sc * 0.125));
            float tw = 0.7 + 0.3 * sin(uTime * (2.0 + h * 5.0) + h * 40.0);
            col += vec3(0.9, 0.95, 1.0) * smoothstep(0.10, 0.0, d) * (h - 0.8) * 5.0 * 0.8 * tw;
          }
        }
        // Earth, small in the distance
        vec2 ep = vec2(0.22, 0.5);
        vec2 d2 = (uv - ep) * vec2(9.0, 1.0);
        float r = length(d2) / uEarth;
        if (r < 1.0) {
          float sh = clamp(0.5 + 0.6 * (-d2.x / uEarth) - 0.2, 0.05, 1.0);
          vec3 ec = mix(vec3(0.02, 0.07, 0.18), vec3(0.12, 0.34, 0.72), sh);
          ec += vec3(0.25, 0.5, 0.4) * smoothstep(0.6, 0.2, r) * sh * 0.4;
          col = ec;
        }
        col += vec3(0.2, 0.45, 1.0) * smoothstep(1.18, 0.98, r) * smoothstep(0.85, 1.0, r) * 0.55;
        // faint red streaks crossing every few seconds
        for (int k = 0; k < 2; k++) {
          float ph = fract(uTime / (5.7 + float(k) * 3.1) + float(k) * 0.4);
          float live = smoothstep(0.0, 0.06, ph) * smoothstep(0.5, 0.30, ph);
          float yy = 0.25 + 0.5 * hash(vec2(floor(uTime / (5.7 + float(k) * 3.1)), float(k)));
          float dd = abs(uv.y - yy + (uv.x - ph * 1.6) * 0.12);
          float trail = exp(-pow((uv.x - ph * 1.6 + 0.3), 2.0) * 30.0);
          col += vec3(1.0, 0.25, 0.15) * exp(-dd * dd * 9000.0) * trail * live * 0.8;
        }
        // glass edge falloff
        col *= smoothstep(0.0, 0.07, uv.y) * smoothstep(1.0, 0.93, uv.y)
             * smoothstep(0.0, 0.02, uv.x) * smoothstep(1.0, 0.98, uv.x);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 0.6), ROOM.windowMat);
  strip.position.set(-floorHW - 0.16, 1.62, 0);
  strip.rotation.y = Math.PI / 2; strip.rotation.x = -0.06;
  RG.add(strip);
  const stripFrame = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.78, 5.5), matTrim);
  stripFrame.position.set(-floorHW - 0.22, 1.62, 0);
  roomLit(stripFrame); RG.add(stripFrame);
  const stripCut = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.62, 5.24), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  stripCut.position.set(-floorHW - 0.185, 1.62, 0);
  RG.add(stripCut);

  buildCabinet(RG);
  buildSeatConsole(RG);
  buildProps(RG, floorHW);
  buildLEDs(RG);
  buildDust(RG);
  buildChevron(RG);

  // ---------- room lights ----------
  const amb = new THREE.AmbientLight(0x223041, 0.10); RG.add(amb);
  // r160 physically-correct lighting → punctual intensities are candela-scale
  const spot = new THREE.SpotLight(0xbfdcff, 0.0, 12, 0.72, 0.8, 1.1);
  spot.position.set(0.5, R + CY - 0.4, 0.6);
  spot.target.position.set(0.2, 0, 0.2);
  RG.add(spot); RG.add(spot.target);
  const screenPt = new THREE.PointLight(0x9fd8ff, 9, 3.4, 1.8);
  screenPt.position.copy(ROOM.arcadePos).add(_v1.set(-0.5, 0.45, -0.35));
  RG.add(screenPt);
  const marqPt = new THREE.PointLight(0xffb454, 6, 2.8, 1.8);
  marqPt.position.copy(ROOM.arcadePos).add(_v1.set(-0.45, 0.95, -0.3));
  RG.add(marqPt);
  const consPt = new THREE.PointLight(0x66ffc8, 0.0, 3.8, 1.8);
  consPt.position.set(0, 1.5, -3.2);
  RG.add(consPt);
  const fill = new THREE.PointLight(0x6f8fc0, 0.0, 10, 1.4);
  fill.position.set(-0.4, 2.7, 2.4);
  RG.add(fill);
  const emerg = new THREE.PointLight(0xff2a18, 0.0, 12, 1.1);
  emerg.position.set(0, 2.9, 3.6);
  RG.add(emerg);
  ROOM.lights = { amb, spot, screenPt, marqPt, consPt, fill, emerg };
}

function buildCabinet(RG) {
  const cab = new THREE.Group();
  cab.position.set(2.05, 0, 1.3);
  cab.rotation.y = -2.214;
  RG.add(cab);
  ROOM.cab = cab;
  const matBody = new THREE.MeshStandardMaterial({ color: 0x1a2230, roughness: 0.6, metalness: 0.2 });

  // body — stepped classic-upright silhouette
  const bodyLow = new THREE.Mesh(new THREE.BoxGeometry(0.68, 1.0, 0.72), matBody);
  bodyLow.position.set(0, 0.5, 0);
  roomLit(bodyLow); cab.add(bodyLow);
  const bodyUp = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.95, 0.55), matBody);
  bodyUp.position.set(0, 1.43, -0.085);
  roomLit(bodyUp); cab.add(bodyUp);
  const shroud = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.56, 0.12), matBody);
  shroud.position.set(0, 1.30, 0.24); shroud.rotation.x = -0.14;
  roomLit(shroud); cab.add(shroud);
  // slanted monitor cheeks bridging shroud → bezel
  for (const sgn of [-1, 1]) {
    const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 0.34), matBody);
    cheek.position.set(sgn * 0.315, 1.30, 0.20); cheek.rotation.x = -0.14;
    roomLit(cheek); cab.add(cheek);
  }
  // top hood over the screen
  const matVoid = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const hood = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.07, 0.38),
    [matBody, matBody, matBody, matVoid, matBody, matBody]);
  hood.position.set(0, 1.80, 0.07); hood.rotation.x = -0.16;
  roomLit(hood); cab.add(hood);
  // red t-molding edge strips
  const matTM = new THREE.MeshStandardMaterial({ color: 0xa32418, roughness: 0.45, metalness: 0.1 });
  for (const sgn of [-1, 1]) {
    const tm1 = new THREE.Mesh(new THREE.BoxGeometry(0.02, 1.0, 0.02), matTM);
    tm1.position.set(sgn * 0.335, 0.5, 0.352);
    roomLit(tm1); cab.add(tm1);
    const tm2 = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.66, 0.02), matTM);
    tm2.position.set(sgn * 0.335, 1.33, 0.255); tm2.rotation.x = -0.14;
    roomLit(tm2); cab.add(tm2);
  }
  // speaker grille under the marquee
  const [gc2, gx2] = makeCanvas(128, 32);
  gx2.fillStyle = '#0a0d12'; gx2.fillRect(0, 0, 128, 32);
  gx2.fillStyle = '#1f2630';
  for (let gy = 4; gy < 30; gy += 7) for (let gx3 = 6; gx3 < 124; gx3 += 7) {
    gx2.beginPath(); gx2.arc(gx3, gy, 2.1, 0, TAU); gx2.fill();
  }
  const grille = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.09),
    new THREE.MeshStandardMaterial({ map: canvasTex(gc2, true), roughness: 0.9, metalness: 0.4 }));
  grille.position.set(0, 1.795, 0.305); grille.rotation.x = -0.20;
  roomLit(grille); cab.add(grille);

  // side art
  const [sa, sx2] = makeCanvas(256, 512);
  const sgr = sx2.createLinearGradient(0, 0, 0, 512);
  sgr.addColorStop(0, '#0b0d1f'); sgr.addColorStop(0.6, '#1b0f33'); sgr.addColorStop(1, '#33104a');
  sx2.fillStyle = sgr; sx2.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 60; i++) { sx2.fillStyle = `rgba(255,255,255,${0.3 + rng() * 0.5})`;
    sx2.fillRect(rng() * 256, rng() * 360, 2, 2); }
  drawSpriteTo(sx2, SPR.octA, 44, 150, 14, '#27ff8a', '#27ff8a', 26);
  drawSpriteTo(sx2, SPR.squidA, 92, 60, 8, '#7adfff', '#7adfff', 18);
  sx2.save(); sx2.translate(36, 480); sx2.rotate(-Math.PI / 2);
  sx2.font = '900 34px ui-monospace, Consolas, monospace';
  sx2.fillStyle = '#ffb454'; sx2.shadowColor = '#ff7a2a'; sx2.shadowBlur = 16;
  sx2.fillText('COSMIC INVADERS', 0, 0);
  sx2.restore();
  const sideT = canvasTex(sa, true);
  const matSide = new THREE.MeshStandardMaterial({ map: sideT, roughness: 0.55, metalness: 0.15 });
  for (const sgn of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 1.86), matSide);
    p.position.set(sgn * 0.345, 0.93, 0);
    p.rotation.y = sgn * Math.PI / 2;
    roomLit(p); cab.add(p);
  }

  // kick plate with scuffs
  const [kc, kx] = makeCanvas(128, 64);
  kx.fillStyle = '#0c0f14'; kx.fillRect(0, 0, 128, 64);
  for (let i = 0; i < 40; i++) { kx.strokeStyle = `rgba(${140 + rng() * 60},${140 + rng() * 50},${130 + rng() * 40},${0.06 + rng() * 0.16})`;
    kx.lineWidth = 1 + rng() * 2; kx.beginPath();
    const sy = 20 + rng() * 40; kx.moveTo(rng() * 30, sy); kx.lineTo(40 + rng() * 88, sy + (rng() - 0.5) * 14); kx.stroke(); }
  const kick = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.16, 0.05),
    new THREE.MeshStandardMaterial({ map: canvasTex(kc, true), roughness: 0.9, metalness: 0.4 }));
  kick.position.set(0, 0.08, 0.345);
  roomLit(kick); cab.add(kick);

  // marquee
  const [mq, mx2] = makeCanvas(512, 128);
  const mg = mx2.createLinearGradient(0, 0, 0, 128);
  mg.addColorStop(0, '#05030f'); mg.addColorStop(1, '#1d0b38');
  mx2.fillStyle = mg; mx2.fillRect(0, 0, 512, 128);
  mx2.strokeStyle = 'rgba(122,223,255,0.25)';
  for (let i = 0; i < 9; i++) { mx2.beginPath(); mx2.moveTo(0, 70 + i * 7); mx2.lineTo(512, 64 + i * 9); mx2.stroke(); }
  mx2.font = '900 44px ui-monospace, Consolas, monospace';
  mx2.textAlign = 'center';
  mx2.fillStyle = '#ffd27a'; mx2.shadowColor = '#ff9a2a'; mx2.shadowBlur = 22;
  mx2.fillText('COSMIC INVADERS', 256, 58);
  drawSpriteTo(mx2, SPR.squidA, 28, 76, 4, '#7adfff', '#7adfff', 10);
  drawSpriteTo(mx2, SPR.crabA, 430, 76, 4, '#27ff8a', '#27ff8a', 10);
  const marq = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.2, 0.1),
    [matBody, matBody, matBody, matBody,
     new THREE.MeshBasicMaterial({ map: canvasTex(mq, true) }), matBody]);
  marq.position.set(0, 1.95, 0.30); marq.rotation.x = 0.12;
  roomLit(marq); cab.add(marq);

  // screen bezel + CRT screen
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.5, 0.07), new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.4, metalness: 0.1 }));
  bezel.position.set(0, 1.30, 0.33); bezel.rotation.x = -0.14;
  roomLit(bezel); cab.add(bezel);
  G.arcTex = new THREE.CanvasTexture(ARC.canvas);
  G.arcTex.colorSpace = THREE.SRGBColorSpace;
  G.arcTex.magFilter = THREE.NearestFilter;
  G.arcTex.minFilter = THREE.LinearFilter;
  G.arcTex.generateMipmaps = false;
  ROOM.screenMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: G.arcTex }, uTime: { value: 0 }, uStr: { value: 0.22 }, uBright: { value: 1.1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D uMap; uniform float uTime; uniform float uStr; uniform float uBright;
      varying vec2 vUv;
      void main(){
        vec2 cc = vUv * 2.0 - 1.0;
        float r2 = dot(cc, cc);
        cc *= 1.0 + (0.052 * uStr + 0.013) * r2;
        vec2 uv = cc * 0.5 + 0.5;
        float inb = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
        // phosphor glow: center + 4 soft taps
        vec2 px = vec2(1.0 / 256.0, 1.0 / 224.0);
        vec3 c = texture2D(uMap, uv).rgb * 0.82;
        c += texture2D(uMap, uv + vec2(px.x, 0.0)).rgb * 0.06;
        c += texture2D(uMap, uv - vec2(px.x, 0.0)).rgb * 0.06;
        c += texture2D(uMap, uv + vec2(0.0, px.y)).rgb * 0.06;
        c += texture2D(uMap, uv - vec2(0.0, px.y)).rgb * 0.06;
        // scanlines
        float sl = 0.80 + 0.20 * pow(max(abs(sin(uv.y * 224.0 * 3.14159)), 1e-4), 0.55);
        c *= mix(1.0, sl, 0.35 + 0.5 * uStr);
        // RGB subpixel mask in texture space
        float m3 = mod(floor(uv.x * 256.0 * 3.0), 3.0);
        vec3 mask = m3 < 0.5 ? vec3(1.12, 0.92, 0.92) : (m3 < 1.5 ? vec3(0.92, 1.12, 0.92) : vec3(0.92, 0.92, 1.12));
        c *= mix(vec3(1.0), mask, 0.30 + 0.45 * uStr);
        // flicker + tube vignette
        c *= 1.0 + 0.018 * sin(uTime * 73.0) + 0.012 * sin(uTime * 13.7);
        float vig = 1.0 - 0.32 * pow(max(r2, 1e-5), 1.6);
        c *= vig * inb;
        c += vec3(0.012, 0.020, 0.026) * inb;   // phosphor base glow
        gl_FragColor = vec4(c * uBright, 1.0);
      }`,
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.3675), ROOM.screenMat);
  screen.position.set(0, 1.30, 0.368); screen.rotation.x = -0.14;
  cab.add(screen);
  ROOM.screen = screen;

  // control deck, joystick, buttons
  // control panel with printed overlay art
  const [pc2, px4] = makeCanvas(256, 128);
  const pg2 = px4.createLinearGradient(0, 0, 256, 0);
  pg2.addColorStop(0, '#101c3a'); pg2.addColorStop(0.5, '#1a1030'); pg2.addColorStop(1, '#101c3a');
  px4.fillStyle = pg2; px4.fillRect(0, 0, 256, 128);
  px4.strokeStyle = '#ff8a2a'; px4.lineWidth = 3;
  px4.strokeRect(5, 5, 246, 118);
  px4.strokeStyle = 'rgba(122,223,255,0.8)'; px4.lineWidth = 2;
  px4.beginPath(); px4.arc(64, 64, 30, 0, TAU); px4.stroke();
  px4.beginPath(); px4.arc(176, 60, 18, 0, TAU); px4.stroke();
  px4.beginPath(); px4.arc(220, 60, 18, 0, TAU); px4.stroke();
  px4.font = '700 13px ui-monospace, monospace'; px4.textAlign = 'center';
  px4.fillStyle = '#7adfff'; px4.shadowColor = '#7adfff'; px4.shadowBlur = 6;
  px4.fillText('MOVE', 64, 110); px4.fillText('FIRE', 198, 104);
  drawSpriteTo(px4, SPR.squidA, 116, 20, 2, '#27ff8a', '#27ff8a', 6);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.07, 0.3),
    [matBody, matBody, new THREE.MeshStandardMaterial({ map: canvasTex(pc2, true), roughness: 0.55 }), matBody, matBody, matBody]);
  deck.position.set(0, 0.93, 0.42); deck.rotation.x = -0.18;
  roomLit(deck); cab.add(deck);
  const deckLip = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.14, 0.05), matBody);
  deckLip.position.set(0, 0.86, 0.55);
  roomLit(deckLip); cab.add(deckLip);
  const jbase = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.02, 16), new THREE.MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.5 }));
  jbase.position.set(-0.13, 0.975, 0.42); jbase.rotation.x = -0.18;
  roomLit(jbase); cab.add(jbase);
  const jstick = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.09, 8), matBody);
  jstick.position.set(-0.13, 1.02, 0.405); jstick.rotation.x = -0.3;
  roomLit(jstick); cab.add(jstick);
  const jball = new THREE.Mesh(new THREE.SphereGeometry(0.021, 16, 12), new THREE.MeshStandardMaterial({ color: 0xc92e1f, roughness: 0.3 }));
  jball.position.set(-0.13, 1.062, 0.392);
  roomLit(jball); cab.add(jball);
  for (let b = 0; b < 2; b++) {
    const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.014, 14), new THREE.MeshStandardMaterial({ color: b ? 0xc92e1f : 0xe8e4da, roughness: 0.35 }));
    btn.position.set(0.07 + b * 0.08, 0.975, 0.43); btn.rotation.x = -0.18;
    roomLit(btn); cab.add(btn);
  }
  // bezel corner screws
  const screwGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.012, 8);
  const screwMat = new THREE.MeshStandardMaterial({ color: 0x6a7888, roughness: 0.35, metalness: 0.9 });
  for (const [sx4, sy4] of [[-0.25, 1.52], [0.25, 1.52], [-0.25, 1.085], [0.25, 1.085]]) {
    const sc2 = new THREE.Mesh(screwGeo, screwMat);
    sc2.position.set(sx4, sy4, 0.366 - (sy4 - 1.30) * 0.14);
    sc2.rotation.x = Math.PI / 2 - 0.14;
    roomLit(sc2); cab.add(sc2);
  }
  // coin door + lock
  const coin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.34, 0.04), matBody);
  coin.position.set(0, 0.5, 0.355);
  roomLit(coin); cab.add(coin);
  const lock = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.02, 10), screwMat);
  lock.position.set(0, 0.40, 0.377); lock.rotation.x = Math.PI / 2;
  roomLit(lock); cab.add(lock);
  const slot = new THREE.Mesh(new THREE.PlaneGeometry(0.022, 0.06), new THREE.MeshBasicMaterial({ color: 0xffc87a }));
  slot.position.set(-0.06, 0.52, 0.378);
  cab.add(slot);
  const slot2 = slot.clone(); slot2.position.x = 0.06; cab.add(slot2);

  // power cable to floor socket
  const cabWorld = new THREE.Vector3();
  const pts = [
    new THREE.Vector3(2.05, 0.25, 1.05).add(new THREE.Vector3(-0.2, 0, -0.1)),
    new THREE.Vector3(2.3, 0.03, 1.7),
    new THREE.Vector3(2.6, 0.02, 2.3),
    new THREE.Vector3(2.86, 0.06, 2.75),
  ];
  const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 28, 0.017, 6),
    new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.85 }));
  roomLit(cable); RG.add(cable);
  const socket = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.05), new THREE.MeshStandardMaterial({ color: 0x222a33, roughness: 0.6 }));
  socket.position.set(2.9, 0.08, 2.78); socket.rotation.y = -0.7;
  roomLit(socket); RG.add(socket);
}

function buildSeatConsole(RG) {
  const matSeat = new THREE.MeshStandardMaterial({ color: 0x232c38, roughness: 0.75, metalness: 0.3 });
  const matPad = new THREE.MeshStandardMaterial({ color: 0x37261c, roughness: 0.95 });
  const seat = new THREE.Group();
  seat.position.copy(ROOM.seatPos);
  RG.add(seat);
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.16, 0.42, 12), matSeat);
  ped.position.y = 0.21; roomLit(ped); seat.add(ped);
  const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.1, 0.5), matPad);
  cushion.position.y = 0.47; roomLit(cushion); seat.add(cushion);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.75, 0.1), matPad);
  back.position.set(0, 0.86, 0.27); back.rotation.x = 0.12;
  roomLit(back); seat.add(back);
  const headrest = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.09), matPad);
  headrest.position.set(0, 1.33, 0.32); headrest.rotation.x = 0.12;
  roomLit(headrest); seat.add(headrest);
  // harness straps
  const matStrap = new THREE.MeshStandardMaterial({ color: 0x5a1e16, roughness: 0.95 });
  for (const sgn of [-1, 1]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.62, 0.015), matStrap);
    strap.position.set(sgn * 0.12, 0.92, 0.21); strap.rotation.x = 0.12; strap.rotation.z = sgn * 0.12;
    roomLit(strap); seat.add(strap);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.4), matSeat);
    arm.position.set(sgn * 0.3, 0.62, 0.02);
    roomLit(arm); seat.add(arm);
  }
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x8a98a8, roughness: 0.3, metalness: 0.9 }));
  buckle.position.set(0, 0.62, 0.235); buckle.rotation.x = 0.12;
  roomLit(buckle); seat.add(buckle);
  // rudder pedals under the console
  for (const sgn of [-1, 1]) {
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.04), matSeat);
    pedal.position.set(sgn * 0.16, 0.14, -3.06); pedal.rotation.x = -0.5;
    roomLit(pedal); RG.add(pedal);
  }

  // console desk (arc of boxes facing the seat)
  const matCons = new THREE.MeshStandardMaterial({ color: 0x1b232e, roughness: 0.6, metalness: 0.45 });
  const [cc2, cx3] = makeCanvas(256, 128);
  cx3.fillStyle = '#04130c'; cx3.fillRect(0, 0, 256, 128);
  cx3.font = '10px ui-monospace, monospace'; cx3.fillStyle = '#3dffa0';
  cx3.shadowColor = '#3dffa0'; cx3.shadowBlur = 4;
  const lines = ['ORBIT SYNC.. OK', 'REACTOR 98.2%', 'O2 RECYC NOMINAL', 'NAV: TERRA APPROACH', 'COMMS: NO CARRIER', 'TACTICAL: STANDBY'];
  lines.forEach((l, i) => cx3.fillText(l, 10, 22 + i * 17));
  for (let i = 0; i < 4; i++) { cx3.fillStyle = `rgba(61,255,160,${0.25 + rng() * 0.4})`;
    cx3.fillRect(150 + i * 24, 30 + rng() * 60, 14, 8); }
  const consT = canvasTex(cc2, true);
  // alternate screen: orbital radar sweep plot
  const [cc3, cx4] = makeCanvas(256, 128);
  cx4.fillStyle = '#03100b'; cx4.fillRect(0, 0, 256, 128);
  cx4.strokeStyle = 'rgba(61,255,160,0.5)'; cx4.lineWidth = 1.5;
  for (const rr of [18, 36, 54]) { cx4.beginPath(); cx4.arc(64, 64, rr, 0, TAU); cx4.stroke(); }
  cx4.beginPath(); cx4.moveTo(64, 64); cx4.lineTo(116, 32); cx4.stroke();
  cx4.fillStyle = 'rgba(61,255,160,0.10)';
  cx4.beginPath(); cx4.moveTo(64, 64); cx4.arc(64, 64, 54, -0.9, -0.2); cx4.fill();
  cx4.fillStyle = '#52ff70';
  for (const [bx2, by2] of [[88, 44], [50, 82], [104, 90]]) cx4.fillRect(bx2, by2, 3, 3);
  cx4.font = '10px ui-monospace, monospace'; cx4.fillStyle = '#3dffa0';
  cx4.shadowColor = '#3dffa0'; cx4.shadowBlur = 4;
  cx4.fillText('ORBITAL SCAN', 140, 28);
  cx4.fillText('TRACK: 3', 140, 48);
  cx4.fillText('SECTOR 7G', 140, 68);
  cx4.fillStyle = '#ffb454'; cx4.fillText('Δv BUDGET 82%', 140, 98);
  const consT2 = canvasTex(cc3, true);
  for (let i = -2; i <= 2; i++) {
    const a = i * 0.30;
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.78, 0.34), matCons);
    seg.position.set(Math.sin(a) * 2.6 * 0.45, 0.39, -3.35 + (1 - Math.cos(a)) * 0.5);
    seg.rotation.y = -a * 0.55;
    roomLit(seg); RG.add(seg);
    if (Math.abs(i) < 2) {
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.26),
        new THREE.MeshBasicMaterial({ map: i === 0 ? consT2 : consT, transparent: true, opacity: 0.9 }));
      scr.position.set(seg.position.x, 0.93, seg.position.z + 0.05);
      scr.rotation.x = -0.5; scr.rotation.y = seg.rotation.y;
      RG.add(scr);
    }
  }
  // holo projector ring
  const holo = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.009, 8, 40),
    new THREE.MeshBasicMaterial({ color: 0x36e0ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending }));
  holo.position.set(0.62, 0.99, -3.30); holo.rotation.x = Math.PI / 2 - 0.3;
  RG.add(holo);
  ROOM.holo = holo;
  // switch banks
  const swN = 26;
  const sw = new THREE.InstancedMesh(new THREE.BoxGeometry(0.025, 0.02, 0.035), matCons, swN);
  for (let i = 0; i < swN; i++) {
    _v1.set(-0.6 + (i % 13) * 0.05, 0.80, -3.18 + Math.floor(i / 13) * 0.07);
    _m1.compose(_v1, _q1.identity(), _v2.set(1, 1, 1));
    sw.setMatrixAt(i, _m1);
  }
  roomLit(sw); RG.add(sw);
  // coffee mug
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.034, 0.09, 14),
    new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.4 }));
  mug.position.set(0.74, 0.83, -3.22);
  roomLit(mug); RG.add(mug);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.007, 6, 14, Math.PI),
    mug.material);
  handle.position.set(0.78, 0.83, -3.22); handle.rotation.z = -Math.PI / 2;
  roomLit(handle); RG.add(handle);
  // sticky note
  const [nc2, nx2] = makeCanvas(128, 128);
  nx2.fillStyle = '#ffe97a'; nx2.fillRect(0, 0, 128, 128);
  nx2.fillStyle = 'rgba(0,0,0,0.08)'; nx2.fillRect(0, 0, 128, 14);
  nx2.fillStyle = '#3a3322';
  nx2.font = 'italic 17px Segoe Script, cursive';
  nx2.fillText("don't touch", 12, 46);
  nx2.fillText('my hi-score', 12, 72);
  nx2.fillText('—K', 76, 102);
  const note = new THREE.Mesh(new THREE.PlaneGeometry(0.085, 0.085),
    new THREE.MeshBasicMaterial({ map: canvasTex(nc2, true) }));
  note.position.set(-0.55, 0.95, -3.10); note.rotation.x = -0.5; note.rotation.z = 0.12;
  RG.add(note);
}

// rec-deck set dressing: posters, lockers, crates, extinguisher, lights, cabling
function buildProps(RG, floorHW) {
  const matMetal = new THREE.MeshStandardMaterial({ color: 0x2a323d, roughness: 0.6, metalness: 0.7 });

  // recruitment poster
  const [pa2, pxa] = makeCanvas(256, 384);
  pxa.fillStyle = '#0a1226'; pxa.fillRect(0, 0, 256, 384);
  pxa.strokeStyle = '#26406a'; pxa.lineWidth = 6; pxa.strokeRect(8, 8, 240, 368);
  const eg2 = pxa.createRadialGradient(128, 150, 8, 128, 150, 86);
  eg2.addColorStop(0, '#3d7fd9'); eg2.addColorStop(0.7, '#173a6e'); eg2.addColorStop(1, '#0a1226');
  pxa.fillStyle = eg2; pxa.beginPath(); pxa.arc(128, 150, 80, 0, TAU); pxa.fill();
  pxa.fillStyle = '#2c5a32';
  pxa.beginPath(); pxa.ellipse(108, 130, 30, 20, 0.5, 0, TAU); pxa.fill();
  pxa.beginPath(); pxa.ellipse(150, 175, 24, 16, -0.3, 0, TAU); pxa.fill();
  drawSpriteTo(pxa, SPR.crabA, 95, 50, 5, 'rgba(255,70,50,0.9)', '#ff4632', 14);
  pxa.strokeStyle = '#ff4632'; pxa.lineWidth = 7;
  pxa.beginPath(); pxa.moveTo(80, 40); pxa.lineTo(180, 120); pxa.moveTo(180, 40); pxa.lineTo(80, 120); pxa.stroke();
  pxa.font = '900 25px ui-monospace, monospace'; pxa.textAlign = 'center';
  pxa.fillStyle = '#dff2ff'; pxa.shadowColor = '#7adfff'; pxa.shadowBlur = 8;
  pxa.fillText('TERRA DEFENSE', 128, 280);
  pxa.fillText('CORPS', 128, 312);
  pxa.font = '700 15px ui-monospace, monospace'; pxa.fillStyle = '#ffb454';
  pxa.fillText('YOUR PLANET NEEDS YOU', 128, 350);
  const poster1 = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.93),
    new THREE.MeshStandardMaterial({ map: canvasTex(pa2, true), roughness: 0.85 }));
  poster1.position.set(-floorHW + 0.30, 1.78, 2.3);
  poster1.rotation.y = Math.PI / 2; poster1.rotation.x = -0.07; poster1.rotation.z = 0.02;
  roomLit(poster1); RG.add(poster1);

  // hi-score night poster (ties to the sticky note)
  const [pb2, pxb] = makeCanvas(256, 384);
  pxb.fillStyle = '#120822'; pxb.fillRect(0, 0, 256, 384);
  pxb.strokeStyle = '#3a2a66'; pxb.lineWidth = 6; pxb.strokeRect(8, 8, 240, 368);
  drawSpriteTo(pxb, SPR.squidA, 76, 60, 13, '#7adfff', '#7adfff', 22);
  pxb.font = '900 27px ui-monospace, monospace'; pxb.textAlign = 'center';
  pxb.fillStyle = '#ffd27a'; pxb.shadowColor = '#ff9a2a'; pxb.shadowBlur = 12;
  pxb.fillText('HI-SCORE NIGHT', 128, 230);
  pxb.font = '700 16px ui-monospace, monospace'; pxb.fillStyle = '#dff2ff'; pxb.shadowBlur = 4;
  pxb.fillText('FRIDAYS · REC DECK', 128, 266);
  pxb.font = 'italic 700 15px ui-monospace, monospace'; pxb.fillStyle = '#52ff70';
  pxb.fillText('BEAT 999999 AND', 128, 318);
  pxb.fillText('K BUYS THE COFFEE', 128, 340);
  const poster2 = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.84),
    new THREE.MeshStandardMaterial({ map: canvasTex(pb2, true), roughness: 0.85 }));
  poster2.position.set(1.35, 1.72, 3.56);
  poster2.rotation.y = Math.PI; poster2.rotation.z = -0.03;
  roomLit(poster2); RG.add(poster2);

  // lockers by the door
  const [lc2, lx2] = makeCanvas(128, 256);
  lx2.fillStyle = '#23303c'; lx2.fillRect(0, 0, 128, 256);
  lx2.fillStyle = '#1a242e';
  for (let v = 28; v < 80; v += 10) lx2.fillRect(22, v, 84, 4);
  lx2.fillStyle = '#0e151c'; lx2.fillRect(96, 120, 12, 26);
  lx2.strokeStyle = '#101820'; lx2.lineWidth = 4; lx2.strokeRect(2, 2, 124, 252);
  const lockT = canvasTex(lc2, true);
  for (let i = 0; i < 2; i++) {
    const lk = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.85, 0.4),
      [matMetal, matMetal, matMetal, matMetal, new THREE.MeshStandardMaterial({ map: lockT, roughness: 0.7, metalness: 0.5 }), matMetal]);
    lk.position.set(-2.0 + i * 0.52, 0.925, 3.32);
    roomLit(lk); RG.add(lk);
  }

  // supply crates
  const [cr2, crx] = makeCanvas(128, 128);
  crx.fillStyle = '#37404c'; crx.fillRect(0, 0, 128, 128);
  crx.strokeStyle = '#222a33'; crx.lineWidth = 6; crx.strokeRect(4, 4, 120, 120);
  crx.strokeRect(28, 28, 72, 72);
  crx.fillStyle = '#ffb454'; crx.font = '700 13px ui-monospace, monospace';
  crx.fillText('ORION-IX', 32, 70);
  crx.fillStyle = 'rgba(255,180,84,0.5)'; crx.fillRect(8, 108, 56, 8);
  const crateT = canvasTex(cr2, true);
  const crateMat = new THREE.MeshStandardMaterial({ map: crateT, roughness: 0.8, metalness: 0.4 });
  const cratePos = [[-2.62, 0.26, 1.2, 0.52, 0.15], [-2.5, 0.26, 0.55, 0.52, -0.3], [-2.56, 0.73, 0.9, 0.42, 0.5]];
  for (const [cx2, cy2, cz2, cs2, cr3] of cratePos) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(cs2, cs2, cs2), crateMat);
    crate.position.set(cx2, cy2, cz2); crate.rotation.y = cr3;
    roomLit(crate); RG.add(crate);
  }

  // fire extinguisher + bracket near the door
  const ext2 = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.38, 12),
    new THREE.MeshStandardMaterial({ color: 0xb02418, roughness: 0.4, metalness: 0.3 }));
  ext2.position.set(1.05, 1.05, 3.42);
  roomLit(ext2); RG.add(ext2);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.02, 0.12, 8),
    new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.6 }));
  nozzle.position.set(1.02, 1.28, 3.40); nozzle.rotation.z = 0.6;
  roomLit(nozzle); RG.add(nozzle);
  const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.1), matMetal);
  bracket.position.set(1.05, 0.98, 3.5);
  roomLit(bracket); RG.add(bracket);

  // hazard stripes on the floor at the door
  const [hz2, hzx] = makeCanvas(128, 32);
  for (let x2 = -32; x2 < 160; x2 += 32) {
    hzx.fillStyle = '#c9a227'; hzx.beginPath();
    hzx.moveTo(x2, 32); hzx.lineTo(x2 + 16, 0); hzx.lineTo(x2 + 32, 0); hzx.lineTo(x2 + 16, 32); hzx.fill();
    hzx.fillStyle = '#15181c'; hzx.beginPath();
    hzx.moveTo(x2 + 16, 32); hzx.lineTo(x2 + 32, 0); hzx.lineTo(x2 + 48, 0); hzx.lineTo(x2 + 32, 32); hzx.fill();
  }
  const hzPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.22),
    new THREE.MeshStandardMaterial({ map: canvasTex(hz2, true), roughness: 0.9, transparent: true, opacity: 0.85 }));
  hzPlane.rotation.x = -Math.PI / 2;
  hzPlane.position.set(0, 0.004, 3.05);
  roomLit(hzPlane); RG.add(hzPlane);

  // ceiling light strips (emissive)
  for (const sgn of [-1, 1]) {
    const strip2 = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.025, 5.6),
      new THREE.MeshBasicMaterial({ color: 0x9fc4e8 }));
    const sx3 = sgn * 1.15;
    strip2.position.set(sx3, 1.3 + Math.sqrt(3.4 * 3.4 - sx3 * sx3) - 0.10, 0);
    strip2.rotation.z = -sgn * 0.34;
    RG.add(strip2);
  }

  // cable bundle along the wall base
  for (let i = 0; i < 3; i++) {
    const cbl = new THREE.Mesh(new THREE.CylinderGeometry(0.02 + i * 0.006, 0.02 + i * 0.006, 7.6, 6),
      new THREE.MeshStandardMaterial({ color: i === 1 ? 0x4a3220 : 0x10141a, roughness: 0.9 }));
    cbl.rotation.x = Math.PI / 2;
    cbl.position.set(floorHW - 0.10 - i * 0.05, 0.05 + (i === 1 ? 0.035 : 0), 0.3);
    roomLit(cbl); RG.add(cbl);
  }

  // wall vent
  const [vt2, vtx] = makeCanvas(128, 64);
  vtx.fillStyle = '#161d24'; vtx.fillRect(0, 0, 128, 64);
  vtx.fillStyle = '#060a0e';
  for (let v = 8; v < 60; v += 10) vtx.fillRect(8, v, 112, 5);
  const vent = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.3),
    new THREE.MeshStandardMaterial({ map: canvasTex(vt2, true), roughness: 0.85, metalness: 0.5 }));
  vent.position.set(floorHW + 0.17, 0.62, -1.8);
  vent.rotation.y = -Math.PI / 2;
  roomLit(vent); RG.add(vent);
}

function buildLEDs(RG) {
  const N = 90;
  const led = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.011, 6, 5),
    new THREE.MeshBasicMaterial({ color: 0x707070 }),   // keep under bloom threshold
    N);
  ROOM.ledPhase = [];
  const palette = [0x44ff88, 0xffb454, 0x44aaff, 0xff4444, 0x66ffee];
  const R = 3.4, CY = 1.3;
  for (let i = 0; i < N; i++) {
    let px3, py3, z;
    if (i < 18) { px3 = -0.6 + (i % 9) * 0.14; py3 = 0.82; z = -3.16 + Math.floor(i / 9) * 0.04; } // console
    else {
      const phi = rng() * TAU;
      px3 = Math.cos(phi) * (R - 0.13); py3 = CY + Math.sin(phi) * (R - 0.13); z = -4 + rng() * 8;
      if (py3 < 0.3) { py3 = 0.3 + rng() * 0.5; }
      if (px3 < -2.6 && py3 > 1.1 && py3 < 2.2) px3 = -px3;
    }
    _m1.compose(_v1.set(px3, py3, z), _q1.identity(), _v2.set(1, 1, 1));
    led.setMatrixAt(i, _m1);
    const col = palette[(rng() * palette.length) | 0];
    led.setColorAt(i, _c1.setHex(col));
    ROOM.ledPhase.push({ col, speed: 0.5 + rng() * 3, ph: rng() * TAU });
  }
  led.instanceMatrix.needsUpdate = true;
  led.instanceColor.needsUpdate = true;
  RG.add(led);
  ROOM.ledMesh = led;
}

function buildDust(RG) {
  const N = 220, pos = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = 0.5 + (rng() - 0.5) * 2.4;
    pos[i * 3 + 1] = rng() * 3.0;
    pos[i * 3 + 2] = 0.6 + (rng() - 0.5) * 2.4;
    seed[i] = rng() * 100;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uAmp: { value: 0 } },
    vertexShader: `
      attribute float aSeed; uniform float uTime; varying float vA;
      void main(){
        vec3 p = position;
        p.x += sin(uTime * 0.12 + aSeed) * 0.3;
        p.y += sin(uTime * 0.07 + aSeed * 1.7) * 0.4;
        p.z += cos(uTime * 0.09 + aSeed * 0.6) * 0.3;
        vA = 0.5 + 0.5 * sin(uTime * 0.8 + aSeed * 3.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = 1.9 * (1.4 / max(0.4, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA; uniform float uAmp;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vec3(0.7, 0.8, 0.95), smoothstep(0.5, 0.1, d) * 0.09 * vA * uAmp);
      }`,
  });
  ROOM.dust = new THREE.Points(g, m);
  ROOM.dust.frustumCulled = false;
  RG.add(ROOM.dust);
}

function buildChevron(RG) {
  const g1 = new THREE.ConeGeometry(0.085, 0.13, 4);
  const m = new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false });
  const ch = new THREE.Group();
  const c1 = new THREE.Mesh(g1, m); c1.rotation.x = Math.PI; ch.add(c1);
  const c2 = new THREE.Mesh(g1, m); c2.rotation.x = Math.PI; c2.position.y = 0.17; c2.scale.setScalar(0.7); ch.add(c2);
  ch.position.set(ROOM.seatPos.x, 1.75, ROOM.seatPos.z);
  ch.renderOrder = 999;
  ch.visible = false;
  RG.add(ch);
  ROOM.chevron = ch;
}

// place camera flush against the CRT so the screen exactly fills the viewport
function placeArcadeCamera() {
  ROOM.screen.updateWorldMatrix(true, false);
  const E = ROOM.screen.matrixWorld;
  const sw = 0.42, sh = 0.3675;
  const fov = 55 * Math.PI / 180;
  const A = G.camera.aspect, As = sw / sh;
  let d;
  if (A >= As) d = (sh / 2) / Math.tan(fov / 2);          // fit height (bezel hidden by darkness)
  else d = (sw / 2) / (Math.tan(fov / 2) * A);            // fit width
  _v1.set(0, 0, d).applyMatrix4(E);                        // world cam pos
  _v3.set(0, 0, 0).applyMatrix4(E);                        // screen center
  _v4.set(0, 1, 0).transformDirection(E);                  // screen up
  _m1.lookAt(_v1, _v3, _v4);
  _q1.setFromRotationMatrix(_m1);
  G.bank.updateWorldMatrix(true, false);
  G.camera.position.copy(G.bank.worldToLocal(_v2.copy(_v1)));
  G.bank.getWorldQuaternion(_q2).invert();
  G.camera.quaternion.copy(_q2.multiply(_q1));
  G.camera.fov = 55;
  G.camera.updateProjectionMatrix();
}
// ============================================================================
// CHOREOGRAPHY — arcade phase → reveal → roam → sit → defense handover
// ============================================================================
const CINE = {
  deathAt: -1, revealAt: -1, reveal0: -1, revealDone: false,
  spline: null, lookA: new THREE.Vector3(), lookB: new THREE.Vector3(),
  upA: new THREE.Vector3(0, 1, 0), p3: new THREE.Vector3(0.55, 1.7, 0.55),
  lastMuffKlax: -99,
  sit0: -1, sitFromPos: new THREE.Vector3(), sitFromQuat: new THREE.Quaternion(),
  shutterOpen: 0, slew0: null, slewQ0: new THREE.Quaternion(), slewQ1: new THREE.Quaternion(),
  bootLines: [], bootIdx: 0, bootT: 0, bootActive: false, bootDone: false,
  burnFrom: 0,
};
const WALK = { yaw: 0, pitch: 0, phase: 0, speed: 0 };

function enterArcade() {
  S.mode = 'ARCADE';
  S.startedAt = S.now;
  uiPrompt(null, null);
  ARC.start();
  ARC.onFinalDeath = onArcadeDeath;
}
function onArcadeDeath() {
  CINE.deathAt = S.now;
  CINE.revealAt = S.now + 2.6;
  S.emergencyOn = true;
  // open the world bus so the muffled klaxon is actually audible at the death frame
  if (AUD.ok) AUD.world.gain.setValueAtTime(0.4, AUD.ctx.currentTime);
  AUD.klaxon(true);                       // the invasion alert IS the death frame
  CINE.lastMuffKlax = S.now;
}
function startReveal() {
  S.mode = 'REVEAL';
  CINE.reveal0 = S.now;
  AUD.startWorldAmbience();
  AUD.attachArcadeToCabinet(ROOM.screen);
  // spline in bank-local space, starting exactly at the current camera pose
  ROOM.screen.updateWorldMatrix(true, false);
  G.bank.updateWorldMatrix(true, false);
  const E = ROOM.screen.matrixWorld;
  const scrC = G.bank.worldToLocal(_v1.set(0, 0, 0).applyMatrix4(E)).clone();
  G.bank.getWorldQuaternion(_q2).invert();
  const n = _v2.set(0, 0, 1).transformDirection(E).applyQuaternion(_q2).clone();
  const up = _v3.set(0, 1, 0).transformDirection(E).applyQuaternion(_q2).clone();
  const side = _v4.set(1, 0, 0).transformDirection(E).applyQuaternion(_q2).clone();
  const P0 = G.camera.position.clone();
  const P1 = scrC.clone().addScaledVector(n, 0.85).addScaledVector(up, 0.10).addScaledVector(side, 0.22);
  const P2 = scrC.clone().addScaledVector(n, 2.3).addScaledVector(up, 0.65).addScaledVector(side, 1.05);
  P2.y = Math.max(P2.y, 1.45);
  const P3 = CINE.p3.clone();
  CINE.spline = new THREE.CatmullRomCurve3([P0, P1, P2, P3], false, 'centripetal');
  CINE.lookA.copy(scrC);
  CINE.lookB.set(0, 1.05, -2.6);          // seat / console area
  CINE.upA.copy(up);
  CINE.revealDone = false;
}
function updateReveal(dt) {
  const t = clamp((S.now - CINE.reveal0) / 10, 0, 1);
  const e = easeIO(t);
  CINE.spline.getPointAt(e, G.camera.position);
  const lk = smooth(clamp((t - 0.55) / 0.40, 0, 1));
  _v1.lerpVectors(CINE.lookA, CINE.lookB, lk);
  _v2.lerpVectors(CINE.upA, _v3.set(0, 1, 0), smooth(clamp(t * 1.8, 0, 1))).normalize();
  _m1.lookAt(G.camera.position, _v1, _v2);
  _q1.setFromRotationMatrix(_m1);
  G.camera.quaternion.slerp(_q1, t < 0.04 ? t / 0.04 : 1);
  G.camera.fov = lerp(55, 75, smooth(clamp((t - 0.55) / 0.45, 0, 1)));
  G.camera.updateProjectionMatrix();
  // room wakes up around the player
  const L = ROOM.lights;
  L.spot.intensity = 100 * smooth(clamp((t - 0.25) / 0.6, 0, 1));
  L.consPt.intensity = 7 * smooth(clamp((t - 0.4) / 0.5, 0, 1));
  L.fill.intensity = 22 * smooth(clamp((t - 0.3) / 0.6, 0, 1));
  L.amb.intensity = lerp(0.10, 0.95, smooth(clamp(t * 1.5, 0, 1)));
  ROOM.screenMat.uniforms.uStr.value = lerp(0.22, 1.0, smooth(t));
  ROOM.screenMat.uniforms.uBright.value = lerp(1.1, 1.55, smooth(t));
  ROOM.dust.material.uniforms.uAmp.value = smooth(clamp((t - 0.35) / 0.5, 0, 1));
  if (t >= 1 && !CINE.revealDone) {
    CINE.revealDone = true;
    uiPrompt('CLICK TO TAKE CONTROL', 'YOUR SHIFT ISN’T OVER');
  }
}
function enterRoam() {
  S.mode = 'ROAM';
  S.paused = false;
  uiPrompt(null, null);
  $('mission').classList.add('show');
  ROOM.chevron.visible = true;
  const hint = $('hint');
  hint.innerHTML = 'WASD — MOVE &nbsp;·&nbsp; MOUSE — LOOK &nbsp;·&nbsp; E — INTERACT';
  hint.style.opacity = '1';
  setTimeout(() => { if (S.mode === 'ROAM') hint.style.opacity = '0'; }, 9000);
  // derive yaw/pitch from current camera orientation
  _v1.set(0, 0, -1).applyQuaternion(G.camera.quaternion);
  WALK.yaw = Math.atan2(-_v1.x, -_v1.z);
  WALK.pitch = Math.asin(clamp(_v1.y, -1, 1));
}
const _eul = new THREE.Euler(0, 0, 0, 'YXZ');
function updateRoam(dt) {
  if (S.paused) return;
  WALK.yaw -= IN.mdx * 0.0023;
  WALK.pitch = clamp(WALK.pitch - IN.mdy * 0.0023, -1.45, 1.45);
  _eul.set(WALK.pitch, WALK.yaw, 0);
  G.camera.quaternion.setFromEuler(_eul);
  let fx = 0, fz = 0;
  if (IN.keys['KeyW']) fz -= 1; if (IN.keys['KeyS']) fz += 1;
  if (IN.keys['KeyA']) fx -= 1; if (IN.keys['KeyD']) fx += 1;
  const moving = fx !== 0 || fz !== 0;
  const sp = 2.3;
  if (moving) {
    const len = Math.hypot(fx, fz); fx /= len; fz /= len;
    const sy = Math.sin(WALK.yaw), cy = Math.cos(WALK.yaw);
    const mx = (fx * cy + fz * sy) * sp * dt;
    const mz = (-fx * sy + fz * cy) * sp * dt;
    moveWithCollision(mx, mz);
    WALK.phase += dt * 7.2;
    if (WALK.phase > TAU) { WALK.phase -= TAU; AUD.footstep(); }
  } else WALK.phase *= 0.9;
  G.camera.position.y = 1.7 + Math.sin(WALK.phase * 2) * 0.022;
  // interactions
  const cp = G.camera.position;
  const dSeat = Math.hypot(cp.x - ROOM.seatPos.x, cp.z - ROOM.seatPos.z);
  const dArc = Math.hypot(cp.x - ROOM.arcadePos.x, cp.z - ROOM.arcadePos.z);
  if (dSeat < 1.45) {
    uiPrompt(null, 'E — MAN THE CONTROL SEAT');
    if (IN.pressed['KeyE']) startSit();
  } else if (dArc < 1.3) {
    uiPrompt(null, 'E — PLAY');
    if (IN.pressed['KeyE']) { uiToast('NOT NOW.'); AUD.uiBlip(330); }
  } else uiPrompt(null, null);
}
function moveWithCollision(mx, mz) {
  const p = G.camera.position, r = 0.32;
  const tryAxis = (nx, nz) => {
    if (nx < -2.82 || nx > 2.82 || nz < -3.55 || nz > 4.05) return false;
    for (const c of ROOM.colliders)
      if (nx > c.x0 - r && nx < c.x1 + r && nz > c.z0 - r && nz < c.z1 + r) return false;
    return true;
  };
  if (tryAxis(p.x + mx, p.z)) p.x += mx;
  if (tryAxis(p.x, p.z + mz)) p.z += mz;
}

// ---------------- sit transition + canopy + boot ----------------
function startSit() {
  S.mode = 'SIT';
  CINE.sit0 = S.now;
  CINE.sitFromPos.copy(G.camera.position);
  CINE.sitFromQuat.copy(G.camera.quaternion);
  CINE.shutterOpen = -1;
  CINE.bootActive = false; CINE.bootDone = false;
  ROOM.chevron.visible = false;
  uiPrompt(null, null);
  $('mission').classList.remove('show');
  AUD.uiBlip(990);
  // ship slew target: face Earth
  CINE.slewQ0.copy(G.shipRig.quaternion);
  _v1.copy(G.shipRig.position).normalize();              // away from Earth
  const zA = _v1.clone();                                 // local +Z away → forward (-Z) at Earth
  const xA = _v2.crossVectors(_v3.set(0, 1, 0), zA).normalize();
  const yA = _v4.crossVectors(zA, xA).normalize();
  _m1.makeBasis(xA, yA, zA);
  CINE.slewQ1.setFromRotationMatrix(_m1);
  CINE.burnFrom = S.earthDist;
}
const BOOT_LINES = n => [
  'ORION-IX TACTICAL // ONLINE',
  'LINK: ORBITAL GRID ........ OK',
  'CANOPY: OPEN',
  'WEAPONS: CHARGED',
  'MISSILES: ARMED',
  `EARTH INTEGRITY: ${Math.round(S.integrity)}%`,
  `THREATS INBOUND: ${n}`,
  'GOOD HUNTING, PILOT.',
];
function updateSit(dt) {
  const t = S.now - CINE.sit0;
  // 0–1.2 s: settle into the seat, FOV 75→68
  const k = smooth(clamp(t / 1.2, 0, 1));
  G.camera.position.lerpVectors(CINE.sitFromPos, ROOM.seatHead, k);
  _q1.setFromEuler(_eul.set(-0.02, 0, 0));
  G.camera.quaternion.copy(CINE.sitFromQuat).slerp(_q1, k);
  G.camera.fov = lerp(75, 68, k);
  G.camera.updateProjectionMatrix();
  // 1.2 s: shutters part + arrival burn + slew to face Earth
  if (t >= 1.2 && CINE.shutterOpen < 0) {
    CINE.shutterOpen = S.now;
    AUD.servo(2.8);
    AUD.startEngine(); AUD.setEngine(0.95, true);
  }
  if (CINE.shutterOpen > 0) {
    const st = clamp((S.now - CINE.shutterOpen) / 2.6, 0, 1);
    const e = easeIO(st);
    for (const sl of ROOM.shutters) {
      sl.position.y = sl.userData.y0 + sl.userData.dir * e * (3.3 - sl.userData.off * 0.35);
      sl.visible = st < 0.995;
    }
    G.sunLight.intensity = lerp(0.3, 2.6, e);   // sunlight floods the deck
    // ship slews so Earth sweeps into the canopy
    G.shipRig.quaternion.slerpQuaternions(CINE.slewQ0, CINE.slewQ1, easeIO(clamp(st * 1.15, 0, 1)));
    // arrival burn: close to combat range
    const bt = clamp((S.now - CINE.shutterOpen) / 6.0, 0, 1);
    S.earthDist = lerp(CINE.burnFrom, 880, easeIO(bt));
    if (st > 0.9) S.flareBoost = 1.6;
    if (bt >= 1 && !CINE.bootActive && !CINE.bootDone) {
      CINE.bootActive = true; CINE.bootIdx = 0; CINE.bootT = 0;
      CINE.bootLines = BOOT_LINES(WAVES.upcomingCount());
      $('boot').classList.remove('hidden');
      $('boot').innerHTML = '';
      AUD.setEngine(0.3, false);
    }
  }
  if (CINE.bootActive) {
    CINE.bootT -= dt;
    if (CINE.bootT <= 0 && CINE.bootIdx < CINE.bootLines.length) {
      const div = document.createElement('div');
      div.className = 'bl';
      div.textContent = CINE.bootLines[CINE.bootIdx];
      $('boot').appendChild(div);
      AUD.bootBlip(CINE.bootIdx);
      CINE.bootIdx++;
      CINE.bootT = 0.13;
    }
    if (CINE.bootIdx >= CINE.bootLines.length && CINE.bootT < -0.9) {
      CINE.bootActive = false; CINE.bootDone = true;
      $('boot').classList.add('hidden');
      enterDefense();
    }
  }
}
function enterDefense() {
  S.mode = 'DEFENSE';
  S.defenseT = 0;
  G.sunLight.intensity = 2.6;
  // if pointer lock was dropped during the cutscene (Esc), pause until reclaimed
  if (!IN.locked && !S.testMode) {
    S.paused = true;
    uiPrompt('CLICK TO RESUME', '');
  }
  $('hud').classList.add('on');
  $('reticle').style.opacity = '1';
  $('aimdot').style.opacity = '1';
  AUD.setMusic('combat');
  FLIGHT.aimX = 0; FLIGHT.aimY = 0; FLIGHT.throttle = 0.45;
  const hint = $('hint');
  hint.innerHTML = 'MOUSE — STEER (C recenters) · W/S — THROTTLE · SHIFT — BOOST · LMB — LASERS · HOLD RMB — LOCK · TAB — TACTICAL · V — CAMERA';
  hint.style.opacity = '1';
  setTimeout(() => { hint.style.opacity = '0'; }, 12000);
  WAVES.begin();
}

// room idle animation + emergency lighting + rail approach
function updateRoomAndShip(dt) {
  // pre-flight approach rail
  if (S.mode !== 'DEFENSE' && S.mode !== 'FALLEN' && S.mode !== 'SIT') {
    S.earthDist += (2600 - S.earthDist) * (1 - Math.exp(-dt / 48));
  }
  if (S.mode !== 'DEFENSE' && S.mode !== 'FALLEN') {
    G.shipRig.position.copy(CFG.shipDir).multiplyScalar(S.earthDist);
  }
  // window strip
  ROOM.windowMat.uniforms.uTime.value = S.now;
  ROOM.windowMat.uniforms.uEarth.value = clamp(Math.atan(CFG.earthR / Math.max(700, S.earthDist)) / 0.75, 0.06, 0.46);
  // CRT + starfield twinkle
  ROOM.screenMat.uniforms.uTime.value = S.now;
  G.starMat.uniforms.uTime.value = S.now;
  if (ROOM.holo) { ROOM.holo.rotation.z += dt * 0.7; }
  // LEDs round-robin blink
  const led = ROOM.ledMesh;
  for (let k = 0; k < 12; k++) {
    const i = (S.frame * 12 + k) % ROOM.ledPhase.length;
    const ph = ROOM.ledPhase[i];
    const on = Math.sin(S.now * ph.speed + ph.ph) > -0.2 ? 1 : 0.06;
    led.setColorAt(i, _c1.setHex(ph.col).multiplyScalar(on));
  }
  led.instanceColor.needsUpdate = true;
  ROOM.dust.material.uniforms.uTime.value = S.now;
  // chevron pulse
  if (ROOM.chevron.visible) {
    ROOM.chevron.position.y = 1.75 + Math.sin(S.now * 2.2) * 0.07;
    ROOM.chevron.scale.setScalar(1 + Math.sin(S.now * 4.4) * 0.1);
  }
  // emergency light
  if (S.emergencyOn) {
    const ramp = clamp((S.now - CINE.deathAt) / 3, 0, 1);
    ROOM.lights.emerg.intensity = (Math.sin(S.now * 2.7) * 0.5 + 0.5) * 34 * ramp;
  }
  // muffled klaxon between death and reveal start
  if (S.mode === 'ARCADE' && S.emergencyOn && S.now - CINE.lastMuffKlax > 4.2) {
    CINE.lastMuffKlax = S.now;
    AUD.klaxon(true);
  }
}
// ============================================================================
// FX — pooled particles, fireballs, debris, rings, tracers, shake
// ============================================================================
const FX = {
  sparks: null, sparkCursor: 0, SPARK_N: 3072,
  smoke: null, smokeCursor: 0, SMOKE_N: 1024,
  fireballs: [], flashes: [], lights: [], rings: [], debris: null, debrisList: [],
  tracers: [], tracerMesh: null, TRACER_N: 256, _tc: 0,
  muzzle: [], muzzleIdx: 0,
  speedLines: null, slPos: null,
  noiseTex: null,
};

function buildFX() {
  // ---- shared noise texture ----
  const [nc, nx] = makeCanvas(256, 256);
  const id = nx.createImageData(256, 256);
  for (let i = 0; i < 256 * 256; i++) {
    const x = i % 256, y = (i / 256) | 0;
    const v = fbm(x / 36, y / 36, 5) * 255;
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
  }
  nx.putImageData(id, 0, 0);
  FX.noiseTex = new THREE.CanvasTexture(nc);
  FX.noiseTex.wrapS = FX.noiseTex.wrapT = THREE.RepeatWrapping;

  // ---- spark + smoke point pools ----
  const mkPool = (N, frag, blending) => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3), vel = new Float32Array(N * 3);
    const t0 = new Float32Array(N).fill(-1e3), life = new Float32Array(N).fill(1);
    const size = new Float32Array(N), col = new Float32Array(N * 3);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    g.setAttribute('aT0', new THREE.BufferAttribute(t0, 1));
    g.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute vec3 aVel; attribute float aT0; attribute float aLife;
        attribute float aSize; attribute vec3 aCol;
        uniform float uTime;
        varying vec3 vC; varying float vK;
        void main(){
          float age = uTime - aT0;
          float k = clamp(age / aLife, 0.0, 1.0);
          vK = k;
          vC = aCol;
          float slow = (1.0 - exp(-age * 2.0)) / 2.0;
          vec3 p = position + aVel * slow;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float alive = (age > 0.0 && age < aLife) ? 1.0 : 0.0;
          gl_PointSize = aSize * alive * (1.0 + k * 0.4) * (320.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: frag,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    G.scene.add(pts);
    return pts;
  };
  FX.sparks = mkPool(FX.SPARK_N, `
    varying vec3 vC; varying float vK;
    void main(){
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.05, d) * (1.0 - vK);
      gl_FragColor = vec4(vC * (1.0 + (1.0 - vK) * 2.0), a);
    }`, THREE.AdditiveBlending);
  FX.smoke = mkPool(FX.SMOKE_N, `
    varying vec3 vC; varying float vK;
    void main(){
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.18, d) * sin(min(vK, 1.0) * 3.14159) * 0.34;
      gl_FragColor = vec4(vC, a);
    }`, THREE.NormalBlending);

  // ---- fireballs ----
  for (let i = 0; i < 14; i++) {
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uT: { value: 2 }, uNoise: { value: FX.noiseTex }, uSeed: { value: Math.random() * 10 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uT; uniform sampler2D uNoise; uniform float uSeed;
        varying vec2 vUv;
        void main(){
          if (uT >= 1.0) discard;
          vec2 cc = vUv - 0.5;
          float r = length(cc) * 2.0;
          float n = texture2D(uNoise, vUv * 1.6 + vec2(uSeed, uT * 0.55)).r;
          float n2 = texture2D(uNoise, vUv * 3.1 - vec2(uT * 0.4, uSeed)).r;
          float edge = r + (n - 0.5) * 0.55 + (n2 - 0.5) * 0.25;
          float body = smoothstep(0.95, 0.25, edge + uT * 0.85);
          vec3 col = mix(vec3(1.0, 0.96, 0.85), vec3(1.0, 0.45, 0.08), clamp(uT * 1.6 + r * 0.8, 0.0, 1.0));
          col = mix(col, vec3(0.25, 0.05, 0.02), clamp((uT - 0.55) * 2.2, 0.0, 1.0));
          gl_FragColor = vec4(col * 2.0, body * (1.0 - uT));
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    mesh.visible = false;
    G.scene.add(mesh);
    FX.fireballs.push({ mesh, t: 2, dur: 1, scale: 1 });
  }
  // ---- core flash sprites ----
  const [flc, flx] = makeCanvas(64, 64);
  const fg = flx.createRadialGradient(32, 32, 0, 32, 32, 32);
  fg.addColorStop(0, 'rgba(255,255,255,1)'); fg.addColorStop(0.3, 'rgba(255,240,200,0.7)'); fg.addColorStop(1, 'rgba(255,200,120,0)');
  flx.fillStyle = fg; flx.fillRect(0, 0, 64, 64);
  const flT = new THREE.CanvasTexture(flc);
  for (let i = 0; i < 8; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: flT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    sp.visible = false;
    G.scene.add(sp);
    FX.flashes.push({ sp, t: 2, dur: 0.18, scale: 1 });
  }
  // ---- pooled point lights ----
  for (let i = 0; i < 3; i++) {
    const li = new THREE.PointLight(0xffffff, 0, 60, 1.6);
    li.visible = false;
    G.scene.add(li);
    FX.lights.push({ li, t: 2, dur: 0.3, i0: 0 });
  }
  // ---- shockwave / decal rings ----
  for (let i = 0; i < 10; i++) {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.82, 1.0, 48), m);
    mesh.visible = false;
    G.scene.add(mesh);
    FX.rings.push({ mesh, t: 2, dur: 1, scale: 1, billboard: true });
  }
  // ---- debris ----
  FX.debris = new THREE.InstancedMesh(
    new THREE.TetrahedronGeometry(0.5),
    new THREE.MeshStandardMaterial({ color: 0x39424c, roughness: 0.6, metalness: 0.85 }), 48);
  FX.debris.frustumCulled = false;
  sunlit(FX.debris);
  G.scene.add(FX.debris);
  for (let i = 0; i < 48; i++) {
    FX.debrisList.push({ alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), ax: new THREE.Vector3(1, 0, 0), spin: 0, t: 0, life: 1, size: 1 });
    _m1.compose(_v1.set(0, -99999, 0), _q1.identity(), _v2.set(0.001, 0.001, 0.001));
    FX.debris.setMatrixAt(i, _m1);
  }
  FX.debris.instanceMatrix.needsUpdate = true;
  // ---- tracers ----
  FX.tracerMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    FX.TRACER_N);
  FX.tracerMesh.frustumCulled = false;
  G.scene.add(FX.tracerMesh);
  for (let i = 0; i < FX.TRACER_N; i++) {
    FX.tracers.push({ alive: false, pos: new THREE.Vector3(), dir: new THREE.Vector3(), speed: 0, len: 4, thick: 0.1, ttl: 0, owner: 0, dmg: 1 });
    FX.tracerMesh.setColorAt(i, _c1.setHex(0xffffff));
    _m1.compose(_v1.set(0, -99999, 0), _q1.identity(), _v2.set(0.001, 0.001, 0.001));
    FX.tracerMesh.setMatrixAt(i, _m1);
  }
  FX.tracerMesh.instanceMatrix.needsUpdate = true;
  // ---- muzzle lights ----
  for (let i = 0; i < 2; i++) {
    const li = new THREE.PointLight(0x9fdfff, 0, 22, 1.8);
    li.visible = false;
    G.scene.add(li);
    FX.muzzle.push(li);
  }
  // ---- boost speed lines (camera-local) ----
  const SLN = 64;
  FX.slPos = new Float32Array(SLN * 6);
  for (let i = 0; i < SLN; i++) resetSpeedLine(i, true);
  const slg = new THREE.BufferGeometry();
  slg.setAttribute('position', new THREE.BufferAttribute(FX.slPos, 3));
  FX.speedLines = new THREE.LineSegments(slg,
    new THREE.LineBasicMaterial({ color: 0x9fdfff, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));
  FX.speedLines.frustumCulled = false;
  G.camera.add(FX.speedLines);
}
function resetSpeedLine(i, randz) {
  const a = rng() * TAU, rr = 2.5 + rng() * 6;
  const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
  const z = randz ? -(4 + rng() * 26) : -30;
  FX.slPos[i * 6] = x; FX.slPos[i * 6 + 1] = y; FX.slPos[i * 6 + 2] = z;
  FX.slPos[i * 6 + 3] = x; FX.slPos[i * 6 + 4] = y; FX.slPos[i * 6 + 5] = z - 2.2;
}

// ---- spawn helpers ----
// flag a contiguous dirty range on an attribute (full upload on ring wrap);
// merges multiple spawns within the same frame
function markRange(attr, start, count, N) {
  if (!attr.addUpdateRange) { attr.needsUpdate = true; return; }
  let r = attr._pr;
  if (!r || r.frame !== S.frame) r = attr._pr = { frame: S.frame, a: start, b: start + count, full: false };
  else { r.a = Math.min(r.a, start); r.b = Math.max(r.b, start + count); }
  if (start + count > N) r.full = true;
  attr.clearUpdateRanges();
  if (!r.full) attr.addUpdateRange(r.a * attr.itemSize, (r.b - r.a) * attr.itemSize);
  attr.needsUpdate = true;
}
function spawnPoolParticles(points, cursorKey, N, p, n, hex, speed, size, life, speedBias) {
  const g = points.geometry;
  const pos = g.attributes.position, vel = g.attributes.aVel, t0 = g.attributes.aT0;
  const lf = g.attributes.aLife, sz = g.attributes.aSize, cl = g.attributes.aCol;
  _c1.setHex(hex);
  const start = FX[cursorKey] % N;
  for (let k = 0; k < n; k++) {
    const i = FX[cursorKey]++ % N;
    pos.setXYZ(i, p.x, p.y, p.z);
    _v1.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize().multiplyScalar(speed * (speedBias + rng()));
    vel.setXYZ(i, _v1.x, _v1.y, _v1.z);
    t0.setX(i, S.now);
    lf.setX(i, life * (0.5 + rng() * 0.8));
    sz.setX(i, size * (0.6 + rng() * 0.9));
    cl.setXYZ(i, _c1.r, _c1.g, _c1.b);
  }
  for (const a of [pos, vel, t0, lf, sz, cl]) markRange(a, start, n, N);
}
function fxSparks(p, n, hex, speed, size, life = 0.7) {
  spawnPoolParticles(FX.sparks, 'sparkCursor', FX.SPARK_N, p, n, hex, speed, size, life, 0.3);
}
function fxSmoke(p, n, hex, speed, size, life = 2.2) {
  spawnPoolParticles(FX.smoke, 'smokeCursor', FX.SMOKE_N, p, n, hex, speed, size, life, 0.2);
}
function fxFireball(p, scale, dur = 0.9) {
  let best = FX.fireballs[0];
  for (const f of FX.fireballs) if (f.t > best.t) best = f;
  best.t = 0; best.dur = dur; best.scale = scale;
  best.mesh.position.copy(p);
  best.mesh.visible = true;
}
function fxFlash(p, scale, hex = 0xffffff) {
  let best = FX.flashes[0];
  for (const f of FX.flashes) if (f.t > best.t) best = f;
  best.t = 0; best.scale = scale;
  best.sp.material.color.setHex(hex);
  best.sp.position.copy(p);
  best.sp.visible = true;
}
function fxLight(p, hex, intensity, dist, dur = 0.25) {
  let best = FX.lights[0];
  for (const f of FX.lights) if (f.t > best.t) best = f;
  best.t = 0; best.dur = dur; best.i0 = intensity;
  best.li.color.setHex(hex);
  best.li.intensity = intensity;
  best.li.distance = dist;
  best.li.position.copy(p);
  best.li.visible = true;
}
function fxRing(p, normal, scale, hex, dur = 0.7) {
  let best = FX.rings[0];
  for (const f of FX.rings) if (f.t > best.t) best = f;
  best.t = 0; best.dur = dur; best.scale = scale;
  best.mesh.material.color.setHex(hex);
  best.mesh.position.copy(p);
  best.billboard = !normal;
  if (normal) {
    _v1.copy(p).add(normal);
    best.mesh.lookAt(_v1);
  }
  best.mesh.visible = true;
}
function fxDebris(p, n, speed) {
  for (let k = 0; k < n; k++) {
    let slot = null;
    for (const d of FX.debrisList) if (!d.alive) { slot = d; break; }
    if (!slot) slot = FX.debrisList[(rng() * 48) | 0];
    slot.alive = true;
    slot.pos.copy(p);
    slot.vel.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize().multiplyScalar(speed * (0.4 + rng()));
    slot.ax.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
    slot.spin = (rng() * 2 - 1) * 9;
    slot.t = 0; slot.life = 1.4 + rng();
    slot.size = 0.4 + rng() * 0.9;
  }
}
function fxShake(amt) { S.shake = Math.min(1.2, S.shake + amt); }
function fxHitstop(t = 0.06) { S.hitstop = Math.max(S.hitstop, t); }

// composite explosion
function fxExplode(p, size, opts = {}) {
  fxFlash(p, size * 7, 0xfff4dd);
  fxFireball(p, size * 9, 0.75 + size * 0.1);
  fxSparks(p, Math.min(60, 18 + size * 14 | 0), opts.spark || 0xffc47a, 18 * size, 5 + size, 0.8);
  fxSmoke(p, Math.min(20, 6 + size * 5 | 0), 0x495059, 4 * size, 26 * size, 2.6);
  fxDebris(p, Math.min(10, 3 + size * 2 | 0), 13 * size);
  fxRing(p, null, size * 4.2, opts.ring || 0xffb47a, 0.55);
  fxLight(p, opts.light || 0xffa860, 1600 * size, 90 * size, 0.3);
  G.camera.getWorldPosition(_v6);
  const d = _v6.distanceTo(p);
  fxShake(clamp(size * 26 / Math.max(20, d), 0, 0.5));
  AUD.boom(clamp(size * 28 / Math.max(24, d), 0.15, 1.6));
}

function fxTracer(p, dir, speed, len, thick, hex, owner, dmg, ttl) {
  let slot = null;
  for (let i = 0; i < FX.TRACER_N; i++) {
    const t = FX.tracers[(i + FX._tc) % FX.TRACER_N];
    if (!t.alive) { slot = t; slot.idx = (i + FX._tc) % FX.TRACER_N; break; }
  }
  FX._tc = ((FX._tc || 0) + 1) % FX.TRACER_N;
  if (!slot) return null;
  slot.alive = true;
  slot.pos.copy(p); slot.dir.copy(dir).normalize();
  slot.speed = speed; slot.len = len; slot.thick = thick;
  slot.ttl = ttl; slot.owner = owner; slot.dmg = dmg;
  FX.tracerMesh.setColorAt(slot.idx, _c1.setHex(hex));
  FX.tracerMesh.instanceColor.needsUpdate = true;
  return slot;
}
function fxMuzzle(p, hex) {
  const li = FX.muzzle[FX.muzzleIdx ^= 1];
  li.position.copy(p);
  li.color.setHex(hex);
  li.intensity = 300;
  li.visible = true;
}

const _upQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
function fxUpdate(dt, rdt) {
  FX.sparks.material.uniforms.uTime.value = S.now;
  FX.smoke.material.uniforms.uTime.value = S.now;
  // fireballs
  for (const f of FX.fireballs) {
    if (f.t > 1) { f.mesh.visible = false; continue; }
    f.t += dt / f.dur;
    f.mesh.material.uniforms.uT.value = f.t;
    const s = f.scale * (0.5 + easeOut(Math.min(1, f.t)) * 0.9);
    f.mesh.scale.set(s, s, s);
    f.mesh.quaternion.copy(G.camera.getWorldQuaternion(_upQ));
  }
  for (const f of FX.flashes) {
    if (f.t > 1) { f.sp.visible = false; continue; }
    f.t += dt / 0.16;
    f.sp.scale.setScalar(f.scale * (0.5 + f.t));
    f.sp.material.opacity = 1 - f.t;
  }
  for (const f of FX.lights) {
    if (f.t > 1) { f.li.visible = false; f.li.intensity = 0; continue; }
    f.t += dt / f.dur;
    f.li.intensity = f.i0 * Math.max(0, 1 - f.t);
  }
  for (const f of FX.rings) {
    if (f.t > 1) { f.mesh.visible = false; continue; }
    f.t += dt / f.dur;
    const s = f.scale * (0.15 + easeOut(Math.min(1, f.t)));
    f.mesh.scale.set(s, s, s);
    f.mesh.material.opacity = Math.max(0, 0.85 * (1 - f.t));
    if (f.billboard) f.mesh.quaternion.copy(G.camera.getWorldQuaternion(_upQ));
  }
  // debris
  let anyDebris = false;
  for (let i = 0; i < FX.debrisList.length; i++) {
    const d = FX.debrisList[i];
    if (!d.alive) continue;
    anyDebris = true;
    d.t += dt;
    if (d.t > d.life) {
      d.alive = false;
      _m1.compose(_v1.set(0, -99999, 0), _q1.identity(), _v2.set(0.001, 0.001, 0.001));
      FX.debris.setMatrixAt(i, _m1);
      continue;
    }
    d.pos.addScaledVector(d.vel, dt);
    d.vel.multiplyScalar(1 - dt * 0.5);
    _q1.setFromAxisAngle(d.ax, d.spin * d.t);
    const sc = d.size * Math.max(0.001, 1 - d.t / d.life);
    _m1.compose(d.pos, _q1, _v2.set(sc, sc, sc));
    FX.debris.setMatrixAt(i, _m1);
  }
  if (anyDebris) FX.debris.instanceMatrix.needsUpdate = true;
  // tracers
  let anyTracer = false;
  for (let i = 0; i < FX.TRACER_N; i++) {
    const t = FX.tracers[i];
    if (!t.alive) continue;
    anyTracer = true;
    t.ttl -= dt;
    if (t.ttl <= 0) {
      t.alive = false;
      _m1.compose(_v1.set(0, -99999, 0), _q1.identity(), _v2.set(0.001, 0.001, 0.001));
      FX.tracerMesh.setMatrixAt(i, _m1);
      continue;
    }
    t.pos.addScaledVector(t.dir, t.speed * dt);
    _q1.setFromUnitVectors(_zAxis, t.dir);
    _m1.compose(t.pos, _q1, _v2.set(t.thick, t.thick, t.len));
    FX.tracerMesh.setMatrixAt(i, _m1);
  }
  if (anyTracer || FX.tracerDirty) { FX.tracerDirty = anyTracer; FX.tracerMesh.instanceMatrix.needsUpdate = true; }
  // muzzle decay
  for (const li of FX.muzzle) {
    if (!li.visible) continue;
    li.intensity -= rdt * 3400;
    if (li.intensity <= 0) { li.intensity = 0; li.visible = false; }
  }
  // shake (uses real dt so it works through hitstop)
  if (S.shake > 0.0005) {
    S.shake *= Math.pow(0.0028, rdt);
    G.camShake.position.set((Math.random() - 0.5) * S.shake * 0.16, (Math.random() - 0.5) * S.shake * 0.16, 0);
    G.camShake.rotation.z = (Math.random() - 0.5) * S.shake * 0.02;
  } else { G.camShake.position.set(0, 0, 0); G.camShake.rotation.z = 0; }
}
// ============================================================================
// ENEMIES — 3D-extruded arcade silhouettes (the payoff), rifts, AI
// ============================================================================
const ENEMIES = {
  list: [], DRONE_MAX: 44,
  droneBody: null, droneCore: null, droneSlots: [],
  rifts: [], cruiserProto: null, bossProto: null,
  droneGeoRadius: 3,
};

// merge horizontal pixel runs of a sprite into boxes → one extruded geometry
function extrudeSprite(spr, px, depth) {
  const geos = [];
  const w2 = spr.w / 2, h2 = spr.h / 2;
  for (let r = 0; r < spr.h; r++) {
    let c = 0;
    while (c < spr.w) {
      if (spr.bits[r] & (1 << c)) {
        let run = 1;
        while (c + run < spr.w && (spr.bits[r] & (1 << (c + run)))) run++;
        const d = depth * (0.85 + 0.3 * Math.abs(Math.sin((c + run / 2) * 2.1)));
        const g = new THREE.BoxGeometry(run * px, px, d);
        g.translate((c + run / 2 - w2) * px, (h2 - r - 0.5) * px, 0);
        geos.push(g);
        c += run;
      } else c++;
    }
  }
  const merged = BufferGeometryUtils.mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
}
function makeBioMat(opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: opts.color || 0x1a2230, metalness: 0.9, roughness: 0.36,
    emissive: 0x0e2a1a, emissiveIntensity: 0.6,
  });
  m.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `
      #include <emissivemap_fragment>
      {
        float fr = pow(max(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 1e-4), 2.6);
        totalEmissiveRadiance += mix(vec3(0.02, 0.55, 0.22), vec3(0.38, 0.10, 0.62), fr) * fr * 0.9;
      }`);
  };
  return m;
}
const MAT_CORE = new THREE.MeshBasicMaterial({ color: 0x5dffa6, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false });

function buildEnemies() {
  // --- drones (squid) : instanced body + instanced core ---
  const dgBase = extrudeSprite(SPR.squidA, 0.62, 0.85);
  const antL = new THREE.BoxGeometry(0.1, 0.85, 0.1); antL.translate(-0.95, 2.85, 0);
  const antR = new THREE.BoxGeometry(0.1, 0.85, 0.1); antR.translate(0.95, 2.85, 0);
  const sting = new THREE.ConeGeometry(0.16, 1.1, 5); sting.rotateX(Math.PI); sting.translate(0, -3.0, 0);
  const dg = BufferGeometryUtils.mergeGeometries([dgBase, antL, antR, sting], false);
  dg.computeBoundingSphere();
  ENEMIES.droneGeoRadius = dg.boundingSphere.radius;
  ENEMIES.droneBody = new THREE.InstancedMesh(dg, makeBioMat(), ENEMIES.DRONE_MAX);
  ENEMIES.droneCore = new THREE.InstancedMesh(new THREE.SphereGeometry(0.62, 10, 8), MAT_CORE.clone(), ENEMIES.DRONE_MAX);
  for (const im of [ENEMIES.droneBody, ENEMIES.droneCore]) {
    im.frustumCulled = false;
    sunlit(im);
    G.scene.add(im);
  }
  for (let i = 0; i < ENEMIES.DRONE_MAX; i++) {
    ENEMIES.droneSlots.push(null);
    _m1.compose(_v1.set(0, -99999, 0), _q1.identity(), _v2.set(0.001, 0.001, 0.001));
    ENEMIES.droneBody.setMatrixAt(i, _m1);
    ENEMIES.droneCore.setMatrixAt(i, _m1);
    ENEMIES.droneBody.setColorAt(i, _c1.setRGB(1, 1, 1));
  }
  ENEMIES.droneBody.instanceMatrix.needsUpdate = true;
  ENEMIES.droneCore.instanceMatrix.needsUpdate = true;

  // --- shared cruiser/boss geometry cache (materials stay per-spawn for hit-flash) ---
  ENEMIES.geo = {
    crab: extrudeSprite(SPR.crabA, 1.35, 2.0),
    oct: extrudeSprite(SPR.octA, 3.4, 5.5),
    coreS: new THREE.SphereGeometry(1.45, 14, 10),
    coreB: new THREE.SphereGeometry(4.4, 18, 14),
    ringS: new THREE.TorusGeometry(2.2, 0.16, 6, 24),
    tentS: new THREE.CylinderGeometry(0.12, 0.05, 4.2, 5),
    tentB: new THREE.CylinderGeometry(0.5, 0.14, 14, 6),
    shield: new THREE.SphereGeometry(9.5, 24, 12, -Math.PI / 2 - 0.95, 1.9, Math.PI * 0.22, Math.PI * 0.56),
    disc: new THREE.CircleGeometry(0.85, 12),
    crown: new THREE.TorusGeometry(15, 0.6, 8, 40),
    spike: new THREE.ConeGeometry(0.7, 4.5, 6),
    bossRing0: new THREE.TorusGeometry(26, 0.85, 8, 60, Math.PI * 2 - 1.35),
    bossRing1: new THREE.TorusGeometry(33, 0.85, 8, 60, Math.PI * 2 - 1.35),
    podBody: new THREE.BoxGeometry(1.5, 1.1, 2.0),
    podBarrel: new THREE.CylinderGeometry(0.16, 0.16, 2.8, 6),
    plate: new THREE.BoxGeometry(2.6, 0.45, 3.0),
    machine: new THREE.TorusGeometry(7, 0.55, 6, 24),
    mandible: new THREE.ConeGeometry(1.0, 4.6, 5),
  };
  // --- rifts pool ---
  for (let i = 0; i < 6; i++) {
    const grp = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0x7a3aff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    const swirl = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uT: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uT; varying vec2 vUv;
        void main(){
          vec2 cc = vUv * 2.0 - 1.0;
          float r = length(cc);
          if (r > 1.0) discard;
          float a = atan(cc.y, cc.x);
          float sw = sin(a * 5.0 - r * 16.0 + uT * 8.0) * 0.5 + 0.5;
          float body = smoothstep(1.0, 0.2, r) * sw;
          vec3 col = mix(vec3(0.15, 1.0, 0.45), vec3(0.55, 0.2, 1.0), r);
          gl_FragColor = vec4(col * body * 1.6, body * 0.85);
        }`,
    }));
    grp.add(ring); grp.add(swirl);
    grp.visible = false;
    G.scene.add(grp);
    ENEMIES.rifts.push({ grp, ring, swirl, t: 99, dur: 2.4, scale: 10 });
  }
}
function spawnRift(pos, scale, dur = 2.6) {
  let best = ENEMIES.rifts[0];
  for (const r of ENEMIES.rifts) if (r.t > best.t) best = r;
  best.t = 0; best.dur = dur; best.scale = scale;
  best.grp.position.copy(pos);
  best.grp.lookAt(0, 0, 0);
  best.grp.visible = true;
  AUD.osc && AUD.ok && AUD.osc('sawtooth', 60, AUD.ctx.currentTime, 1.2, 0.1, AUD.sfx, { f1: 220, lp: 900, a: 0.4, verb: 0.8 });
}

// --- cruiser (crab) — geometries shared via ENEMIES.geo, materials per-spawn ---
function makeCruiser() {
  const GC = ENEMIES.geo;
  const grp = new THREE.Group();
  const body = new THREE.Mesh(GC.crab, makeBioMat());
  grp.add(body);
  const core = new THREE.Mesh(GC.coreS, MAT_CORE.clone());
  core.position.z = 1.2;
  grp.add(core);
  // rotating side rings (animated part)
  const ringMat = makeBioMat({ color: 0x1a2030 });
  const rgL = new THREE.Mesh(GC.ringS, ringMat);
  rgL.position.set(-7.5, 0, 0);
  const rgR = new THREE.Mesh(GC.ringS, ringMat); rgR.position.x = 7.5;
  grp.add(rgL); grp.add(rgR);
  // tentacle antennae
  const tents = [];
  const tentMat = makeBioMat();
  for (let i = 0; i < 3; i++) {
    const t = new THREE.Mesh(GC.tentS, tentMat);
    t.position.set((i - 1) * 2.6, -5.6, 0);
    grp.add(t); tents.push(t);
  }
  // gun pods + armor plates
  const podMat = makeBioMat({ color: 0x161e2c });
  for (const sgn of [-1, 1]) {
    const pod = new THREE.Mesh(GC.podBody, podMat);
    pod.position.set(sgn * 5.0, -1.7, 0.6);
    grp.add(pod);
    const barrel = new THREE.Mesh(GC.podBarrel, podMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(sgn * 5.0, -1.7, 2.4);
    grp.add(barrel);
    const plate = new THREE.Mesh(GC.plate, podMat);
    plate.position.set(sgn * 2.3, 2.1, -0.2);
    plate.rotation.z = sgn * -0.18;
    grp.add(plate);
  }
  // rear engine glows
  for (const sgn of [-1, 1]) {
    const eng = new THREE.Mesh(GC.disc,
      new THREE.MeshBasicMaterial({ color: 0x46ff7a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    eng.position.set(sgn * 4.2, -1.2, -1.6);
    grp.add(eng);
  }
  // front shield arc
  const shield = new THREE.Mesh(GC.shield,
    new THREE.MeshBasicMaterial({ color: 0x35ffc8, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  shield.rotation.x = Math.PI / 2;
  shield.rotation.z = Math.PI;
  grp.add(shield);
  grp.traverse(o => sunlit(o));
  return { grp, core, rings: [rgL, rgR], tents, shield };
}
// --- harvester boss (octopus) ---
function makeBoss() {
  const GC = ENEMIES.geo;
  const grp = new THREE.Group();
  const body = new THREE.Mesh(GC.oct, makeBioMat());
  grp.add(body);
  const core = new THREE.Mesh(GC.coreB, MAT_CORE.clone());
  core.position.set(0, -2, 4.5);
  grp.add(core);
  const darkMat = makeBioMat({ color: 0x141a28 });
  const crown = new THREE.Mesh(GC.crown, darkMat);
  crown.rotation.x = Math.PI / 2;
  crown.position.y = 10;
  grp.add(crown);
  for (let i = 0; i < 8; i++) {
    const spike = new THREE.Mesh(GC.spike, darkMat);
    const a = i / 8 * TAU;
    spike.position.set(Math.cos(a) * 15, 11.5, Math.sin(a) * 15);
    grp.add(spike);
  }
  const rings = [];
  for (let i = 0; i < 2; i++) {
    const ring = new THREE.Mesh(
      i ? GC.bossRing1 : GC.bossRing0,
      new THREE.MeshBasicMaterial({ color: i ? 0x9a4aff : 0x3affa0, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    const holder = new THREE.Group();
    holder.add(ring);
    holder.rotation.x = i ? 0.5 : Math.PI / 2 - 0.2;
    grp.add(holder);
    rings.push({ holder, ring, r: 26 + i * 7, rot: 0, speed: i ? -0.55 : 0.4, gap: 1.35 });
  }
  // inner machinery ring + feeding mandibles around the core
  const machine = new THREE.Mesh(GC.machine, darkMat);
  machine.position.copy(core.position);
  grp.add(machine);
  const mandibles = [];
  for (let i = 0; i < 4; i++) {
    const md = new THREE.Mesh(GC.mandible, darkMat);
    const a = i / 4 * TAU + 0.4;
    md.position.set(core.position.x + Math.cos(a) * 5.6, core.position.y + Math.sin(a) * 5.6, core.position.z + 1.6);
    md.rotation.z = a + Math.PI;
    grp.add(md); mandibles.push({ m: md, a });
  }
  const tents = [];
  const tentMat = makeBioMat();
  for (let i = 0; i < 6; i++) {
    const t = new THREE.Mesh(GC.tentB, tentMat);
    t.position.set((i - 2.5) * 4.4, -16, 0);
    grp.add(t); tents.push(t);
  }
  grp.traverse(o => sunlit(o));
  return { grp, core, rings, tents, machine, mandibles };
}
// release a removed cruiser/boss: geometries are shared, materials are per-spawn
function freeEnemyObj(e) {
  if (!e.obj) return;
  const seen = new Set();
  e.obj.traverse(o => {
    if (o.material && !seen.has(o.material)) { seen.add(o.material); o.material.dispose(); }
  });
  G.scene.remove(e.obj);
  e.obj = null;
}

// ---- spawn / kill ----
function randomSpawnPos(out) {
  const u = rng() * 1.6 - 0.8, a = rng() * TAU, s = Math.sqrt(1 - u * u);
  out.set(s * Math.cos(a), u, s * Math.sin(a));
  // bias most spawns toward the player's side of the planet so the fight is findable
  if (S.mode === 'DEFENSE' && rng() < 0.75) {
    _v8.copy(G.shipRig.position).normalize();
    out.multiplyScalar(0.7).add(_v8).normalize();
  }
  out.multiplyScalar(CFG.spawnR);
  return out;
}
function pickEarthTarget(out) {
  if (rng() < 0.6) {
    const c = EARTH.cities[(rng() * EARTH.cities.length) | 0];
    EARTH.spin.updateWorldMatrix(true, false);
    out.copy(c.dir).transformDirection(EARTH.spin.matrixWorld).multiplyScalar(CFG.earthR);
  } else {
    const u = rng() * 1.7 - 0.85, a = rng() * TAU, s = Math.sqrt(1 - u * u);
    out.set(s * Math.cos(a), u, s * Math.sin(a)).multiplyScalar(CFG.earthR);
  }
  return out;
}
function spawnEnemy(kind, pos, hpMul = 1) {
  const e = {
    kind, alive: true, pos: pos.clone(), vel: new THREE.Vector3(),
    target: pickEarthTarget(new THREE.Vector3()),
    phase: rng() * TAU, f1: 1.3 + rng() * 1.4, f2: 0.7 + rng() * 1.1,
    perp1: new THREE.Vector3(), perp2: new THREE.Vector3(),
    state: 'inbound', t: 0, evadeT: 0, flashT: 0, fireT: 2 + rng() * 3,
    slot: -1, obj: null, parts: null, burnAcc: 0,
  };
  _v1.copy(e.target).sub(e.pos).normalize();
  e.perp1.crossVectors(_v1, _v2.set(0, 1, 0)).normalize();
  if (e.perp1.lengthSq() < 0.01) e.perp1.set(1, 0, 0);
  e.perp2.crossVectors(_v1, e.perp1).normalize();
  e.vel.copy(_v1).multiplyScalar(kind === 'drone' ? 19 : kind === 'cruiser' ? 8 : 5);
  if (kind === 'drone') {
    e.hp = 1; e.radius = 2.6; e.score = 50; e.dmg = 2; e.dimRad = 0.06; e.speed = 19;
    let slot = -1;
    for (let i = 0; i < ENEMIES.DRONE_MAX; i++) if (!ENEMIES.droneSlots[i]) { slot = i; break; }
    if (slot < 0) return null;
    e.slot = slot;
    ENEMIES.droneSlots[slot] = e;
  } else if (kind === 'cruiser') {
    e.hp = Math.round(8 * hpMul); e.radius = 9; e.score = 200; e.dmg = 6; e.dimRad = 0.09; e.speed = 8;
    e.parts = makeCruiser();
    e.obj = e.parts.grp;
    G.scene.add(e.obj);
  } else {
    e.hp = Math.round(60 * hpMul); e.radius = 24; e.score = 1000; e.dmg = 25; e.dimRad = 0.16; e.speed = 5;
    e.parts = makeBoss();
    e.obj = e.parts.grp;
    G.scene.add(e.obj);
    AUD.bossLayer = true;
  }
  e.maxHp = e.hp;
  ENEMIES.list.push(e);
  return e;
}
function killEnemy(e, byPlayer) {
  if (!e.alive) return;
  e.alive = false;
  if (e.kind === 'drone') {
    ENEMIES.droneSlots[e.slot] = null;
    _m1.compose(_v1.set(0, -99999, 0), _q1.identity(), _v2.set(0.001, 0.001, 0.001));
    ENEMIES.droneBody.setMatrixAt(e.slot, _m1);
    ENEMIES.droneCore.setMatrixAt(e.slot, _m1);
    ENEMIES.droneDirty = true;
  } else if (e.obj) {
    freeEnemyObj(e);
    if (e.kind === 'boss') AUD.bossLayer = false;
  }
  if (byPlayer) {
    const size = e.kind === 'drone' ? 1 : e.kind === 'cruiser' ? 2.6 : 6;
    fxExplode(e.pos, size, { spark: 0x7aff9a, ring: 0x6affc0, light: 0x66ff9a });
    fxHitstop(e.kind === 'drone' ? 0.05 : 0.08);
    addScore(e.score);
    S.kills++;
    bumpCombo();
  }
}

// ---- per-frame AI ----
const _ep = new THREE.Vector3(), _ed = new THREE.Vector3();
function updateEnemies(dt) {
  for (const r of ENEMIES.rifts) {
    if (r.t > r.dur) { r.grp.visible = false; continue; }
    r.t += dt;
    const k = r.t / r.dur;
    const s = r.scale * (k < 0.25 ? easeOut(k / 0.25) : k > 0.8 ? 1 - (k - 0.8) / 0.2 : 1);
    r.grp.scale.setScalar(Math.max(0.001, s));
    r.ring.rotation.z += dt * 2.2;
    r.swirl.material.uniforms.uT.value = r.t;
  }
  let anyDrone = false;
  G.shipRig.getWorldPosition(_v7);
  for (let li = ENEMIES.list.length - 1; li >= 0; li--) {
    const e = ENEMIES.list[li];
    if (!e.alive) { ENEMIES.list.splice(li, 1); continue; }
    e.t += dt;
    const r = e.pos.length();
    if (e.state === 'inbound') {
      _ed.copy(e.target).sub(e.pos).normalize();
      const wAmp = e.kind === 'drone' ? (r > 700 ? 0.55 : 0.55 * clamp((r - 645) / 60, 0, 1)) : 0.12;
      _ed.addScaledVector(e.perp1, Math.sin(e.t * e.f1 + e.phase) * wAmp);
      _ed.addScaledVector(e.perp2, Math.cos(e.t * e.f2 + e.phase) * wAmp * 0.7);
      if (e.evadeT > 0) {
        e.evadeT -= dt;
        _ed.addScaledVector(e.perp1, Math.sin(e.phase * 9.0) > 0 ? 1.6 : -1.6);
      }
      _ed.normalize();
      let spd = e.speed;
      if (e.kind === 'drone' && r < 720) spd = lerp(e.speed, 42, clamp((720 - r) / 90, 0, 1)); // kamikaze dive
      e.vel.lerp(_v1.copy(_ed).multiplyScalar(spd), 1 - Math.pow(0.0015, dt * (e.kind === 'drone' ? 1.6 : 0.8)));
      e.pos.addScaledVector(e.vel, dt);
      // engine glow trail — makes enemies readable against space
      e.trailT = (e.trailT || 0) - dt;
      if (e.trailT <= 0) {
        e.trailT = e.kind === 'drone' ? 0.13 : 0.09;
        fxSparks(e.pos, 1, e.kind === 'boss' ? 0xb066ff : 0x37ff8e, 1.6,
          e.kind === 'drone' ? 4.5 : e.kind === 'cruiser' ? 7 : 12, 0.5);
      }
      if (r < CFG.atmoEntry) {
        e.state = 'entry';
        e.vel.copy(e.pos).normalize().multiplyScalar(-36);
      }
      // cruiser fires on the player
      if (e.kind === 'cruiser') {
        e.fireT -= dt;
        const dp = _v2.copy(_v7).sub(e.pos);
        const dist = dp.length();
        if (e.fireT <= 0 && dist < 460) {
          e.fireT = 3.4 + rng() * 2.0;
          const tt = dist / 190;
          _v3.copy(G.flightVel || _v4.set(0, 0, 0));
          _v2.copy(_v7).addScaledVector(_v3, tt * 0.8).sub(e.pos).normalize();
          _v2.x += (rng() - 0.5) * 0.03; _v2.y += (rng() - 0.5) * 0.03;
          _ep.copy(e.pos).addScaledVector(_v2, e.radius + 2);
          fxTracer(_ep, _v2, 190, 7, 0.5, 0x4aff66, 2, 8, 3.4);
          AUD.plasma();
        }
      }
      // boss spawns drones
      if (e.kind === 'boss') {
        e.fireT -= dt;
        if (e.fireT <= 0) {
          e.fireT = 9;
          let free = 0;
          for (let i = 0; i < ENEMIES.DRONE_MAX; i++) if (!ENEMIES.droneSlots[i]) free++;
          if (free > 6 && countAlive('drone') < 26) {
            for (let k = 0; k < 2; k++) {
              _v1.copy(e.pos).addScaledVector(e.perp1, (k ? 1 : -1) * 30);
              spawnRift(_v1, 9, 2.0);
              spawnEnemy('drone', _v1);
            }
          }
        }
      }
    } else { // entry burn
      e.pos.addScaledVector(e.vel, dt);
      e.burnAcc += dt;
      if (e.burnAcc > 0.05) {
        e.burnAcc = 0;
        fxSparks(e.pos, 2, 0xff7a30, 6, 4 + (e.kind !== 'drone' ? 4 : 0), 0.5);
        _v1.copy(e.pos).normalize();
        fxTracer(_v2.copy(e.pos).addScaledVector(_v1, 3), _v1.negate(), 30, 9, 0.7, 0xff8540, 3, 0, 0.3);
      }
      if (e.pos.length() < CFG.impactR) {
        enemyLanded(e);
        continue;
      }
    }
    // visuals
    e.flashT = Math.max(0, e.flashT - dt);
    if (e.kind === 'drone') {
      anyDrone = true;
      _q1.setFromUnitVectors(_zAxis, _v1.copy(e.vel).normalize());
      _q2.setFromAxisAngle(_zAxis, Math.sin(e.t * 3 + e.phase) * 0.4);
      _q1.multiply(_q2);
      const wob = 1 + Math.sin(e.t * 5 + e.phase) * 0.06;
      _m1.compose(e.pos, _q1, _v2.set(wob, wob, wob));
      ENEMIES.droneBody.setMatrixAt(e.slot, _m1);
      const cs = 1.15 + Math.sin(e.t * 7 + e.phase) * 0.35 + e.flashT * 2;
      _m1.compose(e.pos, _q1, _v2.set(cs, cs, cs));
      ENEMIES.droneCore.setMatrixAt(e.slot, _m1);
      if (e.flashT > 0) ENEMIES.droneBody.setColorAt(e.slot, _c1.setRGB(8, 8, 8));
      else ENEMIES.droneBody.setColorAt(e.slot, _c1.setRGB(1, 1, 1));
      ENEMIES.droneBody.instanceColor.needsUpdate = true;
    } else if (e.obj) {
      e.obj.position.copy(e.pos);
      if (e.kind === 'cruiser') {
        const dp = _v2.copy(_v7).sub(e.pos);
        if (dp.length() < 460 && e.state === 'inbound') _v3.copy(e.pos).add(dp);
        else _v3.copy(e.target);
        e.obj.lookAt(_v3);
        e.fwd = e.fwd || new THREE.Vector3();
        e.obj.getWorldDirection(e.fwd);
        e.parts.rings[0].rotation.x += dt * 2.4;
        e.parts.rings[1].rotation.x -= dt * 2.4;
        e.parts.tents.forEach((t, i) => { t.rotation.z = Math.sin(e.t * 2.2 + i * 1.7) * 0.35; });
        e.parts.core.scale.setScalar(1 + Math.sin(e.t * 6) * 0.18 + e.flashT * 1.5);
        e.parts.shield.material.opacity = 0.10 + Math.sin(e.t * 3.3) * 0.04 + (e.shieldFlash || 0);
        e.shieldFlash = Math.max(0, (e.shieldFlash || 0) - dt * 1.4);
      } else {
        e.obj.lookAt(0, 0, 0);
        for (const rg of e.parts.rings) {
          rg.rot += rg.speed * dt;
          rg.holder.rotation.y = rg.rot;
        }
        e.parts.tents.forEach((t, i) => {
          t.rotation.x = Math.sin(e.t * 1.6 + i * 1.1) * 0.4;
          t.rotation.z = Math.cos(e.t * 1.3 + i * 0.9) * 0.3;
        });
        const pulse = 1 + Math.sin(e.t * 4) * 0.22 + e.flashT * 1.2;
        e.parts.core.scale.setScalar(pulse);
        if (e.parts.machine) e.parts.machine.rotation.z += dt * 1.3;
        if (e.parts.mandibles) for (const md of e.parts.mandibles) {
          const open = 0.35 + Math.sin(e.t * 2.1 + md.a) * 0.3;
          md.m.position.x = e.parts.core.position.x + Math.cos(md.a) * (5.6 + open * 2.2);
          md.m.position.y = e.parts.core.position.y + Math.sin(md.a) * (5.6 + open * 2.2);
        }
      }
      // hit flash on standard materials
      if (e.flashT > 0 && !e._flashOn) {
        e._flashOn = true;
        e.obj.traverse(o => { if (o.material && o.material.emissive) { o.material._ei = o.material.emissiveIntensity; o.material.emissive.setHex(0xffffff); o.material.emissiveIntensity = 2.2; } });
      } else if (e.flashT <= 0 && e._flashOn) {
        e._flashOn = false;
        e.obj.traverse(o => { if (o.material && o.material.emissive) { o.material.emissive.setHex(0x0a2014); o.material.emissiveIntensity = o.material._ei || 0.25; } });
      }
    }
  }
  if (anyDrone || ENEMIES.droneDirty) {
    ENEMIES.droneDirty = false;
    ENEMIES.droneBody.instanceMatrix.needsUpdate = true;
    ENEMIES.droneCore.instanceMatrix.needsUpdate = true;
  }
}
function countAlive(kind) {
  let n = 0;
  for (const e of ENEMIES.list) if (e.alive && (!kind || e.kind === kind)) n++;
  return n;
}
function enemyLanded(e) {
  e.alive = false;
  if (e.kind === 'drone') {
    ENEMIES.droneSlots[e.slot] = null;
    _m1.compose(_v1.set(0, -99999, 0), _q1.identity(), _v2.set(0.001, 0.001, 0.001));
    ENEMIES.droneBody.setMatrixAt(e.slot, _m1);
    ENEMIES.droneCore.setMatrixAt(e.slot, _m1);
    ENEMIES.droneDirty = true;
  } else if (e.obj) {
    freeEnemyObj(e);
    if (e.kind === 'boss') AUD.bossLayer = false;
  }
  _v1.copy(e.pos).normalize();
  _v2.copy(_v1).multiplyScalar(CFG.impactR - 1);
  fxFlash(_v2, e.kind === 'boss' ? 90 : 34, 0xffd0a0);
  fxRing(_v2, _v1, e.kind === 'boss' ? 70 : 26, 0xff8540, 1.6);
  fxSmoke(_v2, 10, 0x553a28, 8, e.kind === 'boss' ? 60 : 26, 3.2);
  fxLight(_v2, 0xff9550, 4200, 260, 0.5);
  earthAddImpact(_v2, e.dimRad);
  damageIntegrity(e.dmg);
  AUD.bigImpact();
  if (e.kind === 'boss') AUD.alarm();
}
// ============================================================================
// FLIGHT + COMBAT
// ============================================================================
const FLIGHT = {
  aimX: 0, aimY: 0, throttle: 0.45, speed: 0, boost: false,
  fireT: 0, barrelIdx: 0,
  lockTarget: null, lockP: 0, lockToneT: 0, missileCD: 0,
  camT: 0, // 0 = cockpit, 1 = chase
  missiles: [],
};
G.flightVel = new THREE.Vector3();
const EXT = { group: null, trails: [], glowL: null, glowR: null };

class TrailRibbon {
  constructor(n, width, hex) {
    this.n = n; this.width = width;
    this.pts = [];
    for (let i = 0; i < n; i++) this.pts.push(new THREE.Vector3(0, -99999, 0));
    this.pos = new Float32Array(n * 2 * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    const alpha = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { alpha[i * 2] = alpha[i * 2 + 1] = 1 - i / (n - 1); }
    this.geo.setAttribute('aA', new THREE.BufferAttribute(alpha, 1));
    this.mesh = new THREE.Mesh(this.geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uCol: { value: new THREE.Color(hex) }, uOn: { value: 0 } },
      vertexShader: `attribute float aA; varying float vA;
        void main(){ vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 uCol; uniform float uOn; varying float vA;
        void main(){ gl_FragColor = vec4(uCol * 1.6, vA * 0.5 * uOn); }`,
    }));
    this.mesh.frustumCulled = false;
    G.scene.add(this.mesh);
    this.accum = 0;
  }
  update(head, camPos, dt, on) {
    this.mesh.material.uniforms.uOn.value = on ? 1 : 0;
    if (!on) return;
    this.accum += dt;
    if (this.accum > 0.025) {
      this.accum = 0;
      for (let i = this.n - 1; i > 0; i--) this.pts[i].copy(this.pts[i - 1]);
      this.pts[0].copy(head);
    }
    for (let i = 0; i < this.n; i++) {
      const p = this.pts[i];
      _v1.subVectors(camPos, p).normalize();
      const nxt = this.pts[Math.min(i + 1, this.n - 1)];
      _v2.subVectors(nxt, p).normalize();
      _v3.crossVectors(_v1, _v2).normalize().multiplyScalar(this.width * (1 - i / this.n * 0.6));
      this.pos[i * 6] = p.x + _v3.x; this.pos[i * 6 + 1] = p.y + _v3.y; this.pos[i * 6 + 2] = p.z + _v3.z;
      this.pos[i * 6 + 3] = p.x - _v3.x; this.pos[i * 6 + 4] = p.y - _v3.y; this.pos[i * 6 + 5] = p.z - _v3.z;
    }
    this.geo.attributes.position.needsUpdate = true;
  }
}

function buildExterior() {
  const grp = new THREE.Group();
  // panel-line hull texture
  const [hc2, hx2] = makeCanvas(512, 512);
  hx2.fillStyle = '#414c5b'; hx2.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) { const v = 58 + rng() * 22;
    hx2.fillStyle = `rgba(${v},${v + 6},${v + 13},0.55)`; hx2.fillRect(rng() * 512, rng() * 512, 2, 2); }
  hx2.strokeStyle = 'rgba(12,16,22,0.85)'; hx2.lineWidth = 2;
  let hy = 0;
  while (hy < 512) { const hh = 36 + rng() * 64;
    hx2.beginPath(); hx2.moveTo(0, hy); hx2.lineTo(512, hy); hx2.stroke();
    let hxp = (rng() * 60) | 0;
    while (hxp < 512) { const hw = 50 + rng() * 110;
      hx2.beginPath(); hx2.moveTo(hxp, hy); hx2.lineTo(hxp, Math.min(512, hy + hh)); hx2.stroke();
      if (rng() < 0.18) { hx2.fillStyle = 'rgba(255,170,60,0.5)'; hx2.fillRect(hxp + 4, hy + 4, 12, 5); }
      if (rng() < 0.12) { hx2.fillStyle = 'rgba(20,26,34,0.7)'; hx2.fillRect(hxp + 3, hy + 3, hw * 0.5, hh * 0.4); }
      hxp += hw; }
    hy += hh; }
  hx2.font = '700 26px ui-monospace, monospace';
  hx2.fillStyle = 'rgba(220,235,255,0.8)';
  hx2.fillText('ORION-IX', 36, 268);
  hx2.fillStyle = 'rgba(255,80,60,0.75)'; hx2.fillRect(20, 276, 130, 4);
  const hullTex = canvasTex(hc2, true);
  hullTex.wrapT = THREE.RepeatWrapping;
  const hull = new THREE.MeshStandardMaterial({ map: hullTex, roughness: 0.5, metalness: 0.78, emissive: 0x121a26, emissiveIntensity: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c2228, roughness: 0.5, metalness: 0.7, emissive: 0x0c1118, emissiveIntensity: 0.6 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x2f9fe8, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });
  // fuselage — lathed profile, nose → cockpit hump → tail taper
  const prof = [
    [0.06, -8.8], [0.52, -7.8], [1.0, -6.4], [1.5, -4.4], [1.9, -2.2],
    [2.12, 0.2], [2.05, 2.6], [1.78, 4.5], [1.32, 6.2], [0.95, 7.1], [0.55, 7.45], [0.06, 7.6],
  ].map(p => new THREE.Vector2(p[0], p[1]));
  const fus = new THREE.Mesh(new THREE.LatheGeometry(prof, 22), hull);
  fus.rotation.x = Math.PI / 2;            // lathe axis → Z, nose at -Z
  fus.scale.y = 0.86;                       // slightly flattened belly/back
  grp.add(fus);
  // dorsal cockpit canopy
  const can = new THREE.Mesh(new THREE.SphereGeometry(1.5, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0x0d2030, roughness: 0.08, metalness: 0.9, emissive: 0x06283a, emissiveIntensity: 0.8 }));
  can.scale.set(0.95, 0.66, 2.0); can.position.set(0, 1.45, -3.5);
  grp.add(can);
  // swept delta wings with nav lights
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, -1.3);
  wingShape.lineTo(5.0, 0.7); wingShape.lineTo(5.85, 1.55); wingShape.lineTo(6.0, 2.1);
  wingShape.lineTo(2.4, 1.35); wingShape.lineTo(0, 1.8);
  wingShape.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.06, bevelSegments: 1 });
  wingGeo.rotateX(Math.PI / 2);
  for (const sgn of [-1, 1]) {
    const wg = sgn > 0 ? wingGeo : wingGeo.clone().scale(-1, 1, 1);
    if (sgn < 0) wg.computeVertexNormals();
    const wing = new THREE.Mesh(wg, hull);
    wing.material.side = THREE.DoubleSide;
    wing.position.set(sgn * 1.6, -0.35, 1.2);
    wing.rotation.z = sgn * -0.07;
    grp.add(wing);
    const navLight = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.MeshBasicMaterial({ color: sgn < 0 ? 0xff3522 : 0x2aff55 }));
    navLight.position.set(sgn * 7.45, -0.35, 3.25);
    grp.add(navLight);
    // engine nacelles: body + intake ring + nozzle + glow
    const nacProf = [[0.5, -1.8], [0.85, -1.1], [1.0, 0.0], [0.92, 1.1], [0.7, 1.9], [0.5, 2.1]]
      .map(p => new THREE.Vector2(p[0], p[1]));
    const nac = new THREE.Mesh(new THREE.LatheGeometry(nacProf, 14), dark);
    nac.rotation.x = Math.PI / 2;
    nac.position.set(sgn * 2.55, -0.3, 5.6);
    grp.add(nac);
    const intake = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.1, 8, 18), hull);
    intake.position.set(sgn * 2.55, -0.3, 3.78);
    grp.add(intake);
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.3, 2.4), hull);
    pylon.position.set(sgn * 1.7, -0.25, 5.2);
    grp.add(pylon);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), glow);
    disc.position.set(sgn * 2.55, -0.3, 7.78);
    grp.add(disc);
    if (sgn < 0) EXT.glowL = disc; else EXT.glowR = disc;
    // ventral fin
    const vfin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 1.8), dark);
    vfin.position.set(sgn * 1.05, -1.45, 5.4);
    vfin.rotation.z = sgn * 0.5;
    grp.add(vfin);
  }
  // spine fin
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0); finShape.lineTo(2.6, 0.6); finShape.lineTo(3.1, 2.4); finShape.lineTo(2.0, 0.1);
  finShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.12, bevelEnabled: false });
  finGeo.rotateY(Math.PI / 2);
  const fin = new THREE.Mesh(finGeo, hull);
  fin.material.side = THREE.DoubleSide;
  fin.position.set(0.06, 1.45, 3.6);
  grp.add(fin);
  // blinking anti-collision beacon on the fin
  EXT.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.10, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
  EXT.beacon.position.set(0.12, 3.75, 5.45);
  grp.add(EXT.beacon);
  // wing leading-edge accent strips
  for (const sgn of [-1, 1]) {
    const ledge = new THREE.Mesh(new THREE.BoxGeometry(5.3, 0.08, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x8aa6c0, roughness: 0.3, metalness: 0.9 }));
    ledge.position.set(sgn * 4.1, -0.32, 0.55);
    ledge.rotation.y = sgn * -0.38;
    grp.add(ledge);
  }
  // antenna + RCS blocks + belly greebles
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.5, 6), dark);
  ant.position.set(0.4, 1.7, -1.0);
  grp.add(ant);
  for (const [gx4, gy4, gz4] of [[0.8, 1.45, -5.6], [-0.8, 1.45, -5.6], [0.8, -1.5, -5.0], [-0.8, -1.5, -5.0]]) {
    const rcs = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.5), dark);
    rcs.position.set(gx4, gy4 * 0.8, gz4);
    grp.add(rcs);
  }
  for (let i = 0; i < 6; i++) {
    const gb = new THREE.Mesh(new THREE.BoxGeometry(0.4 + rng() * 0.7, 0.16 + rng() * 0.2, 0.5 + rng() * 0.9), dark);
    gb.position.set((rng() - 0.5) * 2.4, -1.55 - rng() * 0.25, -2.5 + rng() * 6);
    grp.add(gb);
  }
  grp.traverse(o => sunlit(o));
  grp.scale.setScalar(1.15);
  grp.visible = false;
  G.bank.add(grp);
  EXT.group = grp;
  EXT.trails.push(new TrailRibbon(22, 0.55, 0x55c8ff));
  EXT.trails.push(new TrailRibbon(22, 0.55, 0x55c8ff));
}

// ---------------- flight ----------------
const _fwd = new THREE.Vector3();
function updateFlight(dt, rdt) {
  if (S.paused) return;
  // virtual-cursor steering: the offset PERSISTS until the player moves the
  // mouse back — the ship keeps turning toward where you point.
  FLIGHT.aimX = clamp(FLIGHT.aimX + IN.mdx * 0.0023, -1, 1);
  FLIGHT.aimY = clamp(FLIGHT.aimY + IN.mdy * 0.0023, -1, 1);
  if (IN.pressed['KeyC']) { FLIGHT.aimX = 0; FLIGHT.aimY = 0; }   // recenter
  const dead = v => Math.abs(v) < 0.035 ? 0 : v * Math.abs(v) * 0.4 + v * 0.6; // soft response curve
  FLIGHT.rx = lerp(FLIGHT.rx || 0, dead(FLIGHT.aimX), Math.min(1, dt * 9));
  FLIGHT.ry = lerp(FLIGHT.ry || 0, dead(FLIGHT.aimY), Math.min(1, dt * 9));
  G.shipRig.rotateY(-FLIGHT.rx * 2.1 * dt);
  G.shipRig.rotateX(-FLIGHT.ry * 1.55 * dt);
  // cosmetic bank into turns
  const targetRoll = FLIGHT.rx * -0.85;
  G.bank.rotation.z += (targetRoll - G.bank.rotation.z) * Math.min(1, dt * 5);
  // aim cursor dot follows the virtual cursor (write only when it moved)
  if ((S.frame & 1) === 0) {
    const adx = (FLIGHT.aimX * window.innerWidth * 0.20).toFixed(1);
    const ady = (FLIGHT.aimY * window.innerHeight * 0.20).toFixed(1);
    if (adx !== FLIGHT._adx || ady !== FLIGHT._ady) {
      FLIGHT._adx = adx; FLIGHT._ady = ady;
      $('aimdot').style.transform = `translate(${adx}px,${ady}px)`;
    }
  }
  // throttle / boost
  if (IN.keys['KeyW']) FLIGHT.throttle = clamp(FLIGHT.throttle + dt * 0.5, 0.1, 1);
  if (IN.keys['KeyS']) FLIGHT.throttle = clamp(FLIGHT.throttle - dt * 0.6, 0.1, 1);
  FLIGHT.boost = !!IN.keys['ShiftLeft'] || !!IN.keys['ShiftRight'];
  const targetSpeed = FLIGHT.boost ? 150 : 16 + FLIGHT.throttle * 58;
  FLIGHT.speed = lerp(FLIGHT.speed, targetSpeed, Math.min(1, dt * 2.2));
  _fwd.set(0, 0, -1).applyQuaternion(G.shipRig.quaternion);
  if (!S.freezeFlight) G.shipRig.position.addScaledVector(_fwd, FLIGHT.speed * dt);
  G.flightVel.copy(_fwd).multiplyScalar(FLIGHT.speed);
  AUD.setEngine(FLIGHT.throttle, FLIGHT.boost);
  // FOV kick
  const wantFov = (FLIGHT.camT > 0.5 ? 62 : 68) + (FLIGHT.boost ? 8 : 0) + FLIGHT.speed * 0.02;
  G.camera.fov = lerp(G.camera.fov, wantFov, Math.min(1, dt * 4));
  G.camera.updateProjectionMatrix();
  // speed lines
  const slOn = FLIGHT.boost;
  FX.speedLines.material.opacity = lerp(FX.speedLines.material.opacity, slOn ? 0.5 : 0, Math.min(1, dt * 6));
  if (FX.speedLines.material.opacity > 0.02) {
    for (let i = 0; i < 64; i++) {
      FX.slPos[i * 6 + 2] += FLIGHT.speed * dt * 1.5;
      FX.slPos[i * 6 + 5] = FX.slPos[i * 6 + 2] - (1.2 + FLIGHT.speed * 0.012);
      if (FX.slPos[i * 6 + 2] > -2) resetSpeedLine(i, false);
    }
    FX.speedLines.geometry.attributes.position.needsUpdate = true;
  }
  // soft boundary
  const r = G.shipRig.position.length();
  if (r > 1060) {
    hudWarn('RETURN TO COMBAT ZONE');
    steerAssist(dt, -1);
    if (r > CFG.hardMax) G.shipRig.position.setLength(CFG.hardMax);
  } else if (r < 685) {
    hudWarn('ATMOSPHERE — PULL UP');
    steerAssist(dt, 1);
    if (r < CFG.hardMin) {
      G.shipRig.position.setLength(CFG.hardMin);
      damagePlayer(6 * dt + 2 * dt);
    }
  } else hudWarn(null);
  // camera view toggle
  if (IN.pressed['KeyV']) {
    S.thirdPerson = !S.thirdPerson;
    AUD.uiBlip(S.thirdPerson ? 980 : 760);
  }
  FLIGHT.camT = lerp(FLIGHT.camT, S.thirdPerson ? 1 : 0, Math.min(1, rdt * 5));
  const ct = smooth(clamp(FLIGHT.camT, 0, 1));
  ROOM.group.visible = ct < 0.55;
  EXT.group.visible = ct > 0.25;
  _v1.copy(ROOM.seatHead);
  _v2.set(0, 6.2, 20);
  G.camera.position.lerpVectors(_v1, _v2, ct);
  _q1.setFromEuler(_eul.set(-0.02 - ct * 0.12, 0, 0));
  G.camera.quaternion.copy(_q1);
  // engine glow + beacon + trails
  const glowS = 0.6 + FLIGHT.throttle * 0.6 + (FLIGHT.boost ? 0.8 : 0);
  if (EXT.glowL) { EXT.glowL.scale.setScalar(glowS); EXT.glowR.scale.setScalar(glowS); }
  if (EXT.beacon) EXT.beacon.visible = Math.sin(S.now * 6.5) > 0.2;
  if (ct > 0.25) {
    G.camera.getWorldPosition(_v5);
    for (let i = 0; i < 2; i++) {
      _v3.set(i ? 2.55 : -2.55, -0.3, 8.1).applyMatrix4(EXT.group.matrixWorld);
      EXT.trails[i].update(_v3, _v5, rdt, true);
    }
  } else { EXT.trails[0].update(_v1, _v1, rdt, false); EXT.trails[1].update(_v1, _v1, rdt, false); }
  // weapons
  updateWeapons(dt);
  // tactical overlay toggle
  if (IN.pressed['Tab']) setOverlay(!S.overlayOn);
}
function steerAssist(dt, sign) {
  // gently rotate ship toward (sign=1: away from earth) / (sign=-1: toward earth)
  _v1.copy(G.shipRig.position).normalize().multiplyScalar(sign);
  _fwd.set(0, 0, -1).applyQuaternion(G.shipRig.quaternion);
  _v2.copy(_fwd).lerp(_v1, dt * 0.9).normalize();
  _q1.setFromUnitVectors(_fwd, _v2);
  G.shipRig.quaternion.premultiply(_q1);
}

// ---------------- weapons ----------------
function updateWeapons(dt) {
  FLIGHT.fireT -= dt;
  FLIGHT.missileCD -= dt;
  S.missileRegen -= dt;
  if (S.missileRegen <= 0 && S.missiles < S.missileCap) { S.missiles++; S.missileRegen = 6; }
  // lasers
  if ((IN.lmb || IN.keys['Space']) && FLIGHT.fireT <= 0 && !S.paused) {
    FLIGHT.fireT = 0.125 / S.upg.fireMul;
    const nb = S.upg.barrels;
    FLIGHT.barrelIdx = (FLIGHT.barrelIdx + 1) % nb;
    const off = nb === 3 ? [-1.25, 1.25, 0][FLIGHT.barrelIdx] : (FLIGHT.barrelIdx ? 1.25 : -1.25);
    G.bank.updateMatrixWorld();
    _v1.set(off, -0.6, -3.0).applyMatrix4(G.bank.matrixWorld);
    // converge toward a point 320 ahead of the nose
    G.shipRig.getWorldPosition(_v3);
    _v2.copy(_v3).addScaledVector(_fwd, 320).sub(_v1).normalize();
    // soft aim assist: bend the shot toward the closest enemy near the firing line
    let assistE = null, assistA = 0.10;
    for (const ae of ENEMIES.list) {
      if (!ae.alive) continue;
      _v4.copy(ae.pos).sub(_v1);
      const ad = _v4.length();
      if (ad < 35 || ad > 750) continue;
      _v4.multiplyScalar(1 / ad);
      const ang = Math.acos(clamp(_v4.dot(_v2), -1, 1));
      const aw = ang / (ae.kind === 'drone' ? 1 : 1.8);
      if (aw < assistA) { assistA = aw; assistE = ae; _v5.copy(_v4); }
    }
    if (assistE) _v2.lerp(_v5, 0.7).normalize();
    fxTracer(_v1, _v2, 880, 8.5, 0.30, 0x7ae8ff, 1, 1, 0.85);
    fxMuzzle(_v1, 0x8fe0ff);
    AUD.laser();
    S.shots++;
  }
  // missile lock
  const lb = $('lockbox');
  if (IN.rmb && !S.paused) {
    const cand = pickLockTarget();
    if (cand !== FLIGHT.lockTarget) { FLIGHT.lockTarget = cand; FLIGHT.lockP = 0; }
    if (cand) {
      FLIGHT.lockP = Math.min(1, FLIGHT.lockP + dt / 0.95);
      FLIGHT.lockToneT -= dt;
      if (FLIGHT.lockToneT <= 0) {
        FLIGHT.lockToneT = lerp(0.24, 0.07, FLIGHT.lockP);
        if (FLIGHT.lockP >= 1 && !FLIGHT.lockDone) { FLIGHT.lockDone = true; AUD.lockOn(); }
        else if (FLIGHT.lockP < 1) AUD.lockTick(FLIGHT.lockP);
      }
      if (worldToScreen(cand.pos, _flarePos)) {
        const sz = lerp(170, 48, smooth(FLIGHT.lockP));
        lb.style.opacity = '1';
        lb.style.width = lb.style.height = sz.toFixed(0) + 'px';
        lb.style.transform = `translate(${_flarePos.x.toFixed(1)}px,${_flarePos.y.toFixed(1)}px) translate(-50%,-50%)`;
        lb.classList.toggle('locked', FLIGHT.lockP >= 1);
      } else lb.style.opacity = '0';
    } else { lb.style.opacity = '0'; FLIGHT.lockP = 0; }
  } else {
    if (IN.rmbReleased) {
      if (FLIGHT.lockTarget && FLIGHT.lockP >= 1 && S.missiles > 0 && FLIGHT.missileCD <= 0) {
        fireMissile(FLIGHT.lockTarget);
      }
      FLIGHT.lockTarget = null; FLIGHT.lockP = 0; FLIGHT.lockDone = false;
      lb.style.opacity = '0';
    }
    if (!IN.rmb) lb.style.opacity = FLIGHT.lockTarget ? lb.style.opacity : '0';
  }
  // missiles
  for (let i = FLIGHT.missiles.length - 1; i >= 0; i--) {
    const m = FLIGHT.missiles[i];
    m.t += dt;
    const tgt = m.target && m.target.alive ? m.target : null;
    if (tgt) {
      _v1.copy(tgt.pos).sub(m.pos);
      const dist = _v1.length();
      _v1.normalize();
      m.vel.lerp(_v2.copy(_v1).multiplyScalar(lerp(230, 330, Math.min(1, m.t))), Math.min(1, dt * 3.2));
      if (dist < tgt.radius + 5) {
        missileBoom(m, tgt);
        FLIGHT.missiles.splice(i, 1);
        continue;
      }
    }
    m.pos.addScaledVector(m.vel, dt);
    m.smokeT -= dt;
    if (m.smokeT <= 0) { m.smokeT = 0.03; fxSmoke(m.pos, 1, 0x9aa3ad, 1.5, 7, 1.6); fxSparks(m.pos, 1, 0xffc080, 1, 3, 0.12); }
    if (m.t > 7) { missileBoom(m, null); FLIGHT.missiles.splice(i, 1); }
  }
}
function pickLockTarget() {
  G.camera.getWorldDirection(_v1);
  G.camera.getWorldPosition(_v2);
  let best = null, bestA = 0.52;
  for (const e of ENEMIES.list) {
    if (!e.alive) continue;
    _v3.copy(e.pos).sub(_v2);
    const d = _v3.length();
    if (d > 1000) continue;
    _v3.normalize();
    const a = Math.acos(clamp(_v3.dot(_v1), -1, 1));
    const aw = a * (e.kind === 'boss' ? 0.55 : 1);
    if (aw < bestA) { bestA = aw; best = e; }
  }
  return best;
}
function fireMissile(target) {
  S.missiles--;
  FLIGHT.missileCD = 3;
  G.bank.updateMatrixWorld();
  _v1.set(0, -1.2, -2.5).applyMatrix4(G.bank.matrixWorld);
  const m = { pos: _v1.clone(), vel: _fwd.clone().multiplyScalar(80), target, t: 0, smokeT: 0 };
  FLIGHT.missiles.push(m);
  AUD.missile();
  hudMissiles();
}
function missileBoom(m, tgt) {
  fxExplode(m.pos, 2.4, { spark: 0xffd27a });
  for (const e of ENEMIES.list) {
    if (!e.alive) continue;
    const d = e.pos.distanceTo(m.pos);
    if (d < 22 + e.radius) {
      e.hp -= 14;
      e.flashT = 0.1;
      if (e.hp <= 0) killEnemy(e, true);
    }
  }
}

// ---------------- combat resolution ----------------
const _segEnd = new THREE.Vector3(), _hitP = new THREE.Vector3();
function updateCombat(dt) {
  G.shipRig.getWorldPosition(_v7);
  for (let ti = 0; ti < FX.TRACER_N; ti++) {
    const t = FX.tracers[ti];
    if (!t.alive) continue;
    if (t.owner === 1) {
      // player laser vs enemies — segment/sphere
      const step = t.speed * dt + t.len;
      for (const e of ENEMIES.list) {
        if (!e.alive) continue;
        _v1.copy(e.pos).sub(t.pos);
        const along = _v1.dot(t.dir);
        if (along < -e.radius || along > step + e.radius) continue;
        _hitP.copy(t.pos).addScaledVector(t.dir, clamp(along, 0, step));
        const d2 = _hitP.distanceToSquared(e.pos);
        const rad = e.radius * (e.kind === 'drone' ? 1.7 : 1.2);  // generous hit slop
        if (d2 > rad * rad) {
          if (d2 < rad * rad * 9 && e.kind === 'drone' && e.evadeT <= 0 && rng() < 0.25) e.evadeT = 0.55;
          continue;
        }
        // cruiser front shield — blocks shots arriving from its front hemisphere
        if (e.kind === 'cruiser' && e.fwd) {
          _v2.copy(t.dir).negate();
          if (_v2.dot(e.fwd) > 0.35) {
            e.shieldFlash = 0.25;
            fxSparks(_hitP, 6, 0x52ffd0, 9, 4, 0.4);
            AUD.deflect();
            t.alive = false;
            break;
          }
        }
        // boss rotating shield rings
        if (e.kind === 'boss' && bossRingBlocks(e, _hitP)) {
          fxSparks(_hitP, 7, 0xb07aff, 10, 4.5, 0.4);
          AUD.deflect();
          t.alive = false;
          break;
        }
        let dmg = t.dmg;
        if (e.kind === 'boss') {
          e.parts.core.getWorldPosition(_v3);
          if (_hitP.distanceTo(_v3) < 7) { dmg *= 3; fxSparks(_hitP, 10, 0x6dffb0, 14, 6, 0.5); }
        }
        e.hp -= dmg;
        e.flashT = 0.09;
        S.hits++;
        fxSparks(_hitP, 5, 0xaef3ff, 11, 3.5, 0.35);
        AUD.hitSpark();
        t.alive = false;
        if (e.hp <= 0) killEnemy(e, true);
        break;
      }
      if (!t.alive) {
        _m1.compose(_v1.set(0, -99999, 0), _q1.identity(), _v2.set(0.001, 0.001, 0.001));
        FX.tracerMesh.setMatrixAt(ti, _m1);
        FX.tracerDirty = true;
      }
    } else if (t.owner === 2) {
      // enemy plasma vs player — swept segment test (no tunneling)
      const step2 = t.speed * dt + t.len;
      _v1.copy(_v7).sub(t.pos);
      const along2 = clamp(_v1.dot(t.dir), 0, step2);
      _hitP.copy(t.pos).addScaledVector(t.dir, along2);
      if (_hitP.distanceToSquared(_v7) < 12) {
        t.alive = false;
        _m1.compose(_v1.set(0, -99999, 0), _q1.identity(), _v2.set(0.001, 0.001, 0.001));
        FX.tracerMesh.setMatrixAt(ti, _m1);
        FX.tracerDirty = true;
        damagePlayer(t.dmg);
      }
    }
  }
  // drone ramming
  for (const e of ENEMIES.list) {
    if (!e.alive || e.kind !== 'drone') continue;
    if (e.pos.distanceToSquared(_v7) < 22) {
      killEnemy(e, false);
      fxExplode(e.pos, 1.1, {});
      damagePlayer(7);
    }
  }
  // combo decay
  if (S.combo > 1) {
    S.comboT -= dt;
    if (S.comboT <= 0) { S.combo = 1; hudCombo(); }
  }
  // hull/shield regen
  if (S.now - S.lastHullHit > 5 && S.hull > 0) {
    S.hull = Math.min(100, S.hull + (S.upg.shieldRegen ? 9 : 5.5) * dt);
  }
  if (S.upg.shieldRegen && S.now - S.lastHullHit > 5) S.shield = Math.min(30, S.shield + 6 * dt);
  // slow-mo trigger
  if (S.slowmo > 0) S.slowmo -= dt;
  S.slowmoCD -= dt;
  if (S.upg.slowmo && S.integrity < 25 && S.slowmoCD <= 0) {
    for (const e of ENEMIES.list) {
      if (e.alive && e.state === 'entry') { S.slowmo = 2.2; S.slowmoCD = 12; AUD.alarm(); break; }
    }
  }
}
const _bossLocal = new THREE.Vector3();
function bossRingBlocks(e, hitP) {
  _bossLocal.copy(hitP).sub(e.pos);
  _q1.copy(e.obj.quaternion).invert();
  _bossLocal.applyQuaternion(_q1);
  for (const rg of e.parts.rings) {
    const rr = _bossLocal.length();
    if (Math.abs(rr - rg.r) > 4) continue;
    // ring plane normal ~ holder local Y; gap window check by azimuth
    const az = Math.atan2(_bossLocal.z, _bossLocal.x) - rg.rot;
    const azm = ((az % TAU) + TAU) % TAU;
    if (azm < TAU - rg.gap) return true;
  }
  return false;
}
function damagePlayer(d) {
  if (S.mode !== 'DEFENSE' || S.invulnT > 0) return;
  S.lastHullHit = S.now;
  if (S.shield > 0) {
    const absorbed = Math.min(S.shield, d);
    S.shield -= absorbed; d -= absorbed;
  }
  if (d <= 0) { hudHull(); return; }
  S.hull = Math.max(0, S.hull - d);
  fxShake(0.35);
  AUD.hullHit();
  if (G.dmgOverlay) {
    G.dmgOverlay.style.opacity = '0.85';
    setTimeout(() => { G.dmgOverlay.style.opacity = '0'; }, 120);
  }
  hudHull();
  if (S.hull <= 0) emergencyReset();
}
function emergencyReset() {
  S.invulnT = 2.5;
  S.hull = 70;
  S.shield = 0;
  fxExplode(_v7, 2, {});
  $('fade').style.transition = 'opacity .25s';
  $('fade').style.opacity = '1';
  uiToast('EMERGENCY SYSTEMS — HULL RESTORED', 2.5);
  setTimeout(() => {
    G.shipRig.position.setLength(880);
    $('fade').style.opacity = '0';
    setTimeout(() => { $('fade').style.transition = 'opacity 4s'; }, 400);
  }, 350);
}
function addScore(base) {
  S.score += base * S.combo;
  if (S.score > S.best) {
    S.best = S.score;
    try { localStorage.setItem('attractmode.best', String(S.best)); } catch (err) { }
  }
  hudScore();
}
function bumpCombo() {
  if (S.now - (S.lastKillAt || -10) < 2) {
    if (S.combo < 8) { S.combo++; AUD.comboUp(S.combo); }
  } else S.combo = 1;
  S.lastKillAt = S.now;
  S.comboT = 2;
  hudCombo();
}
function damageIntegrity(d) {
  S.integrity = Math.max(0, S.integrity - d);
  hudIntegrity();
  AUD.alarm();
  if (S.integrity <= 0) enterFallen();
}
// ============================================================================
// ENEMY INDICATORS — brackets on screen, edge arrows off screen
// ============================================================================
const EIND = { els: [], N: 16, shown: 0, scratch: [] };
function buildIndicators() {
  for (let i = 0; i < EIND.N; i++) {
    const d = document.createElement('div');
    d.className = 'eind';
    document.body.appendChild(d);
    EIND.els.push(d);
    EIND.scratch.push({ e: null, d2: 0 });
  }
}
function hideIndicators() {
  if (EIND.shown === 0) return;
  for (const d of EIND.els) d.style.display = 'none';
  EIND.shown = 0;
}
const _indV = new THREE.Vector3();
function updateIndicators() {
  if ((S.mode !== 'DEFENSE') || S.paused) { hideIndicators(); return; }
  if (S.frame % 2) return;
  // nearest N alive enemies
  G.camera.getWorldPosition(_v6);
  let n = 0;
  for (const e of ENEMIES.list) {
    if (!e.alive) continue;
    const d2 = e.pos.distanceToSquared(_v6);
    if (n < EIND.N) { EIND.scratch[n].e = e; EIND.scratch[n].d2 = d2; n++; }
    else {
      let wi = 0;
      for (let i = 1; i < EIND.N; i++) if (EIND.scratch[i].d2 > EIND.scratch[wi].d2) wi = i;
      if (d2 < EIND.scratch[wi].d2) { EIND.scratch[wi].e = e; EIND.scratch[wi].d2 = d2; }
    }
  }
  const W = window.innerWidth, H = window.innerHeight, cx = W / 2, cy = H / 2;
  for (let i = 0; i < EIND.N; i++) {
    const d = EIND.els[i];
    if (i >= n) { if (i < EIND.shown) d.style.display = 'none'; continue; }
    const e = EIND.scratch[i].e;
    const dist = Math.sqrt(EIND.scratch[i].d2);
    _indV.copy(e.pos).applyMatrix4(G.camera.matrixWorldInverse);
    const behind = _indV.z > 0;
    let onScreen = false, sx = 0, sy = 0;
    if (!behind) {
      _proj.copy(e.pos).project(G.camera);
      onScreen = Math.abs(_proj.x) < 0.93 && Math.abs(_proj.y) < 0.88;
      sx = (_proj.x * 0.5 + 0.5) * W;
      sy = (-_proj.y * 0.5 + 0.5) * H;
    }
    const burning = e.state === 'entry';
    const col = burning ? '#ff4030' : e.kind === 'drone' ? '#52ff8e' : e.kind === 'cruiser' ? '#ffb454' : '#c46aff';
    d.style.display = 'block';
    d.style.color = col;
    d.style.opacity = burning ? (Math.sin(S.now * 10) > 0 ? '0.95' : '0.3') : '0.7';
    if (onScreen) {
      const s = clamp(5200 * (e.kind === 'boss' ? 3 : e.kind === 'cruiser' ? 1.7 : 1) / Math.max(60, dist), 22, 110);
      if (d._mode !== 1) { d._mode = 1; d.classList.remove('arrow'); d.textContent = ''; }
      d.style.width = d.style.height = s.toFixed(0) + 'px';
      d.style.transform = `translate(${sx.toFixed(0)}px,${sy.toFixed(0)}px) translate(-50%,-50%)`;
    } else {
      // edge arrow toward the enemy
      let vx = _indV.x, vy = -_indV.y;
      if (behind) { vx = -vx; vy = -vy; }
      const m = Math.hypot(vx, vy) || 1;
      vx /= m; vy /= m;
      const px = cx + vx * W * 0.44, py = cy + vy * H * 0.42;
      const ang = Math.atan2(vy, vx) + Math.PI / 2;
      if (d._mode !== 2) { d._mode = 2; d.classList.add('arrow'); d.textContent = '▲'; d.style.width = d.style.height = 'auto'; }
      d.style.transform = `translate(${px.toFixed(0)}px,${py.toFixed(0)}px) translate(-50%,-50%) rotate(${ang.toFixed(2)}rad)`;
    }
  }
  EIND.shown = n;
}

// ============================================================================
// WAVES + UPGRADES
// ============================================================================
const WAVES = {
  n: 0, state: 'idle', t: 0, pending: [], spawnT: 0, interT: 0, picked: false,
  comps: [null,
    { d: 8, c: 0, b: 0 }, { d: 12, c: 0, b: 0 }, { d: 10, c: 1, b: 0 }, { d: 14, c: 2, b: 0 },
    { d: 5, c: 1, b: 1 }, { d: 16, c: 2, b: 0 }, { d: 18, c: 3, b: 0 }, { d: 20, c: 4, b: 0 },
    { d: 22, c: 4, b: 0 }, { d: 10, c: 3, b: 1 }],
  comp(n) {
    if (n < this.comps.length) return this.comps[n];
    const k = n - 10;
    return {
      d: Math.min(28, Math.round(22 * Math.pow(1.15, k))),
      c: Math.min(8, 3 + Math.ceil(k * 0.7)),
      b: n % 5 === 0 ? 1 : 0,
    };
  },
  hpMul(n) { return n <= 10 ? 1 : Math.pow(1.07, n - 10); },
  total(n) { const c = this.comp(n); return c.d + c.c + c.b; },
  upcomingCount() { return this.total(Math.max(1, this.n + 1)); },
  begin() { this.state = 'pre'; this.t = 2.0; },
  startWave(n) {
    this.n = n;
    hudWave();
    hudBanner('WAVE ' + n);
    AUD.uiBlip(1200);
    this.pending = [];
    const c = this.comp(n);
    let drones = c.d;
    const groups = [];
    while (drones > 0) { const g = Math.min(drones, 5 + ((rng() * 4) | 0)); groups.push({ kind: 'drone', count: g, gap: 4.8 }); drones -= g; }
    for (let i = 0; i < c.c; i++) groups.splice(1 + ((rng() * groups.length) | 0), 0, { kind: 'cruiser', count: 1, gap: 3.2 });
    if (c.b) groups.splice(Math.min(1, groups.length), 0, { kind: 'boss', count: 1, gap: 5 });
    this.pending = groups;
    this.spawnT = 2.0;
    this.state = 'active';
  },
  update(dt) {
    if (this.state === 'pre') {
      this.t -= dt;
      if (this.t <= 0) this.startWave(1);
    } else if (this.state === 'active') {
      this.spawnT -= dt;
      if (this.pending.length && this.spawnT <= 0) {
        const ev = this.pending.shift();
        this.spawnT = ev.gap;
        randomSpawnPos(_v1);
        spawnRift(_v1, ev.kind === 'boss' ? 44 : ev.kind === 'cruiser' ? 17 : 12);
        for (let i = 0; i < ev.count; i++) {
          _v2.copy(_v1);
          _v2.x += (rng() - 0.5) * 14; _v2.y += (rng() - 0.5) * 14; _v2.z += (rng() - 0.5) * 14;
          spawnEnemy(ev.kind, _v2, this.hpMul(this.n));
        }
      }
      if (!this.pending.length && countAlive() === 0) {
        this.state = 'inter';
        this.interT = 8;
        this.picked = false;
        S.integrity = Math.min(100, S.integrity + 10);
        hudIntegrity();
        hudBanner('WAVE ' + this.n + ' CLEARED');
        showCards();
      }
    } else if (this.state === 'inter') {
      this.interT -= dt;
      $('cardsTimer').textContent = 'REPAIRS UNDERWAY — NEXT WAVE IN ' + Math.ceil(Math.max(0, this.interT)) + 's';
      for (let k = 0; k < 3; k++)
        if (IN.pressed['Digit' + (k + 1)] || IN.pressed['Numpad' + (k + 1)]) chooseUpgrade(k);
      if (this.interT <= 0) {
        hideCards();
        this.startWave(this.n + 1);
      }
    }
  },
};
const UPGRADES = [
  { id: 'fire', t: 'OVERCHARGED COILS', d: 'Laser fire rate +25%. Stacks.', ok: () => true, fx: () => { S.upg.fireMul *= 1.25; } },
  { id: 'barrel', t: 'TRIBARREL ARRAY', d: 'A third laser barrel comes online.', ok: () => S.upg.barrels < 3, fx: () => { S.upg.barrels = 3; } },
  { id: 'rack', t: 'EXPANDED RACKS', d: '+1 missile capacity.', ok: () => S.missileCap < 5, fx: () => { S.missileCap++; S.missiles++; hudMissiles(); } },
  { id: 'shield', t: 'REGEN PLATING', d: 'Regenerating shield absorbs hull damage.', ok: () => !S.upg.shieldRegen, fx: () => { S.upg.shieldRegen = true; S.shield = 30; } },
  { id: 'slowmo', t: 'TEMPORAL DAMPER', d: 'Time dilates when Earth integrity < 25%.', ok: () => !S.upg.slowmo, fx: () => { S.upg.slowmo = true; } },
];
let _cardOffers = [];
function showCards() {
  const pool = UPGRADES.filter(u => u.ok());
  _cardOffers = [];
  while (_cardOffers.length < 3 && pool.length) {
    const i = (rng() * pool.length) | 0;
    _cardOffers.push(pool.splice(i, 1)[0]);
  }
  const wrap = $('cards');
  wrap.innerHTML = '';
  _cardOffers.forEach((u, i) => {
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = `<div class="k">[${i + 1}] SALVAGE</div><div class="t">${u.t}</div><div class="d">${u.d}</div>`;
    d.addEventListener('click', () => chooseUpgrade(i));
    wrap.appendChild(d);
  });
  $('cards').classList.remove('hidden');
  $('cardsTitle').classList.remove('hidden');
  $('cardsTimer').classList.remove('hidden');
}
function chooseUpgrade(i) {
  if (WAVES.state !== 'inter' || WAVES.picked || !_cardOffers[i]) return;
  WAVES.picked = true;
  _cardOffers[i].fx();
  AUD.upgradeChime();
  uiToast(_cardOffers[i].t + ' INSTALLED', 2);
  hideCards();
}
function hideCards() {
  $('cards').classList.add('hidden');
  $('cardsTitle').classList.add('hidden');
  $('cardsTimer').classList.add('hidden');
}

// ============================================================================
// HUD
// ============================================================================
const HUDC = { score: -1, wave: -1, combo: -1, integ: -1, hull: -1, miss: -1, warn: '' };
function hudScore() {
  if (HUDC.score === S.score) return;
  HUDC.score = S.score;
  $('hScore').textContent = String(S.score);
  $('hBest').textContent = String(S.best);
}
function hudWave() {
  if (HUDC.wave === WAVES.n) return;
  HUDC.wave = WAVES.n;
  $('hWave').textContent = String(WAVES.n);
}
function hudCombo() {
  if (HUDC.combo === S.combo) return;
  HUDC.combo = S.combo;
  const el = $('combo');
  if (S.combo <= 1) { el.style.opacity = '0'; return; }
  el.textContent = '×' + S.combo;
  el.style.opacity = '1';
  const s = 1 + (S.combo - 2) * 0.14;
  el.style.transform = `scale(${s})`;
  el.style.color = S.combo >= 6 ? '#ffb454' : S.combo >= 4 ? '#aef3ff' : '#7adfff';
  el.style.transition = 'none';
  el.style.filter = 'brightness(2)';
  requestAnimationFrame(() => { el.style.transition = 'filter .3s'; el.style.filter = 'brightness(1)'; });
}
function hudIntegrity() {
  const v = Math.round(S.integrity);
  if (HUDC.integ === v) return;
  HUDC.integ = v;
  $('intFill').style.width = v + '%';
  $('intPct').textContent = v + '%';
  $('intBar').classList.toggle('crit', v < 25);
}
function hudHull() {
  const v = Math.round(S.hull);
  if (HUDC.hull === v) return;
  HUDC.hull = v;
  $('hullFill').style.width = v + '%';
  $('hullFill').style.background = v < 30 ? '#ff5a4e' : '#7adfff';
}
function hudMissiles() {
  const k = S.missiles + '/' + S.missileCap;
  if (HUDC.miss === k) return;
  HUDC.miss = k;
  let s = '';
  for (let i = 0; i < S.missileCap; i++) s += i < S.missiles ? '◆' : '◇';
  $('missRow').textContent = s;
}
function hudWarn(msg) {
  if (HUDC.warn === (msg || '')) return;
  HUDC.warn = msg || '';
  const w = $('warnC');
  if (msg) { w.textContent = msg; w.style.opacity = '1'; }
  else w.style.opacity = '0';
}
function hudBanner(text) {
  const b = $('wavebanner');
  b.textContent = text;
  b.style.transition = 'none';
  b.style.opacity = '1';
  requestAnimationFrame(() => { b.style.transition = 'opacity 2.4s ease-in'; b.style.opacity = '0'; });
}
function hudSpeedRadar() {
  $('hSpeed').textContent = String(Math.round(FLIGHT.speed * 4));
  $('hThr').textContent = Math.round(FLIGHT.throttle * 100) + '%';
  const thr = countAlive() + WAVES.pending.reduce((a, g) => a + g.count, 0);
  $('hThreats').textContent = String(thr);
  // radar
  const c = $('radar'), x = c.getContext('2d');
  x.clearRect(0, 0, 158, 158);
  x.strokeStyle = 'rgba(125,255,176,0.25)';
  x.lineWidth = 1;
  for (const rr of [26, 52, 76]) { x.beginPath(); x.arc(79, 79, rr, 0, TAU); x.stroke(); }
  x.beginPath(); x.moveTo(79, 6); x.lineTo(79, 152); x.moveTo(6, 79); x.lineTo(152, 79);
  x.strokeStyle = 'rgba(125,255,176,0.12)'; x.stroke();
  G.shipRig.getWorldPosition(_v7);
  _q1.copy(G.shipRig.quaternion).invert();
  // earth marker
  _v1.copy(_v7).negate().applyQuaternion(_q1).normalize().multiplyScalar(70);
  x.fillStyle = 'rgba(90,160,255,0.9)';
  x.beginPath(); x.arc(79 + _v1.x, 79 + _v1.z, 4, 0, TAU); x.fill();
  // blips
  const k = 76 / 1200;
  for (const e of ENEMIES.list) {
    if (!e.alive) continue;
    _v1.copy(e.pos).sub(_v7).applyQuaternion(_q1);
    let bx = _v1.x * k, bz = _v1.z * k;
    const m = Math.hypot(bx, bz);
    if (m > 74) { bx *= 74 / m; bz *= 74 / m; }
    const blink = e.state === 'entry' && (S.frame & 8);
    x.fillStyle = blink ? '#ff3020' : e.kind === 'drone' ? '#52ff70' : e.kind === 'cruiser' ? '#ffb454' : '#c46aff';
    const sz = e.kind === 'boss' ? 4.5 : e.kind === 'cruiser' ? 3 : 2;
    x.fillRect(79 + bx - sz / 2, 79 + bz - sz / 2, sz, sz);
  }
}

// ============================================================================
// FALLEN — 0% integrity
// ============================================================================
let _fallenT = 0;
function enterFallen() {
  if (S.mode === 'FALLEN') return;
  S.mode = 'FALLEN';
  _fallenT = 0;
  WAVES.state = 'done';
  hideCards();
  // make sure the ending plays from the cockpit, whatever view was active
  S.thirdPerson = false;
  FLIGHT.camT = 0;
  ROOM.group.visible = true;
  EXT.group.visible = false;
  for (const tr of EXT.trails) tr.mesh.material.uniforms.uOn.value = 0;
  G.camera.position.copy(ROOM.seatHead);
  $('hud').classList.remove('on');
  $('reticle').style.opacity = '0';
  $('aimdot').style.opacity = '0';
  $('lockbox').style.opacity = '0';
  hudWarn(null);
  document.exitPointerLock();
  AUD.setMusic('somber');
  AUD.setEngine(0, false);
  const acc = S.shots ? Math.round(100 * S.hits / S.shots) : 0;
  $('fallenStats').innerHTML =
    `WAVES SURVIVED&nbsp; ${Math.max(0, WAVES.n - 1)}<br>` +
    `KILLS&nbsp; ${S.kills}<br>` +
    `ACCURACY&nbsp; ${acc}%<br>` +
    `SCORE&nbsp; ${S.score}${S.score >= S.best && S.score > 0 ? ' — BEST' : ''}`;
  $('fallen').classList.remove('hidden');
  setTimeout(() => { $('fallen').style.opacity = '1'; }, 3600);
}
function updateFallen(dt) {
  _fallenT += dt;
  // slow somber drift away from the darkened planet
  const r = G.shipRig.position.length();
  G.shipRig.position.setLength(r + (2050 - r) * dt * 0.085);
  _v1.copy(G.shipRig.position).normalize();
  const xA = _v2.crossVectors(_v3.set(0, 1, 0), _v1).normalize();
  const yA = _v3.crossVectors(_v1, xA).normalize();
  _m1.makeBasis(xA, yA, _v1);
  _q1.setFromRotationMatrix(_m1);
  G.shipRig.quaternion.slerp(_q1, Math.min(1, dt * 0.5));
  G.bank.rotation.z *= 1 - Math.min(1, dt * 1.5);
  G.camera.position.lerp(ROOM.seatHead, Math.min(1, dt * 2));
  _q2.setFromEuler(_eul.set(-0.02, 0, 0));
  G.camera.quaternion.slerp(_q2, Math.min(1, dt * 2));
  G.camera.fov = lerp(G.camera.fov, 58, Math.min(1, dt * 0.4));
  G.camera.updateProjectionMatrix();
  if (IN.pressed['KeyR']) location.reload();
}

// ============================================================================
// MAIN LOOP + INIT
// ============================================================================
const ARC = new ArcadeGame();

let _last = performance.now();
let _hudAcc = 0;
function loop(tms) {
  requestAnimationFrame(loop);
  const rdt = Math.min(0.05, (tms - _last) / 1000);
  _last = tms;
  S.now += rdt;
  S.frame = (S.frame | 0) + 1;
  let dt = rdt;
  if (S.paused) dt = 0;
  if (S.hitstop > 0) { S.hitstop -= rdt; dt = 0; }
  if (S.slowmo > 0 && dt > 0) dt *= 0.45;
  S.invulnT = Math.max(0, (S.invulnT || 0) - rdt);
  if (_toastTimer > 0) { _toastTimer -= rdt; if (_toastTimer <= 0) $('toast').style.opacity = '0'; }

  // the cabinet never stops
  ARC.update(rdt);
  G.arcTex.needsUpdate = true;

  switch (S.mode) {
    case 'BOOT':
    case 'ARCADE':
      placeArcadeCamera();
      if (S.mode === 'ARCADE' && CINE.revealAt > 0 && S.now >= CINE.revealAt) startReveal();
      break;
    case 'REVEAL': updateReveal(rdt); break;
    case 'ROAM': updateRoam(dt); break;
    case 'SIT': updateSit(rdt); break;
    case 'DEFENSE':
      S.defenseT += dt;
      updateFlight(dt, rdt);
      updateEnemies(dt);
      updateCombat(dt);
      WAVES.update(dt);
      break;
    case 'FALLEN':
      updateFallen(rdt);
      updateEnemies(dt);
      break;
  }
  updateRoomAndShip(rdt);
  updateEarth(rdt);
  updateIndicators();
  if (S.overlayOn) updateTrajLines();
  fxUpdate(dt, rdt);
  AUD.update(rdt);
  updateFlares();
  S.flareBoost = Math.max(1, (S.flareBoost || 1) - rdt * 0.5);

  _hudAcc += rdt;
  if (_hudAcc > 0.1 && (S.mode === 'DEFENSE' || S.mode === 'FALLEN')) {
    _hudAcc = 0;
    hudSpeedRadar();
    hudScore(); hudHull(); hudMissiles();
  }

  // perf watchdog
  S.fpsEMA = lerp(S.fpsEMA, 1 / Math.max(rdt, 1e-3), 0.05);
  if (S.fpsEMA < 45) S.lowFPSTime += rdt; else S.lowFPSTime = 0;
  if (S.lowFPSTime > 4 && !S.degraded) {
    S.degraded = true;
    G.renderer.setPixelRatio(1);
    G.composer.setPixelRatio(1);   // composer caches its own ratio
    G.composer.setSize(window.innerWidth, window.innerHeight);
    setFXAARes();
    G.bloom.strength *= 0.75;
    if (ROOM.dust) ROOM.dust.visible = false;
  }

  G.composer.render();
  endFrameInput();
}

function updateTrajLines() {
  let v = 0;
  const pos = EARTH.trajPos;
  for (const e of ENEMIES.list) {
    if (v > pos.length / 3 - 16) break;
    if (!e.alive) continue;
    // dashed line from enemy to its target
    for (let s = 0; s < 6 && v < pos.length / 3 - 2; s++) {
      const a = s / 6, b = (s + 0.55) / 6;
      _v1.lerpVectors(e.pos, e.target, a);
      _v2.lerpVectors(e.pos, e.target, b);
      pos[v * 3] = _v1.x; pos[v * 3 + 1] = _v1.y; pos[v * 3 + 2] = _v1.z; v++;
      pos[v * 3] = _v2.x; pos[v * 3 + 1] = _v2.y; pos[v * 3 + 2] = _v2.z; v++;
    }
  }
  EARTH.traj.geometry.setDrawRange(0, v);
  EARTH.traj.geometry.attributes.position.needsUpdate = true;
}

function init() {
  initRenderer();
  buildSky();
  buildEarth();
  buildRoom();
  buildFX();
  buildEnemies();
  buildExterior();
  buildIndicators();
  // damage overlay
  const dmg = document.createElement('div');
  dmg.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:7;opacity:0;transition:opacity .35s;' +
    'background:radial-gradient(ellipse at center, transparent 40%, rgba(255,40,20,.38) 100%)';
  document.body.appendChild(dmg);
  G.dmgOverlay = dmg;
  placeArcadeCamera();
  hudIntegrity(); hudHull(); hudMissiles(); hudScore();
  $('restart').addEventListener('click', () => location.reload());
  window.addEventListener('click', () => {
    if (AUD.ctx && AUD.ctx.state === 'suspended') AUD.ctx.resume();
    if (S.mode === 'BOOT') { AUD.init(); enterArcade(); return; }
    if (S.mode === 'REVEAL' && CINE.revealDone) { requestLock(); enterRoam(); return; }
    if ((S.mode === 'ROAM' || S.mode === 'DEFENSE') && S.paused) {
      requestLock(); S.paused = false; uiPrompt(null, null);
      return;
    }
    if ((S.mode === 'ROAM' || S.mode === 'DEFENSE' || S.mode === 'SIT') && !IN.locked) requestLock();
  });
  requestAnimationFrame(loop);
}

// dev/test hooks (harmless in production)
window.__AM = {
  S, G, ENEMIES, WAVES, EARTH, THREE, ROOM, CINE, FLIGHT, WALK, IN,
  state: () => S.mode,
  skip(mode) {
    if (mode === 'ARCADE' && S.mode === 'BOOT') { AUD.init(); enterArcade(); return; }
    if (mode === 'REVEAL') {
      if (S.mode === 'BOOT') { AUD.init(); enterArcade(); }
      ARC.lives = 1; ARC.state = 'PLAY'; ARC.killPlayer();
      CINE.revealAt = S.now + 0.3;
      return;
    }
    if (mode === 'ROAM') {
      this.skip('REVEAL');
      startReveal();
      CINE.reveal0 = S.now - 11;
      updateReveal(0.016);
      enterRoam();
      return;
    }
    if (mode === 'DEFENSE') {
      S.testMode = true;
      if (S.mode !== 'ROAM') this.skip('ROAM');
      G.camera.position.set(0, 1.7, -1.2);
      startSit();
      CINE.sit0 = S.now - 20;
      CINE.shutterOpen = S.now - 20;
      return;
    }
  },
  spawn(kind) { randomSpawnPos(_v1); return spawnEnemy(kind || 'drone', _v1); },
  impact() { const e = this.spawn('drone'); if (e) { e.pos.copy(e.target).setLength(CFG.impactR + 2); e.state = 'entry'; e.vel.copy(e.pos).normalize().multiplyScalar(-44); } },
  setIntegrity(v) { S.integrity = v; hudIntegrity(); if (v <= 0) enterFallen(); },
};

init();

