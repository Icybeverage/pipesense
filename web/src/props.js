// PipeSense interactive props: P-trap, slip nuts, wrench, valve lever, faucet
// handle. Mesh geometry mirrors the deterministic contract in sim.js
// (GEOM.trapLocal etc.) so what the learner sees is what the model scores.
//
// FIXTURES: shared anchor constants. world.js imports these to place the
// static bodies (tailpiece, wall arm, valve body, faucet body) around them.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GEOM } from './sim.js';

export const FIXTURES = {
  tailAxisX: GEOM.tail.x,
  tailAxisZ: GEOM.tail.z,
  tailEndY: GEOM.tail.endY,
  wallAxisY: GEOM.wall.y,
  wallEndZ: GEOM.wall.endZ,
  valvePivot: { x: -0.42, y: 0.84, z: 0.125 },
  faucetPivot: { x: 0.33, y: 1.176, z: 0.135 },
  faucetKnob: { ...GEOM.faucet.pos },
  wrenchRest: { x: -0.14, y: 0.412, z: 0.50 },
  deckY: 1.155,
  shelfY: GEOM.shelf.y,
};

const DEG = Math.PI / 180;

const mats = {
  // PVC is a glossy dielectric: a thin clearcoat gives the long highlight
  // real Schedule 40 shows under a work lamp.
  pvc: new THREE.MeshPhysicalMaterial({ color: 0xeceae4, roughness: 0.42, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.3 }),
  // Moulded fittings: a touch brighter and glossier than extruded pipe.
  pvcShade: new THREE.MeshPhysicalMaterial({ color: 0xe9e8e3, roughness: 0.3, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.2 }),
  nut: new THREE.MeshStandardMaterial({ color: 0x2b333d, roughness: 0.52, metalness: 0.12 }),
  washer: new THREE.MeshStandardMaterial({ color: 0x1c2126, roughness: 0.85, metalness: 0.05 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x767e88, roughness: 0.33, metalness: 0.92 }),
  steelDark: new THREE.MeshStandardMaterial({ color: 0x3f444c, roughness: 0.45, metalness: 0.85 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xe4e8ec, roughness: 0.12, metalness: 1 }),
  redCap: new THREE.MeshStandardMaterial({ color: 0xd6455a, roughness: 0.4, metalness: 0.1, emissive: 0x651222, emissiveIntensity: 0.5 }),
};

// Hero meshes modelled in Blender (tools/blender/build_props.py) in the same
// local frame as the procedural parts. They replace the stand-in meshes once
// loaded; `keep` parts stay (e.g. the valve cap, whose glow shows state).
const gltf = new GLTFLoader();
function dress(group, file, keep = []) {
  gltf.load(`./assets/models/${file}`, ({ scene }) => {
    for (const child of group.children) if (!keep.includes(child)) child.visible = false;
    scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    group.add(scene);
  }, undefined, () => {});
}

function shadowed(mesh, cast = true, receive = true) {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

function knurledNut(radius, height, ridges = 14) {
  const group = new THREE.Group();
  const body = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 24), mats.nut));
  group.add(body);
  const ridgeGeo = new THREE.BoxGeometry(0.005, height * 0.9, 0.008);
  for (let i = 0; i < ridges; i++) {
    const a = (i / ridges) * Math.PI * 2;
    const ridge = new THREE.Mesh(ridgeGeo, mats.nut);
    ridge.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    ridge.rotation.y = -a;
    group.add(ridge);
  }
  const lip = shadowed(new THREE.Mesh(new THREE.TorusGeometry(radius * 0.92, 0.0035, 8, 24), mats.nut));
  lip.rotation.x = Math.PI / 2;
  lip.position.y = height / 2;
  group.add(lip);
  const washer = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.9, radius * 0.74, 0.007, 20), mats.washer);
  washer.position.y = -height / 2 - 0.002;
  group.add(washer);
  return group;
}

// Trap body curve in trap-local space: tail socket top -> inlet leg -> U bend
// -> outlet leg -> elbow -> wall socket opening.
export function trapCurvePoints() {
  return [
    [0, 0.505, 0], [0, 0.47, 0], [0, 0.30, 0], [0, 0.19, 0],
    [0, 0.125, 0], [0, 0.062, -0.028], [0, 0.049, -0.06], [0, 0.062, -0.092],
    [0, 0.125, -0.12], [0, 0.19, -0.12], [0, 0.225, -0.135], [0, 0.235, -0.16], [0, 0.235, -0.175],
  ];
}

