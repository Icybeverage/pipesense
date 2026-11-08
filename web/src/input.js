// PipeSense input layer.
//
// Two sources feed the same interface: every hand exposes a smoothed pose
// (world target, orientation, finger curls, thumb, pinch) that gloves.js
// renders and interaction.js consumes. Camera input uses MediaPipe's Hand
// Landmarker (21 landmarks per hand). Pointer, keyboard and scripted input
// reproduce the same pose only in silent automated-QA sessions (?qa=1 or
// navigator.webdriver); learner sessions accept camera input exclusively and
// the fallback is never surfaced in the interface.
//
// Handedness: the camera frame is NOT mirrored, so MediaPipe's "mirrored
// input" assumption is inverted here - the label is swapped before use. World
// X is mirrored from image X, which matches what the learner sees.
//
// Fidelity: detection slots are assigned by previous-position continuity (the
// label is only a tie-breaker), a short steady two-hand pose calibrates the
// per-user neutral X/Y/depth, depth uses the calibrated palm scale with a
// deadband and a per-frame clamp, pinch uses hysteresis with dwell, a short
// tracking loss freezes the glove pose, and re-acquisition is rate-limited so
// neither identity nor depth can snap.

import { GEOM } from './sim.js';
import {
  DEPTH, HAND_CONF, assignHands, clampStep, clampVecStep, createNeutralCalibration, createPinchLatch, depthTarget,
  landmarkPresence,
} from './handtrack.js';
import { SYNTHETIC_INPUT_MODE, synthesizeHand } from './synth.js';

// The stability helpers (identity assignment, calibrated depth, pinch
// hysteresis) are pure and live in handtrack.js so node tests can exercise
// them without a DOM; re-exported here as the input layer's public surface.
export {
  DEPTH, HAND_CONF, PINCH, assignHands, clampStep, clampVecStep, createNeutralCalibration, createPinchLatch, depthTarget,
} from './handtrack.js';
export { SYNTHETIC_INPUT_MODE, synthesizeHand, isSyntheticPractice } from './synth.js';

export const TASKS_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// The model + wasm are ~10 MB from CDNs; on venue Wi-Fi a stalled download
// must surface as an error instead of leaving the setup screen 'starting'.
const MODEL_LOAD_TIMEOUT_MS = 45000;

const CONF = {
  handMin: 0.55,
  presenceMin: 0.4,
  staleMs: 320,
  lostHintMs: 1600,
  jumpLimit: 0.22,
};

const IMG = { xScale: 1.4, yTop: 1.42, yScale: 1.35 };

// Canonical world pose a calibrated neutral maps to: hands front and centre
// with reach in every direction.
const NEUTRAL_ANCHOR = {
  left: { x: -0.30, y: 0.60, z: 0.45 },
  right: { x: 0.30, y: 0.60, z: 0.45 },
};

const WORK = GEOM.workspace;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);

function emptyTrackingStats() {
  return {
    landmarksPeak: 0,
    twoHandFrames: 0,
    confidenceSum: 0,
    confidenceSamples: 0,
    articulationEvents: 0,
    gripEvents: 0,
    contactSamples: 0,
    previousGrip: { left: false, right: false },
    previousPose: { left: null, right: null },
  };
}

// One Euro filter: low lag while still, stronger smoothing when moving fast.
class OneEuro {
  constructor(value, { minCut = 1.6, beta = 0.05, dCut = 1.0 } = {}) {
    this.minCut = minCut;
    this.beta = beta;
    this.dCut = dCut;
    this.x = value;
    this.dx = 0;
    this.t = null;
  }

  static alpha(cut, dt) {
    const tau = 1 / (2 * Math.PI * cut);
    return 1 / (1 + tau / dt);
  }

  filter(value, dt) {
    if (this.t === null || dt <= 0) {
      this.t = 0;
      this.x = value;
      return value;
    }
    const dRaw = (value - this.x) / dt;
    const aD = OneEuro.alpha(this.dCut, dt);
    this.dx = aD * dRaw + (1 - aD) * this.dx;
    const cut = this.minCut + this.beta * Math.abs(this.dx);
    const a = OneEuro.alpha(cut, dt);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }
}

function angleAt(a, b, c) {
  const abx = a.x - b.x; const aby = a.y - b.y; const abz = (a.z || 0) - (b.z || 0);
  const cbx = c.x - b.x; const cby = c.y - b.y; const cbz = (c.z || 0) - (b.z || 0);
  const dot = abx * cbx + aby * cby + abz * cbz;
  const magA = Math.hypot(abx, aby, abz) || 1e-6;
  const magC = Math.hypot(cbx, cby, cbz) || 1e-6;
  return Math.acos(clamp(dot / (magA * magC), -1, 1));
}

function bendOf(pts, i0, i1, i2) {
  return Math.PI - angleAt(pts[i0], pts[i1], pts[i2]);
}

const FINGER_TRIPLETS = [
  [[0, 5, 6], [5, 6, 7], [6, 7, 8]],
  [[0, 9, 10], [9, 10, 11], [10, 11, 12]],
  [[0, 13, 14], [13, 14, 15], [14, 15, 16]],
  [[0, 17, 18], [17, 18, 19], [18, 19, 20]],
];
const CURL_WEIGHTS = [0.3, 0.45, 0.25];
// Typical relaxed splay of each proximal phalanx relative to the middle
// finger (radians, positive toward the thumb), used when it is unobservable.
const RELAXED_SPREADS = [0.15, 0, -0.1, -0.25];
const CURL_FULL = 1.55;

