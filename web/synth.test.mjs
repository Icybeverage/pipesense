import assert from 'node:assert/strict';
import { LANDMARK_COUNT, SYNTHETIC_INPUT_MODE, isSyntheticPractice, synthesizeHand } from './src/synth.js';

const open = synthesizeHand('left', {
  pos: { x: -0.2, y: 0.6, z: 0.45 }, yaw: 0, pitch: 0, roll: 0,
  curls: [0, 0, 0, 0], thumb: 0,
});
assert.equal(open.points.length, LANDMARK_COUNT);
assert.equal(LANDMARK_COUNT, 21);
assert.ok(open.points.every((point) => [point.x, point.y, point.z].every(Number.isFinite)));

const curled = synthesizeHand('left', {
  pos: { x: -0.2, y: 0.6, z: 0.45 }, yaw: 0, pitch: 0, roll: 0,
  curls: [1, 1, 1, 1], thumb: 1,
});
assert.ok(Math.abs(curled.points[8].y - open.points[8].y) > 0.015, 'index tip articulates');
assert.ok(Math.abs(curled.points[20].y - open.points[20].y) > 0.015, 'pinky tip articulates');

// The first-person camera sits at positive world Z and looks toward the rig,
// so greater world Z is nearer the viewer. MediaPipe encodes nearer as negative.
const farther = synthesizeHand('right', { pos: { x: 0.2, y: 0.6, z: 0.25 } });
const nearer = synthesizeHand('right', { pos: { x: 0.2, y: 0.6, z: 0.65 } });
assert.ok(nearer.meanZ < farther.meanZ, 'nearer landmarks have more-negative signed Z');
assert.ok(Math.abs(farther.meanZ - nearer.meanZ) > 0.5, 'depth separation is visible');
assert.equal(SYNTHETIC_INPUT_MODE, 'synthetic_practice');
assert.equal(isSyntheticPractice(SYNTHETIC_INPUT_MODE), true);
assert.equal(isSyntheticPractice('camera'), false);

console.log('synth.test.mjs: all assertions passed');