// Real Schedule 40 cues on the trap body, painted into canvas maps laid out
// in TubeGeometry UV space (u along the pipe, v around it): an off-white
// tint that drifts along the extrusion, faint extrusion streaks, the inkjet
// legend a DWV pipe carries, a mould parting line over the U-bend, and a
// grey film where the bend holds standing water. Generic markings only.
function pvcMaps(lengthM, circM) {
  if (typeof document === 'undefined') return null;
  const W = 2048;
  const H = 256;
  const make = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const albedo = make();
  const rough = make();
  const a = albedo.getContext('2d');
  const r = rough.getContext('2d');
  let seed = 41;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  a.fillStyle = '#f1efe9';
  a.fillRect(0, 0, W, H);
  r.fillStyle = 'rgb(92,92,92)'; // ~0.36 roughness
  r.fillRect(0, 0, W, H);
  // Slow tint drift along the extrusion.
  for (let x = 0; x < W; x += 16) {
    const t = rnd();
    a.fillStyle = `rgba(${t > 0.5 ? '210,200,180' : '200,205,212'},${0.05 + rnd() * 0.06})`;
    a.fillRect(x, 0, 16, H);
  }
  // Extrusion streaks run along u.
  for (let i = 0; i < 90; i++) {
    const y = rnd() * H;
    a.fillStyle = `rgba(120,115,105,${0.02 + rnd() * 0.03})`;
    a.fillRect(0, y, W, 1 + rnd() * 2);
    r.fillStyle = `rgba(${rnd() > 0.5 ? '130,130,130' : '70,70,70'},0.35)`;
    r.fillRect(0, y, W, 1 + rnd() * 2);
  }
  // Water-line film inside the bend region (u ~0.45..0.7), low on the pipe.
  const film = a.createLinearGradient(W * 0.42, 0, W * 0.72, 0);
  film.addColorStop(0, 'rgba(140,135,120,0)');
  film.addColorStop(0.5, 'rgba(140,132,115,0.16)');
  film.addColorStop(1, 'rgba(140,135,120,0)');
  a.fillStyle = film;
  a.fillRect(W * 0.42, 0, W * 0.3, H);
  // Mould parting line along the U-bend, in the bend plane (the +-X sides).
  for (const v of [0.25, 0.75]) {
    a.fillStyle = 'rgba(150,145,135,0.35)';
    a.fillRect(W * 0.45, v * H, W * 0.27, 2);
    r.fillStyle = 'rgba(180,180,180,0.6)';
    r.fillRect(W * 0.45, v * H, W * 0.27, 2);
  }
  // Inkjet legend on the long inlet leg, printed on two opposite sides.
  // Canvas pixels are not square on the pipe; scale x so letters aren't squashed.
  const pxU = lengthM / W;
  const pxV = circM / H;
  const legend = 'PVC-DWV  1-1/2 IN  SCH 40  ASTM D2665  CELLULAR CORE  NSF-DWV  0411 L2';
  for (const v of [0.02, 0.52]) {
    a.save();
    a.translate(W * 0.07, v * H);
    a.scale(pxV / pxU, 1);
    a.font = '600 8px "Helvetica Neue", Arial, sans-serif';
    a.textBaseline = 'middle';
    a.fillStyle = 'rgba(38,44,58,0.72)';
    a.fillText(legend, 0, 0);
    a.restore();
    r.save();
    r.translate(W * 0.07, v * H);
    r.scale(pxV / pxU, 1);
    r.font = '600 8px "Helvetica Neue", Arial, sans-serif';
    r.textBaseline = 'middle';
    r.fillStyle = 'rgb(150,150,150)';
    r.fillText(legend, 0, 0);
    r.restore();
  }
  const map = new THREE.CanvasTexture(albedo);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const roughnessMap = new THREE.CanvasTexture(rough);
  roughnessMap.anisotropy = 8;
  return { map, roughnessMap };
}

