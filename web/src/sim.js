// PipeSense deterministic simulation core.
//
// Pure logic: no DOM, no Three.js, no network. Everything here is a function
// of the action stream and elapsed time, so the same trajectory always yields
// the same score and primary_issue. The model decides correctness; the voice
// layer only explains it.
//
// Backend contract (backend/app.py AttemptRequest): primary_issue must be one
// of "sequence" | "height_alignment" | "connection_gap" | "none". Richer
// detail codes travel only in the judge view.

export const ISSUES = ['sequence', 'height_alignment', 'connection_gap', 'none'];

export const GEOM = {
  tail: { x: 0, z: 0.30, endY: 0.905, r: 0.021, hubR: 0.027 },
  wall: { y: 0.66, endZ: 0.20, r: 0.021, hubR: 0.027 },
  seat: { tailTopY: 0.930, wallOpenZ: 0.130 },
  // Trap local body offsets from its root: hub top above root, outlet hub
  // height and its opening plane (facing the wall stub).
  trapLocal: { tailHubTop: 0.505, wallHubY: 0.235, wallOpenZ: 0.17 },
  seatPose: { x: 0, y: 0.425, z: 0.30 },
  shelf: { y: 0.40 },
  // Resting on the shelf puts the trap ~6 cm below the seated height, so the
  // learner must lift it while aligning both sockets.
  trapRest: { x: 0.30, y: 0.366, z: 0.50 },
  valve: { pos: { x: -0.42, y: 0.84, z: 0.12 }, closedAngle: -80, closedLatch: -55, reopenLatch: -35 },
  faucet: { pos: { x: 0.34, y: 1.185, z: 0.20 }, onAngle: 52, offAngle: 28, maxAngle: 60 },
  workspace: { minX: -0.55, maxX: 0.55, minY: 0.24, maxY: 1.26, minZ: 0.14, maxZ: 0.66 },
};

export const TUNE = {
  seatLateral: 0.012,
  engageMin: 0.012,
  snapLateral: 0.032,
  snapEngage: -0.022,
  tightFull: 0.75,
  tightSeep: 0.4,
  tightPerRad: 0.55,
  fillRate: 0.75,
  leakFast: 0.55,
  leakSlow: 0.16,
  flowRamp: 1 / 1.2,
};

export const WEIGHTS = { valve: 12, tailSeat: 14, wallSeat: 14, tailNut: 15, wallNut: 15, retain: 30 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);

export function createSim() {
  return {
    time: 0,
    phase: 'active',
    objects: {
      trap: { mode: 'shelf', heldBy: null, pos: { ...GEOM.trapRest } },
      wrench: { mode: 'shelf', heldBy: null },
    },
    valve: { angle: 0, closed: false, heldBy: null },
    faucet: { angle: 0, on: false, heldBy: null, flow: 0 },
    joints: {
      tail: { engaged: 0, tight: 0, clicks: 0 },
      wall: { engaged: 0, tight: 0, clicks: 0 },
    },
    water: { running: false, filled: 0, leak: 0, spilled: 0, puddle: 0 },
    gas: { escaping: 0, blocked: false },
    violations: { valveOpenDuringWork: false, tightenUnseated: 0, waterBeforeReady: false, wrongTarget: 0 },
    lastSeat: null,
    // Coach intervention scaffold: strategy "change_modality_kinesthetic"
    // widens the seating snap window for the next attempt. Purely state-based,
    // so scores stay deterministic; the judge view reports the assist level.
    assist: { snapScale: 1, mode: 'none' },
    traction: { events: 0 },
  };
}

export function resetSim(state, assist = { snapScale: 1, mode: 'none' }) {
  const fresh = createSim();
  // A chosen intervention can persist across the reset (retry loop), so the
  // fresh assist scaffold is applied before the state is overwritten.
  fresh.assist = { ...assist };
  for (const key of Object.keys(state)) {
    if (!(key in fresh)) delete state[key];
  }
  Object.assign(state, fresh);
  return state;
}

