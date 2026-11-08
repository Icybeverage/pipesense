// Deterministic W&B evidence-slide labels: node story.test.mjs
import assert from 'node:assert/strict';
import { NOT_CERTIFIABLE, PENDING, buildStoryModel, SCORE_BOUNDARY } from './src/story.js';

function attempt(overrides = {}) {
  return {
    attempt: 1,
    reason: 'manual',
    score: 62,
    previous: -1,
    primary_issue: 'sequence',
    detail: 'valve_open',
    strategy: 'change_modality_visual',
    verdict: 'accepted',
    source: 'backend',
    input_mode: 'camera',
    outcome: { improved: true, coach: '...' },
    response: null,
    ...overrides,
  };
}

function backendResponse({ score = {}, provider = {}, tracing = {}, webcam = {} } = {}) {
  return {
    source: 'backend',
    outcome: { improved: true, coach: '...' },
    evidence: {
      deterministic_score: score,
      provider,
      tracing,
      webcam_tracking: webcam,
    },
  };
}

// 1. A session with no evaluated attempt reports pending everywhere and never
// implies certification.
{
  const view = buildStoryModel({ evalHistory: [] });
  assert.equal(view.empty, true);
  assert.equal(view.evaluated, false);
  assert.equal(view.score, PENDING);
  assert.equal(view.issue, PENDING);
  assert.equal(view.camera, PENDING);
  assert.equal(view.certificationTone, 'muted');
  assert.match(view.certification, /^Pending/);
}

// 2. Full backend evidence maps every field, with the score pair coming from
// the response rather than the attempt record.
{
  const view = buildStoryModel({
    evalHistory: [attempt({
      score: 999,
      response: backendResponse({
        score: { previous: 40, current: 88 },
        provider: { name: 'wb-inference', used: true },
        tracing: { project: 'pipesense-training', active: true },
        webcam: { score: 88, passed: true },
      }),
    })],
  });
  assert.equal(view.score, '40 → 88 (+48)');
  assert.equal(view.issue, 'sequence / valve_open');
  assert.equal(view.intervention, 'change_modality_visual (accepted)');
  assert.equal(view.provider, 'wb-inference · used');
  assert.equal(view.providerTone, 'ok');
  assert.equal(view.weave, 'pipesense-training · trace active');
  assert.equal(view.weaveActive, true);
  assert.equal(view.input, 'Camera · certifying path');
  assert.equal(view.camera, '88/100 · verified real-camera control');
  assert.equal(view.cameraTone, 'ok');
  assert.equal(view.certification, 'Real-camera control verified');
  assert.equal(view.certificationTone, 'ok');
}

// 3. Guided practice is never certifiable, whatever the numbers say, and the
// camera grade is refused rather than inferred.
{
  const view = buildStoryModel({
    evalHistory: [attempt({
      input_mode: 'synthetic_practice',
      response: backendResponse({
        score: { previous: 0, current: 100 },
        provider: { name: 'wb-inference', used: true },
        webcam: { score: 0, passed: false },
      }),
    })],
  });
  assert.equal(view.synthetic, true);
  assert.equal(view.input, 'Guided practice · simulated hands');
  assert.match(view.camera, /Not certifiable/);
  assert.equal(view.cameraTone, 'danger');
  assert.equal(view.certification, NOT_CERTIFIABLE);
  assert.equal(view.certificationTone, 'danger');
}

// 4. session.guidedPractice alone is enough to force the synthetic label.
{
  const view = buildStoryModel({
    guidedPractice: true,
    evalHistory: [attempt({
      input_mode: 'camera',
      response: backendResponse({ webcam: { score: 90, passed: true } }),
    })],
  });
  assert.equal(view.synthetic, true);
  assert.equal(view.certification, NOT_CERTIFIABLE);
}

// 5. With no backend evidence the provider, trace and camera grade read
// unavailable or pending — never invented — while the local score still shows.
{
  const view = buildStoryModel({
    evalHistory: [attempt({
      score: 55,
      previous: 40,
      response: { source: 'local-offline', outcome: { improved: false, coach: '...' }, evidence: null },
    })],
  });
  assert.equal(view.evaluated, true);
  assert.equal(view.score, '40 → 55 (+15)');
  assert.match(view.provider, /^Unavailable/);
  assert.equal(view.providerTone, 'muted');
  assert.match(view.weave, /^Unavailable/);
  assert.equal(view.weaveActive, false);
  assert.equal(view.camera, 'Pending — no camera-control grade returned');
  assert.equal(view.result, 'Did not improve · scored and coached in browser');
}

// 6. A provider that was configured but not used reads as a warning fallback.
{
  const view = buildStoryModel({
    evalHistory: [attempt({
      response: backendResponse({ provider: { name: 'wb-inference', used: false } }),
    })],
  });
  assert.equal(view.provider, 'wb-inference · fallback');
  assert.equal(view.providerTone, 'warn');
}

// 7. A baseline attempt (no usable previous score) is labelled, not treated as
// a delta against a fabricated zero.
{
  const view = buildStoryModel({
    evalHistory: [attempt({ score: 62, previous: -1, response: backendResponse() })],
  });
  assert.equal(view.score, '62 · baseline');
}

// 8. A missing issue string is reported as "none reported" rather than blank.
{
  const view = buildStoryModel({
    evalHistory: [attempt({ primary_issue: '', detail: '', response: backendResponse() })],
  });
  assert.equal(view.issue, 'none reported');
}

// 9. An inactive trace still names the project when the backend returned one.
{
  const view = buildStoryModel({
    evalHistory: [attempt({
      response: backendResponse({ tracing: { project: 'pipesense-training', active: false } }),
    })],
  });
  assert.equal(view.weave, 'pipesense-training · trace inactive');
  assert.equal(view.weaveActive, false);
}

// 10. An unseen input mode is surfaced verbatim instead of being guessed.
{
  const view = buildStoryModel({
    evalHistory: [attempt({ input_mode: 'telepathy', response: backendResponse() })],
  });
  assert.equal(view.input, 'Unreported input mode (telepathy)');
}

// 11. The deterministic-vs-model boundary is one fixed line.
{
  assert.match(SCORE_BOUNDARY, /deterministic/i);
  assert.match(SCORE_BOUNDARY, /coaching/i);
}

console.log('story.test.mjs: all assertions passed');
