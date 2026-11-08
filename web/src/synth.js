// PipeSense synthetic hand pose for Guided practice.
//
// Guided practice has no camera. The validated full-lesson macro still drives
// the same hand target pose the gloves.js rig renders and interaction.js
// resolves collisions against, so sim correctness can only change through the
// normal glove path. This module forward-renders that pose as a MediaPipe-style
// 21-landmark hand so the integrated landmark preview shows articulated fingers
// and real depth (Z) while the simulated hands move in front of and behind the
// pipes.
//
// Pure math only: no DOM and no Three.js, so node tests can exercise it. The
// local hand frame and the world->image mapping mirror gloves.js and input.js.

const SYNTH = {
  // Mirrors IMG in input.js: world X is mirrored from image X.
  xScale: 1.4,
  yTop: 1.42,
  yScale: 1.35,
  // Mid-workspace depth. Points nearer the viewer than this get negative Z,
  // matching MediaPipe's "negative is closer to the camera" convention.
  refZ: 0.45,
  depthScale: 1.6,
};

export const SYNTHETIC_INPUT_MODE = 'synthetic_practice';

export function isSyntheticPractice(mode) {
  return mode === SYNTHETIC_INPUT_MODE;
}

// Local frame matches gloves.js: fingers extend along +Z, the palm normal is
// -Y, and the thumb sits on +X for the right hand and -X for the left.
// curlMax mirrors the per-joint limits the glove rig applies.
const PALM_FRONT = 0.108;
const FINGER_BASE_Y = 0.002;
const FINGERS = [
  { x: 0.031, dz: 0.000, lens: [0.043, 0.029, 0.021], curlMax: [1.35, 1.5, 0.8] },
  { x: 0.010, dz: 0.005, lens: [0.047, 0.032, 0.022], curlMax: [1.3, 1.5, 0.8] },
  { x: -0.011, dz: 0.001, lens: [0.043, 0.029, 0.021], curlMax: [1.3, 1.5, 0.85] },
  { x: -0.033, dz: -0.008, lens: [0.035, 0.024, 0.018], curlMax: [1.25, 1.45, 0.9] },
];
const THUMB_BASE = { x: 0.040, y: -0.010, z: 0.038 };
const THUMB_LENS = [0.036, 0.027, 0.020];

// MediaPipe landmark order: wrist, thumb (CMC..TIP), then index..pinky.
const LANDMARK_COUNT = 21;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);

// A finger chain bends toward the palm normal (-Y) as its curl rises, exactly
// like the glove's per-bone rotation.x = curl * curlMax.
function fingerChain(side, spec, baseX, curl) {
  const x = baseX * (side === 'right' ? 1 : -1);
  const points = [];
  let y = FINGER_BASE_Y;
  let z = PALM_FRONT + spec.dz;
  points.push({ x, y, z });
  let angle = 0;
  for (let i = 0; i < spec.lens.length; i++) {
    angle += clamp01(curl) * spec.curlMax[i];
    y -= Math.sin(angle) * spec.lens[i];
    z += Math.cos(angle) * spec.lens[i];
    points.push({ x, y, z });
  }
  return points;
}

function thumbChain(side, curl) {
  const s = side === 'right' ? 1 : -1;
  const yaw = 0.9 * s;
  const points = [];
  let x = THUMB_BASE.x * s;
  let y = THUMB_BASE.y;
  let z = THUMB_BASE.z;
  points.push({ x, y, z });
  let angle = 0;
  for (let i = 0; i < THUMB_LENS.length; i++) {
    angle += clamp01(curl) * (1.15 - i * 0.15);
    const cosA = Math.cos(angle);
    x += Math.sin(yaw) * cosA * THUMB_LENS[i];
    y += -Math.sin(angle) * THUMB_LENS[i];
    z += Math.cos(yaw) * cosA * THUMB_LENS[i];
    points.push({ x, y, z });
  }
  return points;
}

// Gloves.js applies root rotation with Euler order 'YXZ' (R = Ry * Rx * Rz).
function rotateYXZ(point, pitch, yaw, roll) {
  const cx = Math.cos(pitch); const sx = Math.sin(pitch);
  const cy = Math.cos(yaw); const sy = Math.sin(yaw);
  const cz = Math.cos(roll); const sz = Math.sin(roll);
  const x1 = point.x * cz - point.y * sz;
  const y1 = point.x * sz + point.y * cz;
  const z1 = point.z;
  const x2 = x1;
  const y2 = y1 * cx - z1 * sx;
  const z2 = y1 * sx + z1 * cx;
  return {
    x: x2 * cy + z2 * sy,
    y: y2,
    z: -x2 * sy + z2 * cy,
  };
}

function project(world) {
  return {
    x: 0.5 - world.x / SYNTH.xScale,
    y: (SYNTH.yTop - world.y) / SYNTH.yScale,
    // Absolute depth cue, not wrist-relative, so moving a hand toward or away
    // from the pipes visibly changes every landmark's Z.
    z: (SYNTH.refZ - world.z) * SYNTH.depthScale,
  };
}

// Forward-render one hand's pose as 21 landmarks in image space (x/y) with a
// signed depth (z, negative = nearer the viewer).
export function synthesizeHand(side, pose = {}) {
  const pos = pose.pos || { x: 0, y: 0, z: SYNTH.refZ };
  const yaw = finite(pose.yaw, 0);
  const pitch = finite(pose.pitch, 0);
  const roll = finite(pose.roll, 0);
  const curls = Array.isArray(pose.curls) ? pose.curls : [0, 0, 0, 0];
  const thumb = clamp01(finite(pose.thumb, 0));

  const wrist = { x: 0, y: 0, z: 0 };
  const local = [wrist, ...thumbChain(side, thumb)];
  FINGERS.forEach((spec, i) => {
    local.push(...fingerChain(side, spec, spec.x, curls[i] ?? 0));
  });

  const points = [];
  let zSum = 0;
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const rotated = rotateYXZ(local[i], pitch, yaw, roll);
    const world = {
      x: pos.x + rotated.x,
      y: pos.y + rotated.y,
      z: pos.z + rotated.z,
    };
    const point = project(world);
    zSum += point.z;
    points.push(point);
  }

  // Palm scale stays consistent with the camera path so downstream consumers
  // can read the same shape; it is not used to score anything.
  const span = Math.hypot((points[9].x - points[0].x) * (16 / 9), points[9].y - points[0].y);
  return {
    points,
    side,
    wristZ: points[0].z,
    meanZ: zSum / LANDMARK_COUNT,
    scale: Math.max(span, 1e-4),
    synthetic: true,
  };
}

export { LANDMARK_COUNT, SYNTH };
