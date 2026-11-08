# PipeSense — hand-tracked apprenticeship simulator

**Anything Applied Agentic Hackathon · San Francisco · Nov 7, 2026 · Challenge 4: Beyond the Resume**

> What if AI understood what you can actually do?

A trainee performs a real trade procedure with **their own hands, tracked by an ordinary camera** — no keyboard, no controller. When a test fails, an agent loop diagnoses the actual mistake and **changes the next attempt**. The trainee leaves with a **skill record** built from what they demonstrably did.

Plumbing (installing a P-trap) is the first apprenticeship module. The goal is every trade.

| | |
|---|---|
| **Live app** | https://pipesense-training.vercel.app — opens the hands-free stage demo; *Try it with your hands* starts the camera lesson |
| **Demo video (2:40)** | see the [latest release](../../releases/latest) |
| **Run time** | ~60 s hands-free demo · camera lesson works in any modern browser (HTTPS) |

## What happens in the demo

1. **Attempt 1** — the trainee closes the supply valve, seats the trap, tightens the tail nut… and forgets the wall nut.
2. **Water test** — water leaks at the wall joint. Score **66**.
3. **Agent loop** — the *Observer* names the real failure (“a slip nut was left loose; the joint leaked”), the *Coach* gives the fix, and the loop applies an **intervention to the next attempt** (guide rings on both slip-nut joints).
4. **Attempt 2** — the trap holds water and blocks sewer gas. Score **100**.
5. **Skill record** — steps verified, each attempt’s outcome, the coaching applied, and the improvement (66 → 100).

## How it works

```
camera ──► MediaPipe Hand Landmarker (21 points / hand)
              │
              ▼
   virtual work gloves (pinch to grab · twist to turn)
              │
              ▼
   deterministic simulation  ──► score + specific failure (e.g. loose_leak)
              │
              ▼
   Observer → Coach → Adapt → Retry → Evaluate      (backend agent loop)
              │                                     traced with W&B Weave
              ▼
   skill record (only from deterministic evidence — never from the coach)
```

**Design rule:** the simulation decides correctness; the agents explain and adapt but never change a score.

## Built today (Nov 7)

PipeSense started at an earlier hackathon. Today’s work:

- **Photoreal rebuild** of the scene (real sink-base cabinet, HDR lighting, scanned/generated textures, Blender-modelled tools) with an adaptive quality governor for tablets.
- **Fixed real-camera tracking** — MediaPipe reports `visibility: 0`, which had discarded every real detection; added an end-to-end camera test (`web/e2e/camera-path.mjs`).
- **Coaching names the actual failure** — the backend now receives the specific failure code instead of a coarse category.
- **Natural glove motion** — staggered finger curls, rest pose, grasp onto the held part.
- **Hands-free stage demo**, **skill record** (Challenge 4), and a sourced pitch video.

## Why it matters

- ~**42,000** openings a year for plumbers, pipefitters and steamfitters (2025–35); most learn through a **4–5 year apprenticeship** — U.S. BLS Occupational Outlook Handbook.
- U.S. construction must attract ~**349,000** new workers in 2026 — Associated Builders and Contractors (Jan 2026).
- Showing guidance on the actual work pieces cut assembly errors by **82%** — Tang et al., ACM CHI 2003.

## Honest notes

- In the hands-free demo the hands are **simulated** (labelled on screen). The product is controlled by real hands through the camera.
- Practice, **not certification**.
- On this deployment the coaching text is rule-based (the LLM rewrite path is configured but currently out of credits); scores are always deterministic.

## Run locally

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python run.py          # serves the app at http://127.0.0.1:8000
```

Tests: `cd web && npm test` · `cd backend && .venv/bin/python -m unittest`

## Repo map

| Path | What |
|---|---|
| `web/` | three.js app: scene (`src/world.js`), gloves (`src/gloves.js`), hand input (`src/input.js`), simulation (`src/sim.js`), demo + skill record (`app.js`) |
| `backend/` | FastAPI agent loop: Observer / Coach / Evaluator (`agents.py`), API (`app.py`) |
| `web/e2e/` | real-camera end-to-end test |
| `tools/blender/` | prop modelling and Cycles renders |
| `docs/` | submission summary, loop and simulation design, asset sources |