function jointEngage(state, joint) {
  const trap = state.objects.trap;
  const L = GEOM.trapLocal;
  if (trap.mode !== 'seated' && trap.mode !== 'held') return { engage: 0, lateral: 0, dx: 0, dy: 0 };
  if (joint === 'tail') {
    const dx = trap.pos.x - GEOM.tail.x;
    const dz = trap.pos.z - GEOM.tail.z;
    const lateral = Math.hypot(dx, dz);
    const hubTopY = trap.pos.y + L.tailHubTop;
    return { engage: hubTopY - GEOM.tail.endY, lateral, dx: dz, dy: 0 };
  }
  const dx = trap.pos.x - 0;
  const dy = trap.pos.y + L.wallHubY - GEOM.wall.y;
  const lateral = Math.hypot(dx, dy);
  const hubOpenZ = trap.pos.z - L.wallOpenZ;
  return { engage: GEOM.wall.endZ - hubOpenZ, lateral, dx: 0, dy };
}

function effectivePlacement(state) {
  const trap = state.objects.trap;
  if (trap.mode === 'seated') {
    const tail = GEOM.seat.tailTopY - GEOM.tail.endY;
    const wall = GEOM.wall.endZ - GEOM.seat.wallOpenZ;
    const z = { tail: { engage: tail, lateral: 0, dx: 0, dy: 0 }, wall: { engage: wall, lateral: 0, dx: 0, dy: 0 } };
    return z;
  }
  const held = trap.mode === 'held';
  if (!held) return { tail: { engage: -0.06, lateral: 0.3, dx: 0, dy: 0 }, wall: { engage: -0.06, lateral: 0.3, dx: 0, dy: 0 } };
  return { tail: jointEngage(state, 'tail'), wall: jointEngage(state, 'wall') };
}

function tallyViolation(state, key) {
  state.violations[key] += 1;
}

export function grab(state, id, hand) {
  const events = [];
  state.traction.events += 1;
  if (id === 'trap') {
    if (state.objects.trap.mode === 'shelf') {
      state.objects.trap.mode = 'held';
      state.objects.trap.heldBy = hand;
      events.push({ type: 'grab', id, hand });
    } else {
      tallyViolation(state, 'wrongTarget');
      events.push({ type: 'reject', id, hand, reason: 'trap_not_free' });
    }
  } else if (id === 'wrench') {
    if (state.objects.wrench.mode === 'shelf') {
      state.objects.wrench.mode = 'held';
      state.objects.wrench.heldBy = hand;
      events.push({ type: 'grab', id, hand });
    } else {
      tallyViolation(state, 'wrongTarget');
      events.push({ type: 'reject', id, hand, reason: 'wrench_not_free' });
    }
  } else if (id === 'valve_lever') {
    if (!state.valve.heldBy) {
      state.valve.heldBy = hand;
      events.push({ type: 'grab', id, hand });
    }
  } else if (id === 'faucet_handle') {
    if (!state.faucet.heldBy) {
      state.faucet.heldBy = hand;
      events.push({ type: 'grab', id, hand });
    }
  }
  return events;
}

export function release(state, id, hand) {
  const events = [];
  state.traction.events += 1;
  if (id === 'trap') {
    const trap = state.objects.trap;
    if (trap.mode !== 'held' || trap.heldBy !== hand) return events;
    const { tail, wall } = effectivePlacement(state);
    const seated = tail.engage >= TUNE.engageMin && tail.lateral <= TUNE.seatLateral
      && wall.engage >= TUNE.engageMin && wall.lateral <= TUNE.seatLateral;
    const snap = state.assist.snapScale;
    const snapLat = TUNE.snapLateral * snap;
    const snapEng = TUNE.snapEngage * snap;
    const canSnap = tail.engage >= snapEng && tail.lateral <= snapLat
      && wall.engage >= snapEng && wall.lateral <= snapLat;
    if (seated || canSnap) {
      trap.mode = 'seated';
      trap.heldBy = null;
      trap.pos = { ...GEOM.seatPose };
      state.joints.tail.engaged = 1;
      state.joints.wall.engaged = 1;
      state.lastSeat = { kind: 'seated', tail, wall };
      events.push({ type: 'seated', tail, wall });
    } else {
      const vertical = Math.max(Math.abs(tail.engage), Math.abs(wall.engage), Math.abs(tail.dx), Math.abs(wall.dy));
      const lateral = Math.max(Math.abs(tail.lateral), Math.abs(wall.lateral));
      const axis = vertical >= lateral ? 'height' : 'gap';
      trap.mode = 'shelf';
      trap.heldBy = null;
      trap.pos = { ...GEOM.trapRest };
      state.lastSeat = { kind: 'dropped', axis, tail, wall };
      events.push({ type: 'dropped', axis, tail, wall });
    }
  } else if (id === 'wrench') {
    if (state.objects.wrench.mode === 'held' && state.objects.wrench.heldBy === hand) {
      state.objects.wrench.mode = 'shelf';
      state.objects.wrench.heldBy = null;
      events.push({ type: 'released', id, hand });
    }
  } else if (id === 'valve_lever') {
    if (state.valve.heldBy === hand) {
      state.valve.heldBy = null;
      events.push({ type: 'released', id, hand });
    }
  } else if (id === 'faucet_handle') {
    if (state.faucet.heldBy === hand) {
      state.faucet.heldBy = null;
      events.push({ type: 'released', id, hand });
    }
  }
  return events;
}