function trapBody() {
  const group = new THREE.Group();
  const points = trapCurvePoints().map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.4);
  const maps = pvcMaps(curve.getLength(), Math.PI * 2 * 0.0215);
  if (maps) {
    mats.pvc.map = maps.map;
    mats.pvc.roughnessMap = maps.roughnessMap;
    mats.pvc.roughness = 1;
    mats.pvc.color.set(0xffffff);
    mats.pvc.needsUpdate = true;
  }
  const tube = shadowed(new THREE.Mesh(new THREE.TubeGeometry(curve, 140, 0.0215, 28, false), mats.pvc));
  group.add(tube);

  const tailSocket = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.0275, 0.0275, 0.068, 26), mats.pvcShade));
  tailSocket.position.set(0, 0.505 - 0.034, 0);
  group.add(tailSocket);
  const tailShoulder = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.0275, 0.0042, 8, 26), mats.pvcShade));
  tailShoulder.rotation.x = Math.PI / 2;
  tailShoulder.position.set(0, 0.44, 0);
  group.add(tailShoulder);

  const wallSocket = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.0275, 0.0275, 0.075, 26), mats.pvcShade));
  wallSocket.rotation.x = Math.PI / 2;
  wallSocket.position.set(0, 0.235, -0.135);
  group.add(wallSocket);
  const wallShoulder = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.0275, 0.0042, 8, 26), mats.pvcShade));
  wallShoulder.position.set(0, 0.235, -0.1);
  group.add(wallShoulder);

  const collarA = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.0225, 0.003, 8, 22), mats.pvcShade));
  collarA.rotation.x = Math.PI / 2;
  collarA.position.set(0, 0.30, 0);
  group.add(collarA);
  const collarB = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.0225, 0.003, 8, 22), mats.pvcShade));
  collarB.rotation.x = Math.PI / 2;
  collarB.position.set(0, 0.30, -0.12);
  group.add(collarB);
  return group;
}

function wrenchBody() {
  const group = new THREE.Group();
  const handle = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.017, 0.012, 0.20), mats.steelDark));
  handle.position.set(0, 0, 0.10);
  group.add(handle);
  const neck = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.013, 0.05), mats.steelDark));
  neck.position.set(0, 0.001, 0.20);
  group.add(neck);
  const head = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.024, 0.042), mats.steel));
  head.position.set(0, 0.004, 0.224);
  group.add(head);
  const jawFixed = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.011, 0.024, 0.034), mats.steel));
  jawFixed.position.set(-0.0135, 0.004, 0.258);
  group.add(jawFixed);
  const jawSlide = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.009, 0.02, 0.03), mats.steel));
  jawSlide.position.set(0.0135, 0.004, 0.252);
  group.add(jawSlide);
  const worm = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.026, 14), mats.steelDark));
  worm.rotation.z = Math.PI / 2;
  worm.position.set(0, -0.009, 0.235);
  group.add(worm);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0115, 0.0022, 8, 18), mats.washer);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, 0.0, 0.006);
  group.add(ring);
  for (let i = 0; i < 3; i++) {
    const groove = new THREE.Mesh(new THREE.BoxGeometry(0.0182, 0.0125, 0.0022), mats.washer);
    groove.position.set(0, 0, 0.036 + i * 0.008);
    group.add(groove);
  }
  return group;
}

function leverBody() {
  const group = new THREE.Group();
  const arm = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.015, 0.012), mats.chrome));
  arm.position.set(0.0375, 0, 0);
  group.add(arm);
  const knob = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.0105, 16, 12), mats.redCap), true, false);
  knob.position.set(0.076, 0, 0);
  group.add(knob);
  group.userData.keep = [knob];
  const collar = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 0.016, 14), mats.steelDark));
  collar.rotation.z = Math.PI / 2;
  group.add(collar);
  return group;
}

function faucetHandleBody() {
  const group = new THREE.Group();
  const stem = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.02, 14), mats.steelDark));
  stem.position.set(0, 0.01, 0);
  group.add(stem);
  const arm = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.017, 0.012, 0.062), mats.chrome));
  arm.position.set(0, 0.016, 0.036);
  group.add(arm);
  const knob = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.0125, 16, 12), mats.chrome), true, false);
  knob.position.set(0, 0.016, 0.069);
  group.add(knob);
  const grip = new THREE.Mesh(new THREE.TorusGeometry(0.0105, 0.0024, 8, 18), mats.washer);
  grip.rotation.y = Math.PI / 2;
  grip.position.set(0, 0.016, 0.069);
  group.add(grip);
  return group;
}

