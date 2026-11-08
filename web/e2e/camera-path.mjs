// PipeSense real-camera-path end-to-end test.
//
// Drives the LEARNER camera path (not ?qa=1, not the webdriver QA channel) in
// real Chrome whose fake camera plays a video of real hands, then checks:
// camera starts, MediaPipe loads, both hands are detected, the gloves move,
// and neutral calibration completes. It also checks denied / absent /
// insecure-context cameras show a clear message and keep Guided practice
// reachable. Always silent: --mute-audio and &mute=1.
//
// Run (backend + web already serving http://127.0.0.1:8000):
//   ffmpeg -i web/assets/real-world-hand-tracking.mp4 -an \
//     -vf "fps=30,crop=360:270:120:290,scale=640:480,format=yuv420p" hands.y4m
//   node web/e2e/camera-path.mjs --video hands.y4m [--out DIR] [--seconds 25]
//        [--scenarios camera,denied,absent,insecure,offline-model,race]
//        [--url http://127.0.0.1:8000/?learn=1] [--headed]
// The camera scenario needs both hands clearly visible and held still ~1 s;
// the stock clip (black gloves, side-on, overlapping) rarely shows two hands,
// so prefer a two-bare-hands clip with a hold segment for the calibration gate.
// Exit code 0 when every requested scenario passes. Writes summary.json and
// screenshots to --out (default: ./camera-e2e-out).
//
// Test-only instrumentation: app.js is served through page.route with one
// appended line exposing its module-scoped `input` and `gloves` so the test
// can read glove positions and wrap detectForVideo for timing. Nothing else
// in the app is altered and the page sees navigator.webdriver === false.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(here, '../../node_modules/playwright-core'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArgs(argv) {
  const out = { seconds: 25, scenarios: 'camera,denied,absent,insecure,offline-model,race', url: 'http://127.0.0.1:8000/?learn=1', out: 'camera-e2e-out', headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headed') out.headed = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  out.seconds = Number(out.seconds);
  out.scenarios = String(out.scenarios).split(',').map((s) => s.trim()).filter(Boolean);
  return out;
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(args.out, { recursive: true });
const pageUrl = `${args.url}${args.url.includes('?') ? '&' : '?'}mute=1`;
const HOOK = '\n;window.__psTest = { input, gloves };\n';

async function launch(extraArgs) {
  return chromium.launch({
    executablePath: CHROME,
    headless: !args.headed,
    args: [
      '--mute-audio',
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      ...extraArgs,
    ],
  });
}

async function openPage(browser, { initScript, routes } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const external = new Map();
  const failed = [];
  const consoleErrors = [];
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol.startsWith('http')) {
      const key = `${u.origin}${u.pathname}`;
      external.set(key, (external.get(key) || 0) + 1);
    }
  });
  page.on('requestfailed', (req) => failed.push(`${req.url()} ${req.failure()?.errorText}`));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  await page.route(/\/app\.js(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    await route.fulfill({ response: res, body: body + HOOK });
  });
  if (initScript) await page.addInitScript(initScript);
  if (routes) await routes(page);
  return { context, page, external, failed, consoleErrors };
}

async function uiState(page) {
  return page.evaluate(() => {
    const txt = (id) => document.getElementById(id)?.textContent?.trim() ?? null;
    const t = window.__psTest;
    const cam = t?.input.cameraState;
    const cal = t?.input.calibrationState();
    const pos = (s) => {
      const p = t?.gloves[s].root.position;
      return p ? [p.x, p.y, p.z].map((v) => +v.toFixed(4)) : null;
    };
    return {
      webdriver: navigator.webdriver,
      input: window.PipeSense?.status.input(),
      snapshotMode: window.PipeSense?.snapshot().input_mode,
      camStatus: cam?.status,
      camActive: cam?.active,
      camError: cam?.error ?? null,
      handsSeen: cam?.handsSeen,
      landmarker: Boolean(cam?.landmarker),
      calibrated: cal?.ready,
      calibProgress: cal ? +cal.progress.toFixed(2) : null,
      tracked: cal ? { left: cal.hands.left.tracked, right: cal.hands.right.tracked } : null,
      telemetry: t?.input.trackingTelemetry(),
      glove: { left: pos('left'), right: pos('right') },
      source: t ? { left: t.input.hands.left.source, right: t.input.hands.right.source } : null,
      trackingTitle: txt('tracking-title'),
      trackingDetail: txt('tracking-detail'),
      camOverlay: txt('cam-status'),
      setupButton: txt('btn-setup-camera'),
      tourDisabled: document.getElementById('btn-tour')?.disabled,
      goDisabled: document.getElementById('btn-go')?.disabled,
      toast: document.getElementById('toast')?.hidden ? null : txt('toast'),
      guidedVisible: (() => {
        const b = document.getElementById('btn-guided-practice');
        if (!b) return false;
        const r = b.getBoundingClientRect();
        return !b.disabled && r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden';
      })(),
    };
  });
}