export function moveCarried(state, id, pos) {
  if (id === 'trap' && state.objects.trap.mode === 'held') {
    state.objects.trap.pos.x = pos.x;
    state.objects.trap.pos.y = pos.y;
    state.objects.trap.pos.z = pos.z;
  }
}

export function rotate(state, id, delta, hand) {
  const events = [];
  if (!Number.isFinite(delta) || delta === 0) return events;
  if (id === 'valve_lever') {
    if (state.valve.heldBy !== hand) return events;
    const { closedAngle, closedLatch, reopenLatch } = GEOM.valve;
    const before = state.valve.closed;
    if (!before && delta > 0.015) {
      events.push({ type: 'valve_wrong_direction', expected: 'clockwise', direction: 'counterclockwise' });
    }
    // Lever travel is one-directional toward the closed stop.
    state.valve.angle = clamp(state.valve.angle + delta * 57.2958, closedAngle, 0);
    if (!before && state.valve.angle <= closedLatch) {
      state.valve.closed = true;
      state.violations.valveOpenDuringWork = false;
      events.push({ type: 'valve_closed' });
    } else if (before && state.valve.angle >= reopenLatch) {
      state.valve.closed = false;
      state.valve.angle = 0;
      events.push({ type: 'valve_opened' });
    }
    return events;
  }
  if (id === 'faucet_handle') {
    if (state.faucet.heldBy !== hand) return events;
    const { onAngle, offAngle, maxAngle } = GEOM.faucet;
    const before = state.faucet.on;
    state.faucet.angle = clamp(state.faucet.angle + delta * 57.2958, 0, maxAngle);
    if (!before && state.faucet.angle >= onAngle) {
      state.faucet.on = true;
      events.push({ type: 'water_on' });
    } else if (before && state.faucet.angle <= offAngle) {
      state.faucet.on = false;
      events.push({ type: 'water_off' });
    }
    return events;
  }
  if (id === 'nut_tail' || id === 'nut_wall') {
    const joint = id === 'nut_tail' ? 'tail' : 'wall';
    const wrenchHeld = state.objects.wrench.mode === 'held' && state.objects.wrench.heldBy === hand;
    if (!wrenchHeld) {
      tallyViolation(state, 'wrongTarget');
      events.push({ type: 'reject', id, hand, reason: 'no_wrench' });
      return events;
    }
    const j = state.joints[joint];
    if (j.engaged < 1) {
      tallyViolation(state, 'tightenUnseated');
      events.push({ type: 'reject', id, hand, reason: 'joint_unseated' });
      return events;
    }
    if (!state.valve.closed) state.violations.valveOpenDuringWork = true;
    const before = j.tight;
    j.tight = clamp01(j.tight + Math.abs(delta) * TUNE.tightPerRad);
    if (Math.floor(j.tight / 0.25) > Math.floor(before / 0.25)) {
      j.clicks += 1;
      events.push({ type: 'tighten_click', joint, tight: j.tight });
    }
    if (before < TUNE.tightFull && j.tight >= TUNE.tightFull) {
      events.push({ type: 'tightened', joint, tight: j.tight });
    }
    return events;
  }
  return events;
}

