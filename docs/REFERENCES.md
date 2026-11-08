# References and provenance

## Interaction reference

User-supplied Dropbox video `final.mp4`, reviewed only from 00:22–00:26. The reference shows a standing learner using two tracked hands in front of a large display. Two separated pipe sections move toward one another and visibly snap into a connected state. PipeSense uses this interaction concept—two-hand alignment, snap feedback, and a visible hand-landmark layer.

A trimmed excerpt of that reference window ships with the hackathon demo as `web/assets/real-world-hand-tracking.mp4`, with the poster frame `web/assets/real-world-hand-tracking-poster.jpg`. It appears in the setup stage as a muted, looping, playsinline visual labelled "Real-world hand tracking". The excerpt stays inside its 00:22–00:26 review window; no other portion of the source footage is redistributed.

## Hackathon tutorial stills

`web/assets/tutorial/step-01.jpg` through `step-05.jpg` are AI-rendered photographic instruction stills produced for this hackathon project with an image-generation model; no third-party stock photography is used. They depict the Build a P-Trap sequence under a sink — closing the supply valve, seating the trap on both sockets, tightening the tail and wall slip nuts with an adjustable wrench, and inspecting after the water test — in a consistent gloved-hands trade style. They are rendered without intentional brand marks, and no TradesQuest or reference-clip artwork is reused.

## Anatomical glove model

The rendered work gloves use the **Anatomically Accurate Rigged & Animated Hand
Model** by **Emma L. D. Lieker**, licensed **CC BY-NC 4.0** for this
non-commercial hackathon prototype. The browser-optimized GLBs
(`hand_left.glb`, `hand_right.glb`) are loaded by
`web/src/gloves.js` through Three's `GLTFLoader` as the primary shell, with the
procedural rig kept as the interaction fallback. The source was browser-optimized without
changing its anatomical proportions or skin weights; at runtime PipeSense applies the work-glove
material, normalises the hand length, rotates it into the simulator frame, and mirrors the full
skinned hierarchy for the right hand (the source is a left hand). Attribution, the verbatim `license.txt`, modification note,
and non-commercial licence boundary are documented in `web/assets/models/SOURCE.md`.
The vendored rig names were verified in-repo (`*_prox/*_midd/*_dist` plus
`thumb_meta/thumb_prox/thumb_dist`), and the MediaPipe-driven glove pose applies
physiological clamping and smoothing before those joints are driven.

## Curriculum reference

Pre-existing TradesQuest lesson family: **Build a P-Trap**. Concepts used as reference:

- A P-trap is the U-shaped pipe under a sink.
- Water held in the trap blocks sewer gases.
- Learners should complete an observable task, record the result, and connect the result to evidence.
- Safety boundary: use a simulated or teacher-approved model rather than real tools, chemicals, or a worksite.

No TradesQuest source code or media is copied into this repository. The Unity experience, agent loop, prompts, telemetry schema, and backend are new hackathon work.

The learner-facing demo intentionally omits grade bands. PipeSense presents the
material as a hypothetical professional skills-check practice simulation and
does not claim to issue or represent an accredited certification.

## Photoreal surface pass (2026-11-07)

- `web/assets/env/carpentry_shop_02_1k.hdr`: Poly Haven "Carpentry Shop 02" HDRI, CC0 (https://polyhaven.com/a/carpentry_shop_02).
- `web/assets/tex/wall_tile*.jpg`: Poly Haven "Long White Tiles" diffuse/normal/roughness, CC0 (https://polyhaven.com/a/long_white_tiles).
- `web/assets/tex/{concrete,counter,painted_wall,steel_brushed}*.jpg`: generated for this project with Stable Diffusion XL base 1.0 (CreativeML Open RAIL++-M) on Modal, using circular padding for seamless tiling. Normal and roughness maps derived from the albedo.

## Under-sink realism pass (2026-11-07)

- `web/assets/tex/plywood{,_n,_r}.jpg`: Poly Haven "Plywood" diffuse / normal (GL) / roughness 1K, CC0 (https://polyhaven.com/a/plywood), re-encoded with macOS `sips` (roughness downsized to 512 px). Replaces the earlier SDXL-generated plywood set; used for the sink-base carcass, cabinet floor and door backs.
- `web/assets/tex/floor_wood{,_n,_r}.jpg`: Poly Haven "Laminate Floor 02" diffuse / normal (GL) / roughness, CC0 (https://polyhaven.com/a/laminate_floor_02), downsized to 512 px (roughness 256 px) and re-encoded.
- Everything else added in this pass is procedural, generated at runtime in the browser: baked ambient-occlusion cards, water-stain and rust-streak decals, the PVC-DWV pipe legend and extrusion/roughness maps (generic markings, no manufacturer name), the knit liner and nitrile-dip glove maps, the cabinet, doors, cleaner bottle, sponge, bucket and clamp work lamp geometry.
