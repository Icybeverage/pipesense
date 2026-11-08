// Hand-tracking fidelity helper test: node handtrack.test.mjs
import assert from 'node:assert/strict';
import {
  DEPTH, HAND_CONF, PINCH, assignHands, clampStep, clampVecStep,
  createNeutralCalibration, createPinchLatch, depthTarget,
} from './src/handtrack.js';

const near = (actual, expected, eps = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
};

// 1. Slot assignment follows previous palm positions when hands cross, even
// though MediaPipe reordered the array and flipped both labels.
{
  const prev = { left: { x: 0.25, y: 0.5 }, right: { x: 0.75, y: 0.5 } };
  const dets = [
    { x: 0.25, y: 0.5, label: 'right' },
    { x: 0.75, y: 0.5, label: 'left' },
  ];
  const assigned = assignHands(dets, prev);
  assert.equal(assigned.left, 0);
  assert.equal(assigned.right, 1);
}

// 2. Handedness is the fallback when there is no usable previous palm.
{
  const dets = [
    { x: 0.8, y: 0.5, label: 'left' },
    { x: 0.2, y: 0.5, label: 'right' },
  ];
  const assigned = assignHands(dets, { left: null, right: null });
  assert.equal(assigned.left, 0);
  assert.equal(assigned.right, 1);
}

// 3. A single unlabelled detection goes to its nearest previous slot.
{
  const prev = { left: { x: 0.2, y: 0.5 }, right: { x: 0.8, y: 0.5 } };
  const assigned = assignHands([{ x: 0.75, y: 0.5 }], prev);
  assert.equal(assigned.right, 0);
  assert.equal(assigned.left, null);
}

// 4. No detections leaves both slots empty.
{
  const assigned = assignHands([], { left: { x: 0.2, y: 0.5 }, right: { x: 0.8, y: 0.5 } });
  assert.equal(assigned.left, null);
  assert.equal(assigned.right, null);
}

// 5. Uncalibrated depth: absolute palm-scale mapping.
{
  near(depthTarget(0.05, null), DEPTH.zBase);
  near(depthTarget(0.02, null), DEPTH.zBase + (0.02 - DEPTH.zRef) * DEPTH.zGain);
}

// 6. Calibrated depth is neutral-relative with a deadband around neutral scale.
{
  const neutral = { scale: 0.05, anchorZ: 0.45 };
  near(depthTarget(0.051, neutral), 0.45); // +2% scale is inside the deadband
  near(depthTarget(0.045, neutral), 0.45 - 0.1 * DEPTH.relGain); // -10% scale
  near(depthTarget(0.06, neutral), 0.45 + 0.2 * DEPTH.relGain); // +20% scale
}

// 7. Per-frame depth clamp: Z cannot move faster than depthRate, and a long
// frame may reach the target in one step.
{
  const dt = 1 / 60;
  const step = HAND_CONF.depthRate * dt;
  near(clampStep(0.5, 0.9, HAND_CONF.depthRate, dt), 0.5 + step);
  near(clampStep(0.5, 0.1, HAND_CONF.depthRate, dt), 0.5 - step);
  near(clampStep(0.5, 0.5 + step / 2, HAND_CONF.depthRate, dt), 0.5 + step / 2);
  near(clampStep(0.5, 0.9, HAND_CONF.depthRate, 0), 0.5);
  near(clampStep(0.5, 0.9, HAND_CONF.depthRate, 10), 0.9);
}

// 8. Vector re-acquisition ease clamps length while preserving direction.
{
  const out = clampVecStep({ x: 0, y: 0, z: 0 }, { x: 1, y: 0.5, z: 0.25 }, 0.55, 1);
  near(Math.hypot(out.x, out.y, out.z), 0.55, 1e-12);
  near(out.y / out.x, 0.5, 1e-12);
  const inside = clampVecStep({ x: 1, y: 1, z: 1 }, { x: 1.01, y: 1, z: 1 }, 0.55, 1);
  assert.deepEqual(inside, { x: 1.01, y: 1, z: 1 });
}

