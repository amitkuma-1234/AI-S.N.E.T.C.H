// =============================================================
//  snetch_assistant.js — S.N.E.T.C.H "SNETCH" Voice Assistant
//  Handles: mic ON/OFF, speech-to-text, text-to-speech, orb
//  visual states, time-based greeting, backend chat, and the
//  "Clear All History" flow.
//
//  VOICE-ONLY MODE: no typed input, no on-screen chat log —
//  everything happens via mic in / TTS out.
//
//  === BARGE-IN REDESIGN (this version) ===
//  The previous version decided "did the user interrupt me?" by
//  comparing the RECOGNIZED WORDS against what SNETCH was saying
//  (text-based echo detection). That was unreliable: SNETCH's own
//  voice, heard back through the microphone, often gets
//  mis-transcribed (different accent/voice, recognition errors),
//  so the words don't line up with what was actually said — and a
//  real interruption gets falsely detected almost every time
//  SNETCH speaks, causing the "speak → stop → speak → stop"
//  behavior.
//
//  This version throws away text comparison entirely for barge-in.
//  Instead it uses the Web Audio API to measure raw microphone
//  LOUDNESS in real time, independent of what words are (mis)heard.
//  Speaker-echo picked back up by the mic is naturally much quieter
//  than a person actually talking nearby, so a simple loudness
//  threshold — sustained for a short window, not a single spike —
//  reliably tells "that's just my own voice bouncing back" apart
//  from "the user is actually talking to me". Speech recognition
//  itself is paused while SNETCH is speaking (we don't need to
//  know the WORDS to detect an interruption — only that someone is
//  talking); it resumes normally the instant a real interruption
//  is confirmed.
// =============================================================
(function () {
  'use strict';

  const API_BASE = '/snetch/api';
  const SILENCE_MS = 3000; // how long you must be quiet before SNETCH replies

  // --- Barge-in tuning (volume-based) ---
  // These control how loud, and for how long, mic input must stay
  // above the ambient/echo floor before we treat it as a real
  // interruption. Tune here if it's too sensitive or not sensitive
  // enough for a given mic/speaker setup.
  const VAD_SAMPLE_MS = 50;         // how often we sample mic volume
  const BARGE_IN_HOLD_MS = 220;     // must stay loud for this long (filters clicks/spikes)
  const BARGE_IN_VOLUME_THRESHOLD = 0.09; // 0..1 scale, above ambient/echo floor
  const AMBIENT_CALIBRATE_MS = 600; // brief silence-listen at mic-start to learn room/echo floor
  const AMBIENT_MARGIN = 0.05;      // threshold = ambient floor + this margin (min BARGE_IN_VOLUME_THRESHOLD)

  // ---------------------------------------------------------
  //  DOM refs
  // ---------------------------------------------------------
  const appEl          = document.querySelector('.sa-app');
  const homeBtn         = document.getElementById('homeBtn');
  const greetingPhrase  = document.getElementById('greetingPhrase');
  const greetingName    = document.getElementById('greetingName');
  const statusTitle     = document.getElementById('statusTitle');
  const statusSub       = document.getElementById('statusSub');
  const waveformEl      = document.getElementById('waveform');
  const micOnBtn        = document.getElementById('micOnBtn');
  const micOffBtn       = document.getElementById('micOffBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const brandNameEl     = document.getElementById('snetchBrandName');
  const footerNameEl    = document.getElementById('footerName');

  const resetOverlay      = document.getElementById('resetConfirmOverlay');
  const resetConfirmInput = document.getElementById('resetConfirmInput');
  const resetConfirmBtn   = document.getElementById('resetConfirmBtn');
  const resetCancelBtn    = document.getElementById('resetCancelBtn');

  let assistantName = 'SNETCH';
  let micActive = false;
  let recognition = null;
  let isSpeaking = false;

  // ---------------------------------------------------------
  //  TURN / GENERATION TRACKING
  //  Every backend request and every TTS utterance gets a turn
  //  number. If a response comes back (or a speak() call fires)
  //  for a turn that is no longer current, it's discarded. This
  //  prevents an old, stale reply from ever being spoken after a
  //  newer one has already started.
  // ---------------------------------------------------------
  let currentTurnId = 0;
  let currentAbortController = null;

  // Silence-based "the user has finished talking" detection.
  let silenceTimer = null;
  let pendingTranscript = '';

  // ---------------------------------------------------------
  //  VOICE SELECTION — prefer an Indian female English voice.
  // ---------------------------------------------------------
  let cachedVoice = null;

  function pickIndianFemaleVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;

    const preferredNames = [
      'Heera', 'Lekha', 'Veena', 'Priya', 'Isha',
      'Google हिन्दी', 'Google Hindi', 'Google UK English Female'
    ];
    for (const name of preferredNames) {
      const v = voices.find(v => v.name.includes(name));
      if (v) return v;
    }

    const indianVoices = voices.filter(v => v.lang === 'en-IN' || v.lang === 'hi-IN');
    const femaleIndian = indianVoices.find(v => /female/i.test(v.name));
    if (femaleIndian) return femaleIndian;
    if (indianVoices.length) return indianVoices[0];

    const anyFemale = voices.find(v => /female/i.test(v.name));
    if (anyFemale) return anyFemale;

    return voices[0] || null;
  }

  function refreshVoice() {
    const v = pickIndianFemaleVoice();
    if (v) cachedVoice = v;
  }

  if ('speechSynthesis' in window) {
    refreshVoice();
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoice);
  }

  // ---------------------------------------------------------
  //  AUTH
  // ---------------------------------------------------------
  function authToken() {
    return localStorage.getItem('snetch_access_token') || '';
  }

  async function api(path, opts, signal) {
    const o = opts || {};
    o.headers = Object.assign({}, o.headers, { Authorization: 'Bearer ' + authToken() });
    if (signal) o.signal = signal;
    let res;
    try {
      res = await fetch(API_BASE + path, o);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error('Network error. Please check your connection.');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || (data && data.success === false)) {
      const msg = (data && data.error) || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  // ---------------------------------------------------------
  //  TIME-BASED GREETING
  // ---------------------------------------------------------
  function timeGreeting() {
    const h = new Date().getHours();
    if (h < 5) return 'Good Night';
    if (h < 12) return 'Good Morning';
    if (h < 17) return 'Good Afternoon';
    if (h < 21) return 'Good Evening';
    return 'Good Night';
  }

  // ---------------------------------------------------------
  //  VISUAL STATE MACHINE — idle | listening | thinking | speaking
  // ---------------------------------------------------------
  function setState(state) {
    appEl.classList.remove('state-idle', 'state-listening', 'state-thinking', 'state-speaking');
    appEl.classList.add('state-' + state);

    if (state === 'idle') {
      statusTitle.textContent = 'Tap the mic to speak';
      statusSub.textContent = 'Voice only — no typing';
    } else if (state === 'listening') {
      statusTitle.textContent = 'Listening...';
      statusSub.textContent = 'Feel free to speak';
    } else if (state === 'thinking') {
      statusTitle.textContent = 'Thinking...';
      statusSub.textContent = `${assistantName} is working on it`;
    } else if (state === 'speaking') {
      statusTitle.textContent = 'Speaking...';
      statusSub.textContent = `${assistantName} is all ears`;
    }
  }

  function buildWaveform(barCount) {
    waveformEl.innerHTML = '';
    for (let i = 0; i < barCount; i++) {
      const bar = document.createElement('span');
      bar.className = 'wf-bar';
      bar.style.animationDelay = (Math.random() * 1).toFixed(2) + 's';
      waveformEl.appendChild(bar);
    }
  }
  buildWaveform(28);

  // ---------------------------------------------------------
  //  MARKDOWN STRIP — safety net for the TTS layer.
  // ---------------------------------------------------------
  function stripMarkdownForSpeech(text) {
    if (!text) return text;
    return String(text)
      .replace(/\*\*\*(.*?)\*\*\*/g, '$1')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/(^|\W)_(.*?)_(\W|$)/g, '$1$2$3')
      .replace(/`{1,3}([^`]*?)`{1,3}/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s*/gm, '')
      .replace(/^\s*[-*•]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`#~]/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // =============================================================
  //  VOLUME-BASED VOICE ACTIVITY DETECTION (replaces text-compare
  //  echo detection entirely for the purpose of barge-in).
  //
  //  Why this works where text-compare didn't: it never looks at
  //  WHAT was said, only HOW LOUD the mic input is. Speaker echo
  //  of SNETCH's own voice, picked up by a laptop/phone mic, is
  //  reliably quieter than a person actually talking nearby — so a
  //  loudness floor (calibrated briefly against the room's own
  //  echo level) separates the two far more reliably than trying
  //  to match imperfectly-recognized words.
  // =============================================================
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let vadRafId = null;
  let vadIntervalId = null;
  let ambientFloor = 0.02; // learned at mic-start; refined conservatively over time
  let loudSinceTs = null;  // timestamp when volume first crossed threshold (for the hold window)

  async function initVAD() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      console.warn('Microphone access for volume detection failed:', e);
      return false;
    }

    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    const source = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    return true;
  }

  function currentMicVolume() {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    // RMS (root-mean-square) of the waveform — a standard, stable
    // loudness measure, 0 (silence) to ~1 (very loud).
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    return Math.sqrt(sumSquares / data.length);
  }

  // Briefly listens to ambient/echo level right when the mic turns
  // on (before the user necessarily starts talking) so the barge-in
  // threshold adapts to this room/speaker setup instead of a single
  // fixed number that might be too sensitive or not sensitive
  // enough on a given device.
  function calibrateAmbientFloor() {
    return new Promise((resolve) => {
      const samples = [];
      const start = Date.now();
      const tick = () => {
        samples.push(currentMicVolume());
        if (Date.now() - start < AMBIENT_CALIBRATE_MS) {
          setTimeout(tick, VAD_SAMPLE_MS);
        } else {
          samples.sort((a, b) => a - b);
          const median = samples[Math.floor(samples.length / 2)] || 0.02;
          ambientFloor = median;
          resolve();
        }
      };
      tick();
    });
  }

  // Runs continuously while the mic is on. Only DOES something
  // (triggers barge-in) while SNETCH is actively speaking — the
  // rest of the time, normal SpeechRecognition handles listening.
  function startVADLoop() {
    stopVADLoop();
    vadIntervalId = setInterval(() => {
      if (!isSpeaking) {
        loudSinceTs = null;
        return;
      }
      const vol = currentMicVolume();
      const threshold = Math.max(BARGE_IN_VOLUME_THRESHOLD, ambientFloor + AMBIENT_MARGIN);

      if (vol > threshold) {
        if (loudSinceTs === null) loudSinceTs = Date.now();
        if (Date.now() - loudSinceTs >= BARGE_IN_HOLD_MS) {
          loudSinceTs = null;
          handleRealBargeIn();
        }
      } else {
        loudSinceTs = null;
      }
    }, VAD_SAMPLE_MS);
  }

  function stopVADLoop() {
    if (vadIntervalId) { clearInterval(vadIntervalId); vadIntervalId = null; }
    loudSinceTs = null;
  }

  function teardownVAD() {
    stopVADLoop();
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    analyser = null;
  }

  // ---------------------------------------------------------
  //  TEXT-TO-SPEECH
  // ---------------------------------------------------------
  function speak(text, turnId) {
    // Stale-response guard: if a newer turn has started since this
    // reply was requested, never speak it.
    if (turnId !== currentTurnId) return;

    const clean = stripMarkdownForSpeech(text);
    if (!('speechSynthesis' in window) || !clean) {
      setState(micActive ? 'listening' : 'idle');
      return;
    }
    isSpeaking = true;
    setState('speaking');

    const utter = new SpeechSynthesisUtterance(clean);
    utter.rate = 1.0;
    utter.pitch = 1.1;
    if (cachedVoice) {
      utter.voice = cachedVoice;
      utter.lang = cachedVoice.lang;
    } else {
      utter.lang = 'en-IN';
    }

    // Known Chrome bug workaround: very long utterances can get
    // silently paused (~14s in) unless nudged periodically.
    let keepAliveId = setInterval(() => {
      if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
        // no-op nudge; some Chromium builds need pause/resume cycling
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 12000);

    const finish = () => {
      clearInterval(keepAliveId);
      isSpeaking = false;
      if (turnId === currentTurnId) {
        setState(micActive ? 'listening' : 'idle');
      }
    };

    utter.onend = finish;
    utter.onerror = finish;

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }

  // Called only after the volume-based VAD confirms real, sustained,
  // above-threshold mic input while SNETCH is speaking — i.e. a
  // genuine interruption, never a text-comparison guess.
  function handleRealBargeIn() {
    if (!isSpeaking) return;
    window.speechSynthesis.cancel();
    isSpeaking = false;
    // Bump the turn so any in-flight backend response for the
    // current reply is discarded if it arrives late.
    currentTurnId++;
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    setState('listening');
    pendingTranscript = '';
    clearSilenceTimer();
    // Resume normal speech recognition so the interruption's actual
    // words get captured going forward.
    ensureRecognitionRunning();
  }

  // ---------------------------------------------------------
  //  SEND A MESSAGE (voice input only)
  // ---------------------------------------------------------
  async function sendMessage(text) {
    text = (text || '').trim();
    if (!text) return;

    const turnId = ++currentTurnId;
    setState('thinking');

    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    try {
      const data = await api('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      }, signal);

      // Discard if a newer turn has already started while we waited.
      if (turnId !== currentTurnId) return;

      if (data.assistant_name) {
        assistantName = data.assistant_name;
        updateBrandName(assistantName);
      }

      speak(data.reply, turnId);
    } catch (e) {
      if (e.name === 'AbortError') return; // superseded by a newer turn — not an error
      if (turnId === currentTurnId) {
        speak('Sorry — ' + e.message, turnId);
      }
    }
  }

  function updateBrandName(name) {
    if (brandNameEl) brandNameEl.textContent = name;
    if (footerNameEl) footerNameEl.textContent = name;
  }

  // ---------------------------------------------------------
  //  SPEECH-TO-TEXT
  //  Recognition now only runs to CAPTURE WORDS while SNETCH is
  //  NOT speaking. While SNETCH is speaking, recognition is paused
  //  entirely — we don't need words during that time, only the
  //  volume-based VAD above, which decides IF an interruption
  //  happened at all. This removes the text-based echo-guessing
  //  step completely.
  // ---------------------------------------------------------
  function getRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-IN';
    return r;
  }

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function armSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      const toSend = pendingTranscript.trim();
      pendingTranscript = '';
      if (toSend) sendMessage(toSend);
    }, SILENCE_MS);
  }

  function ensureRecognitionRunning() {
    if (!micActive || !recognition) return;
    try { recognition.start(); } catch (e) { /* already running */ }
  }

  function startMic() {
    if (micActive) return;

    if (!('speechSynthesis' in window) && !(window.SpeechRecognition || window.webkitSpeechRecognition)) {
      alert('Voice features are not supported in this browser.');
      return;
    }

    recognition = getRecognition();
    if (!recognition) {
      alert('Speech recognition is not supported in this browser.');
      return;
    }

    micActive = true;
    micOnBtn.classList.add('active');
    micOffBtn.classList.remove('active');
    pendingTranscript = '';
    clearSilenceTimer();

    recognition.onresult = (event) => {
      // While SNETCH is speaking, recognition is supposed to be
      // paused (see below) — but if a stray result still arrives in
      // that window, ignore it. Barge-in decisions are made purely
      // by the volume-based VAD now, never by transcript content.
      if (isSpeaking) return;

      let combined = '';
      for (let i = 0; i < event.results.length; i++) {
        combined += event.results[i][0].transcript;
      }
      pendingTranscript = combined.trim();
      armSilenceTimer();
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') return;
      console.warn('Speech recognition error:', event.error);
    };

    recognition.onend = () => {
      // Auto-restart, but only if we're still meant to be listening
      // and SNETCH isn't currently speaking (during speech, we
      // deliberately keep recognition off — see toggling below).
      if (micActive && !isSpeaking) {
        try { recognition.start(); } catch (e) { /* already running */ }
      }
    };

    (async () => {
      setState('listening');
      statusSub.textContent = 'Calibrating room noise...';
      const ok = await initVAD();
      if (ok) {
        await calibrateAmbientFloor();
        startVADLoop();
      }
      setState('listening');
      try { recognition.start(); } catch (e) { /* already running */ }
    })();
  }

  function stopMic() {
    micActive = false;
    micOnBtn.classList.remove('active');
    micOffBtn.classList.add('active');
    setTimeout(() => micOffBtn.classList.remove('active'), 400);
    clearSilenceTimer();
    pendingTranscript = '';
    currentTurnId++; // invalidate anything in flight
    if (currentAbortController) { currentAbortController.abort(); currentAbortController = null; }
    if (recognition) {
      recognition.onend = null;
      try { recognition.stop(); } catch (e) {}
      recognition = null;
    }
    window.speechSynthesis && window.speechSynthesis.cancel();
    isSpeaking = false;
    teardownVAD();
    setState('idle');
  }

  // Whenever `isSpeaking` flips, keep SpeechRecognition and the VAD
  // loop in sync with it: recognition off / VAD on while SNETCH
  // talks, and back the other way once it's done. This is driven
  // from the single state-changing points (speak()/finish() and
  // handleRealBargeIn()) via this watcher instead of scattering the
  // same toggling logic across multiple call sites.
  let lastSpeakingFlag = false;
  setInterval(() => {
    if (!micActive) return;
    if (isSpeaking !== lastSpeakingFlag) {
      lastSpeakingFlag = isSpeaking;
      if (isSpeaking) {
        if (recognition) { try { recognition.stop(); } catch (e) {} }
      } else {
        ensureRecognitionRunning();
      }
    }
  }, 100);

  micOnBtn.addEventListener('click', startMic);
  micOffBtn.addEventListener('click', stopMic);

  // ---------------------------------------------------------
  //  CLEAR ALL HISTORY
  // ---------------------------------------------------------
  clearHistoryBtn.addEventListener('click', () => {
    resetOverlay.classList.remove('hidden');
    resetConfirmInput.value = '';
    resetConfirmBtn.disabled = true;
  });

  resetConfirmInput.addEventListener('input', () => {
    resetConfirmBtn.disabled = resetConfirmInput.value.trim().toUpperCase() !== 'FORGET';
  });

  resetCancelBtn.addEventListener('click', () => {
    resetOverlay.classList.add('hidden');
  });

  resetConfirmBtn.addEventListener('click', async () => {
    resetConfirmBtn.disabled = true;
    resetConfirmBtn.textContent = 'Deleting...';
    try {
      await api('/reset', { method: 'POST' });
      assistantName = 'SNETCH';
      updateBrandName(assistantName);
      resetOverlay.classList.add('hidden');
      setState('idle');
    } catch (e) {
      alert('Could not clear history: ' + e.message);
    } finally {
      resetConfirmBtn.textContent = 'Forget everything';
    }
  });

  // ---------------------------------------------------------
  //  HOME BUTTON
  // ---------------------------------------------------------
  if (homeBtn) {
    homeBtn.addEventListener('click', () => { window.location.href = '/'; });
  }

  // ---------------------------------------------------------
  //  BOOTSTRAP
  // ---------------------------------------------------------
  async function bootstrap() {
    setState('idle');
    try {
      const data = await api('/bootstrap', { method: 'GET' });

      assistantName = data.assistant_name || 'SNETCH';
      updateBrandName(assistantName);

      greetingPhrase.textContent = timeGreeting();
      greetingName.textContent = data.user_name && data.user_name.length ? data.user_name : 'there';
    } catch (e) {
      greetingPhrase.textContent = timeGreeting();
      greetingName.textContent = 'there';
      statusTitle.textContent = 'Please log in to talk to SNETCH';
      statusSub.textContent = e.message || '';
    }
  }

  bootstrap();
})();