// PipeSense voice layer: captions first, speech second, live agent optional.
//
// Ladder for every coaching line:
//   1. connected ElevenLabs agent session (signed URL minted by the local
//      backend; the API key never reaches the browser)
//   2. browser speechSynthesis
//   3. caption only
// Status is reported honestly: "configured" (endpoint exists) is never
// conflated with "used" (audio actually produced this session).

import { BACKEND_BASE, BACKEND_TIMEOUT_MS } from './net.js';

export const ELEVENLABS_SDK_URL = 'https://esm.sh/@elevenlabs/client@1.25.0';
export const VOICE_SIGNED_URL_PATH = '/v1/voice/signed-url';

async function fetchSignedUrl() {
  const url = BACKEND_BASE + VOICE_SIGNED_URL_PATH;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'pipesense-coach' }),
      signal: controller.signal,
    });
    const ms = Math.round(performance.now() - started);
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (err) { data = null; }
    if (!response.ok) {
      return { ok: false, url, status: response.status, ms, error: `HTTP ${response.status}`, raw: text.slice(0, 400) };
    }
    const signedUrl = data && (data.signed_url || data.signedUrl || data.url);
    if (typeof signedUrl !== 'string' || !signedUrl) {
      return { ok: false, url, status: response.status, ms, error: 'response has no signed_url', raw: text.slice(0, 400) };
    }
    return { ok: true, url, status: response.status, ms, signedUrl };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    const message = err && err.name === 'AbortError'
      ? `timed out after ${BACKEND_TIMEOUT_MS / 1000}s`
      : String((err && err.message) || err);
    return { ok: false, url, status: null, ms, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export function createVoice({ onCaption, onStatus } = {}) {
  const hasSynthesis = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const agent = {
    status: 'idle',
    connected: false,
    session: null,
    error: null,
    signed_url: false,
    signed_url_detail: null,
    latency_ms: null,
    connect_ms: null,
    sdk: null,
  };
  const speech = { available: hasSynthesis, voice: null };
  // Voice playback is opt-in; captions remain active by default.
  const state = { enabled: false, used: 'none', lines: 0, last: null };

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function status() {
    return {
      enabled: state.enabled,
      used: state.used,
      speech_available: speech.available,
      last_line: state.last,
      agent: {
        status: agent.status,
        connected: agent.connected,
        sdk: agent.sdk,
        signed_url: agent.signed_url,
        latency_ms: agent.latency_ms,
        connect_ms: agent.connect_ms,
        error: agent.error,
        detail: agent.signed_url_detail,
      },
    };
  }

  function notify() {
    if (onStatus) onStatus(status());
  }

  function caption(text, attrib) {
    if (onCaption) onCaption({ text, attrib: attrib || '' });
  }

  function pickVoice() {
    if (!speech.available) return null;
    if (speech.voice) return speech.voice;
    const voices = window.speechSynthesis.getVoices();
    speech.voice = voices.find((v) => /en[-_]US/i.test(v.lang))
      || voices.find((v) => /^en/i.test(v.lang))
      || voices[0]
      || null;
    return speech.voice;
  }

  function speechSay(text) {
    if (!speech.available || !state.enabled) return false;
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.03;
      utter.pitch = 1.0;
      utter.volume = 1;
      const voice = pickVoice();
      if (voice) utter.voice = voice;
      synth.speak(utter);
      return true;
    } catch (err) {
      return false;
    }
  }

  function speak({ text, attrib = 'coach' }) {
    const clean = String(text || '').trim();
    if (!clean) return status();
    state.lines += 1;
    state.last = { text: clean, attrib, at: Date.now() };
    caption(clean, attrib);

    let used = 'caption';
    if (agent.connected && agent.session) {
      try {
        // The live agent decides the wording and speaks it over the session.
        agent.session.sendContextualUpdate(clean);
        used = 'agent-context';
      } catch (err) {
        used = 'caption';
      }
    } else if (state.enabled && speechSay(clean)) {
      used = 'speechSynthesis';
    }
    state.used = used;
    emit('pipesense:voice', { text: clean, attrib, used });
    notify();
    return status();
  }

  async function connect() {
    if (agent.status === 'connecting' || agent.connected) return status();
    agent.status = 'requesting-signed-url';
    agent.error = null;
    agent.signed_url_detail = null;
    notify();
    const signed = await fetchSignedUrl();
    agent.latency_ms = signed.ms ?? null;
    if (!signed.ok) {
      agent.status = 'unavailable';
      agent.signed_url = false;
      agent.error = signed.error;
      agent.signed_url_detail = { url: signed.url, http: signed.status, raw: signed.raw || null };
      notify();
      emit('pipesense:agent-status', status().agent);
      return status();
    }
    agent.signed_url = true;
    agent.status = 'loading-sdk';
    notify();
    try {
      const t0 = performance.now();
      const mod = await import(/* @vite-ignore */ ELEVENLABS_SDK_URL);
      const Conversation = mod.Conversation || (mod.default && mod.default.Conversation);
      if (!Conversation || typeof Conversation.startSession !== 'function') {
        throw new Error('SDK missing Conversation.startSession');
      }
      agent.sdk = 'elevenlabs-client@1.25.0';
      agent.status = 'connecting';
      notify();
      const session = await Conversation.startSession({
        signedUrl: signed.signedUrl,
        connectionType: 'websocket',
        onConnect: () => {
          agent.connected = true;
          agent.status = 'connected';
          notify();
          emit('pipesense:agent-status', status().agent);
        },
        onDisconnect: () => {
          agent.connected = false;
          agent.session = null;
          agent.status = 'disconnected';
          notify();
          emit('pipesense:agent-status', status().agent);
        },
        onError: (error) => {
          agent.error = String((error && error.message) || error);
          notify();
        },
        onMessage: ({ message, source }) => {
          if (!message || source === 'user') return;
          state.used = 'elevenlabs';
          state.last = { text: message, attrib: 'live agent · elevenlabs', at: Date.now() };
          caption(message, 'live agent · elevenlabs');
          emit('pipesense:agent-say', { message, source: 'agent', provider: 'elevenlabs' });
          notify();
        },
      });
      agent.session = session;
      agent.connect_ms = Math.round(performance.now() - t0);
      agent.connected = true;
      agent.status = 'connected';
    } catch (err) {
      agent.status = 'error';
      agent.connected = false;
      agent.error = String((err && err.message) || err);
    }
    notify();
    emit('pipesense:agent-status', status().agent);
    return status();
  }

  async function disconnect() {
    const session = agent.session;
    agent.session = null;
    agent.connected = false;
    agent.status = 'idle';
    notify();
    emit('pipesense:agent-status', status().agent);
    if (session) {
      try { await session.endSession(); } catch (err) { /* session already gone */ }
    }
  }

  function setEnabled(value) {
    state.enabled = Boolean(value);
    if (!state.enabled && speech.available) {
      try { window.speechSynthesis.cancel(); } catch (err) { /* noop */ }
    }
    notify();
    return status();
  }

  // An external agent (another tab, a console, a future bridge) can ask the
  // caption + fallback speech channel to say something. Lines that arrived
  // over the live session use `message`, so there is no echo here.
  window.addEventListener('pipesense:agent-say', (event) => {
    const detail = event.detail || {};
    if (detail.external && detail.text) speak({ text: detail.text, attrib: detail.attrib || 'agent · external' });
  });

  if (hasSynthesis) {
    window.speechSynthesis.addEventListener?.('voiceschanged', () => { speech.voice = null; });
  }

  return {
    speak,
    connect,
    disconnect,
    setEnabled,
    status,
    get enabled() { return state.enabled; },
    get connected() { return agent.connected; },
    shutdown() {
      disconnect();
      if (speech.available) {
        try { window.speechSynthesis.cancel(); } catch (err) { /* noop */ }
      }
    },
  };
}
