# PipeSense simulation design

PipeSense is a first-person virtual simulation for professional and workforce
training. The TradesQuest lesson provides curriculum provenance, while the demo
translates it into a mature, performance-based workshop scenario. The coaching
loop improves instruction inside that simulation; it is not a substitute for
the hands-on task.

## First-person interaction

The camera is the learner's viewpoint at a workshop sink. Two virtual work
gloves occupy the lower foreground. MediaPipe Hand Landmarker supplies 21
landmarks per detected hand. Wrist and palm landmarks position each glove;
joint triplets bend each finger. Thumb–index distance drives a pinch state:
close to grab the nearest eligible fitting, move to manipulate it, open to
release. Detection confidence and stale-frame handling prevent accidental
placements. Learner sessions require the camera plus a completed neutral
calibration before the tutorial and start-simulation flow unlock. Keyboard,
pointer and scripted input exist only as a silent automated-QA channel
(`?qa=1` or `navigator.webdriver`) that reuses the same interaction checks;
it is never offered in the learner interface.

The bench contains usable pipe sections and purpose-driven tools: a P-trap and
slip nuts for assembly, elbows/tees/couplings for route selection, an adjustable
wrench for tightening, a tape measure for length, a level for slope, and a
shutoff valve for safe sequencing. A tool only changes state when held by a
glove and used at a compatible target.

Simulation correctness remains deterministic. The model checks geometry,
part identity, order, slope, connection gaps and completion. The voice agent
explains and adapts coaching, but never decides whether the assembly is valid.

## Self-improving attempt loop

Every water test closes one loop and starts the next:

1. **Observe** structured evidence: action order, pose error, joint engagement,
   nut tightness, leaks, retained water and completion time.
2. **Coach** with one short intervention through the live voice agent.
3. **Revise** the next attempt's teaching strategy. Improvement reinforces the
   current cue; stagnation switches from verbal guidance to a visual ghost,
   kinesthetic target pulses, or a step-by-step reset.
4. **Retry** the same physical task with that intervention active in the scene.
5. **Evaluate** deterministic score delta and trace the full attempt in W&B
   Weave. The loop retains strategies that improve performance and replaces
   those that do not.

This is the main gameplay loop and the primary hackathon evidence. The agent is
not merely narrating a fixed lesson: measured learner outcomes change its next
teaching action.

## Demo lesson: Build a P-Trap

The single lesson has a complete observable loop: shut off the fixture, inspect
the sink tailpiece and wall arm, grab and position the U-shaped trap, seat both
slip joints, use the adjustable wrench to tighten them, then run water. Correct
geometry leaves visible water in the trap and blocks a sewer-gas visualization.
Incorrect height, gap, sequence or tightening creates a distinct failure and a
targeted retry from the voice coach.

Source concept: TradesQuest `content/lessons/plumb.json`, “Build a P-Trap.”
The course marks the activity as a classroom model and content draft;
this demo is likewise training simulation, not field authorization or
certification.
The course marks these activities as classroom models and content drafts; this
demo is likewise training simulation, not field authorization or certification.