export function advance(state, dt) {
  const events = [];
  if (state.phase === 'complete') {
    state.time += dt;
    decayWater(state, dt);
    return events;
  }
  state.time += dt;
  const f = state.faucet;
  const target = f.on ? 1 : 0;
  const step = TUNE.flowRamp * dt;
  f.flow = target > f.flow ? Math.min(target, f.flow + step) : Math.max(target, f.flow - step * 1.6);

  const trapSeated = state.objects.trap.mode === 'seated';
  const w = state.water;
  w.running = f.flow > 0.02;

  if (w.running) {
    if (!trapSeated) {
      w.spilled = Math.min(1.4, w.spilled + f.flow * dt * 0.5);
      w.puddle = Math.min(1, w.puddle + f.flow * dt * 0.18);
      state.gas.escaping = Math.min(1, state.gas.escaping + f.flow * dt * 0.5);
      if (!state.violations.waterBeforeReady && state.time > 0.5) {
        state.violations.waterBeforeReady = true;
        events.push({ type: 'spill_start' });
      }
    } else {
      w.filled = clamp01(w.filled + f.flow * dt * TUNE.fillRate);
      let leakRate = 0;
      for (const joint of ['tail', 'wall']) {
        const t = state.joints[joint].tight;
        if (t < TUNE.tightFull) {
          const base = t < TUNE.tightSeep ? TUNE.leakFast : TUNE.leakSlow;
          leakRate += base * (1 - t / TUNE.tightFull);
        }
      }
      if (leakRate > 0) {
        w.leak = Math.min(1.2, w.leak + leakRate * f.flow * dt);
        w.puddle = Math.min(1, w.puddle + leakRate * f.flow * dt * 0.5);
        state.gas.escaping = Math.min(1, state.gas.escaping + f.flow * dt * leakRate * 0.3);
        if (!state.violations.waterBeforeReady) {
          state.violations.waterBeforeReady = true;
          events.push({ type: 'leak_start', leakRate });
        }
      } else {
        w.leak = Math.max(0, w.leak - dt * 0.25);
      }
      if (w.filled >= 0.6) state.gas.escaping = Math.max(0, state.gas.escaping - dt * 0.6);
    }
  } else {
    w.puddle = Math.max(0, w.puddle - dt * 0.02);
    state.gas.escaping = Math.max(0, state.gas.escaping - dt * 0.3);
  }

  state.gas.blocked = trapSeated && w.filled >= 0.6 && w.leak < 0.02 && state.gas.escaping < 0.35;

  if (state.phase === 'active' && isComplete(state)) {
    state.phase = 'complete';
    events.push({ type: 'complete' });
  }
  return events;
}

function decayWater(state, dt) {
  const w = state.water;
  if (!w.running) {
    w.puddle = Math.max(0, w.puddle - dt * 0.02);
  }
}

export function isComplete(state) {
  const trapSeated = state.objects.trap.mode === 'seated';
  const tight = state.joints.tail.tight >= TUNE.tightFull && state.joints.wall.tight >= TUNE.tightFull;
  return state.valve.closed && trapSeated && tight && state.faucet.on && holdsWater(state) && state.gas.blocked;
}

export function holdsWater(state) {
  return state.objects.trap.mode === 'seated'
    && state.joints.tail.tight >= TUNE.tightFull
    && state.joints.wall.tight >= TUNE.tightFull
    && state.water.filled >= 0.6
    && state.water.leak < 0.02;
}

