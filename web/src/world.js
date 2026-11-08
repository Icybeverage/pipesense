// PipeSense workshop scene: a dimensional dark under-sink training rig against
// a workshop wall. Camera is first person, just in front of the rig, looking
// down at the trap zone with the sink above it.
//
// Static geometry only. Interactive parts live in props.js; water, gas and
// leaks live in fx.js.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GEOM } from './sim.js';
import { FIXTURES } from './props.js';

export const CAMERA_HOME = {
  // Slightly right of center so the trap's U-bend (in the YZ plane) reads
  // in profile instead of edge-on.
  pos: new THREE.Vector3(0.34, 1.05, 1.24),
  target: new THREE.Vector3(0, 0.72, 0.12),
};

// Photographic surface set: albedo + derived normal/roughness maps in
// assets/tex. A missing file keeps the procedural fallback material.
const texLoader = new THREE.TextureLoader();
function surface(mat, name, repeat, { normalScale = 0.6, roughness = true, albedo = true, normal = true, tint = 0xffffff } = {}) {
  const load = (suffix, srgb, apply) => texLoader.load(`./assets/tex/${name}${suffix}.jpg`, (tex) => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
    tex.anisotropy = 8;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    apply(tex);
    mat.needsUpdate = true;
  }, undefined, () => {});
  if (albedo) load('', true, (t) => { mat.map = t; mat.color.set(tint); });
  if (normal) load('_n', false, (t) => { mat.normalMap = t; mat.normalScale.set(normalScale, normalScale); });
  if (roughness) load('_r', false, (t) => { mat.roughnessMap = t; mat.roughness = 1; });
  return mat;
}

const rbox = (w, h, d, r = 0.004) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2.2, h / 2.2, d / 2.2));

const LITE = /[?&]lite=1/.test(location.search);

// Adaptive quality. Tier 0 is the full image; each step trades fidelity
// for frame time on weak (mobile) GPUs. ?quality=0..3 pins a tier.
//   0 composer + GTAO, dpr <= 2      2 direct render, dpr 1.25, shadow 1024
//   1 GTAO off, dpr <= 1.5           3 dpr 1, hard-edged PCF shadows
const QUALITY_TIERS = [
  { gtao: true, composer: true, dpr: 2, shadow: 2048, soft: true },
  { gtao: false, composer: true, dpr: 1.5, shadow: 2048, soft: true },
  { gtao: false, composer: false, dpr: 1.25, shadow: 1024, soft: true },
  { gtao: false, composer: false, dpr: 1, shadow: 1024, soft: false },
];
const QUALITY_PIN = (() => {
  const m = /[?&]quality=([0-3])\b/.exec(location.search);
  return m ? Number(m[1]) : null;
})();
const COARSE = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
  || /Android|Mobi/i.test(navigator.userAgent || '');
const QUALITY_MIN = LITE ? 2 : 0;                   // ?lite=1 never builds the composer
const QUALITY_START = Math.max(QUALITY_MIN, QUALITY_PIN ?? (COARSE ? 1 : 0));
const FPS_WINDOW = 1.5;     // s per measurement window
const FPS_WARMUP = 2.0;     // s ignored after start and after each tier change
const FPS_DOWN = 45;        // step down after 2 consecutive windows below this
const FPS_UP = 58;          // step up after 4 consecutive windows (~6 s) above this
const FRAME_GAP = 0.25;     // s; longer gaps are tab switches / stalls, not load

