// PipeSense result effects: water held in the trap, spills when the trap is
// missing, drips from loose slip joints, puddles, and a sewer-gas
// visualization that either escapes into the room or stops at the water seal.

import * as THREE from 'three';
import { GEOM } from './sim.js';

const GAS_START_WALL = new THREE.Vector3(0, GEOM.wall.y, 0.03);
const GAS_START_TAIL = new THREE.Vector3(GEOM.tail.x, GEOM.tail.endY - 0.03, GEOM.tail.z);
const GAS_SEAL = new THREE.Vector3(0, 0.50, 0.24);

function sparkRing(color) {
  return new THREE.Mesh(
    new THREE.TorusGeometry(0.05, 0.004, 8, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
}

export function createFx(scene) {
  const group = new THREE.Group();
  group.name = 'fx';
  scene.add(group);

  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2f8fbc, transparent: true, opacity: 0.62, roughness: 0.12, metalness: 0.05, side: THREE.DoubleSide,
  });

  // Trap water: a tube that follows the lower U of the trap body.
  const waterPoints = [
    [0, 0.34, 0], [0, 0.30, 0], [0, 0.19, 0], [0, 0.125, 0],
    [0, 0.062, -0.028], [0, 0.052, -0.06], [0, 0.062, -0.092],
    [0, 0.125, -0.12], [0, 0.19, -0.12], [0, 0.30, -0.12], [0, 0.34, -0.12],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const waterCurve = new THREE.CatmullRomCurve3(waterPoints, false, 'centripetal', 0.4);
  const waterGeo = new THREE.TubeGeometry(waterCurve, 60, 0.0155, 18, false);
  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  waterMesh.visible = false;
  group.add(waterMesh);
  const waterIndexCount = waterGeo.index ? waterGeo.index.count : waterGeo.getAttribute('position').count;

  // Spill stream falling from the open tailpiece to the shelf.
  const streamLen = GEOM.tail.endY - GEOM.shelf.y + 0.02;
  const streamGeo = new THREE.CylinderGeometry(0.0072, 0.009, streamLen, 12, 1, true);
  const streamMat = new THREE.MeshStandardMaterial({ color: 0x53a9d4, transparent: true, opacity: 0.55, roughness: 0.1, metalness: 0.05, side: THREE.DoubleSide });
  const stream = new THREE.Mesh(streamGeo, streamMat);
  stream.position.set(GEOM.tail.x, GEOM.tail.endY - streamLen / 2, GEOM.tail.z);
  stream.visible = false;
  group.add(stream);

  // Puddles on the shelf and the floor.
  const puddleMat = new THREE.MeshStandardMaterial({ color: 0x0d1a26, transparent: true, opacity: 0.0, roughness: 0.08, metalness: 0.85 });
  const shelfPuddle = new THREE.Mesh(new THREE.CircleGeometry(0.22, 28), puddleMat.clone());
  shelfPuddle.rotation.x = -Math.PI / 2;
  shelfPuddle.position.set(0, GEOM.shelf.y + 0.0015, 0.30);
  group.add(shelfPuddle);
  const floorPuddle = new THREE.Mesh(new THREE.CircleGeometry(0.55, 32), puddleMat.clone());
  floorPuddle.rotation.x = -Math.PI / 2;
  floorPuddle.position.set(0.1, 0.0015, 0.62);
  group.add(floorPuddle);

  // Drip particles for loose joints.
  // Glossy, slightly blue water; drops are stretched spheres so a leak reads
  // as falling water from across a room, not as dust.
  const dripMat = new THREE.MeshPhysicalMaterial({ color: 0xcfe9f5, transparent: true, opacity: 0.88, roughness: 0.03, metalness: 0, clearcoat: 1, envMapIntensity: 1.6 });
  const dripGeo = new THREE.SphereGeometry(0.0062, 14, 10);
  dripGeo.scale(1, 1.7, 1);
  const drips = [];
  for (let i = 0; i < 48; i++) {
    const drop = new THREE.Mesh(dripGeo, dripMat);
    drop.visible = false;
    group.add(drop);
    drips.push({ mesh: drop, vy: 0, life: 0, joint: 0 });
  }

  // Sewer-gas particles.
  const gasCount = 150;
  const gasPos = new Float32Array(gasCount * 3);
  const gasState = [];
  for (let i = 0; i < gasCount; i++) {
    gasState.push({
      from: i % 2 === 0 ? 0 : 1,
      t: Math.random(),
      speed: 0.22 + Math.random() * 0.4,
      jitter: Math.random() * Math.PI * 2,
      out: new THREE.Vector3(),
    });
  }
  const gasGeo = new THREE.BufferGeometry();
  gasGeo.setAttribute('position', new THREE.BufferAttribute(gasPos, 3));
  const gasMat = new THREE.PointsMaterial({
    color: 0x9ac26a, size: 0.011, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const gas = new THREE.Points(gasGeo, gasMat);
  group.add(gas);

  // Ring pulses for seated joints and the gas-blocked shimmer at the seal.
  const seatRing = sparkRing(0x7ce8ff);
  seatRing.visible = false;
  group.add(seatRing);
  const sealRing = sparkRing(0x9ad7ff);
  sealRing.visible = false;
  group.add(sealRing);

  const pulses = [];
  const tmp = new THREE.Vector3();
  const GAS_WALL_MID = new THREE.Vector3(0, GEOM.wall.y, GEOM.wall.endZ - 0.05);

  function spawnPulse(kind, position) {
    if (kind === 'seat') {
      seatRing.position.copy(position);
      pulses.push({ mesh: seatRing, t: 0, dur: 0.9 });
    }
  }

  function update(sim, dt, trapWorld) {
    const w = sim.water;
    const trapSeated = sim.objects.trap.mode === 'seated';

    // Water held in the trap.
    waterMesh.visible = trapSeated && w.filled > 0.01;
    if (waterMesh.visible) {
      waterMesh.position.set(trapWorld.x, trapWorld.y, trapWorld.z);
      const fill = Math.max(0.02, Math.min(1, w.filled));
      waterGeo.setDrawRange(0, Math.floor(waterIndexCount * fill));
      waterMat.opacity = 0.45 + 0.22 * fill;
    }

    // Spill stream when water runs with no trap on the drain.
    const spilling = w.running && !trapSeated && w.spilled > 0.01;
    stream.visible = spilling;
    if (spilling) {
      streamMat.opacity = 0.35 + 0.3 * sim.faucet.flow;
      stream.scale.set(1, 0.98 + Math.sin(sim.time * 26) * 0.02, 1);
    }

    // Puddles grow with accumulated water.
    shelfPuddle.material.opacity = Math.min(0.6, w.puddle * 0.7);
    shelfPuddle.scale.setScalar(0.35 + w.puddle * 0.65);
    const floorAmt = Math.max(0, w.puddle - 0.35);
    floorPuddle.material.opacity = Math.min(0.55, floorAmt * 0.9);
    floorPuddle.scale.setScalar(0.3 + floorAmt * 1.1);

    // Joint drips.
    const leakyTail = trapSeated && w.running && sim.joints.tail.tight < 0.75;
    const leakyWall = trapSeated && w.running && sim.joints.wall.tight < 0.75;
    const dripBudget = Math.min(1, w.leak * 2.4);
    for (const drip of drips) {
      if (drip.life <= 0) {
        if ((leakyTail || leakyWall) && Math.random() < Math.max(0.35, dripBudget) * dt * 24) {
          drip.joint = leakyTail ? 0 : 1;
          drip.life = 1;
          drip.vy = 0.25;
          drip.mesh.visible = true;
          if (drip.joint === 0) drip.mesh.position.set(GEOM.tail.x + 0.02, 0.935, GEOM.tail.z + 0.01);
          // Wall joint: the hub mouth of the loose wall nut (z 0.132), on the
          // camera-facing side of the nut. Straight below x = 0 the drops fall
          // behind the trap's outlet leg (z 0.18) as seen from CAMERA_HOME.
          else drip.mesh.position.set(0.024, GEOM.wall.y - 0.02, 0.132);
        }
        continue;
      }
      drip.life -= dt;
      drip.vy -= 3.2 * dt;
      drip.mesh.position.y += drip.vy * dt;
      if (drip.mesh.position.y <= GEOM.shelf.y + 0.004) drip.life = Math.min(drip.life, 0.05);
      if (drip.life <= 0) drip.mesh.visible = false;
    }

    // Gas: contained when the seal holds, escaping otherwise.
    const escaping = Math.max(sim.gas.escaping, w.running && !trapSeated ? 0.6 : 0);
    const contained = sim.gas.blocked;
    gasMat.opacity = escaping > 0.05 ? Math.min(0.55, escaping * 0.6) : contained ? 0.2 : 0;
    if (gasMat.opacity > 0.001) {
      gasMat.color.setHex(escaping > 0.05 ? 0x9ac26a : 0x8fc7e8);
      const attr = gasGeo.getAttribute('position');
      for (let i = 0; i < gasCount; i++) {
        const p = gasState[i];
        p.t += dt * p.speed;
        if (p.t > 1) {
          p.t = 0;
          p.speed = 0.22 + Math.random() * 0.4;
          p.out.set((Math.random() - 0.5) * 0.5, 1.05 + Math.random() * 0.4, 0.25 + Math.random() * 0.55);
        }
        const start = p.from === 0 ? GAS_START_WALL : GAS_START_TAIL;
        const mid = p.from === 0 ? GAS_WALL_MID : GAS_SEAL;
        const wobble = Math.sin(sim.time * 2.2 + p.jitter) * 0.012;
        if (contained && escaping < 0.05) {
          tmp.copy(start).lerp(GAS_SEAL, p.t);
          tmp.x += wobble;
          tmp.z += Math.cos(sim.time * 1.7 + p.jitter) * 0.008;
        } else {
          if (p.t < 0.55) {
            const k = p.t / 0.55;
            tmp.copy(start).lerp(mid, k);
            tmp.x += wobble;
          } else {
            const k = (p.t - 0.55) / 0.45;
            tmp.copy(mid).lerp(p.out, k);
            tmp.x += wobble * 2;
            tmp.y += k * 0.12;
          }
        }
        attr.array[i * 3] = tmp.x;
        attr.array[i * 3 + 1] = tmp.y;
        attr.array[i * 3 + 2] = tmp.z;
      }
      attr.needsUpdate = true;
    }

    // Seal shimmer while gas is blocked.
    sealRing.visible = contained;
    if (contained) {
      sealRing.position.set(0, 0.62, 0.30);
      sealRing.scale.setScalar(1 + Math.sin(sim.time * 2.6) * 0.12);
      sealRing.material.opacity = 0.18 + Math.sin(sim.time * 2.6) * 0.08;
    }

    // One-shot pulses.
    for (const pulse of pulses) {
      pulse.t += dt;
      const k = pulse.t / pulse.dur;
      if (k >= 1) {
        pulse.mesh.visible = false;
        continue;
      }
      pulse.mesh.visible = true;
      pulse.mesh.scale.setScalar(1 + k * 3.6);
      pulse.mesh.material.opacity = (1 - k) * 0.5;
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      if (pulses[i].t >= pulses[i].dur) pulses.splice(i, 1);
    }
  }

  // Clear transient particles (drips, one-shot pulses) so a restarted demo or
  // a reset workspace never shows drops left over from the previous run.
  function reset() {
    for (const drip of drips) {
      drip.life = 0;
      drip.mesh.visible = false;
    }
    for (const pulse of pulses) pulse.mesh.visible = false;
    pulses.length = 0;
    stream.visible = false;
  }

  return { update, spawnPulse, reset, group };
}
