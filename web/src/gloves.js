// PipeSense virtual work gloves.
//
// A glove is a procedural rig: palm + cuff + 5 articulated fingers, driven by
// a pose supplied by the input layer (MediaPipe's 21 landmarks per hand, or
// the silent QA channel in automated test sessions). Local frame: fingers
// extend along +Z, the palm normal is -Y, the thumb sits on +X for the right
// hand and -X for the left. Each finger is a chain of tapered phalanges that
// share the radius at every joint and are covered by a rounded joint volume,
// so the silhouette reads as one padded work glove rather than separate
// capsules. The palm masses (thenar, hypothenar, back dome, knuckle row and
// finger-base webbing) overlap into the same continuous shell.
//
// Anchors are ordinary Object3D nodes, so every consumer can read them in
// world space with getWorldPosition(): pinchAnchor is the thumb/index grasp
// midpoint, gripAnchor carries the wrench, and `anchors` exposes the palm plus
// all five fingertips for full-hand contact.
//
// The rendered shell is Emma Lieker's anatomically constrained skinned hand
// model (see web/assets/models/SOURCE.md), loaded asynchronously per side. The procedural
// rig above stays in the scene graph as the interaction fallback: it is hidden
// once an anatomical model binds successfully and stays visible when the asset
// is missing or cannot be mapped. The shell is fitted onto the procedural
// knuckle row and finger length, and once it binds the fingertip anchors are
// re-parented onto its distal bones (the palm anchor onto its palm surface),
// so pinchAnchor and gripAnchor are derived from the fingers the learner sees.
//
// root rotation defaults to yaw PI, so an idle glove points into the scene.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Anatomical shell. Paths are relative to web/index.html.
const MODEL_URL = {
  left: 'assets/models/hand_left.glb',
  right: 'assets/models/hand_right.glb',
};
// Target hand length in metres, matching the procedural rig (palm + fingers).
const HAND_LENGTH = 0.20;
// The procedural rig is centred near the palm, not the wrist, so the
// normalised model is offset to share that centre.
const MODEL_CENTRE_Z = 0.06;

const PALM = { w: 0.095, t: 0.036, l: 0.112, front: 0.108 };
const FINGERS = [
  { key: 'index', x: 0.031, dz: 0.000, lens: [0.043, 0.029, 0.021], w: 0.0220, curlMax: [1.35, 1.5, 0.8] },
  { key: 'middle', x: 0.010, dz: 0.005, lens: [0.047, 0.032, 0.022], w: 0.0230, curlMax: [1.3, 1.5, 0.8] },
  { key: 'ring', x: -0.011, dz: 0.001, lens: [0.043, 0.029, 0.021], w: 0.0215, curlMax: [1.3, 1.5, 0.85] },
  { key: 'pinky', x: -0.033, dz: -0.008, lens: [0.035, 0.024, 0.018], w: 0.0190, curlMax: [1.25, 1.45, 0.9] },
];
const THUMB = { lens: [0.036, 0.027, 0.020], w: 0.025 };

export const FINGER_ORDER = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const ANCHOR_KEYS = ['palm', ...FINGER_ORDER];

const LEATHER_SURFACE = makeLeatherSurface();

function fract(v) {
  return v - Math.floor(v);
}

function hash2(x, y, seed) {
  return fract(Math.sin((x + seed * 13.13) * 127.1 + (y + seed * 0.73) * 311.7) * 43758.5453123);
}

function smoothNoise(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  const ab = a + (b - a) * sx;
  const cd = c + (d - c) * sx;
  return ab + (cd - ab) * sy;
}

function octaveNoise(x, y, seed) {
  let freq = 1;
  let amp = 0.55;
  let total = 0;
  let norm = 0;
  for (let i = 0; i < 4; i++) {
    total += smoothNoise(x * freq, y * freq, seed + i * 7.17) * amp;
    norm += amp;
    freq *= 2.1;
    amp *= 0.5;
  }
  return total / norm;
}

function makeLeatherSurface() {
  const size = 192;
  const diffuseData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size);
  const normalData = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const warmTint = new THREE.Color(0x493d35);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const n0 = octaveNoise(x / 38, y / 38, 2.17);
      const n1 = octaveNoise(x / 15.5, y / 15.5, 7.83);
      const n2 = octaveNoise((x + 31) / 6.5, (y + 11) / 6.5, 18.11);
      const micro = n0 * 0.56 + n1 * 0.30 + n2 * 0.14;
      const grain = Math.pow(Math.max(0.0, micro), 1.35);
      const wear = Math.max(0, octaveNoise((x + 70) / 57, (y + 26) / 57, 24.2) - 0.46) * 1.8;
      const tint = wear * 0.16;
      height[i] = grain * 0.85 + wear * 0.45;
      // Keep the grain light enough to carry an industrial glove colour in a
      // dark under-sink bay. The previous near-black albedo multiplied every
      // material colour down until the hands disappeared in captured video.
      const base = 118 + Math.floor(grain * 44);
      diffuseData[i * 4 + 0] = Math.min(255, base + Math.floor(warmTint.r * 255 * tint));
      diffuseData[i * 4 + 1] = Math.min(255, base + Math.floor(warmTint.g * 255 * tint));
      diffuseData[i * 4 + 2] = Math.min(255, base + Math.floor(warmTint.b * 255 * tint));
      diffuseData[i * 4 + 3] = 255;
      // A flat, high roughness map keeps nitrile/leather matte: the former
      // wide range produced bright specular blooms that made the finger
      // phalanges read as hard, shiny robot segments.
      roughData[i] = 208 + Math.floor((1 - grain) * 34 + wear * 8);
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const xl = (x + size - 1) % size;
      const xr = (x + 1) % size;
      const yu = (y + size - 1) % size;
      const yd = (y + 1) % size;
      const dx = height[y * size + xr] - height[y * size + xl];
      const dy = height[yd * size + x] - height[yu * size + x];
      const n = new THREE.Vector3(-dx * 2.2, -dy * 2.2, 1).normalize();
      normalData[i * 4 + 0] = Math.floor((n.x * 0.5 + 0.5) * 255);
      normalData[i * 4 + 1] = Math.floor((n.y * 0.5 + 0.5) * 255);
      normalData[i * 4 + 2] = Math.floor((n.z * 0.5 + 0.5) * 255);
      normalData[i * 4 + 3] = 255;
    }
  }

  const wrap = THREE.RepeatWrapping;
  const diffuseMap = new THREE.DataTexture(diffuseData, size, size, THREE.RGBAFormat);
  const roughnessMap = new THREE.DataTexture(roughData, size, size, THREE.RedFormat);
  const normalMap = new THREE.DataTexture(normalData, size, size, THREE.RGBAFormat);
  [diffuseMap, roughnessMap, normalMap].forEach((tex) => {
    tex.wrapS = wrap;
    tex.wrapT = wrap;
    tex.needsUpdate = true;
    tex.colorSpace = THREE.NoColorSpace;
  });
  diffuseMap.colorSpace = THREE.SRGBColorSpace;
  return { diffuseMap, roughnessMap, normalMap };
}

function leather(color, rough = 0.95, repeat = 3.4) {
  const base = new THREE.Color(color);
  const mat = new THREE.MeshStandardMaterial({
    color: base,
    normalMap: LEATHER_SURFACE.normalMap.clone(),
    // Full roughness and almost no environment response give the glove a
    // fabric/rubber response instead of the metallic highlights seen in the
    // previous capture. The brighter diffuse grain preserves visibility.
    roughness: Math.max(0.82, rough * 0.86),
    metalness: 0,
    normalScale: new THREE.Vector2(0.22, 0.22),
    envMapIntensity: 0.45,
  });
  mat.normalMap.repeat.set(repeat, repeat);
  return mat;
}

// Radii along one finger chain: knuckle (MCP) -> PIP -> DIP -> tip. Every
// phalanx is built from r[i] to r[i + 1], so the chain has no radius step at
// any joint and the glove can never read as disconnected links.
function radiusChain(w) {
  return [w * 0.490, w * 0.455, w * 0.415, w * 0.372];
}

