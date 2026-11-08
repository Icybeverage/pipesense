// PipeSense hand-tracking fidelity helpers.
//
// Pure, dependency-free math for the camera input path: handedness continuity
// assignment, per-user neutral calibration, palm-scale depth with deadband and
// per-frame clamping, and pinch hysteresis with dwell. Everything here runs in
// node so the behaviour is unit-tested in handtrack.test.mjs; no DOM and no
// Three.js.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);

export const HAND_CONF = {
  // A previous palm stays a continuity anchor this long after its last sighting.
  continuityMs: 650,
  // Image-space cost of a slot with no fresh previous palm.
  farCost: 0.5,
  // Image-space cost of overriding MediaPipe's handedness label.
  labelPenalty: 0.06,
  // Keep the label-consistent assignment when costs are this close.
  swapMargin: 0.02,
  // Neutral calibration: steady two-hand pose for ~1.1 s over >= 24 frames.
  calibHoldMs: 1100,
  calibMoveEps: 0.012,
  calibMinSamples: 24,
  // Hand loss that invalidates that hand's neutral pose.
  calibResetMs: 2500,
  // Gloves hold their last pose this long during a short tracking loss.
  holdMs: 900,
  // Re-acquisition above this gap is eased instead of jumping.
  reacquireMs: 170,
  easeMs: 320,
  easeRate: 1.6,
  // Depth travel cap (m/s). Monocular scale noise cannot pump the glove.
  depthRate: 0.55,
};

// Absolute mapping away from a neutral pose, and neutral-relative mapping
// once a calibration exists. Depth is scale-relative in both cases.
export const DEPTH = { zBase: 0.10, zRef: 0.05, zGain: 2.6, deadband: 0.06, relGain: 0.85 };

export const PINCH = { close: 0.42, open: 0.62, closeDwellMs: 55, openDwellMs: 70 };

// Mean per-landmark presence for a MediaPipe hand, or null when the model
// does not report it. The Tasks Hand Landmarker (tasks-vision 0.10.x) fills
// every NormalizedLandmark's `visibility` with 0 and has no `presence`, so a
// literal average would reject every real detection; hand presence is
// already gated by minHandPresenceConfidence inside the landmarker.
export function landmarkPresence(points) {
  let sum = 0;
  let reported = false;
  for (const p of points) {
    const v = p.presence ?? p.visibility;
    if (Number.isFinite(v) && v > 0) reported = true;
    sum += Number.isFinite(v) ? v : 0;
  }
  return reported ? sum / points.length : null;
}

// Assign detections (image-space palms, possibly with a handedness label) to
// the left/right hand slots by previous-position continuity. MediaPipe may
// reorder the array, drop labels or flip labels when hands cross; a slot is
// only overridden when the label-consistent assignment costs more than the
// continuity assignment by more than swapMargin.
export function assignHands(dets, prev, opts = {}) {
  const cfg = { ...HAND_CONF, ...opts };
  const sides = ['left', 'right'];
  const combos = [];
  const walk = (index, acc) => {
    if (index >= dets.length) {
      combos.push({ ...acc });
      return;
    }
    for (const side of sides) {
      if (acc[side] === null) {
        acc[side] = index;
        walk(index + 1, acc);
        acc[side] = null;
      }
    }
    walk(index + 1, acc); // leave this detection unassigned
  };
  walk(0, { left: null, right: null });

  let best = null;
  let bestLabel = null;
  for (const combo of combos) {
    let cost = 0;
    let labels = 0;
    for (const side of sides) {
      const idx = combo[side];
      if (idx === null) {
        cost += cfg.farCost;
        continue;
      }
      const det = dets[idx];
      const last = prev ? prev[side] : null;
      cost += last ? Math.hypot(det.x - last.x, det.y - last.y) : cfg.farCost;
      if (det.label === side) labels += 1;
      else if (det.label) cost += cfg.labelPenalty;
    }
    const entry = { combo, cost, labels };
    if (!best || cost < best.cost - 1e-9) best = entry;
    if (!bestLabel || labels > bestLabel.labels || (labels === bestLabel.labels && cost < bestLabel.cost)) bestLabel = entry;
  }
  // Keep the label-consistent assignment only while it stays within swapMargin
  // of the continuity minimum; a label solution that costs more than that
  // (e.g. crossed hands with swapped labels) must not override continuity.
  const chosen = bestLabel && bestLabel.cost - best.cost <= cfg.swapMargin ? bestLabel : best;
  return { left: chosen.combo.left, right: chosen.combo.right };
}

function meanSample(samples) {
  let x = 0; let y = 0; let scale = 0;
  for (const s of samples) { x += s.x; y += s.y; scale += s.scale; }
  return { x: x / samples.length, y: y / samples.length, scale: scale / samples.length };
}

