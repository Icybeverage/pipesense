// Deterministic core test: node sim.test.mjs
import assert from 'node:assert/strict';
import { createSim, grab, release, moveCarried, rotate, advance, evaluate, GEOM, TUNE, holdsWater } from './src/sim.js';

function run(s, seconds, dt = 1 / 60) {
  let out = [];
  for (let t = 0; t < seconds; t += dt) out = out.concat(advance(s, dt));
  return out;
}

function closeValve(s, hand = 'left') {
  grab(s, 'valve_lever', hand);
  rotate(s, 'valve_lever', -1.6, hand);
  release(s, 'valve_lever', hand);
}

function takeWrench(s, hand = 'right') {
  grab(s, 'wrench', hand);
}

function seatTrap(s, hand = 'left', pos = GEOM.seatPose) {
  grab(s, 'trap', hand);
  moveCarried(s, 'trap', pos);
  return release(s, 'trap', hand);
}

function turnFaucetOn(s, hand = 'right') {
  grab(s, 'faucet_handle', hand);
  rotate(s, 'faucet_handle', 1.0, hand);
  release(s, 'faucet_handle', hand);
}

// 1. Full correct sequence reaches 100 and complete.
{
  const s = createSim();
  closeValve(s);
  const seated = seatTrap(s);
  assert.equal(seated[0].type, 'seated');
  takeWrench(s, 'right');
  rotate(s, 'nut_tail', 1.6, 'right');
  rotate(s, 'nut_wall', 1.6, 'right');
  assert.ok(s.joints.tail.tight >= TUNE.tightFull && s.joints.wall.tight >= TUNE.tightFull);
  turnFaucetOn(s);
  run(s, 4);
  const result = evaluate(s);
  assert.equal(s.phase, 'complete');
  assert.equal(result.score, 100);
  assert.equal(result.primary_issue, 'none');
  assert.equal(result.detail, 'complete');
  assert.ok(holdsWater(s));
  assert.ok(s.gas.blocked);
}

// 2. Identical action stream yields identical score (determinism).
{
  const build = () => {
    const s = createSim();
    closeValve(s);
    seatTrap(s);
    takeWrench(s, 'right');
    rotate(s, 'nut_tail', 1.6, 'right');
    turnFaucetOn(s);
    run(s, 3);
    return evaluate(s);
  };
  const a = build();
  const b = build();
  assert.deepEqual(a, b);
}

// 3. Running water first: sequence issue, spill, no hold.
{
  const s = createSim();
  turnFaucetOn(s);
  run(s, 2);
  const result = evaluate(s);
  assert.equal(result.primary_issue, 'sequence');
  assert.ok(s.water.spilled > 0.3);
  assert.ok(!holdsWater(s));
  assert.ok(result.score < 40);
}

// 4. Trap released too low: height_alignment, trap returns to shelf.
{
  const s = createSim();
  closeValve(s);
  const low = { x: 0, y: 0.30, z: 0.30 };
  const dropped = seatTrap(s, 'left', low);
  assert.equal(dropped[0].type, 'dropped');
  assert.equal(dropped[0].axis, 'height');
  const result = evaluate(s);
  assert.equal(result.primary_issue, 'height_alignment');
  assert.equal(result.detail, 'seat_height');
  assert.equal(s.objects.trap.mode, 'shelf');
}

// 5. Trap released beside the mounts: connection_gap.
{
  const s = createSim();
  closeValve(s);
  const aside = { x: 0.10, y: 0.425, z: 0.30 };
  const dropped = seatTrap(s, 'left', aside);
  assert.equal(dropped[0].type, 'dropped');
  assert.equal(dropped[0].axis, 'gap');
  assert.equal(evaluate(s).primary_issue, 'connection_gap');
}

// 6. Tightening without the wrench in hand is rejected; unseated joints too.
{
  const s = createSim();
  rotate(s, 'nut_tail', 1.0, 'right');
  assert.equal(s.joints.tail.tight, 0);
  assert.equal(s.violations.wrongTarget, 1);
  grab(s, 'wrench', 'right');
  rotate(s, 'nut_tail', 1.0, 'right');
  assert.equal(s.joints.tail.tight, 0);
  assert.equal(s.violations.tightenUnseated, 1);
}

// 7. Seated but only hand-tight nuts: loose_joint, water seeps, no hold.
{
  const s = createSim();
  closeValve(s);
  seatTrap(s);
  takeWrench(s, 'right');
  rotate(s, 'nut_tail', 1.6, 'right');
  rotate(s, 'nut_wall', 0.4, 'right');
  turnFaucetOn(s);
  run(s, 3);
  const result = evaluate(s);
  assert.equal(result.primary_issue, 'connection_gap');
  assert.ok(result.detail === 'loose_joint' || result.detail === 'loose_leak');
  assert.ok(!holdsWater(s));
  assert.ok(s.water.leak > 0);
  assert.ok(result.score > 40 && result.score < 100);
}

// 8. Valve still open while tightening: sequence violation surfaces.
{
  const s = createSim();
  seatTrap(s);
  takeWrench(s, 'right');
  rotate(s, 'nut_tail', 0.2, 'right');
  const result = evaluate(s);
  assert.equal(result.primary_issue, 'sequence');
  assert.equal(result.detail, 'valve_open');
}

// 9. Recovering after an early spill still allows completion.
{
  const s = createSim();
  turnFaucetOn(s);
  run(s, 1.5);
  grab(s, 'faucet_handle', 'right');
  // Turn the faucet back off through the same interaction API.
  s.faucet.angle = 10;
  s.faucet.on = false;
  release(s, 'faucet_handle', 'right');
  closeValve(s);
  seatTrap(s);
  takeWrench(s, 'right');
  rotate(s, 'nut_tail', 1.6, 'right');
  rotate(s, 'nut_wall', 1.6, 'right');
  turnFaucetOn(s);
  run(s, 8);
  const result = evaluate(s);
  assert.ok(s.water.spilled > 0.05, 'spill evidence retained');
  assert.ok(result.score >= 84, `expected near-complete score, got ${result.score}`);
  assert.equal(result.primary_issue, 'none');
}

// 10. Valve wrong-direction turn emits explicit corrective event.
{
  const s = createSim();
  grab(s, 'valve_lever', 'left');
  const events = rotate(s, 'valve_lever', 0.25, 'left');
  assert.equal(events[0].type, 'valve_wrong_direction');
  assert.equal(events[0].expected, 'clockwise');
}

console.log('sim.test.mjs: all assertions passed');
