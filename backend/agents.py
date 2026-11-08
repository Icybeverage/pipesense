"""PipeSense observer -> coach -> evaluator loop.

Task correctness remains deterministic. Optional W&B Inference may rewrite
coach phrasing only when explicitly enabled by config.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import os
from typing import Any, Literal
from urllib.error import HTTPError
from urllib.request import Request, urlopen

try:
    import weave
except ImportError:  # pragma: no cover - optional dependency at runtime
    weave = None


MAX_TEXT_LEN = 320
ALLOWED_STRATEGIES = (
    "reinforce",
    "change_modality_visual",
    "change_modality_kinesthetic",
    "step_by_step_reset",
)


@dataclass(frozen=True)
class Attempt:
    attempt_number: int
    score: float
    previous_score: float = -1
    primary_issue: str = "none"
    elapsed_seconds: float = 0
    detail: str | None = None


# Detail-specific wording. primary_issue alone groups unlike failures (a loose
# slip nut is reported as connection_gap), so the coach must name the detail.
DETAIL_TEXT = {
    "valve_open": ("The supply valve is still open.", "Close the supply valve before tightening or running water."),
    "trap_not_placed": ("The P-trap has not been placed on the drain.", "Pick up the trap and seat both sockets on the pipe ends."),
    "seat_height": ("The trap is off vertically, so a socket misses its pipe end.", "Raise or lower the trap until both sockets line up, then release."),
    "seat_lateral": ("The trap is off sideways, so the sockets miss the pipe ends.", "Center both sockets over the pipe ends before releasing the trap."),
    "seat_in_progress": ("The trap is in hand and not seated yet.", "Finish seating the trap on both pipe ends."),
    "loose_joint": ("A slip nut is not fully tight, so the joint can seep.", "Use the wrench on that slip nut until it clicks tight."),
    "loose_leak": ("A slip nut was left loose and the joint leaked in the water test.", "Tighten the loose slip nut with the wrench until it clicks, then test again."),
    "leak": ("Water is escaping through a joint.", "Tighten the leaking slip nut, then run the water test again."),
    "ready_to_run": ("The assembly is sealed and ready for the water test.", "Turn on the faucet to prove the trap holds."),
    "complete": ("The trap holds water and blocks sewer gas.", "Connection sealed. The water in the trap blocks sewer gases."),
}
NUT_DETAILS = {"loose_joint", "loose_leak", "leak"}


def _env_flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _safe_text(value: Any, fallback: str) -> str:
    text = value if isinstance(value, str) else fallback
    return " ".join(text.split())[:MAX_TEXT_LEN]


def _deterministic_strategy(attempt: Attempt, improved: bool) -> str:
    if improved:
        return "reinforce"
    if attempt.attempt_number <= 2:
        return "change_modality_visual"
    if attempt.attempt_number == 3:
        return "change_modality_kinesthetic"
    return "step_by_step_reset"


def observer(attempt: Attempt) -> str:
    if attempt.detail in DETAIL_TEXT:
        return DETAIL_TEXT[attempt.detail][0]
    diagnoses = {
        "sequence": "The learner tried to connect before supporting both sides.",
        "height_alignment": "The two pipe ends are not level.",
        "connection_gap": "The pipe ends are level but still too far from the trap.",
        "none": "The connection is aligned and sealed.",
    }
    return diagnoses.get(attempt.primary_issue, diagnoses["connection_gap"])


def coach(attempt: Attempt) -> str:
    if attempt.detail in DETAIL_TEXT:
        return DETAIL_TEXT[attempt.detail][1]
    hints = {
        "sequence": "Support both sides before making the connection.",
        "height_alignment": "Level the ends first; move one hand vertically, then bring both inward.",
        "connection_gap": "Keep the ends level and bring both hands slowly toward the trap.",
        "none": "Connection sealed. The water in the trap blocks sewer gases.",
    }
    return hints.get(attempt.primary_issue, hints["connection_gap"])


def _coach_with_strategy(attempt: Attempt, strategy: str, improved: bool) -> str:
    base_hint = coach(attempt)
    if improved or strategy == "reinforce":
        return base_hint
    if attempt.detail in NUT_DETAILS:
        # Alignment advice would be wrong for a loose nut.
        strategy_adjustments = {
            "change_modality_visual": "The on-screen guide now rings both slip-nut joints.",
            "change_modality_kinesthetic": "Keep the wrench jaw on the nut and turn in small steps.",
            "step_by_step_reset": "Reset, then tighten each slip nut in order before running water.",
        }
        return _safe_text(f"{base_hint} {strategy_adjustments.get(strategy, '')}".strip(), base_hint)
    strategy_adjustments = {
        "change_modality_visual": "Watch the seam and pause when the rims look even before moving inward.",
        "change_modality_kinesthetic": "Try tiny two-finger pulses so both ends move together and stay level.",
        "step_by_step_reset": "Reset fully: level, hold, then close the gap in three slow steps.",
    }
    return _safe_text(
        f"{base_hint} {strategy_adjustments.get(strategy, '')}".strip(),
        base_hint,
    )


def evaluator(attempt: Attempt, improved: bool) -> str:
    if attempt.previous_score < 0:
        return "Baseline recorded."
    return (
        f"Score {'improved' if improved else 'did not improve'} "
        f"from {attempt.previous_score:.0f} to {attempt.score:.0f}."
    )


def offline_loop(attempt: Attempt) -> dict[str, Any]:
    baseline = attempt.previous_score < 0
    improved = attempt.score >= 100 if baseline else attempt.score > attempt.previous_score
    strategy = _deterministic_strategy(attempt, improved)
    return {
        "observer": observer(attempt),
        "coach": _coach_with_strategy(attempt, strategy, improved),
        "evaluator": evaluator(attempt, improved),
        "strategy": strategy,
        "improved": improved,
        "provider": "deterministic-offline",
        "provider_used": False,
    }


def _sanitize_inference_result(
    baseline: dict[str, Any], result: Any
) -> dict[str, Any]:
    if not isinstance(result, dict):
        return {**baseline, "provider_error": "invalid_json_shape"}
    strategy = result.get("strategy")
    if strategy not in ALLOWED_STRATEGIES:
        strategy = baseline["strategy"]
    sanitized = {
        "observer": _safe_text(result.get("observer"), baseline["observer"]),
        "coach": _safe_text(result.get("coach"), baseline["coach"]),
        "evaluator": _safe_text(result.get("evaluator"), baseline["evaluator"]),
        "strategy": strategy,
        "improved": baseline["improved"],
    }
    provider_evidence = result.get("__provider_evidence")
    if isinstance(provider_evidence, dict):
        sanitized["provider"] = provider_evidence.get(
            "provider", baseline.get("provider", "deterministic-offline")
        )
        sanitized["provider_used"] = bool(
            provider_evidence.get("provider_used", baseline.get("provider_used", False))
        )
        for key in ("provider_error", "provider_error_meta", "provider_disabled"):
            if key in provider_evidence:
                sanitized[key] = provider_evidence[key]
    else:
        sanitized["provider"] = baseline.get("provider", "deterministic-offline")
        sanitized["provider_used"] = baseline.get("provider_used", False)
    return sanitized


def inference_coach(attempt: Attempt, baseline: dict[str, Any]) -> dict[str, Any]:
    if not _env_flag("PIPESENSE_ENABLE_WANDB_INFERENCE"):
        return {**baseline, "provider_disabled": "PIPESENSE_ENABLE_WANDB_INFERENCE"}
    api_key = os.getenv("WANDB_API_KEY")
    if not api_key:
        return {**baseline, "provider_error": "missing_api_key"}
    model = os.getenv("WANDB_INFERENCE_MODEL", "openai/gpt-oss-20b")
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a concise text coach for a simulated plumbing lesson. "
                    "Return JSON with observer, coach, evaluator, strategy. "
                    "Never change improved or numeric score interpretation. "
                    "Describe only the failure named in attempt.detail and deterministic_result; "
                    "never mention a problem that is not stated there. "
                    "coach <= 22 words."
                ),
            },
            {"role": "user", "content": json.dumps({"attempt": asdict(attempt), "deterministic_result": baseline})},
        ],
        "response_format": {"type": "json_object"},
    }
    request = Request(
        "https://api.inference.wandb.ai/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
                 "OpenAI-Project": os.getenv("WANDB_PROJECT", "pipesense"),
                 "User-Agent": "PipeSense/0.1"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=12) as response:
            content = json.loads(response.read())["choices"][0]["message"]["content"]
            result = json.loads(content)
        sanitized = _sanitize_inference_result(baseline, result)
        sanitized["__provider_evidence"] = {
            "provider": f"wandb-inference:{model}",
            "provider_used": True,
        }
        return sanitized
    except HTTPError as error:  # Preserve status metadata for judge evidence.
        return {
            **baseline,
            "__provider_evidence": {
                "provider": baseline.get("provider", "deterministic-offline"),
                "provider_used": False,
                "provider_error": "HTTPError",
                "provider_error_meta": {
                    "status": error.code,
                    "reason": str(error.reason),
                },
            },
        }
    except Exception as error:  # Demo must survive venue Wi-Fi/model failures.
        return {
            **baseline,
            "__provider_evidence": {
                "provider": baseline.get("provider", "deterministic-offline"),
                "provider_used": False,
                "provider_error": type(error).__name__,
            },
        }


def _weave_enabled() -> bool:
    return _env_flag("PIPESENSE_ENABLE_WEAVE_TRACING")


def _decorate_if_tracing(name: str, fn):
    if weave and _weave_enabled():
        return weave.op(name=name)(fn)
    return fn


_observer_op = _decorate_if_tracing("pipesense/observer", observer)
_coach_op = _decorate_if_tracing("pipesense/coach", coach)
_evaluator_op = _decorate_if_tracing("pipesense/evaluator", evaluator)
_inference_op = _decorate_if_tracing("pipesense/inference-coach", inference_coach)


def run_loop(attempt: Attempt) -> dict[str, Any]:
    baseline = attempt.previous_score < 0
    improved = attempt.score >= 100 if baseline else attempt.score > attempt.previous_score
    strategy = _deterministic_strategy(attempt, improved)
    deterministic = {
        "observer": _observer_op(attempt),
        "coach": _coach_with_strategy(attempt, strategy, improved),
        "evaluator": _evaluator_op(attempt, improved),
        "strategy": strategy,
        "improved": improved,
        "provider": "deterministic-offline",
        "provider_used": False,
    }
    result = _inference_op(attempt, deterministic)
    return _sanitize_inference_result(deterministic, result)


def build_response(attempt: Attempt) -> dict[str, Any]:
    baseline = offline_loop(attempt)
    result = run_loop(attempt)
    tracing_active = bool(weave and _weave_enabled())
    inference_enabled = _env_flag("PIPESENSE_ENABLE_WANDB_INFERENCE")
    return {
        "attempt": asdict(attempt),
        "outcome": {
            "observer": result["observer"],
            "coach": result["coach"],
            "evaluator": result["evaluator"],
            "strategy": result["strategy"],
            "improved": bool(result["improved"]),
        },
        "evidence": {
            "provider": {
                "configured": inference_enabled,
                "used": bool(result.get("provider_used")),
                "name": result.get("provider", "deterministic-offline"),
                "error": result.get("provider_error"),
                "error_meta": result.get("provider_error_meta"),
            },
            "tracing": {
                "configured": _weave_enabled(),
                "active": tracing_active,
                "project": os.getenv("WANDB_WEAVE_PROJECT", "pipesense-hackathon") if tracing_active else None,
                "reason": None if tracing_active else "disabled_or_unavailable",
            },
            "deterministic_score": {
                "current": attempt.score,
                "previous": attempt.previous_score,
                "improved": baseline["improved"],
            },
        },
    }
