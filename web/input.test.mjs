import assert from 'node:assert/strict';
import { landmarkPose } from './src/input.js';
import { synthesizeHand } from './src/synth.js';

const base = {
  pos: { x: 0, y: 0.55, z: 0.45 },
  yaw: 0,
  pitch: 0,
  roll: 0,
  curls: [0.05, 0.05, 0.05, 0.05],
  thumb: 0.05,
  pinch: 0,
};

for (const side of ['left', 'right']) {
  const open = landmarkPose(synthesizeHand(side, base).points);
  const closed = landmarkPose(synthesizeHand(side, {
    ...base,
    curls: [0.85, 0.8, 0.75, 0.7],
    thumb: 0.75,
    pinch: 1,
  }).points);

  assert.equal(open.joints.length, 4);
  assert.ok(open.joints.every((chain) => chain.length === 3));
  assert.equal(open.thumbJoints.length, 3);
  assert.equal(open.spreads.length, 4);
  assert.ok(open.spreads.every(Number.isFinite));
  assert.ok(open.joints.flat().every((v) => v >= 0 && v <= 1), `${side} open finger joints normalized`);
  assert.ok(open.thumbJoints.every((v) => v >= 0 && v <= 1), `${side} open thumb joints normalized`);
  assert.ok(open.spreads.every((v) => v >= -0.45 && v <= 0.45), `${side} open spreads clamped`);
  assert.ok(closed.joints.flat().every((v) => v >= 0 && v <= 1), `${side} closed finger joints normalized`);
  assert.ok(closed.thumbJoints.every((v) => v >= 0 && v <= 1), `${side} closed thumb joints normalized`);
  assert.ok(closed.spreads.every((v) => v >= -0.45 && v <= 0.45), `${side} closed spreads clamped`);
  assert.ok(closed.curls[0] > open.curls[0], `${side} index must close`);
  assert.ok(closed.thumb > open.thumb, `${side} thumb must close`);
}

// Webcam-style upright hand, palm toward an un-mirrored camera. `thumbSide`
// +1 puts the thumb on image right, -1 on image left (the other hand).
// `lean` tilts the whole hand across vertical, `tilt` slopes the knuckles and
// `indexSplay` abducts the index toward the thumb (radians, image plane).
function uprightHand(thumbSide, { lean = 0, tilt = 0, indexSplay = 0 } = {}) {
  const aspect = 16 / 9;
  const put = (dx, dy) => {
    const x = dx * Math.cos(lean) - dy * Math.sin(lean);
    const y = dx * Math.sin(lean) + dy * Math.cos(lean);
    return { x: 0.5 + x / aspect, y: 0.75 + y + tilt * dx, z: 0 };
  };
  const points = [put(0, 0)];
  for (let i = 0; i < 4; i++) points.push(put(thumbSide * (0.04 + i * 0.02), -0.03 - i * 0.03));
  [0.03, 0.01, -0.01, -0.03].forEach((col, f) => {
    const splay = f === 0 ? indexSplay : 0;
    for (let k = 0; k < 4; k++) {
      const reach = k * 0.035;
      points.push(put(thumbSide * (col + Math.sin(splay) * reach), -0.10 - Math.cos(splay) * reach));
    }
  });
  return points;
}

// Yaw stays continuous when an upright hand leans across vertical.
{
  const left = landmarkPose(uprightHand(1, { lean: -0.02 })).yaw;
  const right = landmarkPose(uprightHand(1, { lean: 0.02 })).yaw;
  assert.ok(Math.abs(left - right) < 0.1, `yaw must not wrap across vertical (${left} vs ${right})`);
  assert.ok(Math.abs(left - Math.PI) < 0.2, 'upright hand points into the scene');
}

// Roll follows the knuckle slope with the same sign for both hands and does
// not saturate for either one.
for (const thumbSide of [1, -1]) {
  const flat = landmarkPose(uprightHand(thumbSide)).roll;
  const up = landmarkPose(uprightHand(thumbSide, { tilt: 0.2 })).roll;
  const down = landmarkPose(uprightHand(thumbSide, { tilt: -0.2 })).roll;
  assert.ok(Math.abs(flat) < 0.05, `thumb ${thumbSide}: level knuckles give neutral roll (${flat})`);
  assert.ok(Math.abs(up) < 0.6 && Math.abs(down) < 0.6, `thumb ${thumbSide}: roll must not saturate`);
  assert.ok(Math.sign(up) === -Math.sign(down) && Math.abs(up - down) > 0.1, `thumb ${thumbSide}: roll follows tilt`);
  assert.equal(Math.sign(up), Math.sign(landmarkPose(uprightHand(-thumbSide, { tilt: 0.2 })).roll), 'roll sign is handedness-independent');
}

// Index abduction toward the thumb reads positive for both hands; a curled
// finger contributes no spread noise.
for (const thumbSide of [1, -1]) {
  const neutral = landmarkPose(uprightHand(thumbSide)).spreads;
  const splayed = landmarkPose(uprightHand(thumbSide, { indexSplay: 0.3 })).spreads;
  assert.ok(Math.abs(neutral[1]) < 1e-6, 'middle finger is the spread reference');
  assert.ok(splayed[0] - neutral[0] > 0.2, `thumb ${thumbSide}: radial index splay is positive`);
}
{
  // Index proximal phalanx pointing out of the palm plane, with sideways
  // jitter that would read as a large splay if taken at face value.
  const flexed = (jitter) => {
    const points = uprightHand(1);
    points[6] = { x: points[5].x + jitter, y: points[5].y, z: -0.04 };
    return landmarkPose(points).spreads[0];
  };
  assert.ok(Math.abs(flexed(0.004) - flexed(-0.004)) < 1e-6, 'flexed finger spread ignores in-plane noise');
  assert.ok(flexed(0.004) > 0 && flexed(0.004) < 0.3, 'flexed finger falls back to a relaxed splay');
}

console.log('input.test.mjs: anatomical landmark mapping assertions passed');
