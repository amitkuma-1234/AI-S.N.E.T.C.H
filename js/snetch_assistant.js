// =============================================================
//  snetch_assistant.js — S.N.E.T.C.H "SNETCH" Voice Assistant
//  Handles: mic ON/OFF, speech-to-text, text-to-speech, orb
//  visual states, time-based greeting, backend chat, and the
//  "Clear All History" flow.
//
//  VOICE-ONLY MODE: no typed input, no on-screen chat log —
//  everything happens via mic in / TTS out.
//
//  CONVERSATION TIMING (feels human, not robotic):
//  - While SNETCH is speaking, the mic keeps listening in the
//    background. The instant it detects ANY sound from the user
//    (well under 1 second), it cuts its own voice off and flips
//    into listening mode — like a person stopping mid-sentence
//    because you started talking.
//  - It does NOT jump on every browser "final result" the moment
//    you pause for a breath. Instead it waits for a full 3
//    seconds of real silence after you stop talking before it
//    treats your turn as finished and starts replying — the way
//    a patient person waits for you to actually finish, instead
//    of cutting you off.
// =============================================================
(function () {
  'use strict';

  const API_BASE = '/snetch/api';
  const SILENCE_MS = 3000; // how long you must be quiet before SNETCH replies

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

  // The exact (cleaned) text SNETCH is currently speaking, so we can
  // tell the difference between "the mic just picked up SNETCH's own
  // voice bouncing off the speakers" (echo — must NOT stop the reply)
  // and "the user actually said something different" (real barge-in).
  let currentUtteranceText = '';

  // Silence-based "the user has finished talking" detection.
  let silenceTimer = null;
  let pendingTranscript = '';
  // If a real (non-echo) interruption is detected mid-reply, we keep
  // the fragment that triggered it here and restart recognition fresh
  // (so the new session's transcript isn't contaminated by SNETCH's
  // echoed words), then prepend this fragment back once real listening
  // resumes.
  let interruptedPrefix = '';

  // ---------------------------------------------------------
  //  VOICE SELECTION — prefer an Indian female English voice.
  //  Voices load asynchronously in most browsers, so we cache
  //  the pick once the list is ready and re-pick if it changes.
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
  //  AUTH — same pattern as every other feature in this project
  // ---------------------------------------------------------
  function authToken() {
    return localStorage.getItem('snetch_access_token') || '';
  }

  async function api(path, opts) {
    const o = opts || {};
    o.headers = Object.assign({}, o.headers, { Authorization: 'Bearer ' + authToken() });
    let res;
    try {
      res = await fetch(API_BASE + path, o);
    } catch (e) {
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
  //  TIME-BASED GREETING — uses the visitor's own device clock,
  //  so it's correct for whichever timezone they're actually in.
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
  //  The backend already strips markdown from every reply before
  //  it's ever sent here, but we never trust a single layer: if
  //  "**", "*", "#", backticks etc. ever slip through, this makes
  //  sure they're never spoken aloud as literal symbols.
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

  // ---------------------------------------------------------
  //  ECHO DETECTION — tells real user interruptions apart from the
  //  mic simply picking up SNETCH's own voice through the speakers.
  //  Without dedicated echo-cancellation hardware/headphones, the
  //  browser's mic *will* hear SNETCH talking — so we compare what
  //  was just recognized against what SNETCH is currently saying,
  //  and only treat it as a real interruption if it's genuinely
  //  different.
  // ---------------------------------------------------------
  function normalizeForCompare(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function looksLikeSelfEcho(candidate, spokenText) {
    const a = normalizeForCompare(candidate);
    const b = normalizeForCompare(spokenText);
    if (!a || !b) return false;
    // Whole-phrase match (or the recognized bit is simply contained
    // in what's being spoken) — near-certain echo.
    if (b.includes(a)) return true;
    // Otherwise: how many of the recognized words also appear
    // somewhere in the spoken reply? High overlap = almost certainly
    // still hearing itself, not the user saying something new.
    const aWords = a.split(' ').filter(Boolean);
    if (!aWords.length) return false;
    const bWords = new Set(b.split(' ').filter(Boolean));
    let overlap = 0;
    aWords.forEach((w) => { if (bWords.has(w)) overlap++; });
    return (overlap / aWords.length) >= 0.6;
  }

  // ---------------------------------------------------------
  //  TEXT-TO-SPEECH — SNETCH speaks its reply aloud
  // ---------------------------------------------------------
  function speak(text) {
    const clean = stripMarkdownForSpeech(text);
    currentUtteranceText = clean;
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
    utter.onend = () => {
      isSpeaking = false;
      currentUtteranceText = '';
      setState(micActive ? 'listening' : 'idle');
    };
    utter.onerror = () => {
      isSpeaking = false;
      currentUtteranceText = '';
      setState(micActive ? 'listening' : 'idle');
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }

  // Cuts SNETCH off mid-sentence and drops back into listening mode.
  // Only ever called once a recognition result has been confirmed as
  // genuinely different from what SNETCH is currently saying (see
  // looksLikeSelfEcho above) — so this only fires for a real
  // interruption, never for the mic hearing SNETCH's own voice.
  function bargeIn() {
    if (!isSpeaking) return;
    window.speechSynthesis.cancel();
    isSpeaking = false;
    currentUtteranceText = '';
    setState('listening');
  }

  // ---------------------------------------------------------
  //  SEND A MESSAGE (voice input only)
  // ---------------------------------------------------------
  async function sendMessage(text) {
    text = (text || '').trim();
    if (!text) return;

    setState('thinking');

    try {
      const data = await api('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });

      if (data.assistant_name) {
        assistantName = data.assistant_name;
        updateBrandName(assistantName);
      }

      speak(data.reply);
    } catch (e) {
      speak('Sorry — ' + e.message);
    }
  }

  function updateBrandName(name) {
    if (brandNameEl) brandNameEl.textContent = name;
    if (footerNameEl) footerNameEl.textContent = name;
  }

  // ---------------------------------------------------------
  //  SPEECH-TO-TEXT (mic ON)
  //  interimResults is ON so we can (a) detect the user talking
  //  as fast as possible for barge-in, and (b) keep resetting a
  //  3-second "they've gone quiet" timer instead of firing the
  //  instant the browser's own endpointing thinks a sentence is
  //  done.
  // ---------------------------------------------------------
  function getRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-IN'; // works well for Hindi/English mixed speech in most browsers
    return r;
  }

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  // Called on every recognition result (interim or final) while the
  // mic is on. Resets the 3-second "user has stopped talking" clock
  // every time new speech comes in, and only actually sends the
  // message once that clock completes uninterrupted.
  function armSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      const toSend = pendingTranscript.trim();
      pendingTranscript = '';
      interruptedPrefix = '';
      if (toSend) {
        sendMessage(toSend);
      }
    }, SILENCE_MS);
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
    setState('listening');
    pendingTranscript = '';
    interruptedPrefix = '';
    clearSilenceTimer();

    recognition.onresult = (event) => {
      // The recognizer's current best guess for the phrase in
      // progress right now (this is what we check for echo, not the
      // whole accumulated session — it's the freshest signal).
      const lastResult = event.results[event.results.length - 1];
      const lastText = lastResult[0].transcript;

      if (isSpeaking) {
        if (looksLikeSelfEcho(lastText, currentUtteranceText)) {
          // The mic is almost certainly just hearing SNETCH's own
          // voice bounce back through the speakers — NOT the user
          // interrupting. Ignore it completely: keep talking.
          return;
        }
        // Genuinely different from what SNETCH is saying — a real
        // interruption. Stop talking immediately and restart
        // recognition fresh so the transcript we build next doesn't
        // have any of SNETCH's echoed words mixed into it.
        bargeIn();
        interruptedPrefix = lastText.trim();
        pendingTranscript = interruptedPrefix;
        armSilenceTimer();
        try { recognition.stop(); } catch (e) { /* onend restarts it */ }
        return;
      }

      // Not speaking — normal listening flow: rebuild the full
      // transcript for this session (prefixed with anything captured
      // right at the moment of a real interruption above) and reset
      // the 3-second "gone quiet" clock. We only ever finalize and
      // send on that timer, never the instant a result looks final.
      let combined = '';
      for (let i = 0; i < event.results.length; i++) {
        combined += event.results[i][0].transcript;
      }
      combined = (interruptedPrefix ? interruptedPrefix + ' ' : '') + combined;
      pendingTranscript = combined.trim();
      armSilenceTimer();
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') return; // just keep listening
      console.warn('Speech recognition error:', event.error);
    };

    recognition.onend = () => {
      // Browsers auto-stop recognition after a while (or after a long
      // pause) — restart it automatically as long as the user hasn't
      // pressed OFF, so listening truly never has a gap.
      if (micActive) {
        try { recognition.start(); } catch (e) { /* already running */ }
      }
    };

    try { recognition.start(); } catch (e) { /* already running */ }
  }

  function stopMic() {
    micActive = false;
    micOnBtn.classList.remove('active');
    micOffBtn.classList.add('active');
    setTimeout(() => micOffBtn.classList.remove('active'), 400);
    clearSilenceTimer();
    pendingTranscript = '';
    interruptedPrefix = '';
    if (recognition) {
      recognition.onend = null; // prevent auto-restart
      try { recognition.stop(); } catch (e) {}
      recognition = null;
    }
    window.speechSynthesis && window.speechSynthesis.cancel();
    isSpeaking = false;
    currentUtteranceText = '';
    setState('idle');
  }

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
    homeBtn.addEventListener('click', () => { window.location.href = '/home'; });
  }

  // ---------------------------------------------------------
  //  BOOTSTRAP — load identity + greeting (history stays in
  //  memory server-side for context; not rendered on screen —
  //  this app is voice-only).
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