// 9. Pinch close needs the close threshold held for the close dwell; opening
// needs the higher open threshold for its own dwell; the band in between never
// toggles either way.
{
  const latch = createPinchLatch();
  assert.equal(latch.update(PINCH.close - 0.05, PINCH.closeDwellMs - 5), false);
  assert.equal(latch.update(PINCH.close - 0.05, 10), true);
  assert.equal(latch.update(0.5, 5000), true); // inside the band, stays closed
  assert.equal(latch.update(PINCH.open + 0.05, PINCH.openDwellMs - 5), true);
  assert.equal(latch.update(PINCH.open + 0.05, 10), false);
  assert.equal(latch.update(0.5, 5000), false); // inside the band, stays open
}

// 10. A brief dip below the close threshold cannot toggle the latch.
{
  const latch = createPinchLatch();
  assert.equal(latch.update(0.3, PINCH.closeDwellMs - 15), false);
  assert.equal(latch.update(0.7, 200), false);
}

// 11. Analog openness maps close..open to 1..0 and clamps outside.
{
  const latch = createPinchLatch();
  assert.equal(latch.openness(PINCH.close), 1);
  near(latch.openness((PINCH.close + PINCH.open) / 2), 0.5);
  assert.equal(latch.openness(PINCH.open), 0);
  assert.equal(latch.openness(0.1), 1);
  assert.equal(latch.openness(0.9), 0);
  latch.reset(true);
  assert.equal(latch.closed, true);
  latch.reset();
  assert.equal(latch.closed, false);
}

// 12. Neutral calibration completes once on a steady two-hand pose and records
// the mean palm position and scale.
{
  const calib = createNeutralCalibration();
  let completed = 0;
  for (let i = 0; i < 60; i++) {
    const out = calib.sample(20, {
      left: { x: 0.3, y: 0.5, scale: 0.05 },
      right: { x: 0.7, y: 0.5, scale: 0.05 },
    });
    if (out.justCompleted) completed += 1;
  }
  assert.equal(completed, 1);
  assert.equal(calib.ready, true);
  near(calib.neutral.left.x, 0.3);
  near(calib.neutral.left.y, 0.5);
  near(calib.neutral.right.x, 0.7);
  near(calib.neutral.right.scale, 0.05);
}

// 13. Moving a hand restarts the steady window; nothing completes early.
{
  const calib = createNeutralCalibration();
  for (let i = 0; i < 30; i++) {
    calib.sample(20, {
      left: { x: 0.3, y: 0.5, scale: 0.05 },
      right: { x: 0.7, y: 0.5, scale: 0.05 },
    });
  }
  assert.ok(calib.progress > 0.4 && calib.progress < 1);
  calib.sample(20, {
    left: { x: 0.4, y: 0.5, scale: 0.05 },
    right: { x: 0.7, y: 0.5, scale: 0.05 },
  });
  near(calib.progress, 0);
  assert.equal(calib.ready, false);
}

// 14. A single visible hand never calibrates.
{
  const calib = createNeutralCalibration();
  for (let i = 0; i < 80; i++) {
    calib.sample(20, { left: { x: 0.3, y: 0.5, scale: 0.05 }, right: null });
  }
  assert.equal(calib.ready, false);
  near(calib.progress, 0);
}

// 15. Invalidating one hand drops its neutral only; reset clears everything.
{
  const calib = createNeutralCalibration();
  let done = false;
  for (let i = 0; i < 60 && !done; i++) {
    done = calib.sample(20, {
      left: { x: 0.3, y: 0.5, scale: 0.05 },
      right: { x: 0.7, y: 0.5, scale: 0.05 },
    }).justCompleted;
  }
  assert.equal(calib.ready, true);
  calib.invalidate('left');
  assert.equal(calib.ready, false);
  assert.equal(calib.neutral.left, null);
  near(calib.neutral.right.x, 0.7);
  calib.reset();
  assert.equal(calib.neutral.right, null);
  assert.equal(calib.ready, false);
}

console.log('handtrack.test.mjs: all assertions passed');