// A continuous skinned tube removes the visible seams between phalanges. Four
// bones still preserve MCP/PIP/DIP articulation, but the rendered surface is a
// single deforming finger like the gloved hands in the 00:22 reference.
function fingerSkinGeometry(lens, radii, radialSegments = 18, ringsPerBone = 5) {
  const positions = [];
  const skinIndices = [];
  const skinWeights = [];
  const indices = [];
  const rings = [];
  let z0 = 0;

  for (let bone = 0; bone < lens.length; bone++) {
    for (let step = 0; step <= ringsPerBone; step++) {
      if (bone > 0 && step === 0) continue;
      const t = step / ringsPerBone;
      const eased = t * t * (3 - 2 * t);
      const z = z0 + lens[bone] * t;
      const radius = THREE.MathUtils.lerp(radii[bone], radii[bone + 1], eased);
      const ring = [];
      for (let j = 0; j < radialSegments; j++) {
        const a = (j / radialSegments) * Math.PI * 2;
        ring.push(positions.length / 3);
        positions.push(Math.cos(a) * radius, Math.sin(a) * radius, z);
        skinIndices.push(bone, bone + 1, 0, 0);
        skinWeights.push(1 - t, t, 0, 0);
      }
      rings.push(ring);
    }
    z0 += lens[bone];
  }

  for (let r = 0; r < rings.length - 1; r++) {
    for (let j = 0; j < radialSegments; j++) {
      const n = (j + 1) % radialSegments;
      indices.push(rings[r][j], rings[r + 1][j], rings[r + 1][n]);
      indices.push(rings[r][j], rings[r + 1][n], rings[r][n]);
    }
  }

  const start = positions.length / 3;
  positions.push(0, 0, 0);
  skinIndices.push(0, 0, 0, 0);
  skinWeights.push(1, 0, 0, 0);
  const end = positions.length / 3;
  positions.push(0, 0, z0);
  skinIndices.push(lens.length, 0, 0, 0);
  skinWeights.push(1, 0, 0, 0);
  for (let j = 0; j < radialSegments; j++) {
    const n = (j + 1) % radialSegments;
    indices.push(start, rings[0][n], rings[0][j]);
    indices.push(end, rings.at(-1)[j], rings.at(-1)[n]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function ellipsoid(radius, sx, sy, sz) {
  return new THREE.SphereGeometry(radius, 16, 12).scale(sx, sy, sz);
}

function damp(cur, target, lambda, dt) {
  return target + (cur - target) * Math.exp(-lambda * dt);
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ------------------------------------------------------- anatomical shell
//
// The vendored Rigged Hand model is a skinned hand whose bone naming varies by
// exporter, so fingers are resolved by name alias and ordered by hierarchy
// depth rather than by a hard-coded index. Only deforming pivot bones are
// driven: control, IK and terminal (end/tip) bones keep their rest orientation.
// Rest quaternions are cached once per bone so every frame composes from the
// bind pose instead of accumulating drift.

const GLOVE_SHELL = new THREE.MeshStandardMaterial({
  name: 'pipesense-glove-shell',
  color: 0x225f73,
  emissive: 0x071c26,
  emissiveIntensity: 0,
  normalMap: LEATHER_SURFACE.normalMap,
  normalScale: new THREE.Vector2(0.12, 0.12),
  roughness: 0.94,
  metalness: 0,
  envMapIntensity: 0.45,
});
const GLOVE_BACK = new THREE.MeshStandardMaterial({
  name: 'pipesense-glove-back',
  color: 0x2e8aa1,
  emissive: 0x08222d,
  emissiveIntensity: 0,
  roughness: 0.9,
  metalness: 0,
  envMapIntensity: 0.45,
});
const GLOVE_HIVIS = new THREE.MeshStandardMaterial({
  name: 'pipesense-glove-hivis',
  color: 0xd97a1f,
  emissive: 0x3a1500,
  emissiveIntensity: 0.18,
  roughness: 0.8,
  metalness: 0,
});

// ------------------------------------------------- nitrile-dipped knit glove
// The anatomical shell wears a real work-glove finish: a heathered
// grey-blue knit liner on the back of the hand with a charcoal foam-nitrile
// coating dipped over the palm, the palm side of every finger and the
// fingertips. The dip line is computed per vertex from the rest-pose normal
// (palm side) and the distal-bone skin weights (fingertips), then sharpened
// per fragment so it reads as a crisp coating edge, not a gradient.
function makeKnitSurface() {
  const size = 128;
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Stockinette: columns of V-shaped loops, 8 px wide, 6 px tall.
      const cx = x % 8;
      const cy = (y % 6) / 6;
      const d = cx < 4 ? cx / 4 - cy * 0.5 : (7 - cx) / 4 - cy * 0.5;
      const loop = 0.5 + 0.5 * Math.cos(Math.PI * 2 * d);
      const yarn = hash2(x, y, 3.1);
      h[y * size + x] = loop * 0.85 + yarn * 0.15;
      // Heather: individual fibres a little lighter or darker.
      const fibre = 0.82 + 0.18 * hash2(Math.floor(x / 2), y, 9.7) + (loop - 0.5) * 0.12;
      const g = Math.max(0, Math.min(255, Math.round(205 * fibre)));
      albedo.set([g, g, Math.min(255, g + 4), 255], (y * size + x) * 4);
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = h[y * size + ((x + 1) % size)] - h[y * size + ((x + size - 1) % size)];
      const dy = h[((y + 1) % size) * size + x] - h[((y + size - 1) % size) * size + x];
      const n = new THREE.Vector3(-dx * 1.6, -dy * 1.6, 1).normalize();
      normal.set([(n.x * 0.5 + 0.5) * 255, (n.y * 0.5 + 0.5) * 255, (n.z * 0.5 + 0.5) * 255, 255], (y * size + x) * 4);
    }
  }
  const mk = (data, srgb) => {
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(14, 14);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  };
  return { map: mk(albedo, true), normalMap: mk(normal, false) };
}
const KNIT_SURFACE = makeKnitSurface();

const GLOVE_KNIT = new THREE.MeshPhysicalMaterial({
  name: 'pipesense-glove-dipped-knit',
  color: 0x6f7d88,
  map: KNIT_SURFACE.map,
  normalMap: KNIT_SURFACE.normalMap,
  normalScale: new THREE.Vector2(0.55, 0.55),
  roughness: 0.92,
  metalness: 0,
  sheen: 1,
  sheenColor: new THREE.Color(0x7d8994),
  sheenRoughness: 0.7,
  envMapIntensity: 0.6,
});
GLOVE_KNIT.userData.coatColor = { value: new THREE.Color(0x26292d) };
GLOVE_KNIT.onBeforeCompile = (shader) => {
  shader.uniforms.coatColor = GLOVE_KNIT.userData.coatColor;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float gloveCoat;\nvarying float vGloveCoat;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGloveCoat = gloveCoat;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vGloveCoat;\nuniform vec3 coatColor;')
    .replace('#include <map_fragment>', `#include <map_fragment>
      // Dip edge: a slightly wavy, crisp line; foam texture inside it.
      float gWob = (sin(vMapUv.x * 61.0) * sin(vMapUv.y * 47.0)) * 0.035;
      float gCoat = smoothstep(0.47, 0.53, vGloveCoat + gWob);
      float gFoam = 0.9 + 0.1 * fract(sin(dot(floor(vMapUv * 900.0), vec2(12.9898, 78.233))) * 43758.5453);
      diffuseColor.rgb = mix(diffuseColor.rgb, coatColor * gFoam, gCoat);`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, 0.5 + 0.12 * gFoam, gCoat);`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      normal = normalize(mix(normal, nonPerturbedNormal, gCoat * 0.8));`)
    .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      material.sheenColor *= 1.0 - gCoat;`);
};

// Per-vertex coating field (0.5 = dip line) on the skinned hand, measured in
// the normalised glove frame where fingers run +Z and the palm faces -Y.
function applyGloveCoat(model, mesh) {
  if (!mesh || mesh.geometry.getAttribute('gloveCoat')) return;
  model.updateMatrixWorld(true);
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  const bones = mesh.skeleton ? mesh.skeleton.bones : [];
  const distal = new Set(bones.map((b, i) => (/_dist/i.test(b.name) ? i : -1)).filter((i) => i >= 0));
  // Rest pose in the glove frame: skinned positions (as measureShell reads
  // them) and normals recomputed from those, flipped for the mirrored hand.
  const world = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const zs = new Float32Array(pos.count);
  let zMin = Infinity;
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld);
    world.set([p.x, p.y, p.z], i * 3);
    zs[i] = p.z;
    zMin = Math.min(zMin, p.z);
  }
  const tmp = new THREE.BufferGeometry();
  tmp.setAttribute('position', new THREE.BufferAttribute(world, 3));
  if (geo.index) tmp.setIndex(geo.index);
  tmp.computeVertexNormals();
  const nrmW = tmp.getAttribute('normal');
  const flip = mesh.matrixWorld.determinant() < 0 ? -1 : 1;
  const coat = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(nrmW, i).multiplyScalar(flip);
    // Palm side, wrapping a little over the finger sides.
    let f = 0.5 + (-n.y + 0.2) * 1.4;
    let wd = 0;
    if (si && sw) for (let c = 0; c < 4; c++) if (distal.has(si.getComponent(i, c))) wd += sw.getComponent(i, c);
    f = Math.max(f, 0.5 + (wd - 0.55) * 2.5);
    // Bare knit for the last 3 cm before the wrist opening.
    f = Math.min(f, 0.5 + (zs[i] - (zMin + 0.03)) * 40);
    coat[i] = f;
  }
  tmp.dispose();
  geo.setAttribute('gloveCoat', new THREE.BufferAttribute(coat, 1));
}

const FINGER_ALIAS = [
  ['thumb', /(thumb|pollex)/i],
  ['index', /(index|pointer|forefinger)/i],
  ['middle', /(middle|midd|longfinger)/i],
  ['ring', /(ring|annular)/i],
  ['pinky', /(pinky|pinkie|little|minimus)/i],
];
const NON_DEFORM_BONE = /(base|end|tip|ik|ctrl|control|pole|target|helper|nub|twist)/i;
const NUMBERED_DEFORM_BONE = /_(?:0?1|0?2|0?3)(?:\.|_|$)/i;
const HIVIS_MESH = /(seam|stitch|trim|welt|cuff|band|strap|patch|logo|mark|stripe|hivis|hi-vis)/i;
const ANATOMY_CURL_MAX = { thumb: [1.1, 1.0, 0.85], finger: [1.35, 1.5, 0.8] };
const ANATOMY_DEFORM_NAMES = {
  thumb: ['thumb_meta', 'thumb_prox', 'thumb_dist'],
  index: ['index_prox', 'index_midd', 'index_dist'],
  middle: ['midd_prox', 'midd_midd', 'midd_dist'],
  ring: ['ring_prox', 'ring_midd', 'ring_dist'],
  pinky: ['pinky_prox', 'pinky_midd', 'pinky_dist'],
};
// Palmar pad direction of the source thumb in its bind frame, measured from
// the thumb nail (the pad faces away from it). The thumb is pronated about
// 50 degrees relative to the fingers, so bending it toward the palm normal
// (the finger rule) swung the tip up off the palm instead of across it.
const THUMB_PAD_SOURCE = new THREE.Vector3(0.66, 0.41, 0.62).normalize();
// Pinch assist: thumb tip centre stops this far from the index tip centre,
// roughly the two pad radii, so the pads meet instead of intersecting.
const PINCH_CONTACT_GAP = 0.013;
// Solver bounds: thumb [metacarpal spread, metacarpal bend, proximal bend,
// distal bend], then index [MCP, PIP, DIP] bends, in radians.
const PINCH_IK_LIMITS = [[-1.0, 0.6], [-0.2, 1.5], [0, 1.1], [0, 1.0], [0, 1.5], [0, 1.6], [0, 1.0]];

let gltfLoader = null;
const handModelCache = new Map();

// Non-sensitive shell state per side, mirrored onto <body data-glove-models>
// so automated QA can read which shell actually rendered.
const modelStates = new Map();

function publishModelStates() {
  if (typeof document === 'undefined' || !document.body) return;
  const states = [...modelStates.values()];
  const loaded = states.length === 2 && states.every((state) => state === 'loaded');
  const failed = states.some((state) => state === 'fallback');
  document.body.dataset.gloveModels = loaded ? 'loaded' : failed ? 'fallback' : 'loading';
}

export function gloveModelStatus() {
  return {
    left: modelStates.get('left') || 'loading',
    right: modelStates.get('right') || 'loading',
  };
}

function loadHandModel(side) {
  if (!handModelCache.has(side)) {
    if (!gltfLoader) gltfLoader = new GLTFLoader();
    handModelCache.set(side, gltfLoader.loadAsync(MODEL_URL[side]));
  }
  return handModelCache.get(side);
}

function boneDepth(bone) {
  let depth = 0;
  for (let node = bone.parent; node; node = node.parent) depth += 1;
  return depth;
}

// The GLB carries its own cameras, lights and editor helpers; none of them
// belong in the workshop scene.
function stripSceneHelpers(object) {
  const doomed = [];
  object.traverse((node) => {
    if (node.isCamera || node.isLight || /helper/i.test(node.type)) doomed.push(node);
  });
  for (const node of doomed) node.removeFromParent();
}

function dressAnatomy(model) {
  model.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.frustumCulled = false;
    // Nails would print through the glove as ridges.
    if (/nail/i.test(`${node.name || ''} ${(node.material && node.material.name) || ''}`)) { node.visible = false; return; }
    const original = Array.isArray(node.material) ? node.material : [node.material];
    if (node.isSkinnedMesh && node.geometry.getAttribute('gloveCoat')) {
      node.material = GLOVE_KNIT;
      return;
    }
    const mapped = original.map((mat) => {
      const label = `${node.name || ''} ${(mat && mat.name) || ''}`;
      return HIVIS_MESH.test(label) ? GLOVE_HIVIS : (/(back|dorsal)/i.test(label) ? GLOVE_BACK : GLOVE_SHELL);
    });
    node.material = Array.isArray(node.material) ? mapped : mapped[0];
  });
}

// The skinned mesh that actually deforms with the finger bones (the largest
// one when the asset also carries nails or accessories).
function deformingMesh(model) {
  let best = null;
  model.traverse((node) => {
    if (!node.isSkinnedMesh) return;
    if (!best || node.geometry.attributes.position.count > best.geometry.attributes.position.count) best = node;
  });
  return best;
}

// The source has no tip bones, so each distal bone's fingertip is measured
// from the skin: the centroid of the outermost band of vertices it carries,
// in that bone's own frame. An anchor placed there follows the rendered tip
// exactly under any bend because the distal segment is rigidly skinned.
function measureTips(model, rig) {
  const mesh = deformingMesh(model);
  if (!mesh) return;
  const { bones, boneInverses } = mesh.skeleton;
  const pos = mesh.geometry.attributes.position;
  const skinIndex = mesh.geometry.attributes.skinIndex;
  const skinWeight = mesh.geometry.attributes.skinWeight;
  const v = new THREE.Vector3();
  for (const chain of Object.values(rig)) {
    const bone = chain[chain.length - 1];
    const bi = bones.indexOf(bone);
    if (bi < 0) continue;
    const local = [];
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      let w = 0;
      for (let c = 0; c < 4; c++) if (skinIndex.getComponent(i, c) === bi) w += skinWeight.getComponent(i, c);
      if (w < 0.5) continue;
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix).applyMatrix4(boneInverses[bi]);
      local.push(v.clone());
      maxY = Math.max(maxY, v.y);
    }
    if (!local.length || !(maxY > 0)) continue;
    const tip = new THREE.Vector3();
    let n = 0;
    for (const p of local) {
      if (p.y < maxY * 0.8) continue;
      tip.add(p);
      n += 1;
    }
    bone.userData.tipLocal = tip.multiplyScalar(1 / n);
  }
}

function normaliseAnatomy(model, side, rig) {
  // The Blender asset is authored fingers-up (+Y). PipeSense's interaction
  // frame points fingers into the workspace (+Z), with the palm toward -Y.
  // Mirror the complete skinned hierarchy for the right hand before measuring
  // bounds so the two shells remain true anatomical opposites.
  model.rotation.x = Math.PI / 2;
  model.scale.set(side === 'right' ? -1 : 1, 1, 1);
  model.updateMatrixWorld(true);
  const middle = rig.middle;
  const tipLocal = middle && middle[2] && middle[2].userData.tipLocal;
  if (tipLocal) {
    // Fit the rendered middle finger onto the procedural one: same knuckle
    // pivot and the same knuckle-to-tip length. Centring on the forearm bone
    // instead left the whole shell 30 mm toward the thumb and its fingertips
    // 23-40 mm short of the interaction anchors.
    const spec = FINGERS[1];
    const knuckle = middle[0].getWorldPosition(new THREE.Vector3());
    const length = knuckle.distanceTo(middle[2].localToWorld(tipLocal.clone()));
    if (!(length > 0)) return false;
    model.scale.multiplyScalar(spec.lens.reduce((a, b) => a + b, 0) / length);
    model.updateMatrixWorld(true);
    const s = side === 'right' ? 1 : -1;
    const target = new THREE.Vector3(spec.x * s, 0.002, PALM.front + spec.dz);
    model.position.add(target.sub(middle[0].getWorldPosition(new THREE.Vector3())));
    model.updateMatrixWorld(true);
    return true;
  }
  const initial = new THREE.Box3().setFromObject(model);
  const size = initial.getSize(new THREE.Vector3());
  const length = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(length) || length <= 0) return false;
  model.scale.multiplyScalar(HAND_LENGTH / length);
  model.updateMatrixWorld(true);
  // Centre on the anatomical wrist, not the bounding box: the extended
  // thumb makes the box asymmetric and otherwise pulls the wrist out of its cuff.
  const wrist = model.getObjectByName('radius_ulna');
  const centre = wrist
    ? wrist.getWorldPosition(new THREE.Vector3())
    : new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
  model.position.sub(centre).add(new THREE.Vector3(0, 0, wrist ? -0.012 : MODEL_CENTRE_Z));
  return true;
}

// Rest-pose landmarks of the normalised shell in the glove frame: the wrist
// opening the cuff must wrap and the palm surface the palm anchor braces with.
function measureShell(model) {
  const mesh = deformingMesh(model);
  if (!mesh) return null;
  model.updateMatrixWorld(true);
  const count = mesh.geometry.attributes.position.count;
  const points = [];
  let zMin = Infinity;
  for (let i = 0; i < count; i++) {
    const p = mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    points.push(p);
    zMin = Math.min(zMin, p.z);
  }
  const wrist = new THREE.Box3();
  for (const p of points) if (p.z < zMin + 0.012) wrist.expandByPoint(p);
  // The index and pinky knuckles straddle x = 0, so the palm centre line is
  // the glove's own axis on both sides.
  const knuckleZ = PALM.front + FINGERS[1].dz;
  let palmY = Infinity;
  for (const p of points) {
    if (p.z < knuckleZ - 0.075 || p.z > knuckleZ - 0.025 || Math.abs(p.x) > 0.02) continue;
    palmY = Math.min(palmY, p.y);
  }
  return {
    wristCentre: wrist.getCenter(new THREE.Vector3()),
    wristHalf: wrist.getSize(new THREE.Vector3()).multiplyScalar(0.5),
    zMin,
    palm: Number.isFinite(palmY) ? new THREE.Vector3(0, palmY + 0.004, knuckleZ - 0.05) : null,
  };
}

function buildBoneRig(model) {
  model.updateMatrixWorld(true);
  const bones = [];
  model.traverse((node) => { if (node.isBone) bones.push(node); });
  const byName = new Map(bones.map((bone) => [bone.name.toLowerCase(), bone]));
  const rig = {};
  for (const [key, alias] of FINGER_ALIAS) {
    // Prefer the source model's physiological segment names. These are the
    // three articulation pivots corresponding to MediaPipe's MCP, PIP and DIP
    // bends. Metacarpals stay in their bind pose so palm proportions remain
    // intact while the fingers curl.
    const exact = ANATOMY_DEFORM_NAMES[key].map((name) => byName.get(name));
    if (exact.every(Boolean)) {
      rig[key] = exact;
      continue;
    }
    const candidates = bones
      .filter((bone) => alias.test(bone.name) && !NON_DEFORM_BONE.test(bone.name))
      .sort((a, b) => boneDepth(a) - boneDepth(b));
    // The vendored Blender rig exposes deform bones as finger_01/02/03 and
    // also carries separate base/control/tip chains. Prefer the numbered skin
    // pivots so a curl never rotates a controller or the whole metacarpal.
    const numbered = candidates.filter((bone) => NUMBERED_DEFORM_BONE.test(bone.name));
    const joints = (numbered.length >= 2 ? numbered : candidates).slice(0, 3);
    if (joints.length) rig[key] = joints;
  }
  if (!rig.index && !rig.middle) return null;
  const palmNormal = new THREE.Vector3(0, 0, 1);
  const boneAlong = (bone) => new THREE.Vector3(0, 1, 0).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()));
  const middleAlong = rig.middle ? boneAlong(rig.middle[0]).projectOnPlane(palmNormal).normalize() : null;
  const towardThumb = middleAlong ? palmNormal.clone().cross(middleAlong) : null;
  for (const [key, chain] of Object.entries(rig)) {
    for (const bone of chain) {
      if (!bone.userData.restQuat) bone.userData.restQuat = bone.quaternion.clone();
      // The source bones run along local Y, but their roll differs by digit.
      // Resolve anatomical flexion and splay in the bind frame, rather than
      // bending every bone about local X (which fans the fingers sideways).
      // Flexion turns the bone toward its palmar pad: the palm normal for the
      // fingers, the measured pad direction for the pronated thumb.
      const worldQuat = bone.getWorldQuaternion(new THREE.Quaternion());
      const along = new THREE.Vector3(0, 1, 0).applyQuaternion(worldQuat);
      const inverse = worldQuat.clone().invert();
      const pad = key === 'thumb' ? THUMB_PAD_SOURCE.clone().projectOnPlane(along).normalize() : palmNormal;
      bone.userData.bendAxis = along.clone().cross(pad).normalize().applyQuaternion(inverse);
      bone.userData.spreadAxis = palmNormal.clone().applyQuaternion(inverse);
    }
    // Bind-pose splay of each proximal phalanx relative to the middle finger,
    // positive toward the thumb, matching the tracked spreads from input.js.
    // Only the difference is applied, so the model's natural rest fan is not
    // added on top of the learner's own.
    if (key !== 'thumb' && towardThumb) {
      const dir = boneAlong(chain[0]).projectOnPlane(palmNormal);
      chain[0].userData.restSpread = Math.atan2(dir.dot(towardThumb), dir.dot(middleAlong));
    }
  }
  return rig;
}

const BONE_BEND_AXIS = new THREE.Vector3(1, 0, 0);
const boneBend = new THREE.Quaternion();
const boneOppose = new THREE.Quaternion();

// Splay is applied before flexion, so a bent finger still abducts about the
// palm normal instead of twisting about its own long axis.
function poseBone(bone, bend, spread) {
  bone.quaternion.copy(bone.userData.restQuat);
  if (spread) {
    boneOppose.setFromAxisAngle(bone.userData.spreadAxis, spread);
    bone.quaternion.multiply(boneOppose);
  }
  if (bend) {
    boneBend.setFromAxisAngle(bone.userData.bendAxis || BONE_BEND_AXIS, bend);
    bone.quaternion.multiply(boneBend);
  }
}

// Thumb parameters: [metacarpal spread, metacarpal bend, proximal bend,
// distal bend]. Negative spread adducts the thumb toward the index.
function poseThumb(chain, params) {
  poseBone(chain[0], params[1], params[0]);
  poseBone(chain[1], params[2], 0);
  poseBone(chain[2], params[3], 0);
}

function poseIndex(chain, bends, spread) {
  poseBone(chain[0], bends[0], spread);
  poseBone(chain[1], bends[1], 0);
  poseBone(chain[2], bends[2], 0);
}

function posePinch(thumb, index, params, indexSpread) {
  poseThumb(thumb, params);
  poseIndex(index, params.slice(4), indexSpread);
}

const ikIndexTip = new THREE.Vector3();
const ikThumbTip = new THREE.Vector3();

// Pinch assist. Joint bends alone cannot oppose the thumb onto the index
// pad: the measured gap stayed at 49 mm with pinch fully closed, and the
// thumb alone cannot reach a hooked index (38 mm at best). A short bounded
// coordinate descent over the thumb and index joints, regularised toward
// the tracked pose, brings the two tips together.
function solvePinch(thumb, index, tracked, indexSpread, tips, contactGap = PINCH_CONTACT_GAP) {
  const params = tracked.slice();
  const cost = () => {
    posePinch(thumb, index, params, indexSpread);
    tips.index.getWorldPosition(ikIndexTip);
    tips.thumb.getWorldPosition(ikThumbTip);
    const gap = ikThumbTip.distanceTo(ikIndexTip) - contactGap;
    let drift = 0;
    for (let i = 0; i < params.length; i++) drift += (params[i] - tracked[i]) ** 2;
    return gap * gap + 1e-5 * drift;
  };
  let best = cost();
  let step = 0.32;
  for (let sweep = 0; sweep < 9; sweep++) {
    for (let i = 0; i < params.length; i++) {
      const [lo, hi] = PINCH_IK_LIMITS[i];
      for (const dir of [1, -1]) {
        const previous = params[i];
        params[i] = clamp(previous + dir * step, lo, hi);
        const next = cost();
        if (next < best) {
          best = next;
          break;
        }
        params[i] = previous;
      }
    }
    step *= 0.55;
  }
  return params;
}

// `curls` is the damped per-finger closure; `joints` and `thumbJoints` are the
// MediaPipe-derived MCP/PIP/DIP bends; `spreads` carries lateral MCP splay
// relative to the middle finger. `tips` are the anatomical tip anchors.
function driveAnatomy(rig, curls, joints, thumbJoints, spreads, pinch, tips, contactGap) {
  const fingerBends = {};
  const fingerSpreads = {};
  for (const key of FINGER_ORDER) {
    const chain = rig[key];
    if (!chain || key === 'thumb') continue;
    const fingerIndex = FINGER_ORDER.indexOf(key) - 1;
    const tracked = joints && joints[fingerIndex];
    const maxima = ANATOMY_CURL_MAX.finger;
    const bends = chain.map((bone, index) => {
      const source = tracked && Number.isFinite(tracked[index]) ? tracked[index] : curls[key];
      return clamp(source || 0, 0, 1) * (maxima[index] ?? maxima[maxima.length - 1]);
    });
    let spread = 0;
    if (spreads && Number.isFinite(spreads[fingerIndex])) {
      spread = clamp(spreads[fingerIndex] - (chain[0].userData.restSpread || 0), -0.35, 0.35);
    }
    chain.forEach((bone, index) => poseBone(bone, bends[index], index === 0 ? spread : 0));
    fingerBends[key] = bends;
    fingerSpreads[key] = spread;
  }

  const thumb = rig.thumb;
  if (!thumb) return;
  const maxima = ANATOMY_CURL_MAX.thumb;
  const bends = [0, 1, 2].map((i) => {
    const source = thumbJoints && Number.isFinite(thumbJoints[i]) ? thumbJoints[i] : curls.thumb;
    return clamp(source || 0, 0, 1) * maxima[i];
  });
  const thumbTracked = [0, ...bends];
  poseThumb(thumb, thumbTracked);
  const p = clamp(pinch || 0, 0, 1);
  const weight = p * p * (3 - 2 * p);
  const index = rig.index;
  if (weight < 0.01 || !index || index.length < 3 || !tips || !tips.thumb || !tips.index) return;
  const tracked = [...thumbTracked, ...fingerBends.index];
  const solved = solvePinch(thumb, index, tracked, fingerSpreads.index, tips, contactGap);
  posePinch(thumb, index, tracked.map((value, i) => value + (solved[i] - value) * weight), fingerSpreads.index);
}

export function createGlove(side) {
  const s = side === 'right' ? 1 : -1;
  const mats = {
    // Fallback shell in the same finish as the anatomical glove: grey-blue
    // knit back, charcoal nitrile palm and pads.
    leather: leather(0x6f7d88, 1.0, 3.5),
    leatherPalm: leather(0x3a3f45, 1.0, 3.9),
    pad: leather(0x26292d, 0.6, 4.8),
    cuff: leather(0x66737e, 1.0, 3.2),
    seam: new THREE.MeshStandardMaterial({ color: 0xd97a1f, roughness: 0.88, metalness: 0 }),
    reflective: new THREE.MeshStandardMaterial({
      color: 0xffb343,
      emissive: 0x6b2800,
      emissiveIntensity: 0.16,
      roughness: 0.72,
      metalness: 0,
    }),
  };

  const root = new THREE.Group();
  root.name = `glove-${side}`;

  // The anatomical source ends at the wrist. A fitted work-glove cuff hides
  // that open boundary and gives the first-person hand the same continuous
  // wrist silhouette as the physical gloves in the reference footage.
  // Built on a unit-radius ring and scaled to the measured wrist opening once
  // the model loads. Single-sided, the open tube's far wall was culled and
  // the cuff read as a curved sheet beside the wrist, and a double-sided tube
  // reads as a hollow ring from the first-person camera. The gauntlet is
  // longer than the wrist gap and fades out toward the elbow, as a sleeve
  // leaving the view would; its culled inner wall keeps the opening unseen.
  const anatomicalCuff = new THREE.Group();
  anatomicalCuff.name = `glove-anatomy-cuff-${side}`;
  anatomicalCuff.visible = false;
  // Opaque rib-knit cuff (same liner as the glove back) tucked into a jacket
  // sleeve, replacing the translucent fading funnel.
  const cuffKnit = new THREE.MeshPhysicalMaterial({
    color: 0x66737e, map: KNIT_SURFACE.map, normalMap: KNIT_SURFACE.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.95, metalness: 0,
    sheen: 1, sheenColor: new THREE.Color(0x6f7b85), sheenRoughness: 0.7,
  });
  const anatomyCuffShell = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.98, 0.05, 32, 1, true), cuffKnit);
  anatomyCuffShell.rotation.x = Math.PI / 2;
  anatomyCuffShell.position.z = -0.012;
  anatomyCuffShell.castShadow = true;
  anatomicalCuff.add(anatomyCuffShell);
  // A short stretch of the learner's work-jacket sleeve. It stays opaque
  // around the cuff and fades out within a hand's length, so the forearm
  // never hides the trap the learner is working on (a full-length sleeve
  // covered the trap from the first-person camera).
  const sleeveFade = (() => {
    const n = 64;
    const data = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, (i / (n - 1) - 0.1) / 0.55));
      const a = Math.round(t * t * (3 - 2 * t) * 255);
      data.set([a, a, a, 255], i * 4);
    }
    const tex = new THREE.DataTexture(data, 1, n, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
  })();
  const sleeveMat = new THREE.MeshStandardMaterial({
    color: 0x262c34, roughness: 0.9, metalness: 0,
    normalMap: LEATHER_SURFACE.normalMap, normalScale: new THREE.Vector2(0.3, 0.3),
    alphaMap: sleeveFade, transparent: true,
  });
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(1.06, 1.14, 0.10, 32, 4, true), sleeveMat);
  sleeve.rotation.x = Math.PI / 2;
  sleeve.position.z = -0.032 - 0.05;
  sleeve.castShadow = false;
  anatomicalCuff.add(sleeve);
  // Contrast knit stripe where the cuff meets the hand.
  const anatomyCuffBand = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 8, 32), mats.seam);
  anatomyCuffBand.position.z = 0.004;
  anatomicalCuff.add(anatomyCuffBand);
  root.add(anatomicalCuff);

  // Every procedural mesh lives under this group so the whole shell can be
  // hidden in one switch once an anatomical model binds. The bone chains and
  // anchors stay parented to their meshes, so world-space anchor reads and the
  // interaction contract are unaffected by the swap.
  const procedural = new THREE.Group();
  procedural.name = `glove-procedural-${side}`;
  root.add(procedural);

  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.040, 0.082, 24, 3, false), mats.cuff);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0, -0.003, -0.047);
  cuff.castShadow = true;
  procedural.add(cuff);

  // ------------------------------------------------------------- palm shell
  // Overlapping masses rather than one box: core block, back-of-hand dome,
  // broad knuckle row, thenar (thumb side) and hypothenar (pinky side) pads.
  const palm = new THREE.Mesh(new RoundedBoxGeometry(PALM.w, PALM.t, PALM.l, 4, 0.0135), mats.leatherPalm);
  palm.position.set(0, 0, PALM.l / 2 - 0.006);
  palm.castShadow = true;
  procedural.add(palm);

  const palmDome = new THREE.Mesh(ellipsoid(1, PALM.w * 0.50, PALM.t * 0.66, PALM.l * 0.52), mats.leather);
  palmDome.position.set(0, PALM.t * 0.15, PALM.l * 0.46);
  palmDome.castShadow = true;
  procedural.add(palmDome);

  const knuckleRow = new THREE.Mesh(ellipsoid(1, PALM.w * 0.53, PALM.t * 0.60, 0.020), mats.leather);
  knuckleRow.position.set(0, PALM.t * 0.07, PALM.front - 0.010);
  knuckleRow.castShadow = true;
  procedural.add(knuckleRow);

  const wristMass = new THREE.Mesh(ellipsoid(1, PALM.w * 0.45, PALM.t * 0.54, 0.020), mats.leatherPalm);
  wristMass.position.set(0, -0.002, -0.008);
  procedural.add(wristMass);

  // Fuller thenar and hypothenar: these two masses carry the gloved hand's
  // real bulge and blend the thumb base and pinky edge into the palm.
  const thenar = new THREE.Mesh(ellipsoid(1, 0.0235, 0.0150, 0.0325), mats.leatherPalm);
  thenar.position.set(0.0235 * s, -0.0035, 0.047);
  thenar.castShadow = true;
  procedural.add(thenar);
  const hypothenar = new THREE.Mesh(ellipsoid(1, 0.0175, 0.0125, 0.0290), mats.leatherPalm);
  hypothenar.position.set(-0.0285 * s, -0.0035, 0.052);
  hypothenar.castShadow = true;
  procedural.add(hypothenar);

  const palmPad = new THREE.Mesh(new RoundedBoxGeometry(PALM.w * 0.84, 0.011, PALM.l * 0.68, 3, 0.005), mats.pad);
  palmPad.position.set(0, -PALM.t / 2 - 0.0035, PALM.l * 0.46);
  palmPad.castShadow = true;
  procedural.add(palmPad);
  const strap = new THREE.Mesh(new RoundedBoxGeometry(PALM.w * 0.86, 0.0105, 0.016, 2, 0.0038), mats.seam);
  strap.position.set(0, PALM.t / 2 + 0.0005, 0.014);
  procedural.add(strap);
  // A restrained hi-vis chevron gives judges an immediate hand silhouette
  // without turning the glove into a neon controller prop.
  for (const x of [-0.019, 0.019]) {
    const marker = new THREE.Mesh(new RoundedBoxGeometry(0.012, 0.006, 0.046, 2, 0.003), mats.reflective);
    marker.position.set(x, PALM.t / 2 + 0.005, 0.059);
    marker.rotation.y = x * s > 0 ? -0.22 : 0.22;
    marker.castShadow = true;
    procedural.add(marker);
  }

  // Finger-base webbing: a soft wedge between each adjacent pair of knuckles.
  // It fills the notch the old rig left open, which was the strongest cue that
  // the fingers were separate parts.
  for (let i = 0; i < FINGERS.length - 1; i++) {
    const a = FINGERS[i];
    const b = FINGERS[i + 1];
    const web = new THREE.Mesh(ellipsoid(1, Math.abs(a.x - b.x) * 0.66, PALM.t * 0.74, 0.017), mats.leather);
    web.position.set(((a.x + b.x) / 2) * s, 0.001, PALM.front - 0.006);
    web.castShadow = true;
    procedural.add(web);
  }

  // ------------------------------------------------------- articulated chains
  const tipAnchors = {};
  const fingerRigs = [];

  function buildChain({ key, lens, w, curlMax, base, register = true }) {
    const radii = radiusChain(w);
    const bones = lens.map(() => new THREE.Bone());
    bones.push(new THREE.Bone());
    bones[0].name = `${key}-mcp`;
    for (let i = 1; i < bones.length; i++) {
      bones[i].name = `${key}-${i === 1 ? 'pip' : i === 2 ? 'dip' : 'tip'}`;
      bones[i].position.z = lens[i - 1];
      bones[i - 1].add(bones[i]);
    }
    const mesh = new THREE.SkinnedMesh(fingerSkinGeometry(lens, radii), mats.leather);
    mesh.name = `skin-${key}`;
    mesh.position.copy(base);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.add(bones[0]);
    mesh.bind(new THREE.Skeleton(bones));
    procedural.add(mesh);

    const anchor = new THREE.Object3D();
    anchor.name = `anchor-${key}`;
    bones.at(-1).add(anchor);
    anchor.userData.homeLocal = new THREE.Vector3();
    tipAnchors[key] = anchor;
    const tipCap = new THREE.Mesh(ellipsoid(radii.at(-1), 1.0, 0.94, 1.18), mats.leather);
    tipCap.position.z = radii.at(-1) * 0.22;
    tipCap.castShadow = true;
    bones.at(-1).add(tipCap);
    const joints = bones.slice(0, 3);
    if (register) fingerRigs.push({ joints, curlMax });
    return { joints, bones, mesh, anchor };
  }

  for (const spec of FINGERS) {
    buildChain({
      key: spec.key,
      lens: spec.lens,
      w: spec.w,
      curlMax: spec.curlMax,
      base: new THREE.Vector3(spec.x * s, 0.002, PALM.front + spec.dz),
    });
  }

  const thumbRig = buildChain({
    key: 'thumb',
    lens: THUMB.lens,
    w: THUMB.w,
    curlMax: [1.1, 1.0, 0.85],
    base: new THREE.Vector3(0.040 * s, -0.010, 0.038),
    register: false,
  });
  // The thumb has its own opposition transform in addition to bone bends.
  const thumbBase = thumbRig.joints[0];
  const thumbJoints = thumbRig.joints;

  const anchors = {};
  for (const key of ANCHOR_KEYS) {
    anchors[key] = key === 'palm'
      // Heel/hollow of the palm: the surface a gloved hand braces with.
      ? (() => {
        const node = new THREE.Object3D();
        node.name = 'anchor-palm';
        node.position.set(0, -PALM.t * 0.54, PALM.l * 0.55);
        root.add(node);
        return node;
      })()
      : tipAnchors[key];
  }

  const pinchAnchor = new THREE.Object3D();
  pinchAnchor.name = 'anchor-pinch';
  pinchAnchor.position.set(0.006 * s, 0.004, 0.108);
  root.add(pinchAnchor);
  const gripAnchor = new THREE.Object3D();
  root.add(gripAnchor);

  const haloBase = new THREE.Color(0x5e748f);
  const haloHot = new THREE.Color(0x9fc7de);
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.02, 0.0018, 8, 32),
    new THREE.MeshBasicMaterial({ color: haloBase.clone(), transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  halo.position.copy(pinchAnchor.position);
  halo.rotation.x = Math.PI / 2;
  root.add(halo);

  // ------------------------------------------------- anatomical shell attach
  // Fire-and-forget: the procedural rig renders until an anatomical model
  // binds, and stays visible whenever the asset is missing or unmappable.
  const modelStatus = { state: 'loading', detail: 'procedural fallback active', bones: 0, fingers: 0 };
  let anatomy = null;
  let anatomyTips = null;
  modelStates.set(side, modelStatus.state);

  function fitCuff(shell) {
    if (!shell) return;
    const rx = shell.wristHalf.x + 0.003;
    const ry = shell.wristHalf.y + 0.003;
    anatomicalCuff.position.set(shell.wristCentre.x, shell.wristCentre.y, shell.zMin);
    anatomyCuffShell.scale.set(rx, 1, ry);
    anatomyCuffBand.scale.set(rx * 1.06, ry * 1.06, Math.min(rx, ry));
    sleeve.scale.set(rx, 1, ry);
  }

  // Interaction anchors move onto the rendered bones, so contact, pinch and
  // the carried-tool centre are computed where the learner sees the fingers.
  // The procedural skeleton keeps them only while the shell is unavailable.
  function bindAnchorsToAnatomy(rig, shell) {
    const bound = {};
    for (const key of FINGER_ORDER) {
      const chain = rig[key];
      const tip = chain && chain[chain.length - 1];
      if (!tip || !tip.userData.tipLocal || !tipAnchors[key]) continue;
      tip.add(tipAnchors[key]);
      tipAnchors[key].position.copy(tip.userData.tipLocal);
      tipAnchors[key].userData.homeLocal = tip.userData.tipLocal.clone();
      bound[key] = tipAnchors[key];
    }
    if (shell && shell.palm) anchors.palm.position.copy(shell.palm);
    return bound;
  }

  function setModelState(state, detail) {
    modelStatus.state = state;
    modelStatus.detail = detail;
    modelStates.set(side, state);
    publishModelStates();
  }

  loadHandModel(side).then((gltf) => {
    const source = gltf && gltf.scene;
    if (!source) { setModelState('fallback', 'no scene in model'); return; }
    stripSceneHelpers(source);
    const rig = buildBoneRig(source);
    if (!rig) { setModelState('fallback', 'no mappable finger bones'); return; }
    measureTips(source, rig);
    if (!normaliseAnatomy(source, side, rig)) { setModelState('fallback', 'model has no bounds'); return; }
    applyGloveCoat(source, deformingMesh(source));
    dressAnatomy(source);
    source.name = `glove-anatomy-${side}`;
    const shell = measureShell(source);
    root.add(source);
    fitCuff(shell);
    anatomyTips = bindAnchorsToAnatomy(rig, shell);
    anatomy = rig;
    procedural.visible = false;
    anatomicalCuff.visible = true;
    modelStatus.bones = Object.values(rig).reduce((n, chain) => n + chain.length, 0);
    modelStatus.fingers = Object.keys(rig).length;
    setModelState('loaded', `${modelStatus.fingers} fingers · ${modelStatus.bones} deform bones`);
  }).catch(() => {
    setModelState('fallback', 'model load failed');
  });

  const pose = { yaw: Math.PI, pitch: -0.18, roll: 0 };
  const curled = { fingers: [0, 0, 0, 0], thumb: 0, pinch: 0, highlight: 0, contact: 0 };
  const tipA = new THREE.Vector3();
  const tipB = new THREE.Vector3();
  const haloPoint = new THREE.Vector3();
  const gripPoint = new THREE.Vector3();

  root.rotation.set(pose.pitch, pose.yaw, pose.roll, 'YXZ');

  // Grasp snap (visual only). While a hand holds a fixture (valve lever,
  // faucet handle) or carries the trap, the rendered glove is translated so
  // its thumb/index pinch sits on the object's grip point instead of
  // floating wherever the tracked or scripted wrist ended up (measured
  // 0.07-0.33 m away in QA). `base` is the smoothed tracked position; the
  // interaction layer subtracts `snapOffset` so hit tests and carried-object
  // motion still use the tracked hand, never this visual correction.
  const base = root.position.clone();
  const snapOffset = new THREE.Vector3();
  const snapDesired = new THREE.Vector3();
  let snapPoint = null;
  let snapGap = PINCH_CONTACT_GAP;
  const SNAP_MAX = 0.4;

  // ------------------------------------------- natural finger layer (visual)
  // Middle, ring and pinky get a render-only motion layer on top of the
  // canonical pose: staggered, spring-eased closure (index leads, pinky
  // trails), anatomical rest curl, idle micro-motion, an anticipatory
  // pre-curl near a target, and PIP/DIP coupling. Tracked camera joints get
  // a light critically damped filter instead. Thumb and index are never
  // touched, so the pinch geometry is unchanged; pinchAnchor and gripAnchor
  // are computed from the canonical pose first, and the middle/ring/pinky
  // tip anchors are counter-offset back to their canonical world positions,
  // so every point the interaction layer hit-tests is exactly as before.
  const NAT_KEYS = ['index', 'middle', 'ring', 'pinky'];
  const NAT_REST = [0, 0.05, 0.09, 0.14];
  const NAT_DELAY_CLOSE = [0, 0.05, 0.105, 0.165];
  const NAT_DELAY_OPEN = [0, 0.03, 0.06, 0.09];
  const NAT_COUPLE = [0.86, 1.0, 1.16];
  const NAT_IDLE_AMP = [0, 0.035, 0.045, 0.055];
  // Power grip: ring and pinky wrap further than the middle finger.
  const NAT_GRIP_EXTRA = [0, 0, 0.06, 0.12];
  const NAT_OMEGA = [0, 21, 19, 17];
  const NAT_TRACK_OMEGA = 46; // ~43 ms effective lag on camera joints
  const natural = {
    t: 0,
    hist: [],
    seed: side === 'left' ? 1.7 : 0.4,
    fingers: NAT_KEYS.map(() => ({ x: null, v: 0, joints: [0, 1, 2].map(() => ({ x: 0, v: 0 })), tracked: false })),
  };
  const natCanon = { middle: new THREE.Vector3(), ring: new THREE.Vector3(), pinky: new THREE.Vector3() };

  function natSpring(st, goal, omega, dt) {
    const n = Math.max(1, Math.ceil(dt * 120));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const acc = omega * omega * (goal - st.x) - 2 * omega * st.v;
      st.v += acc * h;
      st.x += st.v * h;
    }
  }

  function natDelayed(fi, delay) {
    const want = natural.t - delay;
    const hist = natural.hist;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].t <= want) return hist[i].curls[fi];
    }
    return hist.length ? hist[0].curls[fi] : 0;
  }

  function natPoseFinger(fi, vals, target) {
    const key = NAT_KEYS[fi];
    if (anatomy) {
      const chain = anatomy[key];
      if (!chain) return;
      const maxima = ANATOMY_CURL_MAX.finger;
      let spread = 0;
      const spreads = target && target.spreads;
      if (spreads && Number.isFinite(spreads[fi])) {
        spread = clamp(spreads[fi] - (chain[0].userData.restSpread || 0), -0.35, 0.35);
      }
      chain.forEach((bone, index) => {
        const v = clamp(vals[Math.min(index, 2)], 0, 1);
        poseBone(bone, v * (maxima[index] ?? maxima[maxima.length - 1]), index === 0 ? spread : 0);
      });
    } else {
      const rig = fingerRigs[fi];
      if (!rig) return;
      rig.joints.forEach((joint, ji) => { joint.rotation.x = clamp(vals[ji], 0, 1) * rig.curlMax[ji]; });
    }
  }

  function applyNaturalFingers(dt, target) {
    if (!target || !target.curls) return;
    const step = Math.min(Math.max(dt || 0, 0), 0.1);
    natural.t += step;
    natural.hist.push({ t: natural.t, curls: target.curls.slice(0, 4) });
    while (natural.hist.length > 2 && natural.hist[1].t < natural.t - 0.3) natural.hist.shift();

    // Canonical world positions of the tips the interaction layer samples.
    for (const key of ['middle', 'ring', 'pinky']) {
      const anchor = tipAnchors[key];
      if (anchor && anchor.parent) anchor.getWorldPosition(natCanon[key]);
    }

    const t = natural.t;
    const grasp = Math.max(curled.pinch, curled.contact);
    for (let fi = 1; fi < 4; fi++) {
      const st = natural.fingers[fi];
      const tracked = target.joints && target.joints[fi];
      const vals = [0, 0, 0];
      if (tracked && tracked.every(Number.isFinite)) {
        if (!st.tracked) st.joints.forEach((j, ji) => { j.x = tracked[ji]; j.v = 0; });
        st.joints.forEach((j, ji) => {
          natSpring(j, tracked[ji], NAT_TRACK_OMEGA, step);
          vals[ji] = j.x;
        });
        st.tracked = true;
        st.x = (vals[0] + vals[1] + vals[2]) / 3;
        st.v = 0;
      } else {
        if (st.x === null || st.tracked) {
          st.x = st.tracked ? st.joints.reduce((sum, j) => sum + j.x, 0) / 3 : curled.fingers[fi];
          st.v = 0;
          st.tracked = false;
        }
        const now = target.curls[fi];
        const delayed = natDelayed(fi, now >= st.x ? NAT_DELAY_CLOSE[fi] : NAT_DELAY_OPEN[fi]);
        let goal = clamp(delayed, 0, 1);
        const open = 1 - goal;
        goal += NAT_REST[fi] * open;
        goal += 0.16 * curled.highlight * open * (1 - grasp);
        const phase = natural.seed + fi * 1.9;
        const idle = 0.55 * Math.sin(t * 1.45 + phase) + 0.3 * Math.sin(t * 3.7 + phase * 1.3)
          + 0.45 * Math.sin(t * 1.1 + natural.seed);
        goal += NAT_IDLE_AMP[fi] * idle * open * (1 - grasp);
        goal += NAT_GRIP_EXTRA[fi] * grasp * goal;
        natSpring(st, clamp(goal, 0, 1), NAT_OMEGA[fi], step);
        const x = clamp(st.x, 0, 1);
        for (let ji = 0; ji < 3; ji++) {
          vals[ji] = clamp(x * NAT_COUPLE[ji] + (ji === 2 ? 0.03 * x * (1 - x) : 0), 0, 1);
          st.joints[ji].x = vals[ji];
          st.joints[ji].v = 0;
        }
      }
      natPoseFinger(fi, vals, target);
    }

    // Counter-offset the tip anchors so hit tests see the canonical pose.
    for (const key of ['middle', 'ring', 'pinky']) {
      const anchor = tipAnchors[key];
      if (!anchor || !anchor.parent) continue;
      anchor.parent.updateWorldMatrix(true, false);
      anchor.position.copy(natCanon[key]);
      anchor.parent.worldToLocal(anchor.position);
    }
  }

  function update(dt, target) {
    for (const key of ['middle', 'ring', 'pinky']) {
      const anchor = tipAnchors[key];
      if (anchor && anchor.userData.homeLocal) anchor.position.copy(anchor.userData.homeLocal);
    }
    if (target) {
      const k = 1 - Math.exp(-16 * dt);
      base.x += (target.pos.x - base.x) * k;
      base.y += (target.pos.y - base.y) * k;
      base.z += (target.pos.z - base.z) * k;
      pose.yaw = target.yaw;
      pose.pitch = target.pitch;
      pose.roll = target.roll;
      for (let i = 0; i < 4; i++) curled.fingers[i] = damp(curled.fingers[i], target.curls[i], 16, dt);
      curled.thumb = damp(curled.thumb, target.thumb, 16, dt);
      curled.pinch = damp(curled.pinch, target.pinch, 18, dt);
      curled.highlight = damp(curled.highlight, target.highlight || 0, 10, dt);
      curled.contact = damp(curled.contact, target.contact || 0, 14, dt);
    }
    root.rotation.set(pose.pitch, pose.yaw, pose.roll, 'YXZ');
    root.position.copy(base).add(snapOffset);

    fingerRigs.forEach((rig, fi) => {
      const c = curled.fingers[fi];
      rig.joints.forEach((joint, ji) => {
        // Camera poses include the three MediaPipe bends for this finger.
        // Scripted QA poses omit them and use the aggregate curl instead.
        const trackedJoint = target && target.joints && target.joints[fi]
          ? target.joints[fi][ji]
          : null;
        joint.rotation.x = (Number.isFinite(trackedJoint) ? trackedJoint : c) * rig.curlMax[ji];
      });
    });

    const pinch = curled.pinch;
    thumbBase.rotation.set(0.55, -0.85 * s * (1 - pinch * 0.35), -0.95 * s * (1 - pinch * 0.5), 'YXZ');
    thumbJoints.forEach((joint, ji) => {
      if (ji === 0) return;
      joint.rotation.x = curled.thumb * (1.15 - ji * 0.15);
      joint.rotation.z = -0.12 * s * pinch;
    });

    // The anatomical shell is driven from the same damped pose, so it follows
    // the tracked hand with the rig's own bone names and rest poses.
    if (anatomy) {
      driveAnatomy(anatomy, {
        thumb: curled.thumb,
        index: curled.fingers[0],
        middle: curled.fingers[1],
        ring: curled.fingers[2],
        pinky: curled.fingers[3],
      }, target && target.joints, target && target.thumbJoints, target && target.spreads, pinch, anatomyTips, snapPoint ? snapGap : PINCH_CONTACT_GAP);
    }

    // Centre the carried tool inside the supported hand volume. All five
    // fingertip landmarks plus the palm contribute, so a wrench or fitting
    // follows a whole-hand grasp rather than appearing pinned to the wrist.
    gripAnchor.position.set(0, 0, 0);
    let gripCount = 0;
    for (const anchor of Object.values(anchors)) {
      if (!anchor) continue;
      anchor.getWorldPosition(gripPoint);
      root.worldToLocal(gripPoint);
      gripAnchor.position.add(gripPoint);
      gripCount += 1;
    }
    if (gripCount) gripAnchor.position.multiplyScalar(1 / gripCount);

    // The pinch anchor is the grasp point: midpoint of the thumb and index
    // endpoints in the glove's own frame, so it follows the curled fingers
    // instead of hovering at a fixed palm offset.
    if (tipAnchors.index && tipAnchors.thumb) {
      tipAnchors.index.getWorldPosition(tipA);
      tipAnchors.thumb.getWorldPosition(tipB);
      root.worldToLocal(tipA);
      root.worldToLocal(tipB);
      pinchAnchor.position.set(
        (tipA.x + tipB.x) / 2,
        (tipA.y + tipB.y) / 2,
        (tipA.z + tipB.z) / 2,
      );
      // The contact ring follows whichever anchor the interaction layer used,
      // so a palm brace or a full-finger power grip highlights the right spot.
      const ring = contactAnchor && contactAnchor.parent ? contactAnchor : pinchAnchor;
      ring.getWorldPosition(haloPoint);
      root.worldToLocal(haloPoint);
      halo.position.copy(haloPoint);
    }

    // Ease the visual grasp snap toward the grip point (or back to zero).
    if (snapPoint) {
      pinchAnchor.getWorldPosition(tipA);
      snapDesired.copy(snapOffset).add(snapPoint).sub(tipA);
      if (snapDesired.length() > SNAP_MAX) snapDesired.setLength(SNAP_MAX);
    } else {
      snapDesired.set(0, 0, 0);
    }
    const ks = 1 - Math.exp(-(snapPoint ? 14 : 10) * dt);
    snapOffset.lerp(snapDesired, ks);
    if (!snapPoint && snapOffset.lengthSq() < 1e-8) snapOffset.set(0, 0, 0);
    root.position.copy(base).add(snapOffset);

    const contact = curled.contact;
    // Subtle: a faint ring that warms on contact, not a glowing UI torus.
    halo.material.opacity = Math.min(0.5, curled.highlight * 0.22 + pinch * 0.12 + contact * 0.32);
    halo.material.color.copy(haloBase).lerp(haloHot, contact);
    const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.08 * curled.highlight + contact * 0.2;
    halo.scale.setScalar(pulse * (1 + contact * 0.3));

    applyNaturalFingers(dt, target);
  }

  // Interaction sets this to the anchor currently touching a target; the halo
  // reads it on the next update. Null falls back to the pinch midpoint.
  let contactAnchor = null;

  return {
    root,
    side,
    gripAnchor,
    pinchAnchor,
    anchors,
    fingerOrder: FINGER_ORDER,
    halo,
    update,
    mats,
    // Damped curl per finger chain, 0 (open) .. 1 (fully closed). The thumb is
    // addressed by key, the four fingers by their name in fingerOrder.
    getCurl(key) {
      if (key === 'thumb') return curled.thumb;
      const i = FINGER_ORDER.indexOf(key) - 1;
      return i >= 0 ? curled.fingers[i] : 0;
    },
    // 'loading' | 'loaded' | 'fallback' for the rendered shell, plus the
    // mapped bone count. Never exposes asset URLs or credentials.
    get modelStatus() { return { ...modelStatus }; },
    setContactAnchor(node) { contactAnchor = node || null; },
    // Visual grasp snap: pass a world point (and the thumb/index pad gap for
    // that object's diameter) while holding it, or null to release.
    setGraspSnap(point, gap = PINCH_CONTACT_GAP) {
      if (point) {
        snapPoint = snapPoint || new THREE.Vector3();
        snapPoint.copy(point);
        snapGap = gap;
      } else {
        snapPoint = null;
      }
    },
    // World-space translation currently applied by the grasp snap.
    snapOffset,
    get contact() { return curled.contact; },
  };
}
