// ============================================================
// reminder.js · S.N.E.T.C.H Reminder AI
// Fully wired to the backend REST API (/api/reminders, /api/reminder-tones,
// /api/reminder-tones/download) defined in app.py + reminder.py.
// ============================================================

(function () {
  'use strict';

  // ---------- API HELPERS ----------
  async function apiRequest(url, options = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      throw new Error(data.error || 'Something went wrong. Please try again.');
    }
    return data;
  }

  const apiGetReminders = () => apiRequest('/api/reminders', { method: 'GET' });
  const apiGetUpcoming = () => apiRequest('/api/reminders/upcoming', { method: 'GET' });
  const apiCreateReminder = (payload) => apiRequest('/api/reminders', { method: 'POST', body: JSON.stringify(payload) });
  const apiUpdateReminder = (id, payload) => apiRequest(`/api/reminders/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  const apiDeleteReminders = (ids) => apiRequest('/api/reminders/delete', { method: 'POST', body: JSON.stringify({ ids }) });
  const apiFireReminder = (id) => apiRequest(`/api/reminders/${id}/fire`, { method: 'POST' });
  const apiGetTones = () => apiRequest('/api/reminder-tones', { method: 'GET' });
  const apiDownloadTone = (name) => apiRequest('/api/reminder-tones/download', { method: 'POST', body: JSON.stringify({ name }) });

  // ---------- DOM REFS ----------
  const $ = (sel) => document.querySelector(sel);

  const homeBtn = $('#homeBtn');
  const nextContent = $('#nextReminderContent');

  const wizardOverlay = $('#wizardOverlay');
  const stepSelect = $('#stepSelect');
  const stepForm = $('#stepForm');
  const stepTone = $('#stepTone');
  const stepToneList = $('#stepToneList');
  const stepToneDownload = $('#stepToneDownload');
  const wizardSteps = [stepSelect, stepForm, stepTone, stepToneList, stepToneDownload];

  const wizardSelectList = $('#wizardSelectList');
  const stepSelectCancel = $('#stepSelectCancel');
  const stepSelectNext = $('#stepSelectNext');

  const stepFormTitle = $('#stepFormTitle');
  const fieldName = $('#fieldName');
  const fieldHour = $('#fieldHour');
  const fieldMinute = $('#fieldMinute');
  const fieldAmPm = $('#fieldAmPm');
  const fieldDay = $('#fieldDay');
  const fieldMonth = $('#fieldMonth');
  const fieldYear = $('#fieldYear');
  const stepFormError = $('#stepFormError');
  const stepFormCancel = $('#stepFormCancel');
  const stepFormNext = $('#stepFormNext');

  const toneCurrentName = $('#toneCurrentName');
  const toneOptionList = $('#toneOptionList');
  const toneOptionDownload = $('#toneOptionDownload');
  const toneOptionSkip = $('#toneOptionSkip');
  const toneSkipLabel = $('#toneSkipLabel');
  const stepToneBack = $('#stepToneBack');

  const toneListContainer = $('#toneListContainer');
  const toneListCancel = $('#toneListCancel');
  const toneListSave = $('#toneListSave');

  const toneDownloadName = $('#toneDownloadName');
  const toneDownloadStart = $('#toneDownloadStart');
  const toneDownloadStatus = $('#toneDownloadStatus');
  const toneDownloadCancel = $('#toneDownloadCancel');
  const toneDownloadSave = $('#toneDownloadSave');

  const deletePopup = $('#deletePopup');
  const deleteReminderList = $('#deleteReminderList');
  const deleteSelectAllBtn = $('#deleteSelectAllBtn');
  const deleteClearBtn = $('#deleteClearBtn');
  const cancelDeleteBtn = $('#cancelDeleteBtn');
  const deleteSelectedBtn = $('#deleteSelectedBtn');

  const showPopup = $('#showPopup');
  const showRemindersContainer = $('#showRemindersContainer');
  const closeShowBtn = $('#closeShowBtn');

  const successToast = $('#successToast');
  const successToastMsg = $('#successToastMsg');

  const alertOverlay = $('#reminderAlertOverlay');
  const sceneSleep = $('#sceneSleep');
  const sceneWake = $('#sceneWake');
  const sceneBell = $('#sceneBell');
  const sceneText = $('#sceneText');
  const cinematicReminderName = $('#cinematicReminderName');
  const alertCountdown = $('#alertCountdown');
  const reminderToneAudio = $('#reminderToneAudio');

  // ---------- STATE ----------
  let reminderCache = [];       // last known list from the server
  let firingIds = new Set();    // reminders currently mid-alert (avoid double fire)
  let alertActive = false;      // only one alert screen at a time

  const wizardState = {
    mode: 'set',        // 'set' | 'update'
    reminderId: null,
    tone: '',            // filename, '' = default
    toneChanged: false,  // update-only: did the user actually pick a tone this pass?
  };

  let toneCache = [];

  // ---------- HELPERS ----------
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function showToast(message) {
    successToastMsg.textContent = message;
    successToast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => successToast.classList.remove('show'), 2600);
  }

  function openPopup(overlay) {
    overlay.classList.add('active');
  }
  function closePopup(overlay) {
    overlay.classList.remove('active');
  }

  function showWizardStep(step) {
    wizardSteps.forEach((s) => s.classList.remove('active'));
    step.classList.add('active');
  }

  // ---------- POPULATE DATE/TIME SELECTS ----------
  function populateSelect(selectEl, start, end, pad) {
    selectEl.innerHTML = '';
    for (let i = start; i <= end; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = pad ? String(i).padStart(2, '0') : String(i);
      selectEl.appendChild(opt);
    }
  }

  function initDateTimeSelects() {
    populateSelect(fieldHour, 1, 12, false);
    populateSelect(fieldMinute, 0, 59, true);
    populateSelect(fieldDay, 1, 31, false);
    const nowYear = new Date().getFullYear();
    populateSelect(fieldYear, nowYear, nowYear + 10, false);
  }

  function setFormDefaults() {
    const now = new Date();
    let hour12 = now.getHours() % 12;
    if (hour12 === 0) hour12 = 12;
    fieldHour.value = String(hour12);
    fieldMinute.value = String(now.getMinutes()).padStart(2, '0');
    fieldAmPm.value = now.getHours() >= 12 ? 'PM' : 'AM';
    fieldDay.value = String(now.getDate());
    fieldMonth.value = String(now.getMonth() + 1);
    fieldYear.value = String(now.getFullYear());
    fieldName.value = '';
    stepFormError.textContent = '';
  }

  // ---------- FORMAT HELPERS ----------
  function formatReminderMeta(r) {
    return `${r.date_display} &middot; ${r.time_display}`;
  }

  // ---------- UPCOMING REMINDER PANEL ----------
  let countdownTarget = null;
  let countdownReminderId = null;

  function renderUpcoming(upcoming) {
    if (!upcoming) {
      nextContent.innerHTML = `
        <div class="empty-reminder">
          <i class="fas fa-check-circle" style="color:#b47cff;margin-right:0.5rem;"></i>
          No upcoming reminders. You're all caught up!
        </div>
      `;
      countdownTarget = null;
      countdownReminderId = null;
      return;
    }

    countdownTarget = new Date(upcoming.datetime_iso);
    countdownReminderId = upcoming.id;

    nextContent.innerHTML = `
      <div class="reminder-display">
        <div class="reminder-icon"><i class="fas fa-bell"></i></div>
        <div class="reminder-info">
          <h4 class="reminder-name">${escapeHtml(upcoming.name)}</h4>
          <div class="reminder-meta">
            <span class="meta-item"><i class="far fa-calendar-alt"></i> ${escapeHtml(upcoming.date_display)}</span>
            <span class="meta-item"><i class="far fa-clock"></i> ${escapeHtml(upcoming.time_display)}</span>
            <span class="meta-item"><i class="fas fa-music"></i> ${escapeHtml(upcoming.tone_name)}</span>
          </div>
          <div class="countdown">
            <span class="countdown-label">Time Left</span>
            <span class="countdown-digits" id="countdownDisplay">--:--:--</span>
            <span class="countdown-units">HRS MINS SECS</span>
          </div>
        </div>
      </div>
    `;
    updateCountdown();
  }

  function updateCountdown() {
    const el = document.getElementById('countdownDisplay');
    if (!el || !countdownTarget) return;
    const now = new Date();
    const diff = Math.max(0, countdownTarget.getTime() - now.getTime());
    const hrs = String(Math.floor(diff / 3600000)).padStart(2, '0');
    const mins = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
    const secs = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
    el.textContent = `${hrs}:${mins}:${secs}`;
  }

  async function refreshUpcoming() {
    try {
      const data = await apiGetUpcoming();
      renderUpcoming(data.upcoming);
    } catch (e) {
      // silent — panel just keeps its last known state
    }
  }

  async function refreshReminderCache() {
    try {
      const data = await apiGetReminders();
      reminderCache = data.reminders || [];
    } catch (e) {
      // keep previous cache on failure
    }
  }

  // ---------- FULL-SCREEN REMINDER ALERT ----------
  function setSceneState(scene, state) {
    scene.classList.remove('is-visible', 'is-hidden', 'is-ringing', 'is-shattering');
    if (state) scene.classList.add(state);
  }

  function resetAlertScenes() {
    [sceneSleep, sceneWake, sceneBell, sceneText].forEach((s) => setSceneState(s, 'is-hidden'));
  }

  async function fireReminderAlert(r) {
    if (alertActive || firingIds.has(r.id)) return;
    alertActive = true;
    firingIds.add(r.id);

    cinematicReminderName.textContent = r.name;
    resetAlertScenes();
    alertOverlay.classList.add('active');

    // Start playing the reminder tone for the full 10-second cycle.
    if (r.tone_data) {
      reminderToneAudio.src = r.tone_data;
      reminderToneAudio.currentTime = 0;
      reminderToneAudio.loop = true;
      reminderToneAudio.play().catch(() => { /* needs a user gesture on some browsers */ });
    }

    // Countdown display (10 -> 1)
    let secondsLeft = 10;
    alertCountdown.textContent = String(secondsLeft);
    const countdownTimer = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft >= 0) alertCountdown.textContent = String(secondsLeft);
    }, 1000);

    // ---- Animation sequence timeline (fixed 10s total) ----
    // 0.0s - 2.5s : sleeping peacefully
    // 2.5s - 5.0s : wakes in panic and runs
    // 5.0s - 8.3s : reaches the bell, strikes the log, bell rings
    // 8.3s - 8.8s : bell shatters
    // 8.8s - 10.0s: cinematic "ALL THE BEST FOR <name>" text
    setSceneState(sceneSleep, 'is-visible');

    const timers = [];
    timers.push(setTimeout(() => {
      setSceneState(sceneSleep, 'is-hidden');
      setSceneState(sceneWake, 'is-visible');
    }, 2500));

    timers.push(setTimeout(() => {
      setSceneState(sceneWake, 'is-hidden');
      setSceneState(sceneBell, 'is-visible');
      sceneBell.classList.add('is-ringing');
    }, 5000));

    timers.push(setTimeout(() => {
      sceneBell.classList.remove('is-ringing');
      sceneBell.classList.add('is-shattering');
    }, 8300));

    timers.push(setTimeout(() => {
      setSceneState(sceneBell, 'is-hidden');
      setSceneState(sceneText, 'is-visible');
    }, 8800));

    // ---- End of the 10-second cycle: stop tone, close screen, fire reminder ----
    timers.push(setTimeout(async () => {
      clearInterval(countdownTimer);
      reminderToneAudio.pause();
      reminderToneAudio.currentTime = 0;
      alertOverlay.classList.remove('active');
      resetAlertScenes();
      alertActive = false;

      try {
        await apiFireReminder(r.id);
      } catch (e) {
        // even if the API call fails, don't re-fire from stale cache
      }
      firingIds.delete(r.id);
      await refreshReminderCache();
      await refreshUpcoming();
    }, 10000));
  }

  function checkDueReminders() {
    if (alertActive) return;
    const now = new Date();
    const due = reminderCache.find((r) => !firingIds.has(r.id) && new Date(r.datetime_iso) <= now);
    if (due) fireReminderAlert(due);
  }

  // ---------- MASTER TICK ----------
  function masterTick() {
    updateCountdown();
    checkDueReminders();
  }

  // ---------- TONE CHOOSER (shared by Set + Update) ----------
  function toneDisplayName(filename) {
    if (!filename || filename === 'default_tone.mp3') return 'Default Tone';
    return filename.replace(/\.(mp3|wav|ogg|m4a)$/i, '');
  }

  function resetToneChooser() {
    wizardState.tone = '';
    wizardState.toneChanged = false;
    toneCurrentName.textContent = 'Default Tone';
    toneSkipLabel.textContent = 'Skip';
  }

  async function renderToneList() {
    toneListContainer.innerHTML = `<div class="tone-empty">Loading tones&hellip;</div>`;
    toneListSave.disabled = true;
    try {
      const data = await apiGetTones();
      toneCache = data.tones || [];
    } catch (e) {
      toneCache = [];
    }
    if (toneCache.length === 0) {
      toneListContainer.innerHTML = `<div class="tone-empty">No tones found. Use "Download Reminder Tone" to add one.</div>`;
      return;
    }
    toneListContainer.innerHTML = toneCache.map((t) => `
      <label class="tone-item" data-filename="${escapeHtml(t.filename)}">
        <input type="radio" name="toneRadio" value="${escapeHtml(t.filename)}">
        <span class="tone-name">${escapeHtml(t.name)}</span>
      </label>
    `).join('');
    toneListContainer.querySelectorAll('.tone-item').forEach((item) => {
      item.addEventListener('click', () => {
        toneListContainer.querySelectorAll('.tone-item').forEach((i) => i.classList.remove('selected'));
        item.classList.add('selected');
        item.querySelector('input').checked = true;
        const filename = item.dataset.filename;
        wizardState.tone = filename;
        wizardState.toneChanged = true;
        toneCurrentName.textContent = toneDisplayName(filename);
        toneListSave.disabled = false;
      });
    });
  }

  // ---------- WIZARD: SET / UPDATE ----------
  function renderSelectList() {
    if (reminderCache.length === 0) {
      wizardSelectList.innerHTML = `<div class="list-empty">No saved reminders yet.</div>`;
      stepSelectNext.disabled = true;
      return;
    }
    wizardSelectList.innerHTML = reminderCache.map((r) => `
      <div class="select-row" data-id="${r.id}">
        <i class="fas fa-bell row-icon"></i>
        <div class="row-info">
          <div class="row-name">${escapeHtml(r.name)}</div>
          <div class="row-meta">${formatReminderMeta(r)}</div>
        </div>
      </div>
    `).join('');
    wizardSelectList.querySelectorAll('.select-row').forEach((row) => {
      row.addEventListener('click', () => {
        wizardSelectList.querySelectorAll('.select-row').forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
        wizardState.reminderId = parseInt(row.dataset.id, 10);
        stepSelectNext.disabled = false;
      });
    });
  }

  function fillFormFromReminder(r) {
    fieldName.value = r.name;
    fieldHour.value = String(r.hour);
    fieldMinute.value = String(r.minute).padStart(2, '0');
    fieldAmPm.value = r.ampm;
    fieldDay.value = String(r.day);
    fieldMonth.value = String(r.month);
    fieldYear.value = String(r.year);
    wizardState.tone = r.tone || '';
    toneCurrentName.textContent = r.tone_name || 'Default Tone';
    toneSkipLabel.textContent = 'Skip (keep current tone)';
  }

  async function openSetWizard() {
    wizardState.mode = 'set';
    wizardState.reminderId = null;
    resetToneChooser();
    setFormDefaults();
    stepFormTitle.innerHTML = '<i class="fas fa-plus-circle"></i> Set Reminder';
    showWizardStep(stepForm);
    openPopup(wizardOverlay);
  }

  async function openUpdateWizard() {
    wizardState.mode = 'update';
    wizardState.reminderId = null;
    await refreshReminderCache();
    renderSelectList();
    stepSelectNext.disabled = true;
    showWizardStep(stepSelect);
    openPopup(wizardOverlay);
  }

  stepSelectNext.addEventListener('click', () => {
    const r = reminderCache.find((x) => x.id === wizardState.reminderId);
    if (!r) return;
    fillFormFromReminder(r);
    stepFormTitle.innerHTML = '<i class="fas fa-pen"></i> Update Reminder';
    stepFormError.textContent = '';
    showWizardStep(stepForm);
  });
  stepSelectCancel.addEventListener('click', () => closePopup(wizardOverlay));

  stepFormNext.addEventListener('click', () => {
    const name = fieldName.value.trim();
    if (!name) {
      stepFormError.textContent = 'Please enter a reminder name.';
      return;
    }
    stepFormError.textContent = '';
    showWizardStep(stepTone);
  });
  stepFormCancel.addEventListener('click', () => closePopup(wizardOverlay));

  toneOptionList.addEventListener('click', async () => {
    showWizardStep(stepToneList);
    await renderToneList();
  });
  toneOptionDownload.addEventListener('click', () => {
    toneDownloadName.value = '';
    toneDownloadStatus.textContent = '';
    toneDownloadStatus.className = 'tone-download-status';
    toneDownloadSave.disabled = true;
    showWizardStep(stepToneDownload);
  });
  toneOptionSkip.addEventListener('click', async () => {
    if (wizardState.mode === 'update') {
      wizardState.toneChanged = false; // keep_tone -> backend leaves the existing tone untouched
    } else {
      wizardState.tone = ''; // '' resolves to the app's default tone
      wizardState.toneChanged = true;
    }
    await submitReminder();
  });
  stepToneBack.addEventListener('click', () => showWizardStep(stepForm));

  toneListCancel.addEventListener('click', () => showWizardStep(stepTone));
  toneListSave.addEventListener('click', async () => {
    await submitReminder();
  });

  toneDownloadCancel.addEventListener('click', () => showWizardStep(stepTone));
  toneDownloadStart.addEventListener('click', async () => {
    const name = toneDownloadName.value.trim();
    if (!name) {
      toneDownloadStatus.textContent = 'Please enter a tone name.';
      toneDownloadStatus.className = 'tone-download-status error';
      return;
    }
    toneDownloadStart.disabled = true;
    toneDownloadStart.classList.add('loading');
    toneDownloadStart.innerHTML = '<i class="fas fa-spinner spin"></i> Downloading&hellip;';
    toneDownloadStatus.textContent = 'Downloading the tone. The Save button stays disabled until this finishes.';
    toneDownloadStatus.className = 'tone-download-status';
    toneDownloadSave.disabled = true;

    try {
      const data = await apiDownloadTone(name);
      wizardState.tone = data.filename;
      wizardState.toneChanged = true;
      toneCurrentName.textContent = toneDisplayName(data.filename);
      toneDownloadStatus.textContent = `Downloaded successfully: ${toneDisplayName(data.filename)}`;
      toneDownloadStatus.className = 'tone-download-status success';
      toneDownloadSave.disabled = false;
    } catch (e) {
      toneDownloadStatus.textContent = e.message || 'Download failed. Please try a different name.';
      toneDownloadStatus.className = 'tone-download-status error';
      toneDownloadSave.disabled = true;
    } finally {
      toneDownloadStart.disabled = false;
      toneDownloadStart.classList.remove('loading');
      toneDownloadStart.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Download';
    }
  });
  toneDownloadSave.addEventListener('click', async () => {
    await submitReminder();
  });

  async function submitReminder() {
    const payload = {
      name: fieldName.value.trim(),
      hour: parseInt(fieldHour.value, 10),
      minute: parseInt(fieldMinute.value, 10),
      ampm: fieldAmPm.value,
      day: parseInt(fieldDay.value, 10),
      month: parseInt(fieldMonth.value, 10),
      year: parseInt(fieldYear.value, 10),
    };

    try {
      if (wizardState.mode === 'set') {
        payload.tone = wizardState.tone;
        await apiCreateReminder(payload);
        showToast('Reminder saved successfully!');
      } else {
        payload.keep_tone = !wizardState.toneChanged;
        if (wizardState.toneChanged) payload.tone = wizardState.tone;
        await apiUpdateReminder(wizardState.reminderId, payload);
        showToast('Reminder updated successfully!');
      }
      closePopup(wizardOverlay);
      await refreshReminderCache();
      await refreshUpcoming();
    } catch (e) {
      stepFormError.textContent = e.message || 'Could not save the reminder.';
      showWizardStep(stepForm);
    }
  }

  // ---------- DELETE REMINDER (one / multiple / select all) ----------
  const selectedForDelete = new Set();

  function renderDeleteList() {
    selectedForDelete.clear();
    deleteSelectedBtn.disabled = true;
    if (reminderCache.length === 0) {
      deleteReminderList.innerHTML = `<div class="list-empty">No saved reminders to delete.</div>`;
      return;
    }
    deleteReminderList.innerHTML = reminderCache.map((r) => `
      <label class="select-row" data-id="${r.id}">
        <input type="checkbox" class="row-check" value="${r.id}">
        <i class="fas fa-bell row-icon"></i>
        <div class="row-info">
          <div class="row-name">${escapeHtml(r.name)}</div>
          <div class="row-meta">${formatReminderMeta(r)}</div>
        </div>
      </label>
    `).join('');
    deleteReminderList.querySelectorAll('.row-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.value, 10);
        const row = cb.closest('.select-row');
        if (cb.checked) {
          selectedForDelete.add(id);
          row.classList.add('selected');
        } else {
          selectedForDelete.delete(id);
          row.classList.remove('selected');
        }
        deleteSelectedBtn.disabled = selectedForDelete.size === 0;
      });
    });
  }

  async function openDeletePopup() {
    await refreshReminderCache();
    renderDeleteList();
    openPopup(deletePopup);
  }

  cancelDeleteBtn.addEventListener('click', () => closePopup(deletePopup));
  deleteSelectAllBtn.addEventListener('click', () => {
    deleteReminderList.querySelectorAll('.row-check').forEach((cb) => {
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
    });
  });
  deleteClearBtn.addEventListener('click', () => {
    deleteReminderList.querySelectorAll('.row-check').forEach((cb) => {
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
    });
  });
  deleteSelectedBtn.addEventListener('click', async () => {
    if (selectedForDelete.size === 0) return;
    deleteSelectedBtn.disabled = true;
    try {
      const count = selectedForDelete.size;
      await apiDeleteReminders(Array.from(selectedForDelete));
      showToast(count === 1 ? 'Reminder deleted.' : `${count} reminders deleted.`);
      closePopup(deletePopup);
      await refreshReminderCache();
      await refreshUpcoming();
    } catch (e) {
      showToast(e.message || 'Could not delete the selected reminders.');
      deleteSelectedBtn.disabled = false;
    }
  });

  // ---------- SHOW REMINDERS (premium cards) ----------
  function renderShowReminders() {
    if (reminderCache.length === 0) {
      showRemindersContainer.innerHTML = `<div class="list-empty">No saved reminders yet. Use "Set Reminder" to create one.</div>`;
      return;
    }
    showRemindersContainer.innerHTML = reminderCache.map((r) => `
      <div class="reminder-card-item">
        <div class="rc-name"><i class="fas fa-bell"></i> ${escapeHtml(r.name)}</div>
        <div class="rc-row"><i class="far fa-calendar-alt"></i> ${escapeHtml(r.date_display)}</div>
        <div class="rc-row"><i class="far fa-clock"></i> ${escapeHtml(r.time_display)}</div>
        <div class="rc-row"><i class="fas fa-music"></i> ${escapeHtml(r.tone_name)}</div>
      </div>
    `).join('');
  }

  async function openShowPopup() {
    await refreshReminderCache();
    renderShowReminders();
    openPopup(showPopup);
  }
  closeShowBtn.addEventListener('click', () => closePopup(showPopup));

  // ---------- CARD BUTTONS ----------
  $('#openSetBtn').addEventListener('click', openSetWizard);
  $('#openUpdateBtn').addEventListener('click', openUpdateWizard);
  $('#openShowBtn').addEventListener('click', openShowPopup);
  $('#openDeleteBtn').addEventListener('click', openDeletePopup);

  // ---------- HOME BUTTON ----------
  homeBtn.addEventListener('click', (e) => {
    // Real navigation via href="/" — just a subtle click feedback.
    homeBtn.style.transform = 'scale(0.9)';
    setTimeout(() => { homeBtn.style.transform = ''; }, 150);
  });

  // ---------- BACKGROUND DECORATION (stars / particles / shooting stars) ----------
  function buildBackgroundDecor() {
    const starsLayer = $('#stars');
    const particlesLayer = $('#particles');
    const shootingLayer = $('#shootingStars');

    if (starsLayer && !starsLayer.children.length) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 90; i++) {
        const s = document.createElement('div');
        s.className = 'star';
        const size = (Math.random() * 2 + 1).toFixed(1);
        s.style.width = `${size}px`;
        s.style.height = `${size}px`;
        s.style.top = `${Math.random() * 100}%`;
        s.style.left = `${Math.random() * 100}%`;
        s.style.setProperty('--duration', `${(Math.random() * 3 + 2).toFixed(1)}s`);
        s.style.animationDelay = `${(Math.random() * 3).toFixed(1)}s`;
        frag.appendChild(s);
      }
      starsLayer.appendChild(frag);
    }

    if (particlesLayer && !particlesLayer.children.length) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 22; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        p.style.top = `${Math.random() * 100}%`;
        p.style.left = `${Math.random() * 100}%`;
        p.style.animationDuration = `${(Math.random() * 12 + 18).toFixed(1)}s`;
        p.style.animationDelay = `${(Math.random() * 10).toFixed(1)}s`;
        frag.appendChild(p);
      }
      particlesLayer.appendChild(frag);
    }

    if (shootingLayer && !shootingLayer.children.length) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 4; i++) {
        const s = document.createElement('div');
        s.className = 'shooting-star';
        s.style.top = `${Math.random() * 60}%`;
        s.style.left = `${60 + Math.random() * 35}%`;
        s.style.animationDuration = `${(Math.random() * 3 + 4).toFixed(1)}s`;
        s.style.animationDelay = `${(Math.random() * 8).toFixed(1)}s`;
        frag.appendChild(s);
      }
      shootingLayer.appendChild(frag);
    }
  }

  // ---------- INIT ----------
  async function init() {
    buildBackgroundDecor();
    initDateTimeSelects();

    await refreshReminderCache();
    await refreshUpcoming();

    setInterval(masterTick, 1000);
    setInterval(refreshReminderCache, 20000);
    setInterval(refreshUpcoming, 20000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