export function createWorld({ canvas }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(QUALITY_TIERS[QUALITY_START].dpr, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = QUALITY_TIERS[QUALITY_START].soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070c);
  scene.fog = new THREE.FogExp2(0x0b0c0f, 0.22);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;
  scene.environmentIntensity = 0.32;
  // Real workshop light (Poly Haven CC0 HDRI) replaces the synthetic room
  // once it loads; it drives every reflection on chrome, steel and PVC.
  new RGBELoader().load('./assets/env/carpentry_shop_02_1k.hdr', (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = pmrem.fromEquirectangular(hdr).texture;
    scene.environmentIntensity = 0.55;
    scene.environmentRotation.y = 1.1;
    hdr.dispose();
    pmrem.dispose();
  }, undefined, () => pmrem.dispose());

  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.02, 40);
  camera.position.copy(CAMERA_HOME.pos);
  camera.lookAt(CAMERA_HOME.target);

  // ---------------------------------------------------------------- lights
  // Under-sink lighting: a dim kitchen ceiling light above the counter (its
  // shadow keeps the cabinet bay dark), a warm clamp-on LED work lamp on the
  // left face-frame stile as the key inside the bay, and a faint warm bounce
  // off the lit cabinet floor. Everything uses physical (inverse-square)
  // falloff so the bay darkens toward its back corners.
  const hemi = new THREE.HemisphereLight(0x4a5260, 0x1c1610, 0.16);
  scene.add(hemi);

  // Ceiling light over the counter (the key's old name is kept for the API).
  const key = new THREE.SpotLight(0xffe6c8, 9, 0, 0.7, 0.85, 2);
  key.position.set(0.25, 2.35, 1.35);
  key.target.position.set(0, 1.0, 0.25);
  key.castShadow = true;
  const startShadow = QUALITY_TIERS[QUALITY_START].shadow;
  key.shadow.mapSize.set(startShadow / 2, startShadow / 2);
  key.shadow.radius = 3;
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.01;
  key.shadow.camera.near = 0.8;
  key.shadow.camera.far = 4;
  scene.add(key, key.target);

  // Work lamp: the key light inside the bay. Clamped to the left stile,
  // aimed down and right across the trap so the trap, nuts and gloves throw
  // readable shadows onto the tile and the cabinet floor.
  const LAMP = { pos: new THREE.Vector3(-0.62, 0.90, 0.69), aim: new THREE.Vector3(0.06, 0.56, 0.24) };
  const workBase = 2.6;
  const work = new THREE.SpotLight(0xffe9d2, workBase, 0, 0.72, 0.8, 2);
  work.position.copy(LAMP.pos);
  work.target.position.copy(LAMP.aim);
  work.castShadow = true;
  work.shadow.mapSize.set(startShadow, startShadow);
  work.shadow.radius = 4;
  work.shadow.bias = -0.0009;
  work.shadow.normalBias = 0.006;
  work.shadow.camera.near = 0.12;
  work.shadow.camera.far = 2.4;
  scene.add(work, work.target);

  // Warm bounce from the lit cabinet floor and side panel (no shadows).
  const bounce = new THREE.PointLight(0xffb985, 0.10, 0, 2);
  bounce.position.set(0.12, 0.52, 0.42);
  scene.add(bounce);

  const fill = new THREE.DirectionalLight(0xc9d6e8, 0.12);
  fill.position.set(-1.1, 1.35, 2.3);
  scene.add(fill);

  // Soft camera-side task light keeps the learner's gloves readable against
  // the cabinet in both webcam use and compressed demo footage. Short range,
  // so it reads as the room light behind the learner, not a flash.
  const gloveFill = new THREE.PointLight(0xdfe8f0, 0.22, 0, 2);
  gloveFill.position.set(0.1, 0.95, 1.15);
  scene.add(gloveFill);

  // ----------------------------------------------------------------- room
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 14),
    surface(new THREE.MeshStandardMaterial({ color: 0x9a948c, roughness: 0.7, metalness: 0 }), 'floor_wood', [9, 9], { normalScale: 0.5, tint: 0x8c8780 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const wallMat = surface(new THREE.MeshStandardMaterial({ color: 0x8d8a85, roughness: 0.9, metalness: 0 }), 'painted_wall', [6, 2], { tint: 0x8f8b85, normalScale: 0.25 });
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 3.4), wallMat);
  backWall.position.set(0, 1.7, -0.02);
  backWall.receiveShadow = true;
  scene.add(backWall);
  const sideWall = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.4), wallMat);
  sideWall.rotation.y = Math.PI / 2;
  sideWall.position.set(-2.6, 1.7, 1.4);
  scene.add(sideWall);

  // Tile runs from the cabinet floor up past the counter as a backsplash.
  const tileMat = surface(new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.35 }), 'wall_tile', [2.6, 0.95], { normalScale: 1.0, tint: 0xe4e4e2 });
  const tiles = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.18), tileMat);
  tiles.position.set(0, FIXTURES.shelfY + 0.59 - 0.02, -0.012);
  tiles.receiveShadow = true;
  scene.add(tiles);

  // ----------------------------------------------------------- vanity bay
  // A real sink base: plywood carcass sides and floor, painted face frame,
  // two shaker doors swung open, a drawer front below the bay and a recessed
  // toe kick. The bay interior is x +-0.618, z -0.012..0.585; the cabinet
  // floor top is GEOM.shelf.y. None of it enters the interaction workspace.
  const IN_X = 0.618;          // inner face of the side panels
  const PANEL = 0.018;
  const FRONT_Z = 0.585;       // back of the face frame
  const FF = 0.022;            // face frame thickness
  const underY = FIXTURES.deckY - 0.045;
  const shelfY = FIXTURES.shelfY;

  const rigMat = surface(new THREE.MeshStandardMaterial({ color: 0xb59a78, roughness: 0.75, metalness: 0 }), 'plywood', [0.8, 0.8], { normalScale: 0.35, tint: 0xd8c7ae });
  const plyEdgeMat = new THREE.MeshStandardMaterial({ color: 0x9c8466, roughness: 0.85, metalness: 0 });
  const paintMat = surface(new THREE.MeshStandardMaterial({ color: 0x46515c, roughness: 0.55, metalness: 0 }), 'painted_wall', [0.6, 0.6], { albedo: false, normalScale: 0.06 });
  const kickMat = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.8 });
  const nickel = surface(new THREE.MeshStandardMaterial({ color: 0xb9bcbf, roughness: 0.32, metalness: 1 }), 'steel_brushed', [1, 1], { albedo: false, normal: false });
  const counterMat = surface(new THREE.MeshPhysicalMaterial({ color: 0x3a3b3e, roughness: 0.3, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.15 }), 'counter', [1.4, 0.7], { normalScale: 0.2, roughness: false });
  const rig = new THREE.Group();
  scene.add(rig);

  const add = (mesh, parent = rig, cast = true, receive = true) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    parent.add(mesh);
    return mesh;
  };

  // Countertop runs the length of the kitchen; the sink base sits mid-run.
  const counter = add(new THREE.Mesh(rbox(1.32, 0.045, 0.62, 0.006), counterMat));
  counter.position.set(0, FIXTURES.deckY - 0.0225, 0.31);
  for (const sx of [-1, 1]) {
    const run = add(new THREE.Mesh(rbox(1.6, 0.045, 0.62, 0.006), counterMat));
    run.position.set(sx * (0.66 + 0.8 + 0.001), FIXTURES.deckY - 0.0225, 0.31);
  }
  const splash = add(new THREE.Mesh(rbox(4.5, 0.10, 0.02, 0.004), counterMat), rig, false);
  splash.position.set(0, FIXTURES.deckY + 0.05, 0.0);

  // Carcass sides, wall to face frame, floor to counter underside.
  for (const sx of [-1, 1]) {
    const side = add(new THREE.Mesh(new THREE.BoxGeometry(PANEL, underY, FRONT_Z + 0.012), rigMat));
    side.position.set(sx * (IN_X + PANEL / 2), underY / 2, (FRONT_Z - 0.012) / 2);
  }
  // Cabinet floor (the shelf the trap and wrench rest on): top at shelfY.
  const shelf = add(new THREE.Mesh(new THREE.BoxGeometry(IN_X * 2, 0.018, FRONT_Z + 0.012), rigMat));
  shelf.position.set(0, shelfY - 0.009, (FRONT_Z - 0.012) / 2);
  // Plywood edge banding visible at the bay front.
  const shelfEdge = add(new THREE.Mesh(new THREE.BoxGeometry(IN_X * 2, 0.018, 0.002), plyEdgeMat), rig, false);
  shelfEdge.position.set(0, shelfY - 0.009, FRONT_Z + 0.001);

  // Face frame: two stiles, top rail under the counter, bottom rail at the
  // cabinet floor, and a drawer front + toe kick below the bay.
  const ffZ = FRONT_Z + FF / 2;
  for (const sx of [-1, 1]) {
    const stile = add(new THREE.Mesh(rbox(0.058, underY - 0.09, FF, 0.003), paintMat));
    stile.position.set(sx * (IN_X + PANEL - 0.029 + 0.012), 0.09 + (underY - 0.09) / 2, ffZ);
  }
  const topRail = add(new THREE.Mesh(rbox(IN_X * 2, 0.045, FF, 0.003), paintMat));
  topRail.position.set(0, underY - 0.0225, ffZ);
  const botRail = add(new THREE.Mesh(rbox(IN_X * 2, 0.04, FF, 0.003), paintMat));
  botRail.position.set(0, shelfY + 0.012 - 0.02, ffZ);
  const drawer = add(new THREE.Mesh(rbox(IN_X * 2 - 0.01, shelfY - 0.03 - 0.10, 0.02, 0.004), paintMat));
  drawer.position.set(0, 0.10 + (shelfY - 0.03 - 0.10) / 2, FRONT_Z + FF + 0.01);
  const pull = add(new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.16, 12), nickel));
  pull.rotation.z = Math.PI / 2;
  pull.position.set(0, 0.10 + (shelfY - 0.13) * 0.72, FRONT_Z + FF + 0.04);
  for (const px of [-0.07, 0.07]) {
    const post = add(new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.02, 8), nickel), rig, false);
    post.rotation.x = Math.PI / 2;
    post.position.set(px, pull.position.y, FRONT_Z + FF + 0.03);
  }
  const kick = add(new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.10, 0.02), kickMat), rig, false);
  kick.position.set(0, 0.05, FRONT_Z - 0.06);

  // Shaker door: rails/stiles around a recessed centre panel, bar pull.
  function shakerDoor(w, h) {
    const g = new THREE.Group();
    const t = 0.02;
    const rail = 0.065;
    const panel = add(new THREE.Mesh(new THREE.BoxGeometry(w - rail * 1.6, h - rail * 1.6, 0.008), paintMat), g);
    panel.position.set(0, 0, -0.004);
    for (const sy of [-1, 1]) {
      const r = add(new THREE.Mesh(rbox(w, rail, t, 0.003), paintMat), g);
      r.position.set(0, sy * (h / 2 - rail / 2), 0);
    }
    for (const sx of [-1, 1]) {
      const s = add(new THREE.Mesh(rbox(rail, h - rail * 2 + 0.002, t, 0.003), paintMat), g);
      s.position.set(sx * (w / 2 - rail / 2), 0, 0);
    }
    const back = add(new THREE.Mesh(new THREE.BoxGeometry(w - 0.004, h - 0.004, 0.004), rigMat), g, false);
    back.position.z = -t / 2 + 0.001;
    const bar = add(new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.13, 12), nickel), g);
    bar.position.set(0, 0, t / 2 + 0.028);
    g.userData.bar = bar;
    return g;
  }

  // Two doors swung open ~115 degrees; hinges on the outer stile edges.
  const doorH = underY - 0.045 - (shelfY + 0.02) - 0.006;
  const doorW = IN_X + PANEL + 0.006;
  for (const sx of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(sx * (IN_X + PANEL + 0.006), shelfY + 0.02 + doorH / 2 + 0.003, FRONT_Z + FF + 0.011);
    hinge.rotation.y = sx * 2.0;
    const door = shakerDoor(doorW, doorH);
    door.position.set(-sx * doorW / 2, 0, 0.011);
    door.userData.bar.position.x = -sx * (doorW / 2 - 0.045);
    hinge.add(door);
    rig.add(hinge);
  }

  // Neighbouring base cabinets (closed) so the sink base sits in a kitchen
  // run rather than floating in a workshop.
  for (const sx of [-1, 1]) {
    const box = add(new THREE.Mesh(new THREE.BoxGeometry(1.6, underY - 0.1, FRONT_Z), paintMat));
    box.position.set(sx * (IN_X + PANEL + 0.8), 0.1 + (underY - 0.1) / 2, FRONT_Z / 2 - 0.012);
    for (let i = 0; i < 2; i++) {
      const door = shakerDoor(0.39, underY - 0.14);
      door.position.set(sx * (IN_X + PANEL + 0.24 + i * 0.4), 0.1 + (underY - 0.1) / 2, FRONT_Z + 0.012);
      door.userData.bar.position.x = (i === 0 ? 1 : -1) * 0.15;
      rig.add(door);
    }
  }

  const bowlMat = surface(new THREE.MeshStandardMaterial({ color: 0xc4c9ce, roughness: 0.3, metalness: 1, side: THREE.BackSide }), 'steel_brushed', [3, 1], { albedo: false, normal: false });
  const basin = [[0.034, -0.08], [0.11, -0.08], [0.17, -0.077], [0.21, -0.066], [0.24, -0.044], [0.258, -0.012], [0.267, 0.03], [0.27, 0.074], [0.30, 0.078], [0.30, 0.084]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const bowl = new THREE.Mesh(new THREE.LatheGeometry(basin, 72), bowlMat);
  bowl.castShadow = true;
  bowl.scale.set(1.2, 1, 0.86);
  bowl.position.set(0, FIXTURES.deckY - 0.105, GEOM.tail.z);
  rig.add(bowl);
  // Underside of a real stainless bowl: grey spray-on sound-deadening
  // undercoat, matte and pebbled, instead of a mirror finish.
  const undercoat = new THREE.Mesh(bowl.geometry, surface(new THREE.MeshStandardMaterial({ color: 0x8e8f8b, roughness: 0.9, metalness: 0, side: THREE.FrontSide }), 'concrete', [6, 2], { albedo: false, roughness: false, normalScale: 0.8 }));
  undercoat.scale.copy(bowl.scale).multiplyScalar(1.004);
  undercoat.position.copy(bowl.position);
  undercoat.receiveShadow = true;
  rig.add(undercoat);
  const sinkRim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.011, 10, 44), Object.assign(bowlMat.clone(), { side: THREE.FrontSide }));
  sinkRim.rotation.x = Math.PI / 2;
  sinkRim.scale.set(0.335, 0.288, 1);
  sinkRim.position.set(0, FIXTURES.deckY - 0.002, GEOM.tail.z);
  rig.add(sinkRim);
  const strainer = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.005, 22), new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.4, metalness: 0.85 }));
  strainer.position.set(0, FIXTURES.deckY - 0.185, GEOM.tail.z);
  rig.add(strainer);
  const drainShoe = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.034, 0.03, 20), new THREE.MeshStandardMaterial({ color: 0x606770, roughness: 0.35, metalness: 0.9 }));
  drainShoe.position.set(0, FIXTURES.deckY - 0.20, GEOM.tail.z);
  rig.add(drainShoe);

  // ------------------------------------------------------- static plumbing
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.22, metalness: 1 });
  const agedSteel = new THREE.MeshStandardMaterial({ color: 0x878e97, roughness: 0.42, metalness: 0.9 });
  const brass = new THREE.MeshStandardMaterial({ color: 0x8c7a4e, roughness: 0.45, metalness: 0.85 });

  const tailTop = FIXTURES.deckY - 0.20;
  const tailLen = tailTop - GEOM.tail.endY;
  const tailpiece = new THREE.Mesh(new THREE.CylinderGeometry(0.0215, 0.0215, tailLen, 26), chrome);
  tailpiece.position.set(GEOM.tail.x, GEOM.tail.endY + tailLen / 2, GEOM.tail.z);
  tailpiece.castShadow = true;
  rig.add(tailpiece);
  const tailBead = new THREE.Mesh(new THREE.TorusGeometry(0.0215, 0.0035, 8, 24), chrome);
  tailBead.rotation.x = Math.PI / 2;
  tailBead.position.set(GEOM.tail.x, GEOM.tail.endY + 0.035, GEOM.tail.z);
  rig.add(tailBead);
  const tailCut = new THREE.Mesh(new THREE.CylinderGeometry(0.0185, 0.0185, 0.006, 26), new THREE.MeshStandardMaterial({ color: 0x181c22, roughness: 0.6, metalness: 0.4 }));
  tailCut.position.set(GEOM.tail.x, GEOM.tail.endY + 0.002, GEOM.tail.z);
  rig.add(tailCut);

  const armLen = GEOM.wall.endZ;
  const wallArm = new THREE.Mesh(new THREE.CylinderGeometry(0.0215, 0.0215, armLen, 26), agedSteel);
  wallArm.rotation.x = Math.PI / 2;
  wallArm.position.set(0, GEOM.wall.y, armLen / 2);
  wallArm.castShadow = true;
  rig.add(wallArm);
  const armCut = new THREE.Mesh(new THREE.CylinderGeometry(0.0185, 0.0185, 0.006, 26), new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.6, metalness: 0.4 }));
  armCut.rotation.x = Math.PI / 2;
  armCut.position.set(0, GEOM.wall.y, GEOM.wall.endZ - 0.002);
  rig.add(armCut);
  const escutcheon = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.043, 0.012, 24), brass);
  escutcheon.rotation.x = Math.PI / 2;
  escutcheon.position.set(0, GEOM.wall.y, 0.006);
  rig.add(escutcheon);

  // Angle stop valve on the wall, supply tube up to the faucet.
  const vp = FIXTURES.valvePivot;
  const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.055, 16), brass);
  stub.rotation.x = Math.PI / 2;
  stub.position.set(vp.x, vp.y, 0.03);
  rig.add(stub);
  const valveBody = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.026, 0.05, 6), brass);
  valveBody.rotation.x = Math.PI / 2;
  valveBody.position.set(vp.x, vp.y, 0.082);
  valveBody.castShadow = true;
  rig.add(valveBody);
  const bonnet = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.015, 0.03, 14), agedSteel);
  bonnet.rotation.x = Math.PI / 2;
  bonnet.position.set(vp.x, vp.y, 0.115);
  rig.add(bonnet);

  const tubeCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(vp.x, vp.y + 0.01, 0.135),
    new THREE.Vector3(vp.x + 0.12, vp.y + 0.12, 0.185),
    new THREE.Vector3(-0.05, FIXTURES.deckY + 0.02, 0.155),
    new THREE.Vector3(0.2, FIXTURES.deckY + 0.03, 0.145),
    new THREE.Vector3(0.30, FIXTURES.deckY + 0.035, 0.138),
  ]);
  const supplyTube = new THREE.Mesh(
    new THREE.TubeGeometry(tubeCurve, 60, 0.0085, 12, false),
    new THREE.MeshStandardMaterial({ color: 0x565c64, roughness: 0.55, metalness: 0.7 }),
  );
  supplyTube.castShadow = true;
  rig.add(supplyTube);

  // Faucet body (the handle is an interactive prop anchored at FIXTURES.faucetPivot).
  const faucetBase = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.024, 0.06, 18), chrome);
  faucetBase.position.set(0.30, FIXTURES.deckY + 0.03, 0.14);
  faucetBase.castShadow = true;
  rig.add(faucetBase);
  const faucetBall = new THREE.Mesh(new THREE.SphereGeometry(0.026, 18, 14), chrome);
  faucetBall.position.set(0.30, FIXTURES.deckY + 0.075, 0.14);
  rig.add(faucetBall);
  const spoutCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.30, FIXTURES.deckY + 0.075, 0.14),
    new THREE.Vector3(0.28, FIXTURES.deckY + 0.135, 0.18),
    new THREE.Vector3(0.20, FIXTURES.deckY + 0.125, 0.245),
    new THREE.Vector3(0.13, FIXTURES.deckY + 0.075, 0.285),
    new THREE.Vector3(0.11, FIXTURES.deckY + 0.02, 0.295),
  ]);
  const spout = new THREE.Mesh(new THREE.TubeGeometry(spoutCurve, 60, 0.0135, 14, false), chrome);
  spout.castShadow = true;
  rig.add(spout);
  const aerator = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.014, 14), agedSteel);
  aerator.position.set(0.11, FIXTURES.deckY + 0.012, 0.295);
  rig.add(aerator);

  // ------------------------------------------------- baked occlusion cards
  // Static ambient occlusion for the bay, baked into small greyscale cards
  // and multiplied over the surfaces they sit on. Free at every quality tier
  // (GTAO adds dynamic contact on top at tier 0): corners under the counter,
  // where the floor meets the sides and back, and behind the face frame.
  function aoCard(w, h, edges, { size = 128, blobs = [] } = {}) {
    // edges: { top, right, bottom, left } -> [strength, falloff (fraction of w/h)]
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size;
        const v = (y + 0.5) / size;
        let k = 1;
        const e = (s, d, f) => { if (s) k *= 1 - s * Math.exp(-d / f); };
        if (edges.top) e(edges.top[0], v, edges.top[1]);
        if (edges.bottom) e(edges.bottom[0], 1 - v, edges.bottom[1]);
        if (edges.left) e(edges.left[0], u, edges.left[1]);
        if (edges.right) e(edges.right[0], 1 - u, edges.right[1]);
        for (const [bx, by, br, bs] of blobs) {
          const d = Math.hypot((u - bx) * w, (v - by) * h) / br;
          k *= 1 - bs * Math.exp(-d * d);
        }
        const g = Math.round(Math.max(0, Math.min(1, k)) * 255);
        const i = (y * size + x) * 4;
        img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
      map: tex, blending: THREE.MultiplyBlending, premultipliedAlpha: true, transparent: true,
      depthWrite: false, toneMapped: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }));
    mesh.renderOrder = 1;
    rig.add(mesh);
    return mesh;
  }
  const bayH = underY - shelfY;
  const bayMidY = shelfY + bayH / 2;
  // Back wall of the bay.
  const aoBack = aoCard(IN_X * 2, bayH, { top: [0.7, 0.16], bottom: [0.55, 0.06], left: [0.45, 0.07], right: [0.45, 0.07] });
  aoBack.position.set(0, bayMidY, -0.0105);
  // Side panels (inner faces).
  for (const sx of [-1, 1]) {
    const card = aoCard(FRONT_Z + 0.012, bayH, { top: [0.6, 0.14], bottom: [0.5, 0.06], left: [0.5, 0.1], right: [0.2, 0.03] });
    card.rotation.y = -sx * Math.PI / 2;
    card.position.set(sx * (IN_X - 0.0005), bayMidY, (FRONT_Z - 0.012) / 2);
  }
  // Cabinet floor: dark into the back and side corners, a grimy ring under
  // the drain where drips land, and a soft contact under the stored bottle.
  const aoFloor = aoCard(IN_X * 2, FRONT_Z + 0.012, { top: [0.6, 0.08], left: [0.5, 0.05], right: [0.5, 0.05], bottom: [0.25, 0.02] }, {
    blobs: [[0.5 + GEOM.tail.x / (IN_X * 2), (GEOM.tail.z + 0.012) / (FRONT_Z + 0.012), 0.11, 0.18], [0.5 + -0.5 / (IN_X * 2), 0.27, 0.06, 0.35]],
  });
  aoFloor.rotation.x = -Math.PI / 2;
  aoFloor.position.set(0, shelfY + 0.0006, (FRONT_Z - 0.012) / 2);
  // Counter underside above the bay.
  const aoTop = aoCard(IN_X * 2, FRONT_Z, { top: [0.5, 0.12], left: [0.4, 0.06], right: [0.4, 0.06] });
  aoTop.rotation.x = Math.PI / 2;
  aoTop.position.set(0, underY - 0.0006, FRONT_Z / 2 - 0.012);
  // Room floor in front of the toe kick.
  const aoKick = aoCard(4.6, 0.5, { top: [0.55, 0.12] });
  aoKick.rotation.x = -Math.PI / 2;
  aoKick.position.set(0, 0.0008, FRONT_Z - 0.05 + 0.25);

  // ------------------------------------------------------------ grime decals
  // Hard-water and drip marks: a tide-line stain on the cabinet floor under
  // the trap and a faint rust streak below the wall-arm escutcheon.
  function stainTexture(seed, draw) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext('2d');
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    draw(ctx, rnd);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const floorStain = stainTexture(17, (ctx, rnd) => {
    ctx.clearRect(0, 0, 256, 256);
    for (let i = 0; i < 9; i++) {
      const cx = 128 + (rnd() - 0.5) * 70;
      const cy = 128 + (rnd() - 0.5) * 70;
      const r = 20 + rnd() * 55;
      // tide line: darker rim, lighter centre, like dried drips on ply
      const g = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
      g.addColorStop(0, 'rgba(70,48,25,0.0)');
      g.addColorStop(0.82, `rgba(70,46,22,${0.10 + rnd() * 0.12})`);
      g.addColorStop(0.92, `rgba(55,36,18,${0.20 + rnd() * 0.15})`);
      g.addColorStop(1, 'rgba(60,40,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * (0.7 + rnd() * 0.3), rnd() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  const stainMat = (map, opacity, roughness) => new THREE.MeshStandardMaterial({
    map, transparent: true, opacity, roughness, metalness: 0, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
  });
  const stainFloor = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.30), stainMat(floorStain, 0.9, 0.6));
  stainFloor.rotation.x = -Math.PI / 2;
  stainFloor.position.set(GEOM.tail.x + 0.02, shelfY + 0.0009, GEOM.tail.z - 0.02);
  stainFloor.receiveShadow = true;
  stainFloor.renderOrder = 2;
  rig.add(stainFloor);
  const streakTex = stainTexture(5, (ctx, rnd) => {
    ctx.clearRect(0, 0, 256, 256);
    for (let i = 0; i < 6; i++) {
      const x = 118 + (rnd() - 0.5) * 30;
      const w = 4 + rnd() * 10;
      const len = 90 + rnd() * 140;
      const g = ctx.createLinearGradient(0, 20, 0, 20 + len);
      g.addColorStop(0, `rgba(120,72,30,${0.35 + rnd() * 0.25})`);
      g.addColorStop(1, 'rgba(120,80,40,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - w / 2, 20, w, len);
    }
  });
  const streak = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.16), stainMat(streakTex, 0.55, 0.5));
  streak.position.set(0, GEOM.wall.y - 0.105, -0.0095);
  streak.renderOrder = 2;
  rig.add(streak);

  // --------------------------------------------------------- under-sink kit
  // A few stored items in the back corners, out of the workspace and below
  // the valve's sightline: a cleaner bottle, a sponge and the work lamp.
  const bottle = new THREE.Group();
  const bottleProfile = [[0, 0], [0.034, 0], [0.037, 0.006], [0.037, 0.15], [0.03, 0.18], [0.014, 0.2], [0.014, 0.215], [0, 0.215]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const bottleBody = new THREE.Mesh(new THREE.LatheGeometry(bottleProfile, 28), new THREE.MeshPhysicalMaterial({ color: 0x2f6f9e, roughness: 0.32, clearcoat: 0.5, clearcoatRoughness: 0.3 }));
  bottleBody.scale.set(1, 1, 0.68);
  add(bottleBody, bottle);
  const label = new THREE.Mesh(new THREE.CylinderGeometry(0.0375, 0.0375, 0.08, 28, 1, true, -0.9, 1.8), new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.7 }));
  label.scale.set(1, 1, 0.68);
  label.position.y = 0.085;
  add(label, bottle, false);
  const trigger = new THREE.Mesh(rbox(0.022, 0.035, 0.07, 0.006), new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.45 }));
  trigger.position.set(0, 0.23, 0.02);
  add(trigger, bottle);
  bottle.position.set(-0.50, shelfY, 0.16);
  bottle.rotation.y = 0.5;
  rig.add(bottle);

  const sponge = new THREE.Group();
  const spongeBody = add(new THREE.Mesh(rbox(0.09, 0.022, 0.06, 0.006), new THREE.MeshStandardMaterial({ color: 0xd9b84a, roughness: 0.95 })), sponge);
  spongeBody.position.y = 0.011;
  const scour = add(new THREE.Mesh(rbox(0.09, 0.01, 0.06, 0.003), new THREE.MeshStandardMaterial({ color: 0x2f5d3a, roughness: 1 })), sponge);
  scour.position.y = 0.027;
  sponge.position.set(0.47, shelfY, 0.12);
  sponge.rotation.y = -0.35;
  rig.add(sponge);

  // Clamp-on LED work lamp on the left stile (the bay's key light).
  const lampHead = new THREE.Group();
  const lampShell = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.5, metalness: 0.3 });
  const housing = add(new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.026, 0.045, 20, 1, true), lampShell), lampHead);
  housing.rotation.x = Math.PI / 2;
  housing.material.side = THREE.DoubleSide;
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.025, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff1d8).multiplyScalar(4) }));
  lens.position.z = -0.0226;
  lens.rotation.y = Math.PI;
  lampHead.add(lens);
  const back = add(new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.008, 20), lampShell), lampHead);
  back.rotation.x = Math.PI / 2;
  back.position.z = 0.0225;
  lampHead.position.copy(LAMP.pos);
  lampHead.lookAt(LAMP.pos.clone().multiplyScalar(2).sub(LAMP.aim));
  rig.add(lampHead);
  const clamp = add(new THREE.Mesh(rbox(0.03, 0.05, 0.05, 0.004), new THREE.MeshStandardMaterial({ color: 0xc8551d, roughness: 0.5 })));
  clamp.position.set(LAMP.pos.x - 0.025, LAMP.pos.y - 0.06, FRONT_Z + FF / 2);
  const arm = add(new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.06, 8), lampShell));
  arm.position.set(LAMP.pos.x - 0.012, LAMP.pos.y - 0.03, (LAMP.pos.z + FRONT_Z) / 2);
  arm.rotation.x = 0.9;
  // The lamp housing casts nothing: its light originates inside it.
  lampHead.traverse((o) => { o.castShadow = false; });

  // Bucket on the floor beside the bay, as a plumber would leave it.
  const bucketMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.6, side: THREE.DoubleSide });
  const bucket = new THREE.Group();
  add(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.125, 0.30, 28, 1, true), bucketMat), bucket);
  bucket.children[0].position.y = 0.15;
  const bucketBase = add(new THREE.Mesh(new THREE.CircleGeometry(0.125, 28), bucketMat), bucket, false);
  bucketBase.rotation.x = -Math.PI / 2;
  bucketBase.position.y = 0.004;
  const bucketLip = add(new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.006, 6, 32), bucketMat), bucket);
  bucketLip.rotation.x = Math.PI / 2;
  bucketLip.position.y = 0.30;
  bucket.position.set(0.95, 0, 0.92);
  rig.add(bucket);
  // -------------------------------------------------------------- dust motes
  const moteCount = 90;
  const motePos = new Float32Array(moteCount * 3);
  const moteSeed = new Float32Array(moteCount);
  let a = 99;
  const rnd = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < moteCount; i++) {
    // Only inside the bay, where the work lamp's beam would catch them.
    motePos[i * 3] = (rnd() - 0.5) * 1.1;
    motePos[i * 3 + 1] = 0.48 + rnd() * 0.55;
    motePos[i * 3 + 2] = 0.05 + rnd() * 0.75;
    moteSeed[i] = rnd() * Math.PI * 2;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({
    color: 0xfff0dc, size: 0.0028, transparent: true, opacity: 0.16,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  scene.add(motes);

  const baseMote = motePos.slice();

  // ----------------------------------------------------- post (lens/film)
  // Ambient occlusion grounds every joint and shelf contact; a faint bloom
  // and SMAA finish the image. ?lite=1 renders straight for weak GPUs, and the
  // quality governor below drops these passes on its own when frames run long.
  let composer = null;
  let gtao = null;
  if (!LITE) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    gtao = new GTAOPass(scene, camera, 1280, 720);
    gtao.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.6, thickness: 1.2, scale: 1.1, samples: 12 });
    gtao.blendIntensity = 0.85;
    composer.addPass(gtao);
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.18, 0.5, 0.92));
    composer.addPass(new OutputPass());
    composer.addPass(new SMAAPass(1280, 720));
  }

  let viewW = 1;
  let viewH = 1;

  function resize(width, height) {
    viewW = width;
    viewH = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    if (composer) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(width, height);
    }
  }

  // ------------------------------------------------------ quality governor
  // Rolling frame-rate windows decide the tier: quick to step down when a
  // tablet GPU struggles, slow and one step at a time to step back up. A
  // tier that drops again right after a step up becomes the ceiling, so the
  // image never oscillates during a demo. Render-only: scene, camera and the
  // simulation are untouched.
  let tier = -1;
  let ceiling = QUALITY_START;        // best tier the governor may climb back to
  let fps = 0;
  let lastFrame = 0;
  let settleUntil = 0;
  let winStart = 0;
  let winFrames = 0;
  let slowWindows = 0;
  let fastWindows = 0;
  let lastStepUp = false;

  function applyTier(next) {
    const prev = QUALITY_TIERS[tier] || null;
    const t = QUALITY_TIERS[next];
    tier = next;
    if (gtao) gtao.enabled = t.gtao;
    // The ceiling light's shadow (it keeps the bay dark) is a second shadow
    // pass: tiers 0-1 only. Below that the counter still blocks it visually
    // through the baked occlusion cards, and the work lamp keeps its shadow.
    key.castShadow = next <= 1;
    key.intensity = next <= 1 ? 9 : 3.5; // unshadowed, it would flood the bay
    if (!prev || prev.shadow !== t.shadow || prev.soft !== t.soft) {
      key.shadow.mapSize.set(t.shadow / 2, t.shadow / 2);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
      work.shadow.mapSize.set(t.shadow, t.shadow);
      if (work.shadow.map) { work.shadow.map.dispose(); work.shadow.map = null; }
      const type = t.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
      if (renderer.shadowMap.type !== type) {
        renderer.shadowMap.type = type;
        // Shadow filtering is compiled into each program; rebuild them.
        scene.traverse((o) => {
          if (!o.material) return;
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
        });
      }
    }
    const dpr = Math.min(t.dpr, window.devicePixelRatio || 1);
    if (renderer.getPixelRatio() !== dpr) {
      renderer.setPixelRatio(dpr);
      resize(viewW, viewH);
    }
  }
  applyTier(QUALITY_START);

  function govern(now) {
    if (!lastFrame || document.hidden || now - lastFrame > FRAME_GAP * 1000) {
      // First frame, hidden tab or a long stall: restart the window.
      lastFrame = now;
      winStart = now;
      winFrames = 0;
      if (!settleUntil) settleUntil = now + FPS_WARMUP * 1000;
      return;
    }
    lastFrame = now;
    if (now < settleUntil) { winStart = now; winFrames = 0; return; }
    winFrames++;
    const span = (now - winStart) / 1000;
    if (span < FPS_WINDOW) return;
    fps = Math.round((winFrames / span) * 10) / 10;
    winStart = now;
    winFrames = 0;
    if (QUALITY_PIN !== null) return;
    slowWindows = fps < FPS_DOWN ? slowWindows + 1 : 0;
    fastWindows = fps > FPS_UP ? fastWindows + 1 : 0;
    if (slowWindows >= 2 && tier < QUALITY_TIERS.length - 1) {
      if (lastStepUp) ceiling = tier + 1; // bounced: the better tier cannot hold
      lastStepUp = false;
      step(tier + 1, now);
    } else if (fastWindows >= 4 && tier > Math.max(ceiling, QUALITY_MIN)) {
      lastStepUp = true;
      step(tier - 1, now);
    }
  }

  function step(next, now) {
    applyTier(next);
    slowWindows = 0;
    fastWindows = 0;
    settleUntil = now + FPS_WARMUP * 1000; // shader rebuilds and new targets
  }

  function render() {
    govern(performance.now());
    if (composer && QUALITY_TIERS[tier].composer) composer.render();
    else renderer.render(scene, camera);
  }

  function update(time) {
    // Dust drift keeps the air in the lamp beam alive.
    const positions = moteGeo.getAttribute('position');
    for (let i = 0; i < moteCount; i++) {
      const seed = moteSeed[i];
      positions.array[i * 3] = baseMote[i * 3] + Math.sin(time * 0.13 + seed) * 0.05;
      positions.array[i * 3 + 1] = baseMote[i * 3 + 1] + Math.sin(time * 0.09 + seed * 1.7) * 0.06;
      positions.array[i * 3 + 2] = baseMote[i * 3 + 2] + Math.cos(time * 0.11 + seed) * 0.04;
    }
    positions.needsUpdate = true;
    // LED work lamps don't flicker; a barely-there drift keeps it alive.
    work.intensity = workBase * (1 + Math.sin(time * 0.7) * 0.006);
  }

  return {
    renderer, scene, camera, resize, update, render, key,
    // Read-only: current tier, last measured fps, and whether ?quality pinned it.
    get quality() { return { tier, fps, pinned: QUALITY_PIN !== null, ceiling }; },
  };
}
