// Regression test for the real-camera detection gate: node web/e2e/presence.test.mjs
// MediaPipe Tasks Hand Landmarker (tasks-vision 0.10.14) returns every
// landmark with visibility 0 and no presence; averaging that literally
// rejected 100% of real detections, so the gloves never followed the camera.
import assert from 'node:assert/strict';
import { landmarkPresence } from '../src/handtrack.js';

const hand = (extra) => Array.from({ length: 21 }, (_, i) => ({ x: i / 21, y: 0.5, z: 0, ...extra }));

assert.equal(landmarkPresence(hand({ visibility: 0 })), null, 'tasks-vision shape: no presence reported');
assert.equal(landmarkPresence(hand({})), null, 'no fields: no presence reported');
assert.ok(Math.abs(landmarkPresence(hand({ presence: 0.9 })) - 0.9) < 1e-9);
assert.ok(landmarkPresence(hand({ presence: 0.1 })) < 0.4, 'a real low presence still gates');
console.log('presence.test.mjs: all assertions passed');
