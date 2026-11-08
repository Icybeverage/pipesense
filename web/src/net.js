// PipeSense backend client. The backend (FastAPI, mounted at the same origin)
// owns coaching text and tracing evidence; the browser owns deterministic
// scoring. When no backend responds, callers fall back to local coaching and
// the judge view labels that honestly.

export const EVAL_PATH = '/v1/attempts/evaluate';
export const HEALTH_PATH = '/health';

export const BACKEND_BASE = (typeof window !== 'undefined' && window.PIPESENSE_BACKEND_URL)
  ? String(window.PIPESENSE_BACKEND_URL).replace(/\/+$/, '')
  : '';

// W&B Inference can cold-start during a live event. Keep enough headroom to
// preserve the traced coaching result instead of prematurely presenting the
// offline fallback while the server is still completing a valid request.
export const BACKEND_TIMEOUT_MS = 12000;
export const BACKEND_COOLDOWN_MS = 45000;

async function fetchJson(url, options = {}, timeoutMs = BACKEND_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const ms = Math.round(performance.now() - started);
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (err) { data = null; }
    return { response, status: response.status, ms, data, text };
  } finally {
    clearTimeout(timer);
  }
}

export function buildPayload({ attemptNumber, score, previousScore, primaryIssue, detail, elapsedSeconds, telemetry }) {
  const payload = {
    attempt_number: attemptNumber,
    score,
    previous_score: previousScore,
    primary_issue: primaryIssue,
    elapsed_seconds: Math.round(elapsedSeconds * 10) / 10,
  };
  // The coarse issue groups different failures (a loose nut and a missed
  // socket are both connection_gap); the detail lets the coach name the real one.
  if (typeof detail === 'string' && /^[a-z_]{1,32}$/.test(detail)) payload.detail = detail;
  if (telemetry) {
    payload.telemetry = {
      events_count: Math.min(2000, Math.max(0, Math.round(telemetry.events_count || 0))),
      camera_frames_seen: Math.min(100000, Math.max(0, Math.round(telemetry.camera_frames_seen || 0))),
      input_mode: telemetry.input_mode || 'keyboard_mouse',
      calibrated: Boolean(telemetry.calibrated),
      landmarks_peak: Math.min(42, Math.max(0, Math.round(telemetry.landmarks_peak || 0))),
      two_hand_frames: Math.min(100000, Math.max(0, Math.round(telemetry.two_hand_frames || 0))),
      mean_tracking_confidence: Math.min(1, Math.max(0, Math.round((telemetry.mean_tracking_confidence || 0) * 1000) / 1000)),
      articulation_events: Math.min(10000, Math.max(0, Math.round(telemetry.articulation_events || 0))),
      grip_events: Math.min(10000, Math.max(0, Math.round(telemetry.grip_events || 0))),
      contact_samples: Math.min(100000, Math.max(0, Math.round(telemetry.contact_samples || 0))),
    };
  }
  return payload;
}

export async function postEvaluate(payload) {
  const url = BACKEND_BASE + EVAL_PATH;
  const started = performance.now();
  try {
    const { response, status, ms, data, text } = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return { ok: false, url, status, ms, error: `HTTP ${status}`, raw: text };
    if (!data || !data.outcome || typeof data.outcome.coach !== 'string') {
      return { ok: false, url, status, ms, error: 'malformed response (no outcome.coach)', raw: text };
    }
    return { ok: true, url, status, ms, data };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    const message = err && err.name === 'AbortError'
      ? `timed out after ${BACKEND_TIMEOUT_MS / 1000}s`
      : String((err && err.message) || err);
    return { ok: false, url, status: null, ms, error: message };
  }
}

export async function getHealth() {
  const url = BACKEND_BASE + HEALTH_PATH;
  try {
    const { response, status, ms, data, text } = await fetchJson(url, { method: 'GET' }, 4000);
    if (!response.ok) return { ok: false, url, status, ms, error: `HTTP ${status}`, raw: text };
    return { ok: true, url, status, ms, data, raw: text };
  } catch (err) {
    return { ok: false, url, status: null, error: String((err && err.message) || err) };
  }
}

// Local fallback coaching when the backend cannot be reached. Mirrors the
// deterministic observer/coach wording the backend uses for the same issue.
export function offlineCoaching({ score, previousScore, primaryIssue, detail }) {
  const baseline = previousScore < 0;
  const improved = baseline ? score >= 100 : score > previousScore;
  const diagnoses = {
    sequence: 'The learner worked out of order.',
    height_alignment: 'The trap is not level with the pipe ends.',
    connection_gap: 'The sockets are not reaching the pipe ends.',
    none: 'The assembly is aligned and sealed.',
  };
  const hints = {
    sequence: 'Close the supply valve first, then seat the trap before tightening.',
    height_alignment: 'Lift or lower the trap until both sockets line up with the pipe ends.',
    connection_gap: 'Keep the sockets centered and slide the trap straight onto both pipes.',
    none: 'Connection sealed. The water in the trap blocks sewer gases.',
  };
  const byDetail = {
    valve_open: 'The supply is still live. Close the shutoff valve before tightening or running water.',
    loose_joint: 'One slip nut is only hand-tight. Work the wrench on it until the nut seats.',
    loose_leak: 'A slip nut is barely started and the joint is leaking. Tighten it fully.',
    ready_to_run: 'The trap is sealed. Now turn on the faucet to prove it holds.',
    leak: 'Water is escaping a joint. Tighten the leaking slip nut, then test again.',
    complete: 'Trap holds water and blocks sewer gas. Job done.',
  };
  const text = detail && byDetail[detail] ? byDetail[detail] : (hints[primaryIssue] || hints.connection_gap);
  return {
    observer: diagnoses[primaryIssue] || diagnoses.connection_gap,
    coach: text,
    evaluator: previousScore < 0
      ? 'Baseline recorded.'
      : `Score ${improved ? 'improved' : 'did not improve'} from ${Math.round(previousScore)} to ${Math.round(score)}.`,
    strategy: improved ? 'reinforce' : 'change_modality_visual',
    improved,
    source: 'local-offline',
  };
}
