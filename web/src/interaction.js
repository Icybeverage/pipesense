// PipeSense interaction layer: turns smoothed hand poses into simulated
// actions. Every input source (camera for learners; the scripted QA channel
// in automated sessions) reaches the deterministic core through this one
// path, so a state change always requires a gloved hand holding the right
// thing at the right target.

import * as THREE from 'three';
import { GEOM, grab, release, moveCarried, rotate } from './sim.js';

const REACH = {
  trap: 0.19,
  wrench: 0.16,
  valve_lever: 0.105,
  faucet_handle: 0.115,
  nut: 0.095,
};

const CARRY_CLAMP = { minZ: 0.16, maxZ: 0.62 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createInteraction({ sim, input, props, onEvent }) {
  const held = { left: null, right: null };
  const wasPinched = { left: false, right: false };
  const wasPowerGripped = { left: false, right: false };
  const offset = { left: new THREE.Vector3(), right: new THREE.Vector3() };
  const pinchWorld = { left: new THREE.Vector3(), right: new THREE.Vector3() };
  const gripWorld = { left: new THREE.Vector3(), right: new THREE.Vector3() };
  const anchorWorld = { left: {}, right: {} };
  const tmp = new THREE.Vector3();

  const lastKnown = {
    'valve_lever': new THREE.Vector3(),
    'faucet_handle': new THREE.Vector3(),
    'nut_tail': new THREE.Vector3(),
    'nut_wall': new THREE.Vector3(),
    'wrench': new THREE.Vector3(),
  };

  function updateLastKnown(propsOut) {
    lastKnown.valve_lever.copy(propsOut.valveKnob);
    lastKnown.faucet_handle.copy(propsOut.faucetKnob);
    lastKnown.nut_tail.set(GEOM.tail.x, propsOut.nutTailY, GEOM.tail.z);
    lastKnown.nut_wall.set(0, GEOM.wall.y, propsOut.nutWallZ);
    propsOut.wrench.getWorldPosition(lastKnown.wrench);
  }

  function candidates() {
    const list = [];
    if (sim.objects.trap.mode === 'shelf') {
      list.push({ id: 'trap', kind: 'carry', radius: REACH.trap });
    }
    if (sim.objects.wrench.mode === 'shelf') {
      list.push({ id: 'wrench', kind: 'carry', radius: REACH.wrench });
    }
    if (!sim.valve.heldBy) list.push({ id: 'valve_lever', kind: 'operate', radius: REACH.valve_lever });
    if (!sim.faucet.heldBy) list.push({ id: 'faucet_handle', kind: 'operate', radius: REACH.faucet_handle });
    return list;
  }

  function candidatePos(id, propsOut) {
    if (id === 'trap') return propsOut.trapWorld;
    return lastKnown[id];
  }

  function nearest(side, ids, propsOut) {
    const p = pinchWorld[side];
    let best = null;
    let bestDist = Infinity;
    for (const id of ids) {
      const pos = candidatePos(id, propsOut);
      const d = p.distanceTo(pos);
      if (d < bestDist) { bestDist = d; best = id; }
    }
    return { id: best, dist: bestDist };
  }

  function wrenchHeldBy(side) {
    return sim.objects.wrench.mode === 'held' && sim.objects.wrench.heldBy === side;
  }

  function emit(events, side) {
    for (const event of events) {
      if (onEvent) onEvent({ ...event, side });
    }
  }

  // Hit tests use the tracked hand: the glove's visual grasp snap (which
  // seats a held handle between the rendered thumb and index) is removed.
  function sampleHand(side, glove) {
    const snap = glove.snapOffset;
    glove.pinchAnchor.getWorldPosition(pinchWorld[side]);
    glove.gripAnchor.getWorldPosition(gripWorld[side]);
    if (snap) {
      pinchWorld[side].sub(snap);
      gripWorld[side].sub(snap);
    }
    for (const [key, anchor] of Object.entries(glove.anchors || {})) {
      const point = anchorWorld[side][key] || (anchorWorld[side][key] = new THREE.Vector3());
      anchor.getWorldPosition(point);
      if (snap) point.sub(snap);
    }
  }

  // Grip point the rendered pinch should sit on for each held object, plus
  // the thumb/index pad-centre gap that wraps that object's diameter.
  const GRASP = {
    valve_lever: { gap: 0.026 },   // 21 mm red knob
    faucet_handle: { gap: 0.028 }, // 25 mm chrome knob
    // trap: not snapped yet - its grip point on the riser was not verified
    // visually in time (QA close-up showed the pinch beside the pipe).
  };
  const snapPoint = new THREE.Vector3();
  const TRAP_GRIP = new THREE.Vector3(0, 0.22, 0);
  function graspSnap(side, glove, propsOut) {
    if (!glove.setGraspSnap) return;
    const entry = held[side];
    if (!entry || entry.id === 'wrench' || !GRASP[entry.id]) {
      glove.setGraspSnap(null);
      return;
    }
    // Trap: the vertical riser (local origin sits below the U-bend, off the
    // pipe), 22 cm up, where a hand would pinch the 1-1/2 in tube.
    if (entry.id === 'trap') {
      if (propsOut.trap) propsOut.trap.localToWorld(snapPoint.set(0, 0.22, 0));
      else snapPoint.copy(propsOut.trapWorld).add(TRAP_GRIP);
    }
    else snapPoint.copy(lastKnown[entry.id]);
    glove.setGraspSnap(snapPoint, GRASP[entry.id].gap);
  }

  function supportAt(side, glove, target, radius) {
    let dist = pinchWorld[side].distanceTo(target);
    let anchor = glove.pinchAnchor;
    // `supports` counts the anatomical set only: palm + five fingertips.
    // Precision pinch can win the nearest-point test without inflating the
    // six-point full-hand traction score.
    let supports = 0;
    for (const [key, point] of Object.entries(anchorWorld[side])) {
      const d = point.distanceTo(target);
      if (d <= radius) supports += 1;
      if (d < dist) {
        dist = d;
        anchor = glove.anchors[key];
      }
    }
    return { dist, supports, anchor };
  }

  function update(dt, gloves, propsOut) {
    updateLastKnown(propsOut);

    for (const side of ['left', 'right']) {
      const hand = input.hands[side];
      const glove = gloves[side];
      sampleHand(side, glove);
      const pinch = hand.pinchClosed;
      const fingerClosure = hand.target.curls.reduce((sum, value) => sum + value, 0) / hand.target.curls.length;
      // MediaPipe supplies three bends for every finger plus the thumb. A
      // curled multi-finger pose is therefore a real power grip, independent
      // of the precision thumb-index pinch gesture.
      const powerGrip = fingerClosure >= 0.48 && hand.target.thumb >= 0.24;
      const gripSignal = pinch || powerGrip;
      const rot = input.consumeRot(side);
      const heldEntry = held[side];
      const graspPoint = heldEntry && heldEntry.mode === 'power' ? gripWorld[side] : pinchWorld[side];
      let highlight = 0;
      let contact = 0;
      let activeContactAnchor = null;

      if (heldEntry && heldEntry.id === 'wrench') {
        // A carried wrench remains supported by either precision pinch or a
        // tracked whole-hand power grip. All six anatomical anchors continue
        // to contribute contact while the wrench works against a nut.
        if (!gripSignal || sim.objects.wrench.heldBy !== side) {
          emit(release(sim, 'wrench', side), side);
          held[side] = null;
        } else {
          contact = 1;
          if (rot !== 0) {
            for (const nut of ['nut_tail', 'nut_wall']) {
              const support = supportAt(side, glove, lastKnown[nut], REACH.nut);
              if (support.dist <= REACH.nut) {
                highlight = Math.max(highlight, 1 - support.dist / (REACH.nut * 1.6));
                contact = Math.max(contact, 1 - support.dist / REACH.nut, support.supports / 6);
                activeContactAnchor = support.anchor;
                emit(rotate(sim, nut, rot, side), side);
                break;
              }
            }
          }
        }
      } else if (!heldEntry) {
        const list = candidates();
        let nearest = null;
        for (const cand of list) {
          const support = supportAt(side, glove, candidatePos(cand.id, propsOut), cand.radius);
          if (!nearest || support.dist < nearest.dist) nearest = { id: cand.id, radius: cand.radius, ...support };
        }
        const inReach = nearest && nearest.dist <= nearest.radius;

        if (inReach) {
          highlight = Math.max(0, 1 - nearest.dist / (nearest.radius * 1.6));
          contact = clamp(Math.max(1 - nearest.dist / nearest.radius, nearest.supports / 6), 0, 1);
          activeContactAnchor = nearest.anchor;
        }

        const gripEdge = (pinch && !wasPinched[side]) || (powerGrip && !wasPowerGripped[side]);
        if (gripEdge && inReach) {
          const id = nearest.id;
          contact = 1;
          emit(grab(sim, id, side), side);
          if (sim.objects.trap.heldBy === side || sim.objects.wrench.heldBy === side
            || sim.valve.heldBy === side || sim.faucet.heldBy === side) {
            const mode = pinch ? 'pinch' : 'power';
            held[side] = { id, kind: id === 'trap' || id === 'wrench' ? 'carry' : 'operate', mode };
            const holdPoint = mode === 'power' ? gripWorld[side] : pinchWorld[side];
            if (id === 'trap') {
              offset[side].set(
                sim.objects.trap.pos.x - holdPoint.x,
                sim.objects.trap.pos.y - holdPoint.y,
                sim.objects.trap.pos.z - holdPoint.z,
              );
            }
          }
        }
      } else if (heldEntry.kind === 'carry') {
        if (!gripSignal || sim.objects[heldEntry.id].heldBy !== side) {
          emit(release(sim, heldEntry.id, side), side);
          held[side] = null;
        } else if (heldEntry.id === 'trap') {
          contact = 1;
          activeContactAnchor = heldEntry.mode === 'power' ? glove.anchors.palm : glove.pinchAnchor;
          const target = {
            x: clamp(graspPoint.x + offset[side].x, GEOM.workspace.minX, GEOM.workspace.maxX),
            y: clamp(graspPoint.y + offset[side].y, GEOM.workspace.minY, GEOM.workspace.maxY),
            z: clamp(graspPoint.z + offset[side].z, CARRY_CLAMP.minZ, CARRY_CLAMP.maxZ),
          };
          moveCarried(sim, 'trap', target);
        }
      } else if (heldEntry.kind === 'operate') {
        if (!gripSignal || sim[heldEntry.id === 'valve_lever' ? 'valve' : 'faucet'].heldBy !== side) {
          emit(release(sim, heldEntry.id, side), side);
          held[side] = null;
        } else {
          contact = 1;
          if (rot !== 0) {
            emit(rotate(sim, heldEntry.id, rot, side), side);
          }
        }
      }

      // Wrench in hand: keep a soft highlight so the jaw reads as "ready".
      if (wrenchHeldBy(side)) highlight = Math.max(highlight, 0.25);

      graspSnap(side, glove, propsOut);
      input.setHighlight(side, highlight);
      input.setContact(side, contact);
      glove.setContactAnchor(activeContactAnchor);
      wasPinched[side] = pinch;
      wasPowerGripped[side] = powerGrip;
    }
  }

  function dropAll() {
    for (const side of ['left', 'right']) {
      const entry = held[side];
      if (!entry) continue;
      emit(release(sim, entry.id, side), side);
      held[side] = null;
    }
  }
  // dropAll has no glove handle; the next update() clears each snap.

  return { update, dropAll, held, pinchWorld, gripWorld, anchorWorld };
}
