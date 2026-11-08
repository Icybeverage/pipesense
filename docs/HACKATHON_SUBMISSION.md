# PipeSense — Anything Applied Agentic Hackathon (EF SF, 2026-11-07)

## Submission text (BuilderBase)

**Title:** PipeSense — a hand-tracked mixed-reality job-simulation pilot (Challenge 4: Beyond the Resume)

**One-liner:** What if AI understood what you can actually do? A trainee does a real job procedure with their own camera-tracked hands; when a test fails, a coach diagnoses it and changes the next attempt; the trainee leaves with a skill record built from what they demonstrably did. Scenario 1 is plumbing (install a P-trap); the loop is designed to extend to other hands-on jobs.

**Why it matters (verified sources)**
- About 42,000 openings a year for plumbers, pipefitters and steamfitters are projected, 2025–35; most learn through a 4- or 5-year apprenticeship. — U.S. BLS Occupational Outlook Handbook (updated Oct 29, 2026)
- U.S. construction needs to attract an estimated 349,000 net new workers in 2026. — Associated Builders and Contractors, Jan 15, 2026
- Overlaying 3D instructions on the actual work pieces reduced the error rate for an assembly task by 82% (vs. a printed manual and screen-based instruction). — Tang, Owen, Biocca & Mou, ACM CHI 2003

**What it does**
- First-person P-trap installation in the browser: close the supply valve, seat the trap, tighten both slip nuts with a wrench, run the water test.
- Camera-based, hands-only control: no keyboard or controller. Your real hands drive the work gloves through an ordinary camera (MediaPipe, 21 landmarks per hand, calibration-gated); pinch thumb to index to grab, twist your wrist to turn.
- A deterministic simulation scores the work: sequence, alignment, nut torque, leaks, trap seal. The score is never decided by a model.
- When a test fails, the Observer names the actual failure (for example, "A slip nut was left loose and the joint leaked"), the Coach gives the fix, and the loop applies an intervention to the next attempt (visual guide rings on both slip-nut joints, a wider snap window, or a step-by-step reset). The Evaluator compares the new score with the last one and keeps or replaces the intervention.

**What we built today**
PipeSense started at an earlier hackathon. Today's work, in commits 43aa391 → f0a5825 on branch `hackathon/photoreal-autonomous-demo`:
- Rebuilt the live scene as a realistic sink-base cabinet: real light map, scanned and generated textures, a clamp-on work lamp, PVC with printed markings, coated work gloves, and an adaptive quality governor for tablets.
- Modelled the hero props (slip nut, wrench, faucet handle, valve lever) in Blender from code.
- Found and fixed a bug that discarded every real hand detection: MediaPipe reports visibility 0. Added an end-to-end camera test that drives the real camera path with recorded hands.
- Fixed coaching that gave pipe-alignment advice for a leaking nut: the backend now receives the specific failure and coaches that.
- Built a hands-free stage demo (the home page) with retries, recovery and restart.
- Added the skill record (Beyond the Resume): steps verified, each attempt's score and outcome, the coaching applied and the improvement, built only from the session's deterministic evaluations.
- Made a 2:12 pitch video with motion graphics and sourced statistics.
- Rendered a ray-traced pitch reel with Blender Cycles on Modal GPUs.

**Human–agent collaboration:** the trainee does the physical work; the agent loop watches each water test and changes the next attempt. Every coaching decision is logged against its deterministic score (traced to W&B Weave on the live deployment).

**Tech:** three.js (WebGL), MediaPipe Hand Landmarker, Python/FastAPI backend on Vercel, W&B Weave tracing, Blender (bpy) + Modal GPUs for assets and renders.

**Links**
- Live app: https://pipesense-training.vercel.app
- Stage demo (one tap, then hands-free): https://pipesense-training.vercel.app/?demo=1
- Code: https://github.com/Icybeverage/pipesense-training (branch `hackathon/photoreal-autonomous-demo`)

## Stage script (≈2 min)

1. **(10 s)** "Trades are short of skilled workers, and you can't learn plumbing from a video. PipeSense lets a trainee practise the real procedure with their own hands."
2. **(60 s)** Tap the start button on `?demo=1`. It narrates itself. Attempt 1 skips the wall nut, the water test leaks, the coach names the loose nut, attempt 2 passes, and the score goes 66 → 100.
3. **(30 s, if time)** Open the live app without `?demo=1`, raise both hands, calibrate, and show the gloves following your real hands. Bare hands or light gloves track best.
4. **(20 s)** "The score is deterministic; the agent loop explains the failure and changes the next attempt. Today we rebuilt the scene photoreal, fixed real-camera tracking, and made the coach name the actual failure."

## Say / don't say (accuracy)

- Say the demo hands are **simulated**; the app labels it. Real-hand control is the live-camera path.
- Say "guided practice — not certification". The app never certifies.
- The coaching on the live deployment is **rule-based**: W&B Inference currently returns 402 (out of credits), so no LLM rewrites the text. Describe it as an agent loop with deterministic diagnosis, not as an LLM coach, unless credits are restored.
- "Traced in W&B" is true on the live deployment (tracing active).

## Pre-demo checklist

- [ ] Open the stage link on the Galaxy in its own Chrome (not through remote desktop); tap once; confirm smooth playback. If it stutters, add `&quality=2`.
- [ ] Allow the camera once on the live-app page.
- [ ] Confirm venue Wi-Fi loads the app (three.js and MediaPipe come from public CDNs).
- [ ] Backup: captions-only `?demo=1&mute=1`; offline fallback: run `backend/.venv/bin/python run.py` on the laptop and open `http://127.0.0.1:8000/?demo=1`.
- [ ] Presenter shortcuts for the autoplay demo only: **R** restart, **Esc** stop, "Run again". The trainee never uses a keyboard: PipeSense is controlled by the person's own hands through the camera (pinch to grab, twist to turn).
