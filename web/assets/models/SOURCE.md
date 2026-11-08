# Anatomically constrained hand model — source and attribution

## Model

- **Title:** Anatomically Accurate Rigged & Animated Hand Model
- **Author:** Emma L. D. Lieker
- **Source:** https://github.com/emmalieker/anatomical-hand-model
- **Source revision:** `f27f19f55f8270b3108ea0b53ce5aa81c543ff7c`
- **Licence:** CC BY-NC 4.0
- **Files used:** `hand_left.glb`, `hand_right.glb`

The two GLBs are loaded by `web/src/gloves.js` as the primary rendered glove
shell. The procedural rig stays available only as a loading/error fallback and
continues to own the interaction anchors.

## Browser preparation

The source GLB was optimized with glTF-Transform 4.5.0 using 1024px WebP
textures and KHR mesh quantization. The same skinned source is shipped under
both filenames; PipeSense mirrors the complete hierarchy at runtime for the
right hand. No vertices, skin weights, bone names or anatomical proportions
were manually changed.

The vendored GLBs were inspected directly and expose the same named node set on
both sides, including:

- Finger deform chain names: `index_prox`, `index_midd`, `index_dist`,
  `midd_prox`, `midd_midd`, `midd_dist`, `ring_prox`, `ring_midd`,
  `ring_dist`, `pinky_prox`, `pinky_midd`, `pinky_dist`
- Thumb deform chain names: `thumb_meta`, `thumb_prox`, `thumb_dist`
- Additional non-driven helpers: `index_meta`, `midd_meta`, `ring_meta`,
  `pinky_meta`, `thumb_trapez`, `radius_ulna`, `Hand`, `Nails`, `Rig`

Runtime articulation in `web/src/gloves.js` drives the three deform pivots per
finger from MediaPipe MCP/PIP/DIP-derived bends, and drives the thumb's
`meta/prox/dist` chain from the thumb joint triplets `[0,1,2]`, `[1,2,3]`,
`[2,3,4]` plus opposition/splay.

## Licence boundary

`license.txt` is copied verbatim from the source repository. CC BY-NC 4.0
requires attribution and prohibits commercial use. This asset is used only in
the non-commercial hackathon prototype. A production release must obtain a
commercial licence or replace the asset.

PipeSense changes the material, orientation, scale and handedness at runtime
and preserves the source topology, skin weights and anatomical bone layout.

## Runtime behaviour

`createGlove(side)` stays synchronous and never awaits the network. While a model loads,
and permanently if it fails, the procedural glove renders. The active shell is published
non-sensitively for automated QA:

- `document.body.dataset.gloveModels` — `loading` | `loaded` | `fallback`
- `window.PipeSense.gloveStatus()` — same value per side

## September 30 rig correction

The source thumb points along negative X, so the complete hierarchy is mirrored
for the right glove. Each deform bone derives its flexion axis from its bind-pose
longitudinal direction and the palm normal; splay uses the palm normal.
The surface uses an RGBA micro-normal texture compatible with Three.js r170.

## September 30 second pass (fingertip and anchor alignment)

- The shell is fitted by the middle finger: its `midd_prox` pivot is placed on
  the procedural middle knuckle and its knuckle-to-tip length is scaled to the
  procedural finger. Centring on `radius_ulna` had left the shell about 30 mm
  toward the thumb, with fingertips 23-40 mm short of the interaction anchors.
- The source has no tip bones. Each distal bone's tip is measured from the skin
  (outermost vertex band in that bone's frame) and the fingertip interaction
  anchors are re-parented there, so contact and pinch follow the rendered
  fingers (measured agreement 1-4 mm). The palm anchor moves to the measured
  palm surface. The procedural rig keeps the anchors only in fallback.
- The thumb flexes toward its measured palmar pad (the nail faces about 50
  degrees away from the finger nails), not the palm normal.
- A bounded thumb-plus-index solve, weighted by the pinch value, closes the
  rendered pinch to pad contact (13 mm between tip centres, previously 49 mm).
- Tracked splay is applied relative to each finger's bind-pose fan.
- The cuff is fitted to the measured wrist section and fades toward the elbow.