// Per-user neutral calibration. Feed both palms each camera frame; once a
// short steady two-hand pose is held the neutral palm position and palm scale
// are recorded per hand. Until then (and after reset/invalidate) the caller
// keeps its absolute safe-default mapping.
export function createNeutralCalibration(opts = {}) {
  const cfg = { ...HAND_CONF, ...opts };
  const neutral = { left: null, right: null };
  const samples = { left: [], right: [] };
  let steadyMs = 0;
  let last = { left: null, right: null };
  let ready = false;

  function clear() {
    steadyMs = 0;
    samples.left.length = 0;
    samples.right.length = 0;
  }

  return {
    get ready() { return ready; },
    get progress() { return clamp01(steadyMs / cfg.calibHoldMs); },
    neutral,
    sample(dtMs, frames) {
      const both = frames && frames.left && frames.right;
      if (!both || ready) {
        if (!both) clear();
        last = {
          left: frames && frames.left ? { ...frames.left } : null,
          right: frames && frames.right ? { ...frames.right } : null,
        };
        return { justCompleted: false };
      }
      const move = Math.max(
        last.left ? Math.hypot(frames.left.x - last.left.x, frames.left.y - last.left.y) : 0,
        last.right ? Math.hypot(frames.right.x - last.right.x, frames.right.y - last.right.y) : 0,
      );
      last = { left: { ...frames.left }, right: { ...frames.right } };
      if (move > cfg.calibMoveEps) {
        clear();
      } else {
        steadyMs += dtMs;
        samples.left.push({ x: frames.left.x, y: frames.left.y, scale: frames.left.scale });
        samples.right.push({ x: frames.right.x, y: frames.right.y, scale: frames.right.scale });
        if (samples.left.length > 300) { samples.left.shift(); samples.right.shift(); }
        if (steadyMs >= cfg.calibHoldMs && samples.left.length >= cfg.calibMinSamples) {
          neutral.left = meanSample(samples.left);
          neutral.right = meanSample(samples.right);
          ready = true;
          clear();
          return { justCompleted: true };
        }
      }
      return { justCompleted: false };
    },
    invalidate(side) {
      neutral[side] = null;
      ready = Boolean(neutral.left && neutral.right);
      clear();
    },
    reset() {
      neutral.left = null;
      neutral.right = null;
      ready = false;
      last = { left: null, right: null };
      clear();
    },
  };
}

// Palm-scale depth. Uncalibrated it falls back to the absolute mapping (safe
// default); calibrated it is relative to the neutral palm scale, ignoring
// deviations below the deadband so monocular scale noise cannot pump Z.
export function depthTarget(scale, neutral, cfg = DEPTH) {
  if (neutral && neutral.scale > 0) {
    let dev = scale / neutral.scale - 1;
    if (Math.abs(dev) < cfg.deadband) dev = 0;
    return neutral.anchorZ + dev * cfg.relGain;
  }
  return cfg.zBase + (scale - cfg.zRef) * cfg.zGain;
}

export function clampStep(prev, next, maxRate, dt) {
  const max = maxRate * Math.max(0, dt);
  return clamp(next, prev - max, prev + max);
}

export function clampVecStep(prev, next, maxRate, dt) {
  const max = maxRate * Math.max(0, dt);
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const dz = next.z - prev.z;
  const len = Math.hypot(dx, dy, dz);
  if (len <= max || len === 0) return { x: next.x, y: next.y, z: next.z };
  const k = max / len;
  return { x: prev.x + dx * k, y: prev.y + dy * k, z: prev.z + dz * k };
}

// Pinch latch: closing needs the ratio below `close` for closeDwellMs and
// opening needs it above `open` for openDwellMs, so a chattering ratio at the
// threshold cannot toggle the grip. `openness` gives the analog 0..1 value.
export function createPinchLatch(opts = {}) {
  const cfg = { ...PINCH, ...opts };
  let closed = false;
  let closeMs = 0;
  let openMs = 0;
  return {
    get closed() { return closed; },
    update(ratio, dtMs) {
      if (!closed) {
        closeMs = ratio < cfg.close ? closeMs + dtMs : 0;
        if (closeMs >= cfg.closeDwellMs) {
          closed = true;
          closeMs = 0;
          openMs = 0;
        }
      } else {
        openMs = ratio > cfg.open ? openMs + dtMs : 0;
        if (openMs >= cfg.openDwellMs) {
          closed = false;
          openMs = 0;
          closeMs = 0;
        }
      }
      return closed;
    },
    reset(value = false) {
      closed = Boolean(value);
      closeMs = 0;
      openMs = 0;
    },
    openness(ratio) {
      return clamp01(1 - (ratio - cfg.close) / (cfg.open - cfg.close));
    },
  };
}
