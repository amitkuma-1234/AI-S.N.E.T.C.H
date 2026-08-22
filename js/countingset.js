// ============================================================
// S.N.E.T.C.H · COUNTDOWN & STOPWATCH DASHBOARD
// countingset.js — full frontend logic
//
// Persistence: records are saved to the browser via localStorage so
// the feature works completely standalone. If a matching backend API
// is ever registered (see countingset.py), every save/update/delete
// is also opportunistically mirrored there in the background — the
// UI never waits on it and never breaks if it 404s.
// ============================================================

(function () {
  'use strict';

  // ---------------------------------------------------------
  // CONSTANTS
  // ---------------------------------------------------------
  const REV_SECONDS = 60;          // one full analog-hand revolution
  const ALERT_THRESHOLD = 10;      // seconds remaining that trigger alert mode
  const LS_COUNTDOWNS = 'snetch_countdown_records';
  const LS_STOPWATCHES = 'snetch_stopwatch_records';
  const API_BASE = '/api/countingset';

  // ---------------------------------------------------------
  // DOM REFS
  // ---------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  const homeBtn = $('homeBtn');

  const screens = {
    main: $('screen-main'),
    countdownSetup: $('screen-countdown-setup'),
    countdownRun: $('screen-countdown-run'),
    stopwatch: $('screen-stopwatch'),
    listsMenu: $('screen-lists-menu'),
    countdownList: $('screen-countdown-list'),
    stopwatchList: $('screen-stopwatch-list'),
  };

  const cardSetCountdown = $('cardSetCountdown');
  const cardStopwatch = $('cardStopwatch');
  const cardTimerLists = $('cardTimerLists');
  const cardCountdownList = $('cardCountdownList');
  const cardStopwatchList = $('cardStopwatchList');

  const cdHours = $('cdHours');
  const cdMinutes = $('cdMinutes');
  const cdSeconds = $('cdSeconds');
  const cdBeginBtn = $('cdBeginBtn');

  const cdAnalogProgress = $('cdAnalogProgress');
  const cdHand = $('cdHand');
  const cdCycleText = $('cdCycleText');
  const cdTicks = $('cdTicks');
  const cdSandTop = $('cdSandTop');
  const cdSandBottom = $('cdSandBottom');
  const cdSandStream = $('cdSandStream');
  const cdDigital = $('cdDigital');
  const cdOriginalLabel = $('cdOriginalLabel');
  const cdCompletedBanner = $('cdCompletedBanner');
  const cdStartBtn = $('cdStartBtn');
  const cdPauseBtn = $('cdPauseBtn');
  const cdRestartBtn = $('cdRestartBtn');
  const cdVizBoxes = () => document.querySelectorAll('#screen-countdown-run .viz-box');

  const swAnalogProgress = $('swAnalogProgress');
  const swHand = $('swHand');
  const swCycleText = $('swCycleText');
  const swTicks = $('swTicks');
  const swDigital = $('swDigital');
  const swStartBtn = $('swStartBtn');
  const swPauseBtn = $('swPauseBtn');
  const swRestartBtn = $('swRestartBtn');

  const countdownListBody = $('countdownListBody');
  const countdownListEmpty = $('countdownListEmpty');
  const stopwatchListBody = $('stopwatchListBody');
  const stopwatchListEmpty = $('stopwatchListEmpty');

  const cdSaveModal = $('cdSaveModal');
  const cdSaveName = $('cdSaveName');
  const cdSaveNumber = $('cdSaveNumber');
  const cdSaveDuration = $('cdSaveDuration');
  const cdSaveCycles = $('cdSaveCycles');
  const cdSaveConfirmBtn = $('cdSaveConfirmBtn');

  const swSaveModal = $('swSaveModal');
  const swSaveName = $('swSaveName');
  const swSaveNumber = $('swSaveNumber');
  const swSaveTime = $('swSaveTime');
  const swSaveCycles = $('swSaveCycles');
  const swSaveConfirmBtn = $('swSaveConfirmBtn');

  const modifyModal = $('modifyModal');
  const modifyNameLabel = $('modifyNameLabel');
  const modifyNumberLabel = $('modifyNumberLabel');
  const modifyNameInput = $('modifyNameInput');
  const modifyNumberInput = $('modifyNumberInput');
  const modifySaveBtn = $('modifySaveBtn');
  const modifyCancelBtn = $('modifyCancelBtn');

  const deleteModal = $('deleteModal');
  const deleteConfirmBtn = $('deleteConfirmBtn');
  const deleteCancelBtn = $('deleteCancelBtn');

  const CIRCUMFERENCE = 2 * Math.PI * 98;

  // ---------------------------------------------------------
  // UTIL
  // ---------------------------------------------------------
  function pad2(n) { return String(Math.max(0, Math.floor(n))).padStart(2, '0'); }

  function formatHMS(totalSeconds) {
    totalSeconds = Math.max(0, totalSeconds);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${pad2(h)} : ${pad2(m)} : ${pad2(s)}`;
  }

  function formatHMSCompact(totalSeconds) {
    totalSeconds = Math.max(0, totalSeconds);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  function nowDisplay() {
    return new Date().toLocaleString(undefined, {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function genId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  function buildTicks(container) {
    if (!container || container.children.length) return;
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * 2 * Math.PI;
      const isMajor = i % 3 === 0;
      const rOuter = 98, rInner = isMajor ? 86 : 90;
      const x1 = 110 + rOuter * Math.sin(angle);
      const y1 = 110 - rOuter * Math.cos(angle);
      const x2 = 110 + rInner * Math.sin(angle);
      const y2 = 110 - rInner * Math.cos(angle);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x1.toFixed(2));
      line.setAttribute('y1', y1.toFixed(2));
      line.setAttribute('x2', x2.toFixed(2));
      line.setAttribute('y2', y2.toFixed(2));
      line.setAttribute('class', 'analog-tick' + (isMajor ? ' major' : ''));
      container.appendChild(line);
    }
  }
  buildTicks(cdTicks);
  buildTicks(swTicks);

  // ---------------------------------------------------------
  // AUDIO — Web Audio API (no external files needed)
  // ---------------------------------------------------------
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    return audioCtx;
  }

  function beep(freq = 880, duration = 0.12, delay = 0, gain = 0.18) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g);
    g.connect(ctx.destination);
    const startAt = ctx.currentTime + delay;
    osc.start(startAt);
    g.gain.setValueAtTime(gain, startAt);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.stop(startAt + duration + 0.02);
  }

  function tickBeep() { beep(1200, 0.08, 0, 0.12); }

  function playAlarm() {
    // A bright, alarm-like sequence of beeps.
    for (let i = 0; i < 6; i++) {
      beep(i % 2 === 0 ? 1046 : 1318, 0.18, i * 0.22, 0.22);
    }
  }

  // ---------------------------------------------------------
  // NAVIGATION
  // ---------------------------------------------------------
  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  homeBtn.addEventListener('click', () => {
    window.location.href = '/';
  });

  cardSetCountdown.addEventListener('click', () => {
    resetCountdownSetupDefaults();
    showScreen('countdownSetup');
  });
  cardStopwatch.addEventListener('click', () => {
    resetStopwatchDisplay();
    showScreen('stopwatch');
  });
  cardTimerLists.addEventListener('click', () => showScreen('listsMenu'));
  cardCountdownList.addEventListener('click', () => {
    renderCountdownList();
    showScreen('countdownList');
  });
  cardStopwatchList.addEventListener('click', () => {
    renderStopwatchList();
    showScreen('stopwatchList');
  });

  function resetCountdownSetupDefaults() {
    if (!cdHours.value) cdHours.value = 0;
    if (!cdMinutes.value && cdMinutes.value !== '0') cdMinutes.value = 5;
    if (!cdSeconds.value) cdSeconds.value = 0;
  }

  // ---------------------------------------------------------
  // PERSISTENCE (localStorage + best-effort backend sync)
  // ---------------------------------------------------------
  function loadList(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }
  function saveList(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  function syncApi(method, path, body) {
    // Fire-and-forget: never blocks the UI, never throws.
    try {
      fetch(API_BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function addCountdownRecord(name, number, totalSeconds, cycles) {
    const list = loadList(LS_COUNTDOWNS);
    const record = {
      id: genId(),
      name: (name || '').trim() || 'Countdown',
      number: (number || '').trim() || '-',
      total_seconds: totalSeconds,
      original_time: formatHMSCompact(totalSeconds),
      cycles: cycles,
      created_display: nowDisplay(),
    };
    list.unshift(record);
    saveList(LS_COUNTDOWNS, list);
    syncApi('POST', '/countdowns', { name: record.name, number: record.number, total_seconds: totalSeconds, cycles });
    return record;
  }

  function addStopwatchRecord(name, number, elapsedSeconds, cycles) {
    const list = loadList(LS_STOPWATCHES);
    const record = {
      id: genId(),
      name: (name || '').trim() || 'Stopwatch',
      number: (number || '').trim() || '-',
      elapsed_seconds: elapsedSeconds,
      recorded_time: formatHMSCompact(elapsedSeconds),
      cycles: cycles,
      created_display: nowDisplay(),
    };
    list.unshift(record);
    saveList(LS_STOPWATCHES, list);
    syncApi('POST', '/stopwatches', { name: record.name, number: record.number, elapsed_seconds: elapsedSeconds, cycles });
    return record;
  }

  function updateRecord(key, id, name, number) {
    const list = loadList(key);
    const rec = list.find((r) => r.id === id);
    if (rec) {
      rec.name = (name || '').trim() || rec.name;
      rec.number = (number || '').trim() || rec.number;
      saveList(key, list);
      syncApi('PUT', (key === LS_COUNTDOWNS ? '/countdowns/' : '/stopwatches/') + id, { name: rec.name, number: rec.number });
    }
  }

  function deleteRecord(key, id) {
    const list = loadList(key).filter((r) => r.id !== id);
    saveList(key, list);
    syncApi('DELETE', (key === LS_COUNTDOWNS ? '/countdowns/' : '/stopwatches/') + id);
  }

  // ---------------------------------------------------------
  // MODAL HELPERS
  // ---------------------------------------------------------
  function openModal(m) { m.classList.add('active'); }
  function closeModal(m) { m.classList.remove('active'); }

  // ============================================================
  // COUNTDOWN
  // ============================================================
  let cdOriginal = 0;      // seconds
  let cdRemaining = 0;     // seconds (float)
  let cdElapsed = 0;       // seconds since this run-session started (for hand + cycles)
  let cdCycles = 0;
  let cdRunning = false;
  let cdLastTick = null;
  let cdInterval = null;
  let cdAlertOn = false;
  let cdLastBeepSecond = null;

  cdBeginBtn.addEventListener('click', () => {
    const h = parseInt(cdHours.value, 10) || 0;
    const m = parseInt(cdMinutes.value, 10) || 0;
    const s = parseInt(cdSeconds.value, 10) || 0;
    const total = h * 3600 + m * 60 + s;
    if (total <= 0) {
      cdSeconds.focus();
      cdSeconds.classList.add('shake');
      setTimeout(() => cdSeconds.classList.remove('shake'), 400);
      return;
    }
    cdOriginal = total;
    cdRemaining = total;
    cdElapsed = 0;
    cdCycles = 0;
    cdRunning = false;
    cdAlertOn = false;
    cdLastBeepSecond = null;
    cdCompletedBanner.classList.remove('show');
    cdOriginalLabel.textContent = `Original ${formatHMSCompact(total)}`;
    renderCountdownVisuals();
    updateCountdownButtons();
    showScreen('countdownRun');
  });

  function updateCountdownButtons() {
    cdStartBtn.disabled = cdRunning || cdRemaining <= 0;
    cdPauseBtn.disabled = !cdRunning;
    cdRestartBtn.disabled = false;
  }

  cdStartBtn.addEventListener('click', () => {
    if (cdRunning || cdRemaining <= 0) return;
    cdRunning = true;
    cdLastTick = performance.now();
    if (cdInterval) clearInterval(cdInterval);
    cdInterval = setInterval(cdTick, 100);
    updateCountdownButtons();
  });

  cdPauseBtn.addEventListener('click', () => {
    if (!cdRunning) return;
    cdRunning = false;
    if (cdInterval) { clearInterval(cdInterval); cdInterval = null; }
    updateCountdownButtons();
  });

  cdRestartBtn.addEventListener('click', () => {
    if (cdInterval) { clearInterval(cdInterval); cdInterval = null; }
    cdRemaining = cdOriginal;
    cdElapsed = 0;
    cdCycles = 0;
    cdAlertOn = false;
    cdLastBeepSecond = null;
    cdCompletedBanner.classList.remove('show');
    setAlertMode(false);
    renderCountdownVisuals();
    cdRunning = true;
    cdLastTick = performance.now();
    cdInterval = setInterval(cdTick, 100);
    updateCountdownButtons();
  });

  function cdTick() {
    const now = performance.now();
    const delta = (now - cdLastTick) / 1000;
    cdLastTick = now;
    cdRemaining -= delta;
    cdElapsed += delta;
    if (cdRemaining <= 0) {
      cdRemaining = 0;
      completeCountdown();
      return;
    }
    renderCountdownVisuals();
  }

  function setAlertMode(on) {
    if (cdAlertOn === on) return;
    cdAlertOn = on;
    document.body.classList.toggle('alert-mode', on);
    cdDigital.classList.toggle('alert', on);
    cdVizBoxes().forEach((b) => b.classList.toggle('alert', on));
    cdAnalogProgress.classList.toggle('alert', on);
    cdHand.classList.toggle('alert', on);
  }

  function renderCountdownVisuals() {
    // Digital
    cdDigital.textContent = formatHMS(Math.ceil(cdRemaining));

    // Alert mode (last 10 seconds)
    const remainingCeil = Math.ceil(cdRemaining);
    const shouldAlert = cdRemaining > 0 && remainingCeil <= ALERT_THRESHOLD;
    setAlertMode(shouldAlert);
    if (shouldAlert && cdLastBeepSecond !== remainingCeil) {
      cdLastBeepSecond = remainingCeil;
      tickBeep();
    }

    // Analog hand + cycles (based on elapsed time, one revolution per REV_SECONDS)
    const posInRev = cdElapsed % REV_SECONDS;
    const fraction = posInRev / REV_SECONDS;
    cdCycles = Math.floor(cdElapsed / REV_SECONDS);
    cdHand.style.transform = `rotate(${fraction * 360}deg)`;
    cdAnalogProgress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - fraction));
    cdCycleText.textContent = String(cdCycles);

    // Hourglass sand — synced to remaining/total fraction
    const remFrac = cdOriginal > 0 ? Math.max(0, Math.min(1, cdRemaining / cdOriginal)) : 0;
    const topFullHeight = 76;
    const topH = topFullHeight * remFrac;
    cdSandTop.setAttribute('height', topH.toFixed(2));
    cdSandTop.setAttribute('y', (90 - topH).toFixed(2));
    const bottomH = topFullHeight * (1 - remFrac);
    cdSandBottom.setAttribute('height', bottomH.toFixed(2));
    cdSandBottom.setAttribute('y', (206 - bottomH).toFixed(2));
    cdSandStream.classList.toggle('paused', !cdRunning || cdRemaining <= 0);
  }

  function completeCountdown() {
    cdRunning = false;
    if (cdInterval) { clearInterval(cdInterval); cdInterval = null; }
    renderCountdownVisuals();
    setAlertMode(false);
    document.body.classList.remove('alert-mode');
    cdCompletedBanner.classList.add('show');
    updateCountdownButtons();
    cdStartBtn.disabled = true;
    playAlarm();

    // Prompt to save
    cdSaveName.value = '';
    cdSaveNumber.value = '';
    cdSaveDuration.textContent = formatHMSCompact(cdOriginal);
    cdSaveCycles.textContent = String(cdCycles);
    openModal(cdSaveModal);
  }

  cdSaveConfirmBtn.addEventListener('click', () => {
    addCountdownRecord(cdSaveName.value, cdSaveNumber.value, cdOriginal, cdCycles);
    closeModal(cdSaveModal);
    showScreen('countdownSetup');
  });

  // ============================================================
  // STOPWATCH
  // ============================================================
  let swElapsed = 0;      // seconds (float)
  let swCycles = 0;
  let swRunning = false;
  let swLastTick = null;
  let swInterval = null;

  function resetStopwatchDisplay() {
    if (swInterval) { clearInterval(swInterval); swInterval = null; }
    swElapsed = 0;
    swCycles = 0;
    swRunning = false;
    renderStopwatchVisuals();
    updateStopwatchButtons();
  }

  function updateStopwatchButtons() {
    swStartBtn.disabled = swRunning;
    swPauseBtn.disabled = !swRunning;
    swRestartBtn.disabled = false;
  }

  swStartBtn.addEventListener('click', () => {
    if (swRunning) return;
    swRunning = true;
    swLastTick = performance.now();
    if (swInterval) clearInterval(swInterval);
    swInterval = setInterval(swTick, 100);
    updateStopwatchButtons();
  });

  swPauseBtn.addEventListener('click', () => {
    if (!swRunning) return;
    swRunning = false;
    if (swInterval) { clearInterval(swInterval); swInterval = null; }
    updateStopwatchButtons();

    // "Stopping" the stopwatch automatically prompts the save dialog.
    swSaveName.value = '';
    swSaveNumber.value = '';
    swSaveTime.value = formatHMSCompact(swElapsed);
    swSaveCycles.textContent = String(swCycles);
    openModal(swSaveModal);
  });

  swRestartBtn.addEventListener('click', () => {
    if (swInterval) { clearInterval(swInterval); swInterval = null; }
    swElapsed = 0;
    swCycles = 0;
    renderStopwatchVisuals();
    swRunning = true;
    swLastTick = performance.now();
    swInterval = setInterval(swTick, 100);
    updateStopwatchButtons();
  });

  function swTick() {
    const now = performance.now();
    const delta = (now - swLastTick) / 1000;
    swLastTick = now;
    swElapsed += delta;
    renderStopwatchVisuals();
  }

  function renderStopwatchVisuals() {
    swDigital.textContent = formatHMS(Math.floor(swElapsed));
    const posInRev = swElapsed % REV_SECONDS;
    const fraction = posInRev / REV_SECONDS;
    swCycles = Math.floor(swElapsed / REV_SECONDS);
    swHand.style.transform = `rotate(${fraction * 360}deg)`;
    swAnalogProgress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - fraction));
    swCycleText.textContent = String(swCycles);
  }

  swSaveConfirmBtn.addEventListener('click', () => {
    addStopwatchRecord(swSaveName.value, swSaveNumber.value, swElapsed, swCycles);
    closeModal(swSaveModal);
    resetStopwatchDisplay();
  });

  // ============================================================
  // TIMER LISTS — render, modify, delete
  // ============================================================
  function renderCountdownList() {
    const list = loadList(LS_COUNTDOWNS);
    countdownListBody.innerHTML = '';
    countdownListEmpty.classList.toggle('show', list.length === 0);
    list.forEach((rec) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(rec.name)}</td>
        <td>${escapeHtml(rec.number)}</td>
        <td>${escapeHtml(rec.original_time)}</td>
        <td>${rec.cycles}</td>
        <td>${escapeHtml(rec.created_display)}</td>
        <td class="row-actions">
          <button class="row-btn modify" data-id="${rec.id}" data-list="countdown">Modify</button>
          <button class="row-btn delete" data-id="${rec.id}" data-list="countdown">Delete</button>
        </td>`;
      countdownListBody.appendChild(tr);
    });
    bindRowActions();
  }

  function renderStopwatchList() {
    const list = loadList(LS_STOPWATCHES);
    stopwatchListBody.innerHTML = '';
    stopwatchListEmpty.classList.toggle('show', list.length === 0);
    list.forEach((rec) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(rec.name)}</td>
        <td>${escapeHtml(rec.number)}</td>
        <td>${escapeHtml(rec.recorded_time)}</td>
        <td>${rec.cycles}</td>
        <td>${escapeHtml(rec.created_display)}</td>
        <td class="row-actions">
          <button class="row-btn modify" data-id="${rec.id}" data-list="stopwatch">Modify</button>
          <button class="row-btn delete" data-id="${rec.id}" data-list="stopwatch">Delete</button>
        </td>`;
      stopwatchListBody.appendChild(tr);
    });
    bindRowActions();
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let pendingContext = null; // { listKey, id }

  function bindRowActions() {
    document.querySelectorAll('.row-btn.modify').forEach((btn) => {
      btn.onclick = () => {
        const listKey = btn.dataset.list === 'countdown' ? LS_COUNTDOWNS : LS_STOPWATCHES;
        const rec = loadList(listKey).find((r) => r.id === btn.dataset.id);
        if (!rec) return;
        pendingContext = { listKey, id: rec.id };
        const isCd = listKey === LS_COUNTDOWNS;
        modifyNameLabel.textContent = isCd ? 'Countdown Name' : 'Stopwatch Name';
        modifyNumberLabel.textContent = isCd ? 'Countdown Number' : 'Stopwatch Number';
        modifyNameInput.value = rec.name;
        modifyNumberInput.value = rec.number;
        openModal(modifyModal);
      };
    });
    document.querySelectorAll('.row-btn.delete').forEach((btn) => {
      btn.onclick = () => {
        const listKey = btn.dataset.list === 'countdown' ? LS_COUNTDOWNS : LS_STOPWATCHES;
        pendingContext = { listKey, id: btn.dataset.id };
        openModal(deleteModal);
      };
    });
  }

  modifySaveBtn.addEventListener('click', () => {
    if (!pendingContext) return;
    updateRecord(pendingContext.listKey, pendingContext.id, modifyNameInput.value, modifyNumberInput.value);
    closeModal(modifyModal);
    if (pendingContext.listKey === LS_COUNTDOWNS) renderCountdownList();
    else renderStopwatchList();
    pendingContext = null;
  });
  modifyCancelBtn.addEventListener('click', () => {
    closeModal(modifyModal);
    pendingContext = null;
  });

  deleteConfirmBtn.addEventListener('click', () => {
    if (!pendingContext) return;
    deleteRecord(pendingContext.listKey, pendingContext.id);
    closeModal(deleteModal);
    if (pendingContext.listKey === LS_COUNTDOWNS) renderCountdownList();
    else renderStopwatchList();
    pendingContext = null;
  });
  deleteCancelBtn.addEventListener('click', () => {
    closeModal(deleteModal);
    pendingContext = null;
  });

  // ---------------------------------------------------------
  // INIT
  // ---------------------------------------------------------
  renderCountdownVisuals();
  renderStopwatchVisuals();
  updateCountdownButtons();
  updateStopwatchButtons();
  showScreen('main');

  console.log('🔮 S.N.E.T.C.H Countdown & Stopwatch Dashboard ready.');
})();