export function evaluate(state) {
  const trap = state.objects.trap;
  const seated = trap.mode === 'seated';
  const placement = effectivePlacement(state);
  const tailSeat = clamp01(Math.max(0, placement.tail.engage) / TUNE.engageMin)
    * clamp01(1 - placement.tail.lateral / TUNE.seatLateral);
  const wallSeat = clamp01(Math.max(0, placement.wall.engage) / TUNE.engageMin)
    * clamp01(1 - placement.wall.lateral / TUNE.seatLateral);
  const tailNut = clamp01(state.joints.tail.tight / TUNE.tightFull);
  const wallNut = clamp01(state.joints.wall.tight / TUNE.tightFull);
  const retained = retainScore(state);

  const parts = {
    valveClosed: state.valve.closed ? 1 : 0,
    tailSeat: seated ? 1 : tailSeat,
    wallSeat: seated ? 1 : wallSeat,
    tailNut: seated ? tailNut : 0,
    wallNut: seated ? wallNut : 0,
    retain: retained,
  };

  const score = Math.round(
    WEIGHTS.valve * parts.valveClosed
    + WEIGHTS.tailSeat * parts.tailSeat
    + WEIGHTS.wallSeat * parts.wallSeat
    + WEIGHTS.tailNut * parts.tailNut
    + WEIGHTS.wallNut * parts.wallNut
    + WEIGHTS.retain * parts.retain,
  );

  const minTight = Math.min(state.joints.tail.tight, state.joints.wall.tight);
  let primary = 'none';
  let detail = 'complete';

  const worked = state.objects.trap.mode !== 'shelf'
    || state.joints.tail.tight > 0 || state.joints.wall.tight > 0
    || state.objects.wrench.mode === 'held';

  if (!state.valve.closed && (worked || state.faucet.on)) {
    primary = 'sequence';
    detail = 'valve_open';
  } else if (!seated) {
    const ls = state.lastSeat;
    if (ls && ls.kind === 'dropped') {
      primary = ls.axis === 'height' ? 'height_alignment' : 'connection_gap';
      detail = ls.axis === 'height' ? 'seat_height' : 'seat_lateral';
    } else if (trap.mode === 'held') {
      primary = 'height_alignment';
      detail = 'seat_in_progress';
    } else {
      primary = 'sequence';
      detail = 'trap_not_placed';
    }
  } else if (minTight < TUNE.tightFull) {
    primary = 'connection_gap';
    detail = minTight < TUNE.tightSeep ? 'loose_leak' : 'loose_joint';
  } else if (!state.faucet.on || state.water.filled < 0.6) {
    primary = 'none';
    detail = state.faucet.on ? 'filling' : 'ready_to_run';
  } else if (!holdsWater(state)) {
    primary = 'connection_gap';
    detail = 'leak';
  }

  if (state.phase === 'complete') {
    primary = 'none';
    detail = 'complete';
  }

  return {
    score,
    primary_issue: primary,
    detail,
    parts,
    checks: {
      valve: { angle_deg: Math.round(state.valve.angle * 10) / 10, closed: state.valve.closed },
      trap: {
        mode: trap.mode,
        pos_m: { x: r3(trap.pos.x), y: r3(trap.pos.y), z: r3(trap.pos.z) },
        tail_engage_m: r3(placement.tail.engage),
        tail_lateral_m: r3(placement.tail.lateral),
        wall_engage_m: r3(placement.wall.engage),
        wall_lateral_m: r3(placement.wall.lateral),
        seated,
      },
      nuts: {
        tail_tightness: r3(state.joints.tail.tight),
        wall_tightness: r3(state.joints.wall.tight),
        clicks: state.joints.tail.clicks + state.joints.wall.clicks,
      },
      water: {
        faucet_deg: Math.round(state.faucet.angle * 10) / 10,
        running: state.water.running,
        trap_fill: r3(state.water.filled),
        leak: r3(state.water.leak),
        spilled: r3(state.water.spilled),
        puddle: r3(state.water.puddle),
      },
      gas: { blocked: state.gas.blocked, escaping: r3(state.gas.escaping) },
      assist: { mode: state.assist.mode, snap_scale: state.assist.snapScale, events: state.traction.events },
      violations: { ...state.violations },
      held_water: holdsWater(state),
    },
  };
}

function retainScore(state) {
  const w = state.water;
  if (!w.running) return 0;
  if (holdsWater(state)) return w.spilled > 0.05 ? 0.7 : 1;
  if (w.spilled > 0.05) return 0.15;
  if (w.leak > 0.02) return 0.35;
  return clamp01(w.filled) * 0.6;
}

function r3(v) { return Math.round(v * 1000) / 1000; }

export function describeDetail(detail) {
  const map = {
    valve_open: 'The supply valve is still open while working.',
    trap_not_placed: 'The P-trap has not been placed on the drain.',
    seat_height: 'The trap is off vertically; the socket cannot slip over the pipe end.',
    seat_lateral: 'The trap is off sideways; the sockets miss the pipe ends.',
    seat_in_progress: 'The trap is in hand and not seated yet.',
    loose_joint: 'A slip nut is not tight; the joint will seep.',
    loose_leak: 'A slip nut is barely started; the joint will leak.',
    ready_to_run: 'Assembly is sealed. Turn on the faucet to test.',
    filling: 'Trap is filling.',
    leak: 'Water is escaping through a joint.',
    complete: 'Trap holds water and blocks sewer gas.',
  };
  return map[detail] || '';
}
