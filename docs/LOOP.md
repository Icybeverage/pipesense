# Adaptive voice-agent loop

1. Unity records structured attempt telemetry: hand positions, connection alignment, action order, elapsed time, and deterministic geometry score.
2. The Observer agent converts telemetry into one concise diagnosis.
3. The Coach agent speaks a short hint that addresses the diagnosis without revealing every step.
4. The learner retries the same connection.
5. The Evaluator compares the attempts and measures improvement.
6. If improvement is below threshold, the Coach revises the hint strategy for the next pass.

Every stage is a nested W&B Weave operation. The trace makes the loop visible to judges, while deterministic Unity measurements remain the source of truth for task correctness.

