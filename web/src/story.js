// Pure label logic for the W&B evidence slide.
//
// The slide must never infer: every value comes from the most recent backend
// response, and anything the response did not return reads as unavailable or
// pending. Keeping the mapping here (DOM-free) lets node tests pin the labels
// that judges read, including the non-certification boundary.

export const NOT_CERTIFIABLE = 'NOT CERTIFIABLE';
export const PENDING = 'Pending — no evaluated attempt yet';

const finite = (value) => (Number.isFinite(value) ? value : null);
const signed = (value) => `${value >= 0 ? '+' : ''}${value}`;

function certificationOf({ synthetic, webcam }) {
  if (synthetic) return { certification: NOT_CERTIFIABLE, certificationTone: 'danger' };
  if (webcam.passed === true) return { certification: 'Real-camera control verified', certificationTone: 'ok' };
  return { certification: 'Not verified — more tracked practice needed', certificationTone: 'muted' };
}

export function buildStoryModel({ evalHistory = [], guidedPractice = false } = {}) {
  const latest = evalHistory.length ? evalHistory[evalHistory.length - 1] : null;
  const response = latest && latest.response && latest.response.outcome ? latest.response : null;
  const evidence = (response && response.evidence) || {};
  const provider = evidence.provider || {};
  const tracing = evidence.tracing || {};
  const score = evidence.deterministic_score || {};
  const webcam = evidence.webcam_tracking || {};
  const backend = response ? response.source === 'backend' : false;
  const inputMode = latest ? latest.input_mode || 'unknown' : 'unknown';
  const synthetic = inputMode === 'synthetic_practice'
    || guidedPractice
    || webcam.source === 'synthetic_practice_not_certifiable';

  const model = {
    empty: !latest,
    evaluated: Boolean(response),
    synthetic,
    score: PENDING,
    issue: PENDING,
    intervention: PENDING,
    provider: PENDING,
    providerTone: 'muted',
    weave: PENDING,
    weaveActive: false,
    input: PENDING,
    camera: PENDING,
    cameraTone: 'muted',
    result: PENDING,
    ...certificationOf({ synthetic, webcam }),
  };

  if (!latest) {
    model.certification = 'Pending — no attempt to certify';
    model.certificationTone = 'muted';
    return model;
  }

  // Deterministic score delta: prefer the response's own score pair, fall back
  // to the attempt record, and never invent a previous value.
  const previous = finite(score.previous) ?? finite(latest.previous);
  const current = finite(score.current) ?? finite(latest.score);
  if (current !== null) {
    model.score = previous !== null && previous >= 0
      ? `${previous} → ${current} (${signed(current - previous)})`
      : `${current} · baseline`;
  }

  model.issue = latest.primary_issue
    ? `${latest.primary_issue}${latest.detail ? ` / ${latest.detail}` : ''}`
    : 'none reported';
  model.intervention = `${latest.strategy || 'none'}${latest.verdict ? ` (${latest.verdict})` : ''}`;

  if (provider.name) {
    model.provider = `${provider.name} · ${provider.used ? 'used' : 'fallback'}`;
    model.providerTone = provider.used ? 'ok' : 'warn';
  } else if (response) {
    model.provider = backend
      ? 'Unavailable — backend did not report a provider'
      : 'Unavailable — local fallback used, no provider evidence';
  }

  model.weaveActive = tracing.active === true;
  if (tracing.project || tracing.active !== undefined) {
    model.weave = `${tracing.project || 'project unknown'} · ${model.weaveActive ? 'trace active' : 'trace inactive'}`;
  } else if (response) {
    model.weave = 'Unavailable — no trace returned';
  }

  model.input = {
    camera: 'Camera · certifying path',
    synthetic_practice: 'Guided practice · simulated hands',
    mixed: 'Mixed source · camera + scripted input',
    keyboard_mouse: 'Automated QA · scripted input',
  }[inputMode] || `Unreported input mode (${inputMode})`;

  if (synthetic) {
    model.camera = 'Not certifiable — simulated guided practice, no camera input';
    model.cameraTone = 'danger';
  } else if (finite(webcam.score) !== null) {
    model.camera = `${webcam.score}/100 · ${webcam.passed ? 'verified real-camera control' : 'more tracked practice needed'}`;
    model.cameraTone = webcam.passed ? 'ok' : 'warn';
  } else {
    model.camera = 'Pending — no camera-control grade returned';
  }

  model.result = response
    ? `${response.outcome.improved ? 'Improved' : 'Did not improve'} · ${backend ? 'scored in browser, coached by backend' : 'scored and coached in browser'}`
    : PENDING;

  return model;
}

// The certification boundary is one line, shown verbatim on the slide.
export const SCORE_BOUNDARY = 'Deterministic browser scoring decides geometry, sequence and pass/fail; the model only rewrites coaching language and the bounded next intervention.';