function createHandState(side) {
  return {
    side,
    source: 'idle',
    target: {
      // Rest in an open, visible neutral pose. Camera input replaces this
      // immediately after calibration; scripted QA keeps the same human hand
      // silhouette until a task moves the wrist.
      pos: { x: side === 'left' ? -0.24 : 0.24, y: 0.62, z: 0.46 },
      yaw: Math.PI, pitch: -0.10, roll: 0,
      curls: [0.10, 0.08, 0.10, 0.14], thumb: 0.12, pinch: 0, highlight: 0, contact: 0,
      joints: null,
      thumbJoints: null,
      spreads: null,
    },
    pinchClosed: false,
    pinchRaw: 0,
    rotDelta: 0,
    raf: { x: null, y: null, z: null },
    filters: null,
    lastSeen: 0,
    tracked: false,
    holding: false,
    lastPalm: null,
    calib: null,
    easeUntil: 0,
    contact: 0,
    latch: createPinchLatch(),
  };
}

function hydrateFilters(hand) {
  if (hand.filters) return;
  hand.filters = {
    x: new OneEuro(hand.target.pos.x),
    y: new OneEuro(hand.target.pos.y),
    z: new OneEuro(hand.target.pos.z, { minCut: 1.1, beta: 0.03 }),
    yaw: new OneEuro(hand.target.yaw, { minCut: 1.2, beta: 0.02 }),
    pitch: new OneEuro(hand.target.pitch, { minCut: 1.2, beta: 0.02 }),
    roll: new OneEuro(hand.target.roll, { minCut: 1.0, beta: 0.02 }),
    scale: new OneEuro(0.13, { minCut: 0.9, beta: 0.02 }),
    curls: [0, 1, 2, 3].map(() => new OneEuro(0.25, { minCut: 2.2, beta: 0.04 })),
    joints: [0, 1, 2, 3].map(() => [0, 1, 2].map(() => new OneEuro(0.2, { minCut: 2.4, beta: 0.045 }))),
    thumbJoints: [0, 1, 2].map(() => new OneEuro(0.2, { minCut: 2.4, beta: 0.045 })),
    spreads: [0, 1, 2, 3].map(() => new OneEuro(0, { minCut: 1.8, beta: 0.025 })),
    thumb: new OneEuro(0.2, { minCut: 2.2, beta: 0.04 }),
    pinch: new OneEuro(1.0, { minCut: 2.6, beta: 0.02 }),
  };
}

function landmarkVec(points, a, b, aspect) {
  return {
    x: (points[b].x - points[a].x) * aspect,
    y: points[b].y - points[a].y,
    z: ((points[b].z || 0) - (points[a].z || 0)) * aspect,
  };
}