// Wrap the landmarker once it exists: per-call latency and hands per call.
const INSTRUMENT = () => {
  const cam = window.__psTest.input.cameraState;
  if (!cam.landmarker || cam.landmarker.__wrapped) return Boolean(cam.landmarker);
  const lm = cam.landmarker;
  const orig = lm.detectForVideo.bind(lm);
  const rec = { calls: 0, ms: [], ts: [], hands: [0, 0, 0], t0: performance.now(), firstTwoAt: null, videoTimes: new Set() };
  window.__psRec = rec;
  lm.detectForVideo = (video, ts) => {
    const s = performance.now();
    const r = orig(video, ts);
    rec.ms.push(performance.now() - s);
    rec.ts.push(s);
    rec.calls += 1;
    const n = Math.min(2, (r.landmarks || []).length);
    rec.hands[n] += 1;
    if (n === 2 && rec.firstTwoAt === null) rec.firstTwoAt = performance.now();
    return r;
  };
  rec.raf = 0;
  const tick = () => { rec.raf += 1; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  lm.__wrapped = true;
  return true;
};

const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
};

async function scenarioCamera() {
  if (!args.video) throw new Error('--video <file.y4m|.mjpeg> is required for the camera scenario');
  const video = path.resolve(args.video);
  const browser = await launch([
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${video}`,
  ]);
  const r = { name: 'camera', video, checks: {}, timeline: [] };
  try {
    const { page, external, failed, consoleErrors } = await openPage(browser);
    const tLoad = Date.now();
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.PipeSense && window.__psTest, null, { timeout: 30000 });
    r.pageReadyMs = Date.now() - tLoad;
    const before = await uiState(page);
    r.checks.webdriverFalse = before.webdriver === false;
    r.checks.gatedBeforeCamera = before.tourDisabled === true;
    await page.screenshot({ path: path.join(args.out, 'camera-0-before.png') });

    const tClick = Date.now();
    await page.click('#btn-setup-camera');
    let runningAt = null; let modelAt = null; let calibAt = null; let bothAt = null; let shot = 1;
    const gloveSamples = [];
    const deadline = tClick + args.seconds * 1000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(250);
      const s = await uiState(page);
      const t = Date.now() - tClick;
      if (s.landmarker) await page.evaluate(INSTRUMENT);
      if (!runningAt && s.camStatus === 'running') runningAt = t;
      if (!modelAt && s.landmarker) modelAt = t;
      if (!bothAt && s.tracked?.left && s.tracked?.right) bothAt = t;
      if (!calibAt && s.calibrated) calibAt = t;
      if (s.camActive) gloveSamples.push({ t, ...s.glove, src: s.source });
      if (r.timeline.length === 0 || t - r.timeline.at(-1).t >= 1000) {
        r.timeline.push({ t, status: s.camStatus, hands: s.handsSeen, progress: s.calibProgress, calibrated: s.calibrated, overlay: s.camOverlay, input: s.input });
      }
      if (s.camStatus === 'error') { r.error = s.camError; break; }
      if ((t > 4000 && shot === 1) || (calibAt && shot === 2)) {
        await page.screenshot({ path: path.join(args.out, `camera-${shot}-${calibAt ? 'calibrated' : 'tracking'}.png`) });
        shot += 1;
      }
      if (calibAt && t > calibAt + 3000) break;
    }
    // Calibration must open the learner flow: tutorial, then the simulation.
    if (calibAt) {
      await page.click('#btn-tour');
      for (let i = 0; i < 10 && !(await page.isVisible('#btn-go')); i++) {
        await page.click('#btn-tour-next');
        await page.waitForTimeout(600);
      }
      await page.screenshot({ path: path.join(args.out, 'camera-3-tutorial.png') });
      await page.click('#btn-go');
      const g0 = (await uiState(page)).glove;
      await page.waitForTimeout(3000);
      const lesson = await page.evaluate(() => ({ introHidden: document.getElementById('intro').hidden, snap: window.PipeSense.snapshot() }));
      const g1 = (await uiState(page)).glove;
      r.lesson = { introHidden: lesson.introHidden, phase: lesson.snap.phase, input_mode: lesson.snap.input_mode, guided_practice: lesson.snap.guided_practice, gloveBefore: g0, gloveAfter: g1 };
      r.checks.lessonStartsOnCamera = lesson.introHidden && lesson.snap.input_mode === 'camera' && lesson.snap.guided_practice === false;
      await page.screenshot({ path: path.join(args.out, 'camera-4-lesson.png') });
    }
    const final = await uiState(page);
    const rec = await page.evaluate(() => {
      const x = window.__psRec;
      return x ? { raf: x.raf, ts: x.ts.map((v) => v - x.t0), calls: x.calls, ms: x.ms, hands: x.hands, spanMs: performance.now() - x.t0, firstTwoAfterMs: x.firstTwoAt ? x.firstTwoAt - x.t0 : null } : null;
    });
    await page.screenshot({ path: path.join(args.out, 'camera-9-final.png') });
    // Glove travel while camera-driven.
    const travel = { left: 0, right: 0 };
    for (const side of ['left', 'right']) {
      const pts = gloveSamples.filter((g) => g.src?.[side] === 'camera' && g[side]).map((g) => g[side]);
      for (let i = 1; i < pts.length; i++) travel[side] += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
      travel[side] = +travel[side].toFixed(3);
    }
    // Camera-frame rate while the learner holds still (both hands -> calibrated).
    const inHold = rec && bothAt && calibAt ? rec.ts.filter((v) => v >= bothAt - (modelAt ?? 0) && v <= calibAt - (modelAt ?? 0)).length : null;
    r.numbers = {
      cameraRunningMs: runningAt,
      modelLoadedMs: modelAt,
      bothHandsTrackedMs: bothAt,
      calibratedMs: calibAt,
      calibAfterBothHandsMs: calibAt && bothAt ? calibAt - bothAt : null,
      appCameraFrames: final.input?.frames,
      detectCalls: rec?.calls ?? 0,
      detectFpsDuringCalibration: inHold && calibAt > bothAt ? +(inHold / ((calibAt - bothAt) / 1000)).toFixed(1) : null,
      rafFps: rec ? +(rec.raf / (rec.spanMs / 1000)).toFixed(1) : null,
      detectFps: rec ? +(rec.calls / (rec.spanMs / 1000)).toFixed(1) : null,
      framesWith0_1_2Hands: rec?.hands,
      twoHandRate: rec?.calls ? +(rec.hands[2] / rec.calls).toFixed(3) : 0,
      anyHandRate: rec?.calls ? +((rec.hands[1] + rec.hands[2]) / rec.calls).toFixed(3) : 0,
      detectLatencyMs: rec ? { p50: pct(rec.ms, 0.5), p95: pct(rec.ms, 0.95), max: pct(rec.ms, 1) } : null,
      appTwoHandFrames: final.telemetry?.two_hand_frames,
      meanTrackingConfidence: final.telemetry ? +final.telemetry.mean_tracking_confidence.toFixed(3) : null,
      gloveTravelM: travel,
    };
    r.final = final;
    r.checks.cameraRunning = runningAt !== null;
    r.checks.modelLoaded = modelAt !== null;
    r.checks.bothHandsDetected = (rec?.hands?.[2] ?? 0) > 0;
    r.checks.glovesMove = travel.left > 0.01 && travel.right > 0.01;
    r.checks.inputModeCamera = final.input?.mode === 'camera' && final.input?.frames > 0;
    r.checks.calibrated = calibAt !== null;
    r.checks.unlockedAfterCalibration = calibAt !== null ? final.tourDisabled === false : null;
    r.external = Object.fromEntries(external);
    r.failedRequests = failed;
    r.consoleErrors = consoleErrors.slice(0, 20);
  } finally {
    await browser.close();
  }
  r.pass = Object.values(r.checks).every((v) => v !== false);
  return r;
}

// Failure scenarios: the UI must say what is wrong within a few seconds and
// keep Guided practice usable.
async function scenarioFailure(name) {
  let flags = [];
  let initScript;
  if (name === 'denied') {
    flags = ['--use-fake-device-for-media-stream', '--deny-permission-prompts'];
  } else if (name === 'absent') {
    // A Mac always has a camera, so emulate a device-less tablet: the browser
    // reports NotFoundError exactly as Chrome does with no video input.
    flags = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
    initScript = () => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));
    };
  } else if (name === 'offline-model') {
    // Camera works but the MediaPipe CDN / model host is unreachable.
    flags = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
  } else if (name === 'insecure') {
    // Plain http:// on a LAN IP is not a secure context: mediaDevices is undefined.
    flags = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
    initScript = () => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    };
  }
  const browser = await launch(flags);
  const r = { name, checks: {} };
  try {
    const routes = name === 'offline-model'
      ? (page) => page.route(/tasks-vision|mediapipe-models/, (route) => route.abort('internetdisconnected'))
      : undefined;
    const { page, consoleErrors } = await openPage(browser, { initScript, routes });
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.PipeSense && window.__psTest, null, { timeout: 30000 });
    const t0 = Date.now();
    await page.click('#btn-setup-camera');
    let s;
    while (Date.now() - t0 < 8000) {
      await page.waitForTimeout(200);
      s = await uiState(page);
      if (s.camStatus !== 'starting' && s.camStatus !== 'off') break;
    }
    r.settleMs = Date.now() - t0;
    r.state = s;
    await page.screenshot({ path: path.join(args.out, `failure-${name}.png`) });
    r.checks.notHung = s.camStatus !== 'starting';
    r.checks.clearMessage = s.trackingTitle === 'Camera unavailable' && Boolean(s.trackingDetail) && s.trackingDetail !== 'Enable the camera to map your hands to the virtual work gloves.';
    r.checks.stillGated = s.tourDisabled === true;
    r.checks.guidedPracticeOffered = s.guidedVisible;
    await page.click('#btn-guided-practice');
    await page.waitForTimeout(1500);
    const g = await page.evaluate(() => ({ snap: window.PipeSense.snapshot(), mode: window.PipeSense.status.input().mode, banner: !document.getElementById('practice-banner').hidden }));
    r.guided = { mode: g.mode, banner: g.banner, guided_practice: g.snap.guided_practice };
    r.message = { status: s.camStatus, title: s.trackingTitle, detail: s.trackingDetail, overlay: s.camOverlay, toast: s.toast };
    r.checks.guidedPracticeWorks = g.snap.guided_practice === true && g.banner;
    await page.screenshot({ path: path.join(args.out, `failure-${name}-guided.png`) });
    r.consoleErrors = consoleErrors.slice(0, 10);
  } finally {
    await browser.close();
  }
  r.pass = Object.values(r.checks).every(Boolean);
  return r;
}

// Learner taps Guided practice while the camera is still starting (model
// download in flight). The late-finishing start must not turn the camera on.
async function scenarioRace() {
  const browser = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']);
  const r = { name: 'race', checks: {} };
  try {
    const routes = (page) => page.route(/mediapipe-models/, async (route) => {
      await new Promise((ok) => setTimeout(ok, 4000));
      await route.continue();
    });
    const { page } = await openPage(browser, { routes });
    await page.goto(pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.PipeSense && window.__psTest, null, { timeout: 30000 });
    await page.click('#btn-setup-camera');
    await page.waitForTimeout(1200);
    r.duringStart = (await uiState(page)).camStatus;
    await page.click('#btn-guided-practice');
    await page.waitForTimeout(9000);
    const s = await uiState(page);
    r.state = s;
    const tracksLive = await page.evaluate(() => {
      const v = document.getElementById('cam-video');
      return Boolean(v.srcObject && v.srcObject.getTracks().some((t) => t.readyState === 'live'));
    });
    r.checks.wasStarting = r.duringStart === 'starting';
    r.checks.cameraStaysOff = s.camActive === false && s.camStatus === 'off' && !tracksLive;
    r.checks.practiceActive = s.input?.mode === 'synthetic_practice';
    await page.screenshot({ path: path.join(args.out, 'race-guided.png') });
  } finally {
    await browser.close();
  }
  r.pass = Object.values(r.checks).every(Boolean);
  return r;
}

const results = [];
for (const name of args.scenarios) {
  const res = name === 'camera' ? await scenarioCamera() : name === 'race' ? await scenarioRace() : await scenarioFailure(name);
  results.push(res);
  const { final, state, timeline, ...brief } = res;
  console.log(JSON.stringify(brief, null, 2));
  if (timeline) console.log('timeline', JSON.stringify(timeline));
}
fs.writeFileSync(path.join(args.out, 'summary.json'), JSON.stringify(results, null, 2));
const ok = results.every((r) => r.pass);
console.log(ok ? 'PASS' : 'FAIL', results.map((r) => `${r.name}:${r.pass ? 'pass' : 'fail'}`).join(' '));
process.exit(ok ? 0 : 1);
