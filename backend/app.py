from __future__ import annotations

import os
import json
from pathlib import Path
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from agents import Attempt, build_response

try:
    import weave
except ImportError:
    weave = None


app = FastAPI(title="PipeSense Voice Agents", version="0.1.0")


class TelemetrySnapshot(BaseModel):
    events_count: int = Field(default=0, ge=0, le=2000)
    camera_frames_seen: int = Field(default=0, ge=0, le=100000)
    input_mode: Literal["keyboard_mouse", "camera", "mixed", "synthetic_practice"] = "keyboard_mouse"
    calibrated: bool = False
    landmarks_peak: int = Field(default=0, ge=0, le=42)
    two_hand_frames: int = Field(default=0, ge=0, le=100000)
    mean_tracking_confidence: float = Field(default=0, ge=0, le=1)
    articulation_events: int = Field(default=0, ge=0, le=10000)
    grip_events: int = Field(default=0, ge=0, le=10000)
    contact_samples: int = Field(default=0, ge=0, le=100000)


class AttemptRequest(BaseModel):
    attempt_number: int = Field(ge=1, le=1000)
    score: float = Field(ge=0, le=100)
    previous_score: float = Field(default=-1, ge=-1, le=100)
    primary_issue: Literal["sequence", "height_alignment", "connection_gap", "none"]
    # Specific failure code from the browser's deterministic check (e.g. loose_leak).
    detail: str | None = Field(default=None, max_length=32, pattern=r"^[a-z_]+$")
    elapsed_seconds: float = Field(default=0, ge=0, le=7200)
    telemetry: TelemetrySnapshot | None = None

    @field_validator("score", "previous_score")
    @classmethod
    def _round_scores(cls, value: float) -> float:
        # Keep bounded numeric telemetry deterministic across runtime/platforms.
        return round(float(value), 2)


def _grade_webcam_tracking(telemetry: TelemetrySnapshot | None) -> dict:
    """Deterministic, privacy-safe control grade; no images or raw landmarks leave the browser."""
    if telemetry is None:
        return {"score": 0, "passed": False, "source": "no_telemetry", "checks": {}}
    if telemetry.input_mode == "synthetic_practice":
        return {
            "score": 0,
            "passed": False,
            "source": "synthetic_practice_not_certifiable",
            "checks": {"real_camera_input": False},
            "metrics": telemetry.model_dump(),
            "privacy": "synthetic_landmarks_no_camera_input",
        }
    checks = {
        "real_camera_input": telemetry.input_mode == "camera",
        "neutral_calibrated": telemetry.calibrated,
        "all_42_landmarks_seen": telemetry.landmarks_peak == 42,
        "sustained_two_hand_control": telemetry.two_hand_frames >= 45,
        "tracking_confidence": telemetry.mean_tracking_confidence >= 0.70,
        "independent_articulation": telemetry.articulation_events >= 8,
        "grip_transitions": telemetry.grip_events >= 2,
        "tool_contact": telemetry.contact_samples >= 10,
    }
    weights = {
        "real_camera_input": 15, "neutral_calibrated": 15, "all_42_landmarks_seen": 15,
        "sustained_two_hand_control": 20, "tracking_confidence": 15,
        "independent_articulation": 10, "grip_transitions": 5, "tool_contact": 5,
    }
    score = sum(weights[name] for name, passed in checks.items() if passed)
    return {
        "score": score,
        "passed": score >= 70 and checks["real_camera_input"] and checks["neutral_calibrated"],
        "source": "mediapipe_aggregate_v1",
        "checks": checks,
        "metrics": telemetry.model_dump(),
        "privacy": "aggregate_metrics_only_no_images_or_raw_landmarks",
    }


grade_webcam_tracking = _grade_webcam_tracking


def _evaluate(request: AttemptRequest):
    payload = request.model_dump(exclude={"telemetry"})
    response = build_response(Attempt(**payload))
    response["evidence"]["webcam_tracking"] = grade_webcam_tracking(request.telemetry)
    return response


if weave and os.getenv("PIPESENSE_ENABLE_WEAVE_TRACING", "").strip().lower() in {"1", "true", "yes", "on"} and os.getenv("WANDB_API_KEY"):
    weave.init(os.getenv("WANDB_WEAVE_PROJECT", "pipesense-hackathon"))
    grade_webcam_tracking = weave.op(name="pipesense/grade-webcam-control")(_grade_webcam_tracking)
    evaluate_attempt = weave.op(name="pipesense/attempt-loop")(_evaluate)
    _tracing_status = {"configured": True, "active": True}
else:
    evaluate_attempt = _evaluate
    _tracing_status = {
        "configured": os.getenv("PIPESENSE_ENABLE_WEAVE_TRACING", "").strip().lower() in {"1", "true", "yes", "on"},
        "active": False,
    }


@app.get("/health")
def health():
    return {
        "ok": True,
        "tracing": _tracing_status,
        "inference": {
            "configured": os.getenv("PIPESENSE_ENABLE_WANDB_INFERENCE", "").strip().lower() in {"1", "true", "yes", "on"},
            "has_api_key": bool(os.getenv("WANDB_API_KEY")),
        },
        "voice": {
            "configured": bool(os.getenv("ELEVENLABS_API_KEY") and os.getenv("ELEVENLABS_AGENT_ID")),
            "provider": "elevenlabs-live" if os.getenv("ELEVENLABS_API_KEY") and os.getenv("ELEVENLABS_AGENT_ID") else None,
        },
    }


@app.post("/v1/voice/signed-url")
def voice_signed_url():
    api_key = os.getenv("ELEVENLABS_API_KEY")
    agent_id = os.getenv("ELEVENLABS_AGENT_ID")
    if not api_key or not agent_id:
        return {"configured": False, "error": "voice_not_configured"}
    endpoint = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?" + urlencode({"agent_id": agent_id})
    request = Request(endpoint, headers={"xi-api-key": api_key, "accept": "application/json"})
    try:
        with urlopen(request, timeout=12) as response:
            payload = json.loads(response.read())
        signed_url = payload.get("signed_url")
        if not signed_url:
            return {"configured": True, "error": "invalid_provider_response"}
        return {"configured": True, "provider": "elevenlabs-live", "signed_url": signed_url}
    except (HTTPError, URLError, TimeoutError, ValueError) as error:
        return {"configured": True, "error": type(error).__name__}


@app.post("/v1/attempts/evaluate")
def evaluate(request: AttemptRequest):
    return evaluate_attempt(request)


web_dir = Path(__file__).resolve().parent.parent / "web"
if web_dir.exists():
    app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")