function dot3(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function unit3(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1e-6;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function palmSpreads(points, aspect) {
  const forward = unit3(landmarkVec(points, 0, 9, aspect));
  const across = landmarkVec(points, 17, 5, aspect);
  const along = dot3(across, forward);
  const radial = unit3({ x: across.x - forward.x * along, y: across.y - forward.y * along, z: across.z - forward.z * along });
  // A flexed phalanx points along the palm normal, where its in-plane angle
  // is landmark noise, so the reading fades to a relaxed-hand prior as the
  // finger leaves the plane.
  const reading = (mcp) => {
    const dir = landmarkVec(points, mcp, mcp + 1, aspect);
    const r = dot3(dir, radial);
    const f = dot3(dir, forward);
    const inPlane = Math.hypot(r, f) / (Math.hypot(dir.x, dir.y, dir.z) || 1e-6);
    return { angle: Math.atan2(r, f), weight: clamp01((inPlane - 0.35) / 0.4) };
  };
  const middle = reading(9);
  const reference = middle.angle * middle.weight;
  return [5, 9, 13, 17].map((mcp, i) => {
    const { angle, weight } = reading(mcp);
    const measured = i === 1 ? 0 : angle - reference;
    return clamp(RELAXED_SPREADS[i] + (measured - RELAXED_SPREADS[i]) * weight, -0.45, 0.45);
  });
}

export function landmarkPose(points) {
  const aspect = 16 / 9;
  const palmIdx = [0, 5, 9, 13, 17];
  let px = 0; let py = 0;
  for (const i of palmIdx) { px += points[i].x; py += points[i].y; }
  px /= palmIdx.length;
  py /= palmIdx.length;

  const wrist = points[0];
  const midMcp = points[9];
  // Palm scale averages the wrist->middle-MCP span with the across-palm width,
  // so hand pitch and roll cancel out of the depth estimate.
  const span = Math.hypot((midMcp.x - wrist.x) * aspect, midMcp.y - wrist.y);
  const width = Math.hypot((points[17].x - points[5].x) * aspect, points[17].y - points[5].y);
  const scale = Math.max((span + width) / 2, 1e-4);

  const fx = (midMcp.x - wrist.x) * aspect;
  const fy = midMcp.y - wrist.y;
  const fLen = Math.hypot(fx, fy) || 1e-4;
  const dirX = -fx / fLen;
  const dirY = -fy / fLen;
  const world = { x: dirX, y: dirY, z: -0.8 };
  const wLen = Math.hypot(world.x, world.y, world.z) || 1;
  // Measured around PI (fingers into the scene) so an upright hand leaning
  // across vertical stays continuous. atan2(x, -0.8) wraps from +PI to -PI
  // there, and the One Euro filter then swept the glove through yaw 0.
  const yaw = Math.PI - Math.atan2(world.x / wLen, -world.z / wLen);
  const pitch = -Math.asin(clamp(world.y / wLen, -1, 1));

  // Knuckle-line slope, independent of which side of the image the thumb is
  // on. The signed index->pinky vector sat near atan2(.., -1) for one
  // handedness, saturating roll at +/-0.6 and flipping it on a 1 degree tilt.
  const rx = (points[17].x - points[5].x) * aspect;
  const ry = points[17].y - points[5].y;
  const roll = clamp(Math.atan2(rx >= 0 ? ry : -ry, Math.abs(rx)) * 0.5, -0.6, 0.6);

  const curls = FINGER_TRIPLETS.map((joints) => {
    let bend = 0;
    joints.forEach(([a, b, c], i) => { bend += bendOf(points, a, b, c) * CURL_WEIGHTS[i]; });
    return clamp01(bend / CURL_FULL);
  });
  const joints = FINGER_TRIPLETS.map((triplets) => triplets.map(([a, b, c]) => clamp01(bendOf(points, a, b, c) / CURL_FULL)));
  const thumbJoints = [[0, 1, 2], [1, 2, 3], [2, 3, 4]]
    .map(([a, b, c]) => clamp01(bendOf(points, a, b, c) / CURL_FULL));
  const thumb = clamp01(thumbJoints[0] * 0.35 + thumbJoints[1] * 0.4 + thumbJoints[2] * 0.25);

  // Lateral MCP spread of each proximal phalanx relative to the middle
  // finger, measured in the palm plane and positive toward the thumb.
  // Curl alone cannot reproduce finger splay, so this is the missing degree
  // of freedom between MediaPipe's landmarks and the anatomical rig. Using
  // the hand's own radial axis (pinky MCP -> index MCP) keeps the sign the
  // same for both hands and for palm- or back-facing poses.
  const spreads = palmSpreads(points, aspect);

  const pinchRatio = Math.hypot((points[4].x - points[8].x) * aspect, points[4].y - points[8].y) / scale;

  return {
    palm: { x: px, y: py },
    inRange: px > 0.04 && px < 0.96 && py > 0.02 && py < 0.96,
    scale,
    yaw,
    pitch,
    roll,
    curls,
    joints,
    thumbJoints,
    spreads,
    thumb,
    pinchRatio,
    smooth: (dt, hand) => {
      const f = hand.filters;
      const calib = hand.calib;
      let wx = (0.5 - px) * IMG.xScale;
      let wy = IMG.yTop - py * IMG.yScale;
      if (calib) {
        // Neutral-relative mapping: the calibrated pose maps to the canonical
        // anchor so an off-centre stance still reaches the full workspace.
        const anchor = NEUTRAL_ANCHOR[hand.side];
        const nx = anchor.x + (calib.x - px) * IMG.xScale;
        const ny = anchor.y + (calib.y - py) * IMG.yScale;
        const k = calib.blend;
        wx += (nx - wx) * k;
        wy += (ny - wy) * k;
        if (k < 1) calib.blend = Math.min(1, k + dt / 0.45);
      }
      const zs = f.scale.filter(scale, dt);
      const zAbs = depthTarget(zs, null, DEPTH);
      let zTarget = zAbs;
      if (calib) {
        const zNeutral = { scale: calib.scale, anchorZ: NEUTRAL_ANCHOR[hand.side].z };
        zTarget = zAbs + (depthTarget(zs, zNeutral, DEPTH) - zAbs) * calib.blend;
      }
      return {
        x: f.x.filter(clamp(wx, WORK.minX, WORK.maxX), dt),
        y: f.y.filter(clamp(wy, WORK.minY, WORK.maxY), dt),
        z: clamp(clampStep(hand.target.pos.z, zTarget, HAND_CONF.depthRate, dt), WORK.minZ, WORK.maxZ),
        yaw: f.yaw.filter(yaw, dt),
        pitch: f.pitch.filter(pitch, dt),
        roll: f.roll.filter(roll, dt),
        curls: curls.map((c, i) => f.curls[i].filter(c, dt)),
        joints: joints.map((chain, fi) => chain.map((value, ji) => f.joints[fi][ji].filter(value, dt))),
        thumbJoints: thumbJoints.map((value, ji) => f.thumbJoints[ji].filter(value, dt)),
        spreads: spreads.map((value, i) => f.spreads[i].filter(value, dt)),
        thumb: f.thumb.filter(thumb, dt),
        pinchRatio: f.pinch.filter(pinchRatio, dt),
      };
    },
  };
}

export function createInput({ canvas, video, onStatus, automated = false }) {
  const hands = { left: createHandState('left'), right: createHandState('right') };
  const calibrator = createNeutralCalibration();
  const keys = new Set();
  const drags = new Map();
  const dragOffsets = new Map();
  let wheelDelta = 0;
  let cameraFrames = 0;
  let fallbackFrames = 0;
  let lastReportedHands = -1;
  let lastCalibReport = -1;

  // Guided practice: no camera. The full-lesson macro drives the same hand
  // target pose the gloves render and interaction.js resolves against, and
  // synth.js forward-renders that pose as 21 landmarks for the preview.
  const practice = { active: false, hands: { left: null, right: null } };

  const camera = {
    active: false,
    status: 'off',
    stream: null,
    landmarker: null,
    lastVideoTime: -1,
    lastFrameAt: 0,
    // Bumped by stopCamera so a start still awaiting permission or the model
    // download cannot resurrect the camera after it was turned off (e.g. the
    // learner chose Guided practice meanwhile).
    startToken: 0,
    landmarkerLoad: null,
    errors: 0,
    handsSeen: 0,
    lostSince: 0,
    tmp: { x: 0, y: 0, z: 0 },
    debugHands: { left: null, right: null },
    stats: emptyTrackingStats(),
  };

  function status() {
    if (onStatus) {
      let holding = 0;
      for (const side of ['left', 'right']) if (hands[side].holding) holding += 1;
      onStatus({
        camera: {
          active: camera.active,
          status: camera.status,
          handsSeen: camera.handsSeen,
          holding,
          calibrated: calibrator.ready,
          calibProgress: calibrator.progress,
          error: camera.error || null,
        },
        inputMode: inputMode(),
      });
    }
  }

  function resetTrackingFidelity() {
    calibrator.reset();
    camera.stats = emptyTrackingStats();
    lastCalibReport = -1;
    for (const side of ['left', 'right']) {
      const hand = hands[side];
      hand.calib = null;
      hand.filters = null;
      hand.lastSeen = 0;
      hand.lastPalm = null;
      hand.easeUntil = 0;
      hand.holding = false;
      hand.latch.reset(false);
    }
  }

  function inputMode() {
    // Guided practice is classified on its own so the backend can refuse to
    // certify it. Learner sessions are otherwise camera-only, so an active
    // session always reports 'camera'; the QA channel keeps the mixed-source
    // classification.
    if (practice.active) return SYNTHETIC_INPUT_MODE;
    // Learner sessions are camera-only by product policy; never surface
    // keyboard/mouse as an available mode outside the silent QA channel.
    if (!automated) return camera.active ? 'camera' : 'off';
    if (!camera.active || cameraFrames === 0) return 'keyboard_mouse';
    if (fallbackFrames === 0) return 'camera';
    const ratio = cameraFrames / (cameraFrames + fallbackFrames);
    if (ratio > 0.7) return 'camera';
    if (ratio < 0.25) return 'keyboard_mouse';
    return 'mixed';
  }

  // ---------------------------------------------------- guided practice channel
  function setSynthetic(active) {
    const next = Boolean(active);
    if (next === practice.active) return;
    practice.active = next;
    if (next) {
      // Guided practice and the camera are mutually exclusive so a simulated
      // session can never borrow a real camera session's certification.
      stopCamera();
      for (const side of ['left', 'right']) {
        hands[side].source = 'synthetic';
        hands[side].target.joints = null;
        hands[side].target.thumbJoints = null;
        hands[side].target.spreads = null;
      }
    } else {
      practice.hands = { left: null, right: null };
      for (const side of ['left', 'right']) {
        if (hands[side].source === 'synthetic') hands[side].source = 'idle';
      }
    }
    status();
  }

  function updatePractice() {
    const out = { left: null, right: null };
    for (const side of ['left', 'right']) {
      const hand = hands[side];
      const synth = synthesizeHand(side, {
        pos: hand.target.pos,
        yaw: hand.target.yaw,
        pitch: hand.target.pitch,
        roll: hand.target.roll,
        curls: hand.target.curls,
        thumb: hand.target.thumb,
        pinch: hand.target.pinch,
      });
      out[side] = {
        points: synth.points,
        confidence: 1,
        curls: [...hand.target.curls],
        thumb: hand.target.thumb,
        pinchRatio: 1 - clamp01(hand.target.pinch),
        pinchClosed: hand.pinchClosed,
        roll: hand.target.roll,
        pitch: hand.target.pitch,
        contact: hand.contact,
        wristZ: synth.wristZ,
        meanZ: synth.meanZ,
        synthetic: true,
      };
    }
    practice.hands = out;
  }

  // ------------------------------------------- pointer/keyboard QA channel
  function toWorldFromPointer(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    return {
      x: clamp((0.5 - nx) * IMG.xScale * 1.15, WORK.minX, WORK.maxX),
      y: clamp(IMG.yTop - ny * IMG.yScale * 1.05, WORK.minY, WORK.maxY),
      z: null,
    };
  }

  function pickHand(point) {
    let best = null; let bestDist = 0.42;
    for (const side of ['left', 'right']) {
      const t = hands[side].target.pos;
      const d = Math.hypot(t.x - point.x, t.y - point.y);
      if (d < bestDist) { bestDist = d; best = hands[side]; }
    }
    return best || (point.x < 0 ? hands.left : hands.right);
  }

  function onPointerDown(event) {
    if (!automated) return;
    if (event.button !== 0 && event.button !== 1) return;
    const p = toWorldFromPointer(event.clientX, event.clientY);
    const hand = pickHand(p);
    canvas.setPointerCapture(event.pointerId);
    drags.set(event.pointerId, hand.side);
    dragOffsets.set(event.pointerId, { dx: hand.target.pos.x - p.x, dy: hand.target.pos.y - p.y });
    hand.grabIntent = !event.altKey;
  }

  function onPointerMove(event) {
    if (!automated) return;
    const side = drags.get(event.pointerId);
    if (!side) return;
    const hand = hands[side];
    const p = toWorldFromPointer(event.clientX, event.clientY);
    const off = dragOffsets.get(event.pointerId) || { dx: 0, dy: 0 };
    hand.target.pos.x = clamp(p.x + off.dx, WORK.minX, WORK.maxX);
    hand.target.pos.y = clamp(p.y + off.dy, WORK.minY, WORK.maxY);
  }

  function onPointerUp(event) {
    if (!automated) return;
    if (!drags.has(event.pointerId)) return;
    const side = drags.get(event.pointerId);
    drags.delete(event.pointerId);
    dragOffsets.delete(event.pointerId);
    if (side) hands[side].grabIntent = false;
  }

  function onWheel(event) {
    if (!automated) return;
    wheelDelta += event.deltaY;
    event.preventDefault();
  }

  function onKeyDown(event) {
    if (!automated) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select')) return;
    if (target instanceof HTMLElement && target.closest('button') && (event.code === 'Space' || event.key === 'Enter')) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code)) event.preventDefault();
    keys.add(event.code);
    if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
      const amt = event.code === 'BracketRight' ? 1 : -1;
      if (keys.has('KeyF')) hands.left.rotDelta += amt * 0.09;
      if (keys.has('Semicolon')) hands.right.rotDelta += amt * 0.09;
      event.preventDefault();
    }
  }

  function onKeyUp(event) {
    keys.delete(event.code);
  }

  function applyFallback(dt) {
    const fine = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = fine ? 0.16 : 0.42;
    const L = hands.left;
    const R = hands.right;
    const moveX = (k1, k2) => ((keys.has(k2) ? 1 : 0) - (keys.has(k1) ? 1 : 0));
    const steps = [
      [L, moveX('KeyA', 'KeyD'), moveX('KeyW', 'KeyS'), moveX('KeyQ', 'KeyE')],
      [R, moveX('KeyJ', 'KeyL'), moveX('KeyI', 'KeyK'), moveX('KeyU', 'KeyO')],
    ];
    for (const [hand, mx, my, mz] of steps) {
      let touched = false;
      if (mx || my || mz) {
        const norm = Math.hypot(mx, my, mz) || 1;
        hand.target.pos.x = clamp(hand.target.pos.x + (mx / norm) * speed * dt, WORK.minX, WORK.maxX);
        hand.target.pos.y = clamp(hand.target.pos.y + (my / norm) * speed * dt, WORK.minY, WORK.maxY);
        hand.target.pos.z = clamp(hand.target.pos.z + (mz / norm) * speed * dt, WORK.minZ, WORK.maxZ);
        touched = true;
      }
      if (drags.size > 0 || touched || keys.size > 0) hand.source = 'fallback';
      if (drags.size > 0 || touched || keys.size > 0) {
        hand.target.joints = null;
        hand.target.thumbJoints = null;
        hand.target.spreads = null;
      }
    }
    if (wheelDelta !== 0) {
      const amt = clamp(wheelDelta * 0.0016, -0.35, 0.35);
      let anyGrabbed = false;
      for (const side of drags.values()) {
        if (hands[side].grabIntent) {
          hands[side].rotDelta += amt;
          anyGrabbed = true;
        }
      }
      if (!anyGrabbed) {
        const side = keys.has('KeyF') ? 'left' : keys.has('Semicolon') ? 'right' : null;
        if (side) hands[side].rotDelta += amt;
      }
      wheelDelta = 0;
    }
    for (const side of ['left', 'right']) {
      const hand = hands[side];
      // A holding hand keeps its last camera pose (and grip) through a short
      // tracking loss instead of decaying toward the fallback idle state.
      if (hand.forced || hand.holding) continue;
      const dragging = [...drags.values()].includes(side);
      const keyDown = side === 'left' ? keys.has('KeyF') : keys.has('Semicolon');
      const want = (dragging && hand.grabIntent) || keyDown;
      setPinch(hand, want ? 1 : 0);
      hand.target.curls = hand.target.curls.map((c) => c + ((want ? 0.85 : 0.3) - c) * Math.min(1, dt * 8));
      hand.target.thumb += ((want ? 0.75 : 0.25) - hand.target.thumb) * Math.min(1, dt * 8);
    }
  }

  function setPinch(hand, want) {
    if (want >= 1) hand.pinchRaw = Math.min(1, hand.pinchRaw + 0.2);
    else hand.pinchRaw = Math.max(0, hand.pinchRaw - 0.12);
    hand.target.pinch = hand.pinchRaw;
    hand.pinchClosed = hand.pinchRaw > 0.55;
    hand.latch.reset(hand.pinchClosed);
  }

  // -------------------------------------------------------- camera input
  async function ensureLandmarker() {
    if (camera.landmarker) return camera.landmarker;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('model load timed out')), MODEL_LOAD_TIMEOUT_MS);
    });
    // One in-flight download shared by restarts; a failure allows a retry.
    if (!camera.landmarkerLoad) {
      camera.landmarkerLoad = loadLandmarker().catch((err) => {
        camera.landmarkerLoad = null;
        throw err;
      });
    }
    try {
      return await Promise.race([camera.landmarkerLoad, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadLandmarker() {
    const vision = await import(/* @vite-ignore */ TASKS_VISION_URL);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${TASKS_VISION_URL}/wasm`);
    const options = {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
    try {
      camera.landmarker = await vision.HandLandmarker.createFromOptions(fileset, options);
    } catch (gpuError) {
      options.baseOptions.delegate = 'CPU';
      camera.landmarker = await vision.HandLandmarker.createFromOptions(fileset, options);
    }
    return camera.landmarker;
  }

  async function startCamera() {
    if (camera.active || camera.status === 'starting') return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // Reported as an error so the setup screen explains it; the usual cause
      // on a tablet is opening the app over plain http:// on a LAN address.
      camera.status = 'error';
      camera.error = window.isSecureContext === false
        ? 'camera needs a secure page — open the app over HTTPS (or localhost)'
        : 'this browser does not support camera access';
      status();
      return;
    }
    const token = ++camera.startToken;
    camera.status = 'starting';
    camera.error = null;
    status();
    resetTrackingFidelity();
    let stage = 'camera';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (token !== camera.startToken) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      camera.stream = stream;
      video.srcObject = stream;
      await video.play();
      stage = 'model';
      await ensureLandmarker();
      if (token !== camera.startToken) return;
      camera.active = true;
      camera.status = 'running';
      camera.errors = 0;
      camera.lastVideoTime = -1;
      camera.lastFrameAt = 0;
      camera.lostSince = 0;
    } catch (err) {
      if (token !== camera.startToken) return;
      const name = err && err.name;
      const reason = stage === 'model'
        ? 'hand-tracking model could not load — check the network, then reload the page'
        : name === 'NotAllowedError' || name === 'SecurityError' ? 'permission denied'
          : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'no camera found'
            : name === 'NotReadableError' || name === 'AbortError' ? 'camera is in use by another app'
              : String((err && err.message) || err);
      camera.status = 'error';
      camera.error = reason;
      stopTracks();
    }
    status();
  }

  function stopTracks() {
    if (camera.stream) {
      for (const track of camera.stream.getTracks()) track.stop();
      camera.stream = null;
    }
    if (video) video.srcObject = null;
  }

  function stopCamera() {
    camera.startToken += 1;
    stopTracks();
    camera.active = false;
    camera.status = 'off';
    camera.handsSeen = 0;
    camera.debugHands = { left: null, right: null };
    // The neutral pose belongs to one camera session; the next session starts
    // from the safe absolute mapping and calibrates again.
    resetTrackingFidelity();
    for (const side of ['left', 'right']) {
      hands[side].tracked = false;
      hands[side].target.joints = null;
      hands[side].target.thumbJoints = null;
      hands[side].target.spreads = null;
    }
    status();
  }

  async function toggleCamera() {
    if (camera.active) stopCamera();
    else await startCamera();
  }

  // Camera frame is raw (not mirrored), so MediaPipe's handedness label is
  // inverted relative to the learner; return the corrected label.
  function correctedLabel(categoryName) {
    const label = String(categoryName || '').toLowerCase();
    if (label === 'left') return 'right';
    if (label === 'right') return 'left';
    return '';
  }

  function selectDetections(result) {
    const out = [];
    const landmarks = result.landmarks || [];
    const handedness = result.handednesses || result.handedness || [];
    for (let i = 0; i < landmarks.length; i++) {
      const points = landmarks[i];
      if (!points || points.length !== 21) continue;
      const category = handedness[i] && handedness[i][0];
      const score = category ? category.score : 0;
      if (score < CONF.handMin) continue;
      // Hand Landmarker reports visibility 0 on every landmark; only gate on
      // per-landmark presence when the model actually provides it.
      const presence = landmarkPresence(points);
      if (presence !== null && presence < CONF.presenceMin) continue;
      out.push({
        label: correctedLabel(category && category.categoryName),
        score,
        points,
        x: points[9].x,
        y: points[9].y,
      });
    }
    return out;
  }

  function applyCameraFrame(renderDt) {
    if (!camera.landmarker || !camera.active) return false;
    if (video.readyState < 2) return false;
    if (video.currentTime === camera.lastVideoTime) return false;
    camera.lastVideoTime = video.currentTime;
    // Filters, pinch dwell and calibration hold time advance by the time
    // between processed camera frames, not the render frame: on a 60-120 Hz
    // display with a 30 fps camera the render dt would under-count real time
    // 2-4x (calibration needing a 4.4 s hold, pinch dwell 4x longer).
    const frameAt = performance.now();
    const dt = camera.lastFrameAt ? clamp((frameAt - camera.lastFrameAt) / 1000, 0.001, 0.1) : renderDt;
    camera.lastFrameAt = frameAt;
    let result;
    try {
      result = camera.landmarker.detectForVideo(video, performance.now());
      camera.errors = 0;
    } catch (err) {
      camera.errors += 1;
      if (camera.errors > 6) {
        // stopCamera resets status to 'off'; report the failure after it so
        // the setup screen shows why the camera stopped.
        stopCamera();
        camera.status = 'error';
        camera.error = 'tracking failed repeatedly';
        status();
      }
      return false;
    }
    const detections = selectDetections(result);
    camera.handsSeen = detections.length;
    if (camera.handsSeen !== lastReportedHands) {
      lastReportedHands = camera.handsSeen;
      status();
    }

    const now = performance.now();
    // Slots are matched to detections by previous-position continuity, so a
    // reordered array, a dropped label or a crossed pair never swaps hands.
    const prev = { left: null, right: null };
    for (const side of ['left', 'right']) {
      const hand = hands[side];
      if (hand.lastPalm && now - hand.lastSeen <= HAND_CONF.continuityMs) prev[side] = hand.lastPalm;
    }
    const assigned = assignHands(detections, prev);
    const calibFrames = { left: null, right: null };
    const debugHands = { left: null, right: null };

    for (const side of ['left', 'right']) {
      const hand = hands[side];
      const index = assigned[side];
      const det = index === null || index === undefined ? null : detections[index];
      if (!det) {
        if (hand.tracked && now - hand.lastSeen > CONF.staleMs) hand.tracked = false;
        continue;
      }
      const pose = landmarkPose(det.points);
      if (!pose.inRange) continue;
      if (hand.lastPalm && hand.tracked) {
        const jump = Math.hypot(pose.palm.x - hand.lastPalm.x, pose.palm.y - hand.lastPalm.y);
        if (jump > CONF.jumpLimit) continue;
      }
      const gapMs = hand.lastSeen ? now - hand.lastSeen : Infinity;
      if (gapMs > HAND_CONF.continuityMs) {
        // Long gap: drop stale filter state so re-acquisition starts from the
        // glove's current pose instead of dragging the old one across the bench.
        hand.filters = null;
      }
      hydrateFilters(hand);
      const smooth = pose.smooth(dt, hand);
      if (gapMs > HAND_CONF.reacquireMs) hand.easeUntil = now + HAND_CONF.easeMs;
      if (hand.easeUntil && now < hand.easeUntil) {
        const eased = clampVecStep(hand.target.pos, { x: smooth.x, y: smooth.y, z: smooth.z }, HAND_CONF.easeRate, dt);
        hand.target.pos.x = eased.x;
        hand.target.pos.y = eased.y;
        hand.target.pos.z = eased.z;
      } else {
        hand.easeUntil = 0;
        hand.target.pos.x = smooth.x;
        hand.target.pos.y = smooth.y;
        hand.target.pos.z = smooth.z;
      }
      hand.target.yaw = smooth.yaw;
      hand.target.pitch = clamp(smooth.pitch, -0.7, 0.9);
      hand.target.roll = smooth.roll;
      hand.target.curls = smooth.curls.map((c) => clamp(c, 0, 1));
      hand.target.joints = smooth.joints.map((chain) => chain.map((v) => clamp01(v)));
      hand.target.thumbJoints = smooth.thumbJoints.map((v) => clamp01(v));
      hand.target.spreads = smooth.spreads.map((v) => clamp(v, -0.45, 0.45));
      hand.target.thumb = clamp(smooth.thumb, 0, 1);

      const ratio = smooth.pinchRatio;
      if (!hand.forced) {
        hand.latch.update(ratio, dt * 1000);
        hand.pinchClosed = hand.latch.closed;
        hand.pinchRaw = hand.pinchClosed ? 1 : hand.latch.openness(ratio);
        hand.target.pinch = hand.pinchRaw;
      }
      if (hand.pinchClosed && hand.roll !== undefined) {
        // Wrist roll while pinched drives rotation (valve, faucet, wrench).
        const delta = smooth.roll - (hand.prevRoll ?? smooth.roll);
        if (Math.abs(delta) < 0.35) hand.rotDelta += delta * 1.6;
      }
      hand.prevRoll = smooth.roll;
      hand.tracked = true;
      hand.source = 'camera';
      hand.lastSeen = now;
      hand.lastPalm = pose.palm;
      calibFrames[side] = { x: pose.palm.x, y: pose.palm.y, scale: pose.scale };
      debugHands[side] = {
        points: det.points.map((p) => ({ x: p.x, y: p.y, z: p.z || 0 })),
        confidence: det.score,
        curls: [...smooth.curls],
        thumb: smooth.thumb,
        pinchRatio: ratio,
        pinchClosed: hand.pinchClosed,
        roll: smooth.roll,
        pitch: smooth.pitch,
        contact: hand.contact,
      };
    }

    camera.debugHands = debugHands;
    const trackedCount = Object.values(debugHands).filter(Boolean).length;
    camera.stats.landmarksPeak = Math.max(camera.stats.landmarksPeak, trackedCount * 21);
    if (trackedCount === 2) camera.stats.twoHandFrames += 1;
    for (const side of ['left', 'right']) {
      const data = debugHands[side];
      if (!data) continue;
      camera.stats.confidenceSum += data.confidence;
      camera.stats.confidenceSamples += 1;
      if (data.contact > 0.15) camera.stats.contactSamples += 1;
      const pose = [data.thumb, ...data.curls];
      const previous = camera.stats.previousPose[side];
      if (previous && now - previous.at >= 100 && Math.max(...pose.map((v, i) => Math.abs(v - previous.values[i]))) >= 0.12) {
        camera.stats.articulationEvents += 1;
        camera.stats.previousPose[side] = { values: pose, at: now };
      } else if (!previous) {
        camera.stats.previousPose[side] = { values: pose, at: now };
      }
      const powerGrip = data.curls.reduce((sum, value) => sum + value, 0) / data.curls.length >= 0.48 && data.thumb >= 0.24;
      const gripping = data.pinchClosed || powerGrip;
      if (gripping && !camera.stats.previousGrip[side]) camera.stats.gripEvents += 1;
      camera.stats.previousGrip[side] = gripping;
    }

    const outcome = calibrator.sample(dt * 1000, calibFrames);
    if (outcome.justCompleted) {
      applyNeutralCalibration();
      lastCalibReport = -1;
      status();
    } else {
      reportCalibrationProgress();
    }
    return detections.length > 0;
  }

  // A completed calibration blends each hand from the absolute mapping to its
  // neutral-relative mapping; hands that match an existing neutral are kept so
  // re-invalidating one hand does not disturb the other.
  function applyNeutralCalibration() {
    for (const side of ['left', 'right']) {
      const n = calibrator.neutral[side];
      const hand = hands[side];
      if (!n || !hand) continue;
      const cur = hand.calib;
      const same = cur
        && Math.abs(cur.x - n.x) < 0.025 && Math.abs(cur.y - n.y) < 0.025
        && Math.abs(n.scale - cur.scale) < cur.scale * 0.12;
      if (!same) hand.calib = { x: n.x, y: n.y, scale: n.scale, blend: 0 };
    }
  }

  function reportCalibrationProgress() {
    const bucket = Math.floor(calibrator.progress * 5);
    if (bucket !== lastCalibReport) {
      lastCalibReport = bucket;
      status();
    }
  }

  function update(dt) {
    const now = performance.now();
    for (const side of ['left', 'right']) {
      const hand = hands[side];
      // A hand that was tracked and vanished holds its last pose for a short
      // window: the glove stays visible and keeps its grip instead of snapping.
      hand.holding = hand.tracked
        || (hand.source === 'camera' && hand.lastSeen > 0 && now - hand.lastSeen <= HAND_CONF.holdMs);
      if (hand.calib && hand.lastSeen && now - hand.lastSeen > HAND_CONF.calibResetMs) {
        hand.calib = null;
        calibrator.invalidate(side);
      }
    }
    if (practice.active) updatePractice();
    if (automated && !practice.active) applyFallback(dt);
    const anyCamera = applyCameraFrame(dt);
    if (anyCamera) cameraFrames += 1;
    else fallbackFrames += 1;

    for (const side of ['left', 'right']) {
      const hand = hands[side];
      if (!hand.tracked && !hand.holding) {
        hand.source = hand.source === 'camera' ? 'fallback' : hand.source;
      }
    }

    if (camera.active && camera.handsSeen === 0) {
      if (!camera.lostSince) camera.lostSince = now;
    } else {
      camera.lostSince = 0;
    }
  }

  function consumeRot(side) {
    const hand = hands[side];
    const v = hand.rotDelta;
    hand.rotDelta = 0;
    return v;
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('pagehide', () => {
    stopTracks();
    if (camera.landmarker) {
      try { camera.landmarker.close(); } catch (err) { /* already closed */ }
      camera.landmarker = null;
      camera.landmarkerLoad = null;
    }
  });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  return {
    hands,
    update,
    consumeRot,
    toggleCamera,
    startCamera,
    stopCamera,
    cameraState: camera,
    inputMode,
    keys,
    // Guided practice: synthetic hands on the validated glove path, with no
    // camera. `practiceHands()` exposes the generated 21 landmarks per hand in
    // the same shape the camera preview renders.
    setSynthetic,
    get practiceActive() { return practice.active; },
    practiceHands() { return practice.hands; },
    // Macros drive the same pinch/curl state the pointer QA channel uses, so
    // scripted commands cannot bypass the hand-target interaction checks.
    forcePinch(side, value) {
      const hand = hands[side];
      if (!hand) return;
      const want = value >= 1;
      hand.forced = want ? value : null;
      hand.pinchRaw = clamp01(value);
      hand.target.pinch = hand.pinchRaw;
      hand.pinchClosed = want;
      hand.latch.reset(want);
      hand.target.joints = null;
      hand.target.thumbJoints = null;
      hand.target.spreads = null;
      hand.target.curls = hand.target.curls.map((c) => clamp01(c + ((want ? 0.85 : 0.3) - c) * 0.6));
      hand.target.thumb = clamp01(hand.target.thumb + ((want ? 0.75 : 0.25) - hand.target.thumb) * 0.6);
      hand.source = 'macro';
    },
    forceRotate(side, amount) {
      const hand = hands[side];
      if (hand && Number.isFinite(amount)) hand.rotDelta += amount;
    },
    cameraFrames() { return cameraFrames; },
    trackingTelemetry() {
      const stats = camera.stats;
      return {
        calibrated: calibrator.ready,
        landmarks_peak: stats.landmarksPeak,
        two_hand_frames: stats.twoHandFrames,
        mean_tracking_confidence: stats.confidenceSamples ? stats.confidenceSum / stats.confidenceSamples : 0,
        articulation_events: stats.articulationEvents,
        grip_events: stats.gripEvents,
        contact_samples: stats.contactSamples,
      };
    },
    setHighlight(side, value) {
      hands[side].target.highlight = value;
    },
    // Fingertip contact strength (0..1) against the nearest interactive
    // surface; drives the glove contact ring and is exposed per hand.
    setContact(side, value) {
      const hand = hands[side];
      if (!hand) return;
      hand.contact = clamp01(value);
      hand.target.contact = hand.contact;
    },
    calibrationState() {
      const handsOut = {};
      for (const side of ['left', 'right']) {
        const hand = hands[side];
        handsOut[side] = {
          tracked: hand.tracked,
          holding: hand.holding,
          calibrated: Boolean(hand.calib),
          contact: hand.contact,
        };
      }
      return { ready: calibrator.ready, progress: calibrator.progress, hands: handsOut };
    },
  };
}
