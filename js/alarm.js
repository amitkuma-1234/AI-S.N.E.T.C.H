// ============================================================
// alarm.js · S.N.E.T.C.H Alarm System
// Fully wired to the backend REST API (/api/alarms, /api/tones,
// /api/tones/download) defined in app.py + alarm.py.
// ============================================================

(function () {
  'use strict';

  // ----- DOM HELPERS -----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ----- STATE -----
  let alarms = [];               // cache of alarms from the server
  let toneCache = [];            // cache of tone names from /api/tones (excludes "default")

  const setState = { tone: null };                       // resolved tone for Set wizard
  const updateState = { id: null, tone: null, toneChanged: false }; // for Update wizard
  const deleteSelected = new Set();

  // ----- MODAL REFS -----
  const setModal = $('#setModal');
  const updateModal = $('#updateModal');
  const deleteModal = $('#deleteModal');
  const listModal = $('#listModal');

  // ============================================================
  //  API HELPERS
  // ============================================================
    function authToken() { return localStorage.getItem('snetch_access_token') || ''; }

  async function apiRequest(url, options) {
    let res;
    const opts = options || {};
    opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + authToken() });
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new Error('Network error. Please check your connection.');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status}).`);
    }
    return data;
  }

  const apiGetAlarms = () => apiRequest('/api/alarms', { method: 'GET' });
  const apiCreateAlarm = (payload) => apiRequest('/api/alarms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const apiUpdateAlarm = (id, payload) => apiRequest(`/api/alarms/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const apiDeleteAlarm = (id) => apiRequest(`/api/alarms/${id}`, { method: 'DELETE' });
  const apiGetTones = () => apiRequest('/api/tones', { method: 'GET' });
  const apiDownloadTone = (name) => apiRequest('/api/tones/download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const apiGetRinging = () => apiRequest('/api/alarms/ringing', { method: 'GET' });
  const apiStopAlarm = () => apiRequest('/api/alarms/stop', { method: 'POST' });

  // ============================================================
  //  TIME HELPERS  (backend stores 24h "HH:MM"; UI uses 12h + AM/PM)
  // ============================================================
  function to12Hour(time24) {
    const [h, m] = time24.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    let hour12 = h % 12;
    if (hour12 === 0) hour12 = 12;
    return { hour: String(hour12).padStart(2, '0'), minute: String(m).padStart(2, '0'), ampm };
  }

  function formatTime12(time24) {
    const { hour, minute, ampm } = to12Hour(time24);
    return `${hour}:${minute} ${ampm}`;
  }

  function toneDisplayName(tonePath) {
    if (!tonePath) return 'Default';
    const base = tonePath.split(/[\\/]/).pop();
    return base.replace(/\.mp3$/i, '');
  }

  function todayLabel() {
    const now = new Date();
    return now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function populateHourMinuteSelects(hourSel, minuteSel) {
    if (hourSel.options.length === 0) {
      for (let h = 1; h <= 12; h++) {
        const opt = document.createElement('option');
        opt.value = String(h).padStart(2, '0');
        opt.textContent = String(h).padStart(2, '0');
        hourSel.appendChild(opt);
      }
    }
    if (minuteSel.options.length === 0) {
      for (let m = 0; m < 60; m++) {
        const opt = document.createElement('option');
        opt.value = String(m).padStart(2, '0');
        opt.textContent = String(m).padStart(2, '0');
        minuteSel.appendChild(opt);
      }
    }
  }

  // ============================================================
  //  ALARM LOADING + UPCOMING / NEXT WIDGETS
  // ============================================================
  async function loadAlarms() {
    try {
      const data = await apiGetAlarms();
      alarms = data.alarms || [];
    } catch (e) {
      alarms = [];
    }
    updateUpcomingAndNext();
    return alarms;
  }

  function minutesUntil(time24) {
    const [h, m] = time24.split(':').map(Number);
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const alarmMinutes = h * 60 + m;
    return ((alarmMinutes - nowMinutes) + 1440) % 1440;
  }

  function updateUpcomingAndNext() {
    const upcomingTime = $('#upcomingTime');
    const upcomingName = $('#upcomingName');
    const upcomingRepeat = $('#upcomingRepeat');
    const upcomingCountdown = $('#upcomingCountdown');
    const nextAlarmsList = $('#nextAlarmsList');

    const active = alarms.filter((a) => a.active);
    const withDiff = active.map((a) => ({ ...a, diff: minutesUntil(a.time) })).sort((a, b) => a.diff - b.diff);

    if (withDiff.length === 0) {
      upcomingTime.textContent = '--:--';
      upcomingName.textContent = 'No alarm set';
      upcomingRepeat.textContent = '-';
      upcomingCountdown.textContent = '-';
    } else {
      const next = withDiff[0];
      const hrs = String(Math.floor(next.diff / 60)).padStart(2, '0');
      const mins = String(next.diff % 60).padStart(2, '0');
      upcomingTime.textContent = formatTime12(next.time);
      upcomingName.textContent = next.label || 'Alarm';
      upcomingRepeat.textContent = 'Daily';
      upcomingCountdown.textContent = `⏳ ${hrs}h ${mins}m`;
    }

    const next3 = withDiff.slice(0, 3);
    if (next3.length === 0) {
      nextAlarmsList.innerHTML = `<div class="next-item empty">No upcoming alarms</div>`;
    } else {
      nextAlarmsList.innerHTML = next3.map((a) => `
        <div class="next-item">
          <span class="time">${formatTime12(a.time)}</span>
          <span class="name">${escapeHtml(a.label || 'Alarm')}</span>
          <span class="repeat">${toneDisplayName(a.tone)}</span>
          <span class="status">✅</span>
        </div>
      `).join('');
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ============================================================
  //  TONE CHOOSER  (shared logic for "set" and "update" prefixes)
  // ============================================================
  function getToneRefs(prefix) {
    return {
      methodRow: $(`#${prefix}MethodRow`),
      listPanel: $(`#${prefix}ToneListPanel`),
      listItems: $(`#${prefix}ToneListItems`),
      listCancel: $(`#${prefix}ToneListCancel`),
      downloadPanel: $(`#${prefix}DownloadPanel`),
      downloadName: $(`#${prefix}DownloadName`),
      downloadBtn: $(`#${prefix}DownloadBtn`),
      downloadStatus: $(`#${prefix}DownloadStatus`),
      downloadCancel: $(`#${prefix}DownloadCancel`),
      selectedBadge: $(`#${prefix}ToneSelected`),
    };
  }

  function resetToneChooser(prefix) {
    const refs = getToneRefs(prefix);
    refs.methodRow.querySelectorAll('.tone-method-btn').forEach((b) => b.classList.remove('active'));
    refs.listPanel.classList.add('hidden');
    refs.downloadPanel.classList.add('hidden');
    refs.selectedBadge.classList.add('hidden');
    refs.selectedBadge.textContent = '';
    refs.downloadStatus.textContent = '';
    refs.downloadStatus.className = 'download-status';
    refs.downloadName.value = '';
    refs.downloadBtn.disabled = false;
    const state = prefix === 'set' ? setState : updateState;
    state.tone = null;
    if (prefix === 'update') updateState.toneChanged = false;
    setSaveEnabled(prefix);
  }

  function setSaveEnabled(prefix) {
    if (prefix === 'set') {
      $('#setSave').disabled = !setState.tone;
    }
    // Update's Save is always enabled once an alarm is picked (tone change is optional);
    // handled directly where updateState.id gets set.
  }

  function selectTone(prefix, toneValue, label) {
    const state = prefix === 'set' ? setState : updateState;
    state.tone = toneValue;
    if (prefix === 'update') updateState.toneChanged = true;
    const refs = getToneRefs(prefix);
    refs.selectedBadge.textContent = `✓ Selected tone: ${label}`;
    refs.selectedBadge.classList.remove('hidden');
    setSaveEnabled(prefix);
  }

  async function renderToneList(prefix) {
    const refs = getToneRefs(prefix);
    refs.listItems.innerHTML = `<div class="tone-empty">Loading tones…</div>`;
    try {
      const data = await apiGetTones();
      toneCache = (data.tones || []).filter((t) => t !== 'default');
    } catch (e) {
      toneCache = [];
    }
    if (toneCache.length === 0) {
      refs.listItems.innerHTML = `<div class="tone-empty">No downloaded tones yet. Use "Download Alarm Tone" to add one.</div>`;
      return;
    }
    const state = prefix === 'set' ? setState : updateState;
    refs.listItems.innerHTML = toneCache.map((t) => {
      const name = t.replace(/\.mp3$/i, '');
      const checked = state.tone === t ? 'checked' : '';
      return `
        <label class="tone-item ${state.tone === t ? 'selected' : ''}" data-tone="${escapeHtml(t)}">
          <input type="radio" name="${prefix}ToneRadio" value="${escapeHtml(t)}" ${checked}>
          <span>${escapeHtml(name)}</span>
        </label>
      `;
    }).join('');
    refs.listItems.querySelectorAll('.tone-item').forEach((item) => {
      item.addEventListener('click', () => {
        const toneVal = item.dataset.tone;
        refs.listItems.querySelectorAll('.tone-item').forEach((i) => i.classList.remove('selected'));
        item.classList.add('selected');
        item.querySelector('input[type="radio"]').checked = true;
        selectTone(prefix, toneVal, toneVal.replace(/\.mp3$/i, ''));
      });
    });
  }

  function bindToneMethodButtons(prefix) {
    const refs = getToneRefs(prefix);
    refs.methodRow.querySelectorAll('.tone-method-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        refs.methodRow.querySelectorAll('.tone-method-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        refs.listPanel.classList.add('hidden');
        refs.downloadPanel.classList.add('hidden');
        refs.selectedBadge.classList.add('hidden');

        const method = btn.dataset.method;
        if (method === 'skip') {
          selectTone(prefix, 'default', 'Default (application tone)');
        } else if (method === 'list') {
          refs.listPanel.classList.remove('hidden');
          await renderToneList(prefix);
        } else if (method === 'download') {
          refs.downloadPanel.classList.remove('hidden');
        }
      });
    });

    refs.listCancel.addEventListener('click', () => {
      refs.listPanel.classList.add('hidden');
      refs.methodRow.querySelectorAll('.tone-method-btn').forEach((b) => b.classList.remove('active'));
    });
    refs.downloadCancel.addEventListener('click', () => {
      refs.downloadPanel.classList.add('hidden');
      refs.methodRow.querySelectorAll('.tone-method-btn').forEach((b) => b.classList.remove('active'));
    });

    refs.downloadBtn.addEventListener('click', async () => {
      const name = refs.downloadName.value.trim();
      if (!name) {
        refs.downloadStatus.textContent = 'Please enter a tone name.';
        refs.downloadStatus.className = 'download-status error';
        return;
      }
      refs.downloadBtn.disabled = true;
      if (prefix === 'set') $('#setSave').disabled = true;
      refs.downloadStatus.textContent = 'Downloading… this may take a moment.';
      refs.downloadStatus.className = 'download-status';

      try {
        const data = await apiDownloadTone(name);
        const tones = (data.tones || []).filter((t) => t !== 'default');
        toneCache = tones;
        const match = tones.find((t) => t.toLowerCase() === `${name.toLowerCase()}.mp3`) || `${name}.mp3`;
        refs.downloadStatus.textContent = `Downloaded "${name}" successfully.`;
        refs.downloadStatus.className = 'download-status success';
        selectTone(prefix, match, name);
      } catch (e) {
        refs.downloadStatus.textContent = e.message || 'Download failed. Please try a different name.';
        refs.downloadStatus.className = 'download-status error';
      } finally {
        refs.downloadBtn.disabled = false;
      }
    });
  }

  // ============================================================
  //  SET ALARM WIZARD
  // ============================================================
  function openSetModal() {
    const dateRow = $('#setDateRow');
    if (dateRow) dateRow.querySelector('span').innerHTML = `<strong>Today</strong> \u00b7 ${todayLabel()} \u00b7 Repeats daily`;
    populateHourMinuteSelects($('#setHour'), $('#setMinute'));
    const now = new Date();
    const { hour, minute, ampm } = to12Hour(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
    $('#setHour').value = hour;
    $('#setMinute').value = minute;
    $('#setAmPm').value = ampm;

    $('#setStepTime').classList.remove('hidden');
    $('#setStepTone').classList.add('hidden');
    resetToneChooser('set');
    setModal.classList.add('active');
  }

  function closeSetModal() {
    setModal.classList.remove('active');
  }

  function goToSetToneStep() {
    $('#setStepTime').classList.add('hidden');
    $('#setStepTone').classList.remove('hidden');
  }

  function goToSetTimeStep() {
    $('#setStepTone').classList.add('hidden');
    $('#setStepTime').classList.remove('hidden');
  }

  async function handleSetSave() {
    if (!setState.tone) return;
    const hour = $('#setHour').value;
    const minute = $('#setMinute').value;
    const ampm = $('#setAmPm').value;
    const btn = $('#setSave');
    btn.disabled = true;
    try {
      await apiCreateAlarm({ time: `${hour}:${minute}`, ampm, tone: setState.tone });
      closeSetModal();
      await loadAlarms();
      showSuccess('Alarm saved successfully.', `Set for ${hour}:${minute} ${ampm}`);
    } catch (e) {
      showSuccess(e.message || 'Could not save the alarm.');
      btn.disabled = false;
    }
  }

  // ============================================================
  //  UPDATE ALARM WIZARD
  // ============================================================
  async function openUpdateModal() {
    updateState.id = null;
    updateState.tone = null;
    updateState.toneChanged = false;
    $('#updateStepPick').classList.remove('hidden');
    $('#updateStepEdit').classList.add('hidden');
    $('#updateToneStep').classList.add('hidden');
    updateModal.classList.add('active');

    const list = await loadAlarms();
    const container = $('#updatePickList');
    if (list.length === 0) {
      container.innerHTML = `<div class="tone-empty">No alarms saved yet.</div>`;
      return;
    }
    container.innerHTML = list.map((a) => `
      <div class="picker-item" data-id="${a.id}">
        <div></div>
        <div>
          <div class="p-time">${formatTime12(a.time)}</div>
          <div class="p-tone">${escapeHtml(a.label || 'Alarm')} · ${escapeHtml(toneDisplayName(a.tone))}</div>
        </div>
        <div class="p-status">${a.active ? 'Active' : 'Off'}</div>
      </div>
    `).join('');
    container.querySelectorAll('.picker-item').forEach((item) => {
      item.addEventListener('click', () => openUpdateEditStep(parseInt(item.dataset.id, 10)));
    });
  }

  function openUpdateEditStep(id) {
    const alarmObj = alarms.find((a) => a.id === id);
    if (!alarmObj) return;
    updateState.id = id;
    updateState.tone = null;
    updateState.toneChanged = false;

    const dateRow = $('#updateDateRow');
    if (dateRow) dateRow.querySelector('span').innerHTML = `<strong>Today</strong> \u00b7 ${todayLabel()} \u00b7 Repeats daily`;
    populateHourMinuteSelects($('#updateHour'), $('#updateMinute'));
    const { hour, minute, ampm } = to12Hour(alarmObj.time);
    $('#updateHour').value = hour;
    $('#updateMinute').value = minute;
    $('#updateAmPm').value = ampm;
    $('#updateCurrentToneName').textContent = toneDisplayName(alarmObj.tone);
    $('#updateId').value = id;

    $('#updateToneStep').classList.add('hidden');
    resetToneChooser('update');

    $('#updateStepPick').classList.add('hidden');
    $('#updateStepEdit').classList.remove('hidden');
  }

  function closeUpdateModal() {
    updateModal.classList.remove('active');
  }

  async function handleUpdateSave() {
    const id = parseInt($('#updateId').value, 10);
    if (!id) return;
    const hour = $('#updateHour').value;
    const minute = $('#updateMinute').value;
    const ampm = $('#updateAmPm').value;

    const payload = { time: `${hour}:${minute}`, ampm };
    if (updateState.toneChanged && updateState.tone) {
      payload.tone = updateState.tone;
    }

    const btn = $('#updateSave');
    btn.disabled = true;
    try {
      await apiUpdateAlarm(id, payload);
      closeUpdateModal();
      await loadAlarms();
      showSuccess('Alarm updated successfully.');
    } catch (e) {
      showSuccess(e.message || 'Could not update the alarm.');
    } finally {
      btn.disabled = false;
    }
  }

  // ============================================================
  //  DELETE ALARM (multi-select)
  // ============================================================
  async function openDeleteModal() {
    deleteSelected.clear();
    $('#deleteConfirm').disabled = true;
    deleteModal.classList.add('active');

    const list = await loadAlarms();
    const container = $('#deletePickList');
    if (list.length === 0) {
      container.innerHTML = `<div class="tone-empty">No alarms to delete.</div>`;
      return;
    }
    container.innerHTML = list.map((a) => `
      <label class="picker-item" data-id="${a.id}">
        <input type="checkbox" data-id="${a.id}">
        <div>
          <div class="p-time">${formatTime12(a.time)}</div>
          <div class="p-tone">${escapeHtml(a.label || 'Alarm')} · ${escapeHtml(toneDisplayName(a.tone))}</div>
        </div>
        <div class="p-status">${a.active ? 'Active' : 'Off'}</div>
      </label>
    `).join('');
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.id, 10);
        if (cb.checked) deleteSelected.add(id); else deleteSelected.delete(id);
        $('#deleteConfirm').disabled = deleteSelected.size === 0;
      });
    });
  }

  function closeDeleteModal() {
    deleteModal.classList.remove('active');
    deleteSelected.clear();
  }

  async function handleDeleteConfirm() {
    if (deleteSelected.size === 0) return;
    const btn = $('#deleteConfirm');
    btn.disabled = true;
    try {
      await Promise.all([...deleteSelected].map((id) => apiDeleteAlarm(id)));
      closeDeleteModal();
      await loadAlarms();
      showSuccess('Selected alarm(s) deleted.');
    } catch (e) {
      showSuccess(e.message || 'Could not delete one or more alarms.');
      btn.disabled = false;
    }
  }

  // ============================================================
  //  SHOW ALARM LIST (read-only)
  // ============================================================
  async function openListModal() {
    listModal.classList.add('active');
    const list = await loadAlarms();
    const container = $('#showListItems');
    if (list.length === 0) {
      container.innerHTML = `<div class="tone-empty">No alarms saved yet.</div>`;
      return;
    }
    container.innerHTML = list.map((a) => `
      <div class="picker-item">
        <div>
          <div class="p-time">${formatTime12(a.time)}</div>
          <div class="p-tone">${escapeHtml(a.label || 'Alarm')} · Tone: ${escapeHtml(toneDisplayName(a.tone))}</div>
        </div>
        <div class="p-status">${a.active ? 'Active' : 'Off'}</div>
      </div>
    `).join('');
  }

  function closeListModal() {
    listModal.classList.remove('active');
  }

  // ============================================================
  //  PROCEDURAL CINEMATIC AUDIO (no external sound assets needed —
  //  the actual alarm ringtone keeps playing server-side the whole
  //  time via alarm.py/pygame; this layer adds the emotional score).
  // ============================================================
  const CineAudio = (() => {
    let ctx = null;
    let nodes = [];

    function getCtx() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ctx = new AC();
      }
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function stopAll() {
      nodes.forEach((n) => { try { n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} });
      nodes = [];
    }

    function drone() {
      const c = getCtx();
      if (!c) return;
      const o1 = c.createOscillator(); const o2 = c.createOscillator();
      const g = c.createGain();
      o1.type = 'sawtooth'; o1.frequency.value = 55;
      o2.type = 'sine'; o2.frequency.value = 58;
      g.gain.value = 0.0001;
      g.gain.linearRampToValueAtTime(0.05, c.currentTime + 1.5);
      o1.connect(g); o2.connect(g); g.connect(c.destination);
      o1.start(); o2.start();
      nodes.push(o1, o2);
    }

    function heartbeatSwell() {
      const c = getCtx();
      if (!c) return;
      const o = c.createOscillator(); const g = c.createGain();
      o.type = 'triangle'; o.frequency.value = 90;
      g.gain.value = 0.0001;
      const now = c.currentTime;
      for (let i = 0; i < 8; i++) {
        const t = now + i * 0.85;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.12, t + 0.08);
        g.gain.linearRampToValueAtTime(0.0001, t + 0.3);
      }
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(now + 7.2);
      nodes.push(o);
    }

    function goldenSwell() {
      const c = getCtx();
      if (!c) return;
      const o = c.createOscillator(); const g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(220, c.currentTime);
      o.frequency.linearRampToValueAtTime(440, c.currentTime + 2.2);
      g.gain.value = 0.0001;
      g.gain.linearRampToValueAtTime(0.08, c.currentTime + 1.5);
      g.gain.linearRampToValueAtTime(0.0001, c.currentTime + 3.5);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + 3.6);
      nodes.push(o);
    }

    function impact() {
      const c = getCtx();
      if (!c) return;
      const o = c.createOscillator(); const g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(120, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(30, c.currentTime + 0.4);
      g.gain.setValueAtTime(0.35, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.6);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + 0.65);
    }

    return { drone, heartbeatSwell, goldenSwell, impact, stopAll };
  })();

  // ============================================================
  //  SUCCESS ANIMATION (replaces plain alert() popups)
  // ============================================================
  const successBurst = $('#successBurst');
  function showSuccess(text, sub) {
    if (!successBurst) { return; }
    $('#successBurstText').textContent = text || 'Done.';
    $('#successBurstSub').textContent = sub || '';
    successBurst.classList.add('active');
    clearTimeout(showSuccess._t);
    showSuccess._t = setTimeout(() => successBurst.classList.remove('active'), 1800);
  }

  // ============================================================
  //  CINEMATIC FULL-SCREEN ALARM EXPERIENCE (Scene 1 / 2 / 3)
  // ============================================================
  const ringOverlay = $('#ringOverlay');
  const cineStage = $('#cineStage');
  const cineDoor = $('#cineDoor');
  const cineCountdown = $('#cineCountdown');
  const cineMessage = $('#cineMessage');
  const cineSubMessage = $('#cineSubMessage');
  const cineStopBtn = $('#cineStopBtn');
  const cineBlackout = $('#cineBlackout');
  const cineFinalMessage = $('#cineFinalMessage');
  const cinePerson = $('#cinePerson');

  let cineActive = false;         // true while any scene is actively running — single source of truth
  let cineTimers = [];            // all pending timeouts/rAF ids for cleanup
  let scene1StopRequested = false;

  const wait = (ms) => new Promise((res) => { const id = setTimeout(res, ms); cineTimers.push(id); });

  function clearCineTimers() {
    cineTimers.forEach((id) => { clearTimeout(id); cancelAnimationFrame(id); });
    cineTimers = [];
  }

  function setStageVars({ brightness, doorOpen, sun }) {
    if (brightness !== undefined) cineStage.style.setProperty('--brightness', brightness);
    if (doorOpen !== undefined) cineStage.style.setProperty('--door-open', doorOpen);
    if (sun !== undefined) cineStage.style.setProperty('--sun', sun);
  }

  function setMessage(text) {
    cineMessage.classList.add('msg-fade');
    const id = setTimeout(() => { cineMessage.textContent = text; cineMessage.classList.remove('msg-fade'); }, 260);
    cineTimers.push(id);
  }

  // ---- Scene 1: door slowly closes, 10s countdown, one STOP button ----
  function runScene1() {
    return new Promise((resolveScene1) => {
      scene1StopRequested = false;
      cineStage.className = 'cine-stage';
      cineBlackout.classList.remove('show');
      cineFinalMessage.classList.remove('show');
      cineFinalMessage.textContent = '';
      cinePerson.classList.remove('running');
      cineStopBtn.classList.remove('hidden');
      cineCountdown.classList.remove('hidden');
      cineStopBtn.disabled = false;
      setStageVars({ brightness: 1, doorOpen: 1, sun: 0 });
      setMessage('Every second you sleep\u2026 opportunity slips away.');
      cineSubMessage.textContent = 'In this world, everyone writes their own story; if you put in the effort, the ending will be good\u2014otherwise, it will be bad.';

      CineAudio.drone();

      const DURATION = 10; // seconds — exact, per spec
      const startedAt = performance.now();

      function onStop() {
        if (scene1StopRequested) return;
        scene1StopRequested = true;
        cineStopBtn.removeEventListener('click', onStop);
        resolveScene1('stopped');
      }
      cineStopBtn.addEventListener('click', onStop);

      function tick() {
        if (scene1StopRequested) return;
        const elapsed = (performance.now() - startedAt) / 1000;
        const remaining = Math.max(0, DURATION - elapsed);
        const frac = Math.min(1, elapsed / DURATION);        // 0 -> 1 over 10s
        cineCountdown.textContent = String(Math.ceil(remaining));
        setStageVars({ brightness: 1 - frac * 0.75, doorOpen: 1 - frac });

        if (remaining <= 0) {
          cineStopBtn.removeEventListener('click', onStop);
          scene1StopRequested = true;
          resolveScene1('expired');
          return;
        }
        const id = requestAnimationFrame(tick);
        cineTimers.push(id);
      }
      const id = requestAnimationFrame(tick);
      cineTimers.push(id);
    });
  }

  // ---- Scene 2: wake up, actually run to the door, THEN struggle for exactly 7s ----
  async function runScene2() {
    cineStopBtn.classList.add('hidden');
    cineCountdown.classList.add('hidden');
    cineSubMessage.textContent = '';
    setMessage('');

    // The person visibly gets up and runs toward the door first — the door
    // itself does NOT move yet, it stays wherever Scene 1 left it (almost
    // closed). Only once they've actually reached it and grabbed the
    // handle does the door begin to budge.
    cinePerson.classList.add('running');
    CineAudio.heartbeatSwell();
    await wait(900); // time to reach the door and grab the handle

    cineStage.classList.add('shake');

    const DURATION = 7; // seconds — exact struggle duration once the handle is grabbed, per spec
    const startedAt = performance.now();
    await new Promise((resolve) => {
      function tick() {
        const elapsed = (performance.now() - startedAt) / 1000;
        const frac = Math.min(1, elapsed / DURATION);
        setStageVars({ brightness: 0.25 + frac * 0.9, doorOpen: frac, sun: frac });
        if (elapsed >= DURATION) { resolve(); return; }
        const id = requestAnimationFrame(tick);
        cineTimers.push(id);
      }
      const id = requestAnimationFrame(tick);
      cineTimers.push(id);
    });

    cineStage.classList.remove('shake');
    setStageVars({ brightness: 1, doorOpen: 1, sun: 1 });
    CineAudio.goldenSwell();

    setMessage('You chose discipline over comfort.');
    await wait(1700);
    setMessage('Every great achievement begins with getting out of bed.');
    await wait(1700);
    setMessage('Today is yours. Go build something extraordinary.');
    await wait(1900);
  }

  // ---- Scene 3: the door slams shut — silence, and a lesson ----
  async function runScene3() {
    cineStopBtn.classList.add('hidden');
    cineCountdown.classList.add('hidden');
    setStageVars({ doorOpen: 0, brightness: 0.05, sun: 0 });
    cineStage.classList.add('impact');
    CineAudio.stopAll();
    CineAudio.impact();
    setMessage('');
    await wait(350);
    cineStage.classList.remove('impact');

    // Auto-stop the alarm the moment the door slams — no user action needed.
    try { await apiStopAlarm(); } catch (e) {}

    cineBlackout.classList.add('show');
    await wait(900);

    cineFinalMessage.textContent = 'You missed the opportunity.';
    cineFinalMessage.classList.add('show');
    await wait(2200);
    cineFinalMessage.classList.remove('show');
    await wait(900);

    cineFinalMessage.textContent = 'Some doors never open again; once the timer runs out, it\u2019s over\u2014it will never come back.';
    cineFinalMessage.classList.add('show');
    await wait(2800);
    cineFinalMessage.classList.remove('show');
    await wait(900);

    cineFinalMessage.textContent = 'Tomorrow is another chance\u2026 if you choose it.';
    cineFinalMessage.classList.add('show');
    await wait(2600);
  }

  async function runCinematicExperience() {
    if (cineActive) return;
    cineActive = true;
    ringOverlay.classList.add('active');

    const outcome = await runScene1();
    if (outcome === 'stopped') {
      await runScene2();
      CineAudio.stopAll();
      try { await apiStopAlarm(); } catch (e) {}
    } else {
      await runScene3();
    }

    ringOverlay.classList.remove('active');
    cineStage.classList.remove('shake', 'impact');
    cineBlackout.classList.remove('show');
    cineActive = false;
    await loadAlarms();
  }

  function hideRingOverlay() {
    // Called if the alarm gets stopped from elsewhere (e.g. another tab)
    // while our own Scene 1/2/3 sequence hasn't reached that point yet.
    if (!cineActive) {
      ringOverlay.classList.remove('active');
      return;
    }
    scene1StopRequested = true; // lets a running Scene 1 rAF loop exit
    clearCineTimers();
    CineAudio.stopAll();
    ringOverlay.classList.remove('active');
    cineStage.classList.remove('shake', 'impact');
    cineActive = false;
  }

  async function pollRingingStatus() {
    try {
      const data = await apiGetRinging();
      if (data.ringing) {
        if (!cineActive) runCinematicExperience();
      } else if (cineActive) {
        // Stopped elsewhere mid-sequence — close immediately, no delay.
        hideRingOverlay();
        await loadAlarms();
      }
    } catch (e) {
      // Network hiccup — try again on the next poll, don't disturb the UI.
    }
  }

  // ============================================================
  //  BIND EVENTS
  // ============================================================
  function bindEvents() {
    $('#homeBtn').addEventListener('click', () => { window.location.href = '/'; });

    $$('.card-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'set') openSetModal();
        else if (action === 'update') openUpdateModal();
        else if (action === 'delete') openDeleteModal();
        else if (action === 'list') openListModal();
      });
    });

    // Set wizard
    $('#setCancel').addEventListener('click', closeSetModal);
    $('#setNext').addEventListener('click', goToSetToneStep);
    $('#setBack').addEventListener('click', goToSetTimeStep);
    $('#setSave').addEventListener('click', handleSetSave);
    setModal.addEventListener('click', (e) => { if (e.target === setModal) closeSetModal(); });
    bindToneMethodButtons('set');

    // Update wizard
    $('#updatePickCancel').addEventListener('click', closeUpdateModal);
    $('#updateBack').addEventListener('click', () => {
      $('#updateStepEdit').classList.add('hidden');
      $('#updateStepPick').classList.remove('hidden');
    });
    $('#updateChangeToneBtn').addEventListener('click', () => {
      $('#updateToneStep').classList.toggle('hidden');
    });
    $('#updateSave').addEventListener('click', handleUpdateSave);
    updateModal.addEventListener('click', (e) => { if (e.target === updateModal) closeUpdateModal(); });
    bindToneMethodButtons('update');

    // Delete
    $('#deleteCancel').addEventListener('click', closeDeleteModal);
    $('#deleteConfirm').addEventListener('click', handleDeleteConfirm);
    deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) closeDeleteModal(); });

    // Show list
    $('#listCloseBtn').addEventListener('click', closeListModal);
    listModal.addEventListener('click', (e) => { if (e.target === listModal) closeListModal(); });

    // Escape key closes any open modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSetModal();
        closeUpdateModal();
        closeDeleteModal();
        closeListModal();
      }
    });
  }

  // ----- INIT -----
  function init() {
    bindEvents();
    loadAlarms();
    setInterval(loadAlarms, 30000); // keep the upcoming/next widgets fresh
    pollRingingStatus();
    setInterval(pollRingingStatus, 400); // check for a ringing alarm frequently — no noticeable delay
  }

  init();
})();