export function createProps(scene) {
  const root = new THREE.Group();
  root.name = 'props';
  scene.add(root);

  const trap = trapBody();
  trap.position.set(GEOM.trapRest.x, GEOM.trapRest.y, GEOM.trapRest.z);
  root.add(trap);

  const nutTail = knurledNut(0.031, 0.026);
  dress(nutTail, 'slip_nut.glb');
  nutTail.position.set(GEOM.tail.x, 0.968, GEOM.tail.z);
  root.add(nutTail);

  const nutWall = knurledNut(0.031, 0.026);
  dress(nutWall, 'slip_nut.glb');
  nutWall.rotation.x = Math.PI / 2;
  nutWall.position.set(0, GEOM.wall.y, 0.04);
  root.add(nutWall);

  const wrench = wrenchBody();
  dress(wrench, 'wrench.glb');
  wrench.position.set(FIXTURES.wrenchRest.x, FIXTURES.wrenchRest.y, FIXTURES.wrenchRest.z);
  wrench.rotation.y = Math.PI / 2;
  root.add(wrench);

  const valveLever = leverBody();
  dress(valveLever, 'valve_lever.glb', valveLever.userData.keep);
  valveLever.position.set(FIXTURES.valvePivot.x, FIXTURES.valvePivot.y, FIXTURES.valvePivot.z);
  root.add(valveLever);

  const faucetHandle = faucetHandleBody();
  dress(faucetHandle, 'faucet_handle.glb');
  faucetHandle.position.set(FIXTURES.faucetPivot.x, FIXTURES.faucetPivot.y, FIXTURES.faucetPivot.z);
  faucetHandle.rotation.x = -0.18;
  faucetHandle.rotation.y = 0.12;
  root.add(faucetHandle);

  const state = {
    wrenchHome: { pos: new THREE.Vector3(FIXTURES.wrenchRest.x, FIXTURES.wrenchRest.y, FIXTURES.wrenchRest.z), rot: new THREE.Euler(0, Math.PI / 2, 0) },
  };

  const vTmp = new THREE.Vector3();

  function lerp(a, b, t) { return a + (b - a) * t; }

  function update(sim, dt, gloves) {
    root.updateMatrixWorld(true);
    const t = sim.objects.trap;
    if (t.mode === 'seated') {
      trap.position.set(GEOM.seatPose.x, GEOM.seatPose.y, GEOM.seatPose.z);
    } else {
      const k = 1 - Math.exp(-14 * dt);
      trap.position.x += (t.pos.x - trap.position.x) * k;
      trap.position.y += (t.pos.y - trap.position.y) * k;
      trap.position.z += (t.pos.z - trap.position.z) * k;
    }

    const nt = sim.joints.tail.tight;
    const nw = sim.joints.wall.tight;
    nutTail.position.y = lerp(0.968, 0.940, nt);
    nutWall.position.z = lerp(0.04, 0.155, nw);

    if (sim.objects.wrench.mode === 'held' && gloves) {
      const holder = gloves[sim.objects.wrench.heldBy];
      if (holder && wrench.parent !== holder.gripAnchor) {
        holder.gripAnchor.add(wrench);
        // Jaw forward of the fist, handle crossing the palm below the pad.
        wrench.position.set(0, -0.013, -0.10);
        wrench.rotation.set(0, 0, 0);
      }
    } else if (wrench.parent !== root) {
      root.add(wrench);
      wrench.position.set(state.wrenchHome.pos.x, state.wrenchHome.pos.y, state.wrenchHome.pos.z);
      wrench.rotation.copy(state.wrenchHome.rot);
    }

    const valveRad = sim.valve.angle * DEG;
    valveLever.rotation.z = valveRad;
    mats.redCap.emissiveIntensity = sim.valve.closed ? 0.25 : 0.75;

    faucetHandle.rotation.x = -0.18 - Math.max(0, sim.faucet.angle) * DEG * 0.9;

    return {
      trapWorld: trap.position,
      nutTailY: nutTail.position.y,
      nutWallZ: nutWall.position.z,
      valveKnob: valveLever.localToWorld(vTmp.set(0.076, 0, 0)).clone(),
      faucetKnob: faucetHandle.localToWorld(vTmp.set(0, 0.016, 0.069)).clone(),
      wrenchJaw: wrench.localToWorld(vTmp.set(0, 0.004, 0.262)).clone(),
      wrench,
      trap,
    };
  }

  return { root, trap, wrench, valveLever, faucetHandle, update };
}
