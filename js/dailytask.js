// ============================================================
// S.N.E.T.C.H · DAILY TASK MANAGER
// dailytask.js — full logic (Set / Update / Delete / List)
//              + Task Execution Engine (multi-song ordered playlist
//                playback, Skip mode, and the Task Start/End fire-alarm
//                warning tone). The old 10-second countdown popup has
//                been removed completely and must never come back.
// Talks to the Flask backend at /api/dailytask/* (see dailytask.py)
// ============================================================

(function () {
  'use strict';

  const API = {
    tasks: '/api/dailytask/tasks',
    deleteTasks: '/api/dailytask/tasks/delete',
    tones: '/api/dailytask/tones',
    downloadTone: '/api/dailytask/tones/download',
    fireAlarm: '/api/dailytask/fire-alarm',
  };

  // ---------- Engine constants ----------
  const TICK_MS = 200;                 // engine resolution
  const FIRE_ALARM_LEAD_MS = 2000;     // fire alarm plays exactly 2s before start AND 2s before end
  const FIRE_ALARM_DURATION_MS = 2000; // fire alarm plays for exactly 2 seconds

  // ---------- DOM refs ----------
  const homeBtn = document.getElementById('homeBtn');

  const openSetTaskBtn = document.getElementById('openSetTaskBtn');
  const openUpdateTaskBtn = document.getElementById('openUpdateTaskBtn');
  const openDeleteTaskBtn = document.getElementById('openDeleteTaskBtn');
  const openListTaskBtn = document.getElementById('openListTaskBtn');

  // Wizard (Set + Update share this)
  const wizardOverlay = document.getElementById('wizardOverlay');
  const stepSelect = document.getElementById('stepSelect');
  const stepForm = document.getElementById('stepForm');
  const stepTone = document.getElementById('stepTone');
  const stepToneList = document.getElementById('stepToneList');
  const stepToneDownload = document.getElementById('stepToneDownload');
  const stepFormTitle = document.getElementById('stepFormTitle');

  const wizardTaskSelectList = document.getElementById('wizardTaskSelectList');
  const stepSelectCancel = document.getElementById('stepSelectCancel');
  const stepSelectNext = document.getElementById('stepSelectNext');

  const fieldStart = document.getElementById('fieldStart');
  const fieldEnd = document.getElementById('fieldEnd');
  const fieldTaskName = document.getElementById('fieldTaskName');
  const stepFormCancel = document.getElementById('stepFormCancel');
  const stepFormNext = document.getElementById('stepFormNext');

  const toneCurrentName = document.getElementById('toneCurrentName');
  const toneOptionList = document.getElementById('toneOptionList');
  const toneOptionDownload = document.getElementById('toneOptionDownload');
  const toneOptionSkip = document.getElementById('toneOptionSkip');
  const toneSkipLabel = document.getElementById('toneSkipLabel');
  const stepToneBack = document.getElementById('stepToneBack');

  const toneListContainer = document.getElementById('toneListContainer');
  const toneListCancel = document.getElementById('toneListCancel');
  const toneListSave = document.getElementById('toneListSave');

  const toneDownloadName = document.getElementById('toneDownloadName');
  const toneDownloadStart = document.getElementById('toneDownloadStart');
  const toneDownloadStatus = document.getElementById('toneDownloadStatus');
  const toneDownloadCancel = document.getElementById('toneDownloadCancel');
  const toneDownloadSave = document.getElementById('toneDownloadSave');

  // Delete
  const deleteTaskPopup = document.getElementById('deleteTaskPopup');
  const deleteTaskList = document.getElementById('deleteTaskList');
  const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
  const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');

  // List
  const listTaskPopup = document.getElementById('listTaskPopup');
  const listTasksContainer = document.getElementById('listTasksContainer');
  const closeListBtn = document.getElementById('closeListBtn');

  // Upcoming / Overview
  const upcomingList = document.getElementById('upcomingList');
  const viewAllUpcomingBtn = document.getElementById('viewAllUpcomingBtn');
  const viewAllUpcomingPopup = document.getElementById('viewAllUpcomingPopup');
  const allUpcomingList = document.getElementById('allUpcomingList');
  const closeUpcomingAllBtn = document.getElementById('closeUpcomingAllBtn');

  const totalTasksEl = document.getElementById('totalTasks');
  const todayTasksEl = document.getElementById('todayTasks');
  const tonedTasksEl = document.getElementById('tonedTasks');
  const defaultTonedTasksEl = document.getElementById('defaultTonedTasks');
  const progressFill = document.getElementById('progressFill');
  const progressPercent = document.getElementById('progressPercent');

  const successToast = document.getElementById('successToast');
  const successToastMsg = document.getElementById('successToastMsg');

  // NOTE: the old Task Reminder popup (10s countdown + sand-watch) has
  // been removed per spec. We deliberately do NOT query/open/show
  // #reminderOverlay or any of its children anymore — it must never
  // appear again, and no replacement popup is created.

  // ---------- Task Running Dashboard (full-screen, auto-triggered) ----------
  const dashOverlay = document.getElementById('taskDashboardOverlay');
  const dashStatus = document.getElementById('dashStatus');
  const dashStatusLabel = document.getElementById('dashStatusLabel');
  const dashTaskName = document.getElementById('dashTaskName');
  const dashTopSand = document.getElementById('dashTopSand');
  const dashBottomSand = document.getElementById('dashBottomSand');
  const dashUpperPct = document.getElementById('dashUpperPct');
  const dashLowerPct = document.getElementById('dashLowerPct');
  const dashRingFill = document.getElementById('dashRingFill');
  const dashRingPercent = document.getElementById('dashRingPercent');
  const dashTimer = document.getElementById('dashTimer');
  const dashMusicName = document.getElementById('dashMusicName');
  const dashMusicBox = dashMusicName ? dashMusicName.closest('.task-dash-info-box') : null;
  const dashPauseBtn = document.getElementById('dashPauseBtn');
  const dashPauseIcon = document.getElementById('dashPauseIcon');
  const dashPauseLabel = document.getElementById('dashPauseLabel');

  // ---------- State ----------
  let tasks = [];
  let toneDataCache = {}; // filename -> data URI (selectable Task Tone List only)
  let fireAlarmDataUri = ''; // reserved task_tone/fire_alarm.mp3, never in toneDataCache

  let wizardMode = 'create';        // 'create' | 'update'
  let wizardTaskId = null;          // task being updated
  let wizardTones = [];             // staged ordered playlist filenames (Song1 -> Song2 -> ...)
  let wizardSkip = false;           // staged Skip flag
  let wizardKeepTone = false;       // Skip during Update -> leave playlist untouched

  // ---------- Utility ----------
  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"]/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[m]));
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatToAMPM(hhmm) {
    if (!hhmm || hhmm === '--:--') return '--:--';
    const parts = hhmm.split(':');
    if (parts.length < 2) return hhmm;
    const h = parseInt(parts[0], 10);
    const m = parts[1];
    if (isNaN(h)) return hhmm;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${m} ${ampm}`;
  }

  function toneDisplayName(task) {
    if (!task) return 'No Tone Selected';
    if (task.skip) return 'Skip (No Music)';
    if (Array.isArray(task.tone_names) && task.tone_names.length) {
      return task.tone_names.join(' → ');
    }
    if (task.tone_name) return task.tone_name; // backend-provided summary fallback
    return 'No Tone Selected';
  }

  // type: 'success' (default) | 'error' | 'warning'. Every failure path in
  // the engine below (missing song, audio error, download failure, backend
  // error, unexpected task stop, invalid schedule) surfaces here instead of
  // ever throwing/crashing the page.
  function showToast(msg, type) {
    const icon = type === 'error' ? 'fa-circle-exclamation'
      : type === 'warning' ? 'fa-triangle-exclamation'
      : 'fa-check-circle';
    const iconEl = successToast.querySelector('i');
    if (iconEl) iconEl.className = `fas ${icon}`;
    successToastMsg.textContent = msg;
    successToast.classList.remove('toast-error', 'toast-warning');
    if (type === 'error') successToast.classList.add('toast-error');
    else if (type === 'warning') successToast.classList.add('toast-warning');
    successToast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => successToast.classList.remove('show'), 3200);
  }

  async function api(url, options) {
    const res = await fetch(url, options);
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  // ---------- Load tasks from backend ----------
  let tasksLoadFailedOnce = false;

  async function loadTasks() {
    try {
      const data = await api(API.tasks);
      tasks = data.tasks || [];
      tasksLoadFailedOnce = false;
    } catch (e) {
      // Backend error: keep whatever we had (so a currently-running task
      // dashboard isn't yanked away by a transient network hiccup) and
      // tell the user once, instead of crashing or failing silently.
      console.error('Failed to load tasks:', e);
      if (!tasksLoadFailedOnce) {
        showToast('Could not reach the server — showing last known tasks.', 'error');
        tasksLoadFailedOnce = true;
      }
      refreshDashboard();
      return;
    }

    // UNEXPECTED TASK STOP: if the task currently owning the dashboard /
    // audio was deleted (or its schedule vanished) out from under us,
    // shut everything down cleanly instead of leaving a ghost dashboard,
    // stuck audio, or a stuck fire-alarm timer running forever.
    const stillExists = dashboardTaskId === null || tasks.some((t) => t.id === dashboardTaskId);
    if (!stillExists) {
      stopPlaylist();
      stopFireAlarm();
      audioOwnerTaskId = null;
      hideTaskDashboard();
      showToast('The running task was removed — dashboard closed.', 'warning');
    }
    // Same guard for the audio owner even when no dashboard is showing.
    if (audioOwnerTaskId !== null && !tasks.some((t) => t.id === audioOwnerTaskId)) {
      stopPlaylist();
      stopFireAlarm();
      audioOwnerTaskId = null;
    }

    // Avoid a slow memory leak: drop runtime/phase entries for tasks that
    // no longer exist instead of letting the Map grow forever.
    const liveIds = new Set(tasks.map((t) => t.id));
    for (const id of Array.from(taskRuntime.keys())) {
      if (!liveIds.has(id)) taskRuntime.delete(id);
    }

    refreshDashboard();
  }

  // ---------- Load tone audio cache (filename -> base64 data URI) ----------
  // fire_alarm.mp3 is never returned by API.tones (hidden server-side),
  // so it can never end up in toneDataCache / the Task Tone List picker.
  async function fetchTones() {
    const data = await api(API.tones);
    const list = data.tones || [];
    toneDataCache = {};
    list.forEach((t) => { if (t && t.filename) toneDataCache[t.filename] = t.data || ''; });
    return list;
  }

  async function loadToneCache() {
    try {
      await fetchTones();
    } catch (e) {
      console.error('Failed to load tone cache:', e);
      showToast('Could not load task tones from the server.', 'error');
    }
  }

  // ---------- Load the reserved Task Start/End Warning tone ----------
  async function loadFireAlarm() {
    try {
      const data = await api(API.fireAlarm);
      fireAlarmDataUri = data.data || '';
      if (!data.ok) {
        // Backend found no fire_alarm.mp3 on disk — not fatal, the
        // dashboard/timers still run fine, just without the warning tone.
        console.warn('Fire alarm tone unavailable:', data.error);
      }
    } catch (e) {
      fireAlarmDataUri = '';
      console.error('Failed to load fire alarm tone:', e);
    }
  }

  // ============================================================
  // TIME / STATUS HELPERS
  // Every saved task recurs daily, so status is computed purely from
  // today's Start/End time versus the current clock — no persistence
  // needed across page reloads or midnight rollovers.
  // ============================================================

  function minutesSinceMidnight(hhmm) {
    if (!hhmm) return 24 * 60; // treat as "end of day" if missing
    const [h, m] = hhmm.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function getTaskTimes(task, now) {
    now = now || new Date();
    const [sh, sm] = (task.start || '00:00').split(':').map(Number);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh || 0, sm || 0, 0, 0);
    const [eh, em] = (task.end || task.start || '00:00').split(':').map(Number);
    let end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), eh || 0, em || 0, 0, 0);
    if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  function computeTaskState(task, now) {
    now = now || new Date();
    const { start, end } = getTaskTimes(task, now);
    if (now.getTime() >= end.getTime()) return { status: 'completed', start, end };
    if (now.getTime() < start.getTime()) return { status: 'upcoming', start, end };
    return { status: 'running', start, end };
  }

  function getDisplayStatus(task, now) {
    return computeTaskState(task, now).status;
  }

  function statusLabel(status) {
    return { upcoming: 'Upcoming', running: 'Running', completed: 'Completed' }[status] || 'Upcoming';
  }

  function statusBadgeHtml(status) {
    return `<span class="status-badge status-${status}">${statusLabel(status)}</span>`;
  }

  function formatRemaining(ms) {
    if (ms <= 0) return 'now';
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const s = Math.floor((ms % 60000) / 1000);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function remainingLabelForTask(task, now) {
    const { status, start, end } = computeTaskState(task, now);
    if (status === 'upcoming') return `Starts in ${formatRemaining(start.getTime() - now.getTime())}`;
    if (status === 'running') return `Ends in ${formatRemaining(end.getTime() - now.getTime())}`;
    return 'Completed for today';
  }

  // ============================================================
  // TASK TONE PLAYLIST PLAYBACK  (Song1 -> Song2 -> ... -> repeat)
  // + FIRE ALARM (Task Start/End Warning), fully independent of the
  //   old reminder popup, which no longer exists.
  // ============================================================

  // Single shared <audio> used for the currently playing playlist song.
  const playlistAudio = new Audio();
  playlistAudio.loop = false;

  // Single shared <audio> used only for the 2-second fire-alarm warning.
  const fireAlarmAudio = new Audio();
  let fireAlarmStopTimer = null;

  function stopPlaylist() {
    try { playlistAudio.pause(); } catch (e) { /* ignore */ }
    playlistAudio.currentTime = 0;
    playlistAudio.src = '';
    playlistAudio.onended = null;
    playlistAudio.onerror = null;
    currentPlayingFilename = '';
    updateDashboardMusicLabel();
  }

  let currentPlayingFilename = ''; // drives the dashboard's "Currently Playing" display
  let playlistSkipWarned = false;  // only ever show one "missing song" toast per run

  function playPlaylistSong(tones, index, attempts) {
    if (!tones || !tones.length) return;
    attempts = attempts || 0;
    // ERROR HANDLING — Missing Song: if every song in the playlist is
    // unplayable, stop instead of looping forever.
    if (attempts >= tones.length) {
      currentPlayingFilename = '';
      updateDashboardMusicLabel();
      if (!playlistSkipWarned) {
        showToast('None of this task\u2019s songs could be played.', 'error');
        playlistSkipWarned = true;
      }
      return;
    }

    const filename = tones[index % tones.length];
    const dataUri = toneDataCache[filename];
    if (!dataUri) {
      // ERROR HANDLING — Missing Song: skip straight to the next one.
      if (!playlistSkipWarned) {
        showToast(`"${filename.replace(/\.[^.]+$/, '')}" is missing — skipping to the next song.`, 'warning');
        playlistSkipWarned = true;
      }
      playPlaylistSong(tones, index + 1, attempts + 1);
      return;
    }

    playlistAudio.src = dataUri;
    playlistAudio.currentTime = 0;
    currentPlayingFilename = filename;
    playlistSkipWarned = false;
    updateDashboardMusicLabel();
    playlistAudio.onended = () => {
      playPlaylistSong(tones, index + 1); // Song1 -> Song2 -> ... -> repeat from Song1
    };
    playlistAudio.onerror = () => {
      // ERROR HANDLING — Audio Error: don't get stuck, move on automatically.
      if (!playlistSkipWarned) {
        showToast(`Playback error on "${filename.replace(/\.[^.]+$/, '')}" — skipping.`, 'warning');
        playlistSkipWarned = true;
      }
      playPlaylistSong(tones, index + 1, attempts + 1);
    };
    playlistAudio.play().catch(() => { /* autoplay may need a user gesture */ });
  }

  function startPlaylist(tones) {
    stopPlaylist();
    if (!tones || !tones.length) return; // Skip mode / no tones -> no music at all
    playlistSkipWarned = false;
    playPlaylistSong(tones, 0);
  }

  function stopFireAlarm() {
    if (fireAlarmStopTimer) { clearTimeout(fireAlarmStopTimer); fireAlarmStopTimer = null; }
    try { fireAlarmAudio.pause(); } catch (e) { /* ignore */ }
    fireAlarmAudio.currentTime = 0;
    fireAlarmAudio.onerror = null;
  }

  let fireAlarmWarned = false;

  function playFireAlarmFor2Seconds() {
    // Missing fire_alarm.mp3 is not fatal — the task still starts/ends on
    // schedule, it just plays silently. Warn the user once.
    if (!fireAlarmDataUri) {
      if (!fireAlarmWarned) {
        showToast('Task warning tone is unavailable — continuing silently.', 'warning');
        fireAlarmWarned = true;
      }
      return;
    }
    stopFireAlarm();
    fireAlarmAudio.onerror = () => {
      if (!fireAlarmWarned) {
        showToast('Task warning tone failed to play.', 'warning');
        fireAlarmWarned = true;
      }
    };
    fireAlarmAudio.src = fireAlarmDataUri;
    fireAlarmAudio.currentTime = 0;
    fireAlarmAudio.play().catch(() => { /* autoplay may need a user gesture */ });
    fireAlarmStopTimer = setTimeout(stopFireAlarm, FIRE_ALARM_DURATION_MS);
  }

  // ============================================================
  // TASK RUNNING DASHBOARD — full-screen control center shown the
  // instant a task's engine phase becomes 'active', hidden the
  // instant it becomes 'done'. Purely a UI layer: reads task
  // start/end/tones and the currently-playing filename, never
  // touches scheduling, playback, or fire-alarm logic itself.
  // ============================================================

  let dashboardTaskId = null;
  let dashboardTaskRef = null;

  const RING_CIRCUMFERENCE = 2 * Math.PI * 94; // matches r="94" in the SVG

  function pad3(n) { return String(Math.max(0, Math.floor(n))).padStart(2, '0'); }

  function formatHHMMSS(ms) {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${pad3(h)}:${pad3(m)}:${pad3(s)}`;
  }

  function updateDashboardMusicLabel() {
    if (!dashMusicName || !dashMusicBox) return;
    if (!dashboardTaskRef) return;
    if (dashboardTaskRef.skip || !currentPlayingFilename) {
      dashMusicName.innerHTML = '<i class="fas fa-music"></i> No Background Music';
      dashMusicBox.classList.add('dash-music-off');
    } else {
      const label = currentPlayingFilename.replace(/\.[^.]+$/, '');
      dashMusicName.innerHTML = `<i class="fas fa-music"></i> ${escHtml(label)}`;
      dashMusicBox.classList.remove('dash-music-off');
    }
  }

  function updateTaskDashboard(now) {
    if (!dashboardTaskRef || !dashOverlay || !dashOverlay.classList.contains('active')) return;
    const rt = taskRuntime.get(dashboardTaskId);
    const { start, end } = getTaskTimes(dashboardTaskRef, now);
    const nowMs = now.getTime();
    const pauseOffset = rt ? (rt.pauseOffsetMs || 0) : 0;
    // Time actually spent paused is excluded from elapsed/remaining, so the
    // countdown freezes on Stop and continues from exactly where it left
    // off on Resume — it never "loses" real running time to a pause.
    const effNowMs = (rt && rt.paused) ? (rt.pauseStartedAt - pauseOffset) : (nowMs - pauseOffset);

    const total = end.getTime() - start.getTime();
    const elapsed = effNowMs - start.getTime();
    const progress = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 1;
    const remainingMs = end.getTime() - effNowMs;

    // Progress ring
    if (dashRingFill) dashRingFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
    if (dashRingPercent) dashRingPercent.textContent = Math.round(progress * 100) + '%';

    // Hourglass sand — the sand rectangle spans the ENTIRE chamber (wide
    // cap + narrowing neck), and the clip-path tapers it to the hourglass
    // outline automatically. Top chamber: full at 22..156, drains from the
    // top down. Bottom chamber: empty at 160..294, fills from the bottom
    // up toward the neck.
    const TOP_TOP = 22, TOP_NECK = 156;
    const BOTTOM_NECK = 160, BOTTOM_BOTTOM = 294;
    const topSpan = TOP_NECK - TOP_TOP;       // 134
    const bottomSpan = BOTTOM_BOTTOM - BOTTOM_NECK; // 134
    const topH = topSpan * (1 - progress);
    const bottomH = bottomSpan * progress;
    if (dashTopSand) {
      dashTopSand.setAttribute('height', topH.toFixed(2));
      dashTopSand.setAttribute('y', (TOP_NECK - topH).toFixed(2));
    }
    if (dashBottomSand) {
      dashBottomSand.setAttribute('height', bottomH.toFixed(2));
      dashBottomSand.setAttribute('y', (BOTTOM_BOTTOM - bottomH).toFixed(2));
    }
    if (dashUpperPct) dashUpperPct.textContent = Math.round((1 - progress) * 100) + '%';
    if (dashLowerPct) dashLowerPct.textContent = Math.round(progress * 100) + '%';

    // Live timer
    if (dashTimer) dashTimer.textContent = formatHHMMSS(remainingMs);

    updateDashboardMusicLabel();
  }

  function updatePauseButtonUI(isPaused) {
    if (dashPauseBtn) dashPauseBtn.classList.toggle('is-paused', isPaused);
    if (dashPauseIcon) dashPauseIcon.className = isPaused ? 'fas fa-play' : 'fas fa-pause';
    if (dashPauseLabel) dashPauseLabel.textContent = isPaused ? 'Resume' : 'Stop';
    if (dashStatus) dashStatus.classList.toggle('dash-status-paused', isPaused);
    if (dashStatusLabel) dashStatusLabel.textContent = isPaused ? 'Paused' : 'Running...';
    if (dashOverlay) dashOverlay.classList.toggle('dash-paused', isPaused);
  }

  // ----- Stop / Resume the currently running task -----
  // Stop: freezes the timer/ring/sand exactly where they are and pauses
  // (not stops) the currently playing song, so Resume continues the same
  // song from the same position. Resume: the paused duration is added to
  // the task's running pause-offset, so it is subtracted back out of
  // "now" everywhere — the remaining time picks up exactly where Stop
  // left it, it never keeps counting down while paused.
  function toggleTaskPause() {
    if (!dashboardTaskId) return;
    const rt = taskRuntime.get(dashboardTaskId);
    if (!rt || rt.phase !== 'active') return; // only meaningful while the task is actually running

    if (!rt.paused) {
      rt.paused = true;
      rt.pauseStartedAt = Date.now();
      try { playlistAudio.pause(); } catch (e) { /* ignore */ }
      updatePauseButtonUI(true);
    } else {
      const pausedFor = Date.now() - rt.pauseStartedAt;
      rt.pauseOffsetMs = (rt.pauseOffsetMs || 0) + Math.max(0, pausedFor);
      rt.paused = false;
      rt.pauseStartedAt = 0;
      if (playlistAudio.src) {
        playlistAudio.play().catch(() => { /* autoplay may need a user gesture */ });
      }
      updatePauseButtonUI(false);
    }
    updateTaskDashboard(new Date());
  }

  if (dashPauseBtn) dashPauseBtn.addEventListener('click', toggleTaskPause);

  function showTaskDashboard(task, now) {
    if (!dashOverlay) return;
    dashboardTaskId = task.id;
    dashboardTaskRef = task;
    if (dashTaskName) dashTaskName.textContent = task.task_name || 'Task';
    document.body.classList.add('task-dash-open');
    dashOverlay.classList.add('active');
    updatePauseButtonUI(false); // every fresh task run starts un-paused
    updateDashboardMusicLabel();
    updateTaskDashboard(now || new Date());
  }

  function hideTaskDashboard() {
    if (!dashOverlay) return;
    dashOverlay.classList.remove('active');
    dashOverlay.classList.remove('dash-paused');
    document.body.classList.remove('task-dash-open');
    updatePauseButtonUI(false);
    dashboardTaskId = null;
    dashboardTaskRef = null;
  }

  // ============================================================
  // TASK EXECUTION ENGINE
  // Per task, per-day state machine:
  //   idle -> pre-start (fire alarm, last 2s before start)
  //        -> active (playlist playing, unless Skip)
  //        -> pre-end (fire alarm, last 2s before end; playlist stopped)
  //        -> done (until the next day's occurrence)
  // Never shows any popup. Never shuffles the playlist order.
  // ============================================================

  const taskRuntime = new Map(); // taskId -> { occurrenceKey, phase }
  let audioOwnerTaskId = null;   // only one task "owns" the shared audio elements at a time

  function occurrenceKeyFor(start) {
    return start.toDateString();
  }

  function getRuntime(task, start) {
    const key = occurrenceKeyFor(start);
    let rt = taskRuntime.get(task.id);
    if (!rt || rt.occurrenceKey !== key) {
      rt = { occurrenceKey: key, phase: 'idle', paused: false, pauseStartedAt: 0, pauseOffsetMs: 0 };
      taskRuntime.set(task.id, rt);
    }
    return rt;
  }

  const invalidScheduleWarned = new Set(); // taskId set, one toast per bad task

  function isValidSchedule(task) {
    return !!(task && typeof task.start === 'string' && /^\d{1,2}:\d{2}$/.test(task.start));
  }

  function engineTick(now) {
    const nowMs = now.getTime();

    for (const task of tasks) {
      // ERROR HANDLING — Invalid Schedule: skip this task's engine logic
      // instead of throwing and breaking every other task's sync.
      if (!isValidSchedule(task)) {
        if (!invalidScheduleWarned.has(task.id)) {
          invalidScheduleWarned.add(task.id);
          showToast(`"${task.task_name || 'Task'}" has an invalid schedule and was skipped.`, 'error');
        }
        continue;
      }

      let start, end, rt;
      try {
        ({ start, end } = getTaskTimes(task, now));
        rt = getRuntime(task, start);
      } catch (e) {
        // ERROR HANDLING — Backend/Unexpected Error: never let one bad
        // task stop the rest of the engine from ticking.
        console.error('Engine error for task', task && task.id, e);
        continue;
      }
      const msToStart = start.getTime() - nowMs;
      // While paused, "now" is frozen at the moment Stop was pressed (minus
      // whatever was already banked from earlier pauses this run), so the
      // task can never silently finish, fire-alarm, or roll to 'done'
      // while stopped — Resume picks up exactly where it left off.
      const effNowMs = rt.paused ? (rt.pauseStartedAt - (rt.pauseOffsetMs || 0)) : (nowMs - (rt.pauseOffsetMs || 0));
      const msToEnd = end.getTime() - effNowMs;

      if (rt.phase === 'idle') {
        if (msToStart <= FIRE_ALARM_LEAD_MS && msToStart > 0 &&
            (audioOwnerTaskId === null || audioOwnerTaskId === task.id)) {
          // Exactly 2 seconds before the task starts: play fire alarm.
          audioOwnerTaskId = task.id;
          rt.phase = 'pre-start';
          playFireAlarmFor2Seconds();
        } else if (nowMs >= start.getTime() && nowMs < end.getTime() &&
                   (audioOwnerTaskId === null || audioOwnerTaskId === task.id)) {
          // Page loaded / tab woke up mid-task: skip straight to active.
          audioOwnerTaskId = task.id;
          rt.phase = 'active';
          if (!task.skip) startPlaylist(task.tones);
          if (dashboardTaskId === null) showTaskDashboard(task, now);
        }
      } else if (rt.phase === 'pre-start') {
        if (nowMs >= start.getTime()) {
          // Task officially starts now: stop fire alarm immediately,
          // then start the selected playlist (or nothing, if Skip).
          stopFireAlarm();
          rt.phase = 'active';
          if (!task.skip) {
            startPlaylist(task.tones);
          }
          if (dashboardTaskId === null) showTaskDashboard(task, now);
        }
      } else if (rt.phase === 'active') {
        if (msToEnd <= FIRE_ALARM_LEAD_MS && msToEnd > 0) {
          // Exactly 2 seconds before task completion: stop any playing
          // task song immediately, then play the fire alarm.
          stopPlaylist();
          rt.phase = 'pre-end';
          playFireAlarmFor2Seconds();
        } else if (effNowMs >= end.getTime()) {
          // Missed the pre-end window (e.g. tab was inactive) — stop
          // everything cleanly. Uses effNowMs so a paused task can never
          // "finish" while stopped.
          stopPlaylist();
          stopFireAlarm();
          rt.phase = 'done';
          rt.paused = false;
          if (audioOwnerTaskId === task.id) audioOwnerTaskId = null;
          if (dashboardTaskId === task.id) hideTaskDashboard();
        }
      } else if (rt.phase === 'pre-end') {
        if (nowMs >= end.getTime()) {
          // After the task finishes, stop the fire alarm automatically.
          stopFireAlarm();
          rt.phase = 'done';
          if (audioOwnerTaskId === task.id) audioOwnerTaskId = null;
          if (dashboardTaskId === task.id) hideTaskDashboard();
        }
      }
      // 'done' -> nothing to do until occurrenceKey rolls over tomorrow,
      // which getRuntime() resets back to 'idle' automatically.
    }
  }

  let masterTickErrorWarned = false;

  function masterTick() {
    // ERROR HANDLING — never let a single bad tick throw and silently
    // kill the whole setInterval loop (which would freeze every timer,
    // animation, and sync in the app until the next full page reload).
    try {
      const now = new Date();
      engineTick(now);
      refreshDashboard();
      updateTaskDashboard(now);
    } catch (e) {
      console.error('Task engine tick failed:', e);
      if (!masterTickErrorWarned) {
        showToast('A sync error occurred — recovering automatically.', 'error');
        masterTickErrorWarned = true;
      }
    }
  }

  // ---------- Dashboard: Upcoming + Overview ----------

  function buildTaskCard(task, opts) {
    opts = opts || {};
    const now = new Date();
    const status = getDisplayStatus(task, now);
    const control = opts.checkbox
      ? `<div class="tc-control"><input type="checkbox" data-id="${task.id}" /></div>`
      : (opts.radio ? `<div class="tc-control"><input type="radio" name="${opts.radioName}" value="${task.id}" /></div>` : '');

    const remaining = opts.showRemaining
      ? `<span class="tc-remaining">${escHtml(remainingLabelForTask(task, now))}</span>`
      : '';

    const div = document.createElement('div');
    div.className = 'task-card';
    div.dataset.id = task.id;
    div.innerHTML = `
      ${control}
      <div class="tc-body">
        <div class="tc-top-row">
          <span class="tc-name">${escHtml(task.task_name)}</span>
          ${statusBadgeHtml(status)}
        </div>
        <div class="tc-meta-row">
          <span><i class="fas fa-hourglass-start"></i> ${formatToAMPM(task.start)} &rarr; ${formatToAMPM(task.end)}</span>
          <span><i class="fas fa-music"></i> ${escHtml(toneDisplayName(task))}</span>
        </div>
      </div>
      ${remaining}
    `;
    return div;
  }

  function renderUpcoming() {
    const now = new Date();
    const sorted = [...tasks].sort((a, b) => {
      const sa = computeTaskState(a, now).start.getTime();
      const sb = computeTaskState(b, now).start.getTime();
      return sa - sb;
    });
    const top = sorted.slice(0, 4);

    upcomingList.innerHTML = '';
    if (top.length === 0) {
      upcomingList.innerHTML = '<div class="task-card-empty">No tasks scheduled</div>';
      return;
    }
    top.forEach((task) => upcomingList.appendChild(buildTaskCard(task, { showRemaining: true })));
  }

  function renderOverview() {
    const total = tasks.length;
    const toned = tasks.filter((t) => !t.skip && Array.isArray(t.tones) && t.tones.length > 0).length;
    const defaultToned = total - toned;
    const todayCount = total; // every saved task recurs daily in this scheduler

    totalTasksEl.textContent = total;
    todayTasksEl.textContent = todayCount;
    tonedTasksEl.textContent = toned;
    defaultTonedTasksEl.textContent = defaultToned;

    const pct = total === 0 ? 0 : Math.round((toned / total) * 100);
    progressFill.style.width = pct + '%';
    progressPercent.textContent = pct + '%';
  }

  function refreshDashboard() {
    renderUpcoming();
    renderOverview();
    // Keep any currently-open List popup live too.
    if (listTaskPopup.classList.contains('active')) renderListTasks(listTasksContainer);
    // NOTE: Do NOT re-render deleteTaskPopup here — doing so destroys
    // and recreates checkbox elements every second, which prevents clicks
    // from registering and causes visual flickering/vibration.
    if (viewAllUpcomingPopup.classList.contains('active')) renderAllUpcoming();
  }

  // ---------- Popup helpers ----------
  function openPopup(popup) { if (popup) popup.classList.add('active'); }
  function closePopup(popup) { if (popup) popup.classList.remove('active'); }

  function showWizardStep(step) {
    [stepSelect, stepForm, stepTone, stepToneList, stepToneDownload].forEach((s) =>
      s.classList.remove('active')
    );
    step.classList.add('active');
  }

  // ============================================================
  // WIZARD: shared by Set Task (create) + Update Task (update)
  // ============================================================

  function resetWizardState() {
    wizardTaskId = null;
    wizardTones = [];
    wizardSkip = false;
    wizardKeepTone = false;

    const now = new Date();
    const currentHHMM = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    fieldStart.value = currentHHMM;
    fieldEnd.value = currentHHMM;

    fieldTaskName.value = '';
    toneDownloadName.value = '';
    toneDownloadStatus.textContent = '';
    toneDownloadStatus.className = 'tone-download-status';
    toneDownloadSave.disabled = true;
    toneListSave.disabled = true;
  }

  function openWizardCreate() {
    resetWizardState();
    wizardMode = 'create';
    stepFormTitle.innerHTML = '<i class="fas fa-plus-circle"></i> Set Task';
    toneSkipLabel.textContent = 'Skip';
    openPopup(wizardOverlay);
    showWizardStep(stepForm);
  }

  function renderTaskSelectList() {
    wizardTaskSelectList.innerHTML = '';
    if (tasks.length === 0) {
      wizardTaskSelectList.innerHTML = '<div class="tone-list-empty">No tasks yet. Use Set Task to create one first.</div>';
      return;
    }
    const sorted = [...tasks].sort(
      (a, b) => minutesSinceMidnight(a.start) - minutesSinceMidnight(b.start)
    );
    sorted.forEach((task) => {
      const card = buildTaskCard(task, { radio: true, radioName: 'wizardTaskPick' });
      wizardTaskSelectList.appendChild(card);
    });
    wizardTaskSelectList.querySelectorAll('input[name="wizardTaskPick"]').forEach((radio) => {
      radio.addEventListener('change', () => { stepSelectNext.disabled = false; });
    });
    // Clicking anywhere on the card should also select its radio.
    wizardTaskSelectList.querySelectorAll('.task-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const radio = card.querySelector('input[type="radio"]');
        if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
      });
    });
  }

  function openWizardUpdate() {
    resetWizardState();
    wizardMode = 'update';
    stepFormTitle.innerHTML = '<i class="fas fa-edit"></i> Update Task';
    toneSkipLabel.textContent = 'Skip (keep tone)';
    stepSelectNext.disabled = true;
    renderTaskSelectList();
    openPopup(wizardOverlay);
    showWizardStep(stepSelect);
  }

  stepSelectCancel.addEventListener('click', () => closePopup(wizardOverlay));

  stepSelectNext.addEventListener('click', () => {
    const checked = wizardTaskSelectList.querySelector('input[name="wizardTaskPick"]:checked');
    if (!checked) return;
    const task = tasks.find((t) => String(t.id) === checked.value);
    if (!task) return;
    wizardTaskId = task.id;
    // Preload the existing ordered playlist / skip flag so re-opening the
    // Task Tone step shows exactly what's saved for this task right now.
    wizardTones = Array.isArray(task.tones) ? task.tones.slice() : [];
    wizardSkip = !!task.skip;
    // Auto-fill Start Time, End Time, Task Name from the existing task
    fieldStart.value = task.start || '';
    fieldEnd.value = task.end || '';
    fieldTaskName.value = task.task_name || '';
    showWizardStep(stepForm);
  });

  stepFormCancel.addEventListener('click', () => closePopup(wizardOverlay));

  stepFormNext.addEventListener('click', () => {
    const name = fieldTaskName.value.trim();
    const start = fieldStart.value;
    if (!name) { alert('Please enter a task name.'); return; }
    if (!start) { alert('Please choose a start time.'); return; }
    toneCurrentName.textContent = wizardSkip
      ? 'Skip (No Music)'
      : (wizardTones.length
          ? wizardTones.map((f) => f.replace(/\.[^.]+$/, '')).join(' → ')
          : (wizardMode === 'update' ? 'Unchanged' : 'No Tone Selected'));
    showWizardStep(stepTone);
  });

  stepToneBack.addEventListener('click', () => {
    showWizardStep(stepForm);
  });

  // ----- Finalize: create or update the task with the chosen playlist -----
  async function finalizeSaveTask({ tones, skip, keepTone }) {
    const payload = {
      task_name: fieldTaskName.value.trim(),
      start: fieldStart.value,
      end: fieldEnd.value || '',
    };

    try {
      if (wizardMode === 'create') {
        payload.tones = tones || [];
        payload.skip = !!skip;
        await api(API.tasks, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        showToast('Task saved successfully!');
      } else {
        payload.keep_tone = !!keepTone;
        if (!keepTone) {
          payload.tones = tones || [];
          payload.skip = !!skip;
        }
        await api(`${API.tasks}/${wizardTaskId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        showToast('Task updated successfully!');
      }
      closePopup(wizardOverlay);
      await loadTasks();
    } catch (e) {
      alert(e.message || 'Something went wrong while saving the task.');
    }
  }

  // ----- Tone Option: Skip -----
  toneOptionSkip.addEventListener('click', () => {
    if (wizardMode === 'update') {
      finalizeSaveTask({ tones: [], skip: true, keepTone: true });
    } else {
      finalizeSaveTask({ tones: [], skip: true, keepTone: false });
    }
  });

  // ----- Tone Option: Task Tone List (MULTI-SELECT, ordered) -----
  // The user can pick Song1, Song2, Song3, Song4... in any click order;
  // that click order becomes the playback order (Song1 -> Song2 -> ...).
  // fire_alarm.mp3 never appears here because API.tones already excludes
  // it server-side.
  let toneListSelection = []; // ordered filenames, rebuilt each time the panel opens

  function renderToneSelectionOrder() {
    // Re-number the "N." prefix on every checked item to reflect current order.
    toneListContainer.querySelectorAll('.tone-list-item').forEach((label) => {
      const input = label.querySelector('input[type="checkbox"]');
      const nameEl = label.querySelector('.tone-order-name');
      if (!input || !nameEl) return;
      const pos = toneListSelection.indexOf(input.value);
      nameEl.textContent = pos > -1 ? `${pos + 1}. ${nameEl.dataset.baseName}` : nameEl.dataset.baseName;
      label.classList.toggle('tone-list-item-selected', pos > -1);
    });
    toneListSave.disabled = toneListSelection.length === 0;
  }

  async function renderToneListPanel() {
    toneListContainer.innerHTML = '<div class="tone-list-empty">Loading tones...</div>';
    toneListSave.disabled = true;
    let tones = [];
    try {
      tones = await fetchTones();
    } catch (e) {
      toneListContainer.innerHTML = '<div class="tone-list-empty">Could not load tones.</div>';
      return;
    }

    if (tones.length === 0) {
      toneListContainer.innerHTML = '<div class="tone-list-empty">No task tones stored yet. Try Download Task Tone instead.</div>';
      return;
    }

    // Seed selection + order from whatever the wizard already has staged
    // (e.g. reopening the panel, or editing an existing task's playlist).
    toneListSelection = wizardTones.filter((f) => tones.some((t) => t.filename === f));

    toneListContainer.innerHTML = '';
    tones.forEach((tone) => {
      const label = document.createElement('label');
      label.className = 'tone-list-item';
      const checked = toneListSelection.indexOf(tone.filename) > -1;
      label.innerHTML = `
        <input type="checkbox" name="toneListPick" value="${escHtml(tone.filename)}" ${checked ? 'checked' : ''} />
        <span class="tone-order-name" data-base-name="${escHtml(tone.name)}"><i class="fas fa-music"></i> ${escHtml(tone.name)}</span>
      `;
      toneListContainer.appendChild(label);
    });

    toneListContainer.querySelectorAll('input[name="toneListPick"]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const idx = toneListSelection.indexOf(checkbox.value);
        if (checkbox.checked && idx === -1) {
          toneListSelection.push(checkbox.value); // append: user's click order = playback order
        } else if (!checkbox.checked && idx > -1) {
          toneListSelection.splice(idx, 1);
        }
        renderToneSelectionOrder();
      });
    });

    renderToneSelectionOrder();
  }

  toneOptionList.addEventListener('click', () => {
    renderToneListPanel();
    showWizardStep(stepToneList);
  });

  toneListCancel.addEventListener('click', () => showWizardStep(stepTone));

  toneListSave.addEventListener('click', () => {
    if (!toneListSelection.length) return;
    wizardTones = toneListSelection.slice();
    wizardSkip = false;
    finalizeSaveTask({ tones: wizardTones, skip: false, keepTone: false });
  });

  // ----- Tone Option: Download Task Tone -----
  toneOptionDownload.addEventListener('click', () => {
    toneDownloadName.value = '';
    toneDownloadStatus.textContent = '';
    toneDownloadStatus.className = 'tone-download-status';
    toneDownloadSave.disabled = true;
    showWizardStep(stepToneDownload);
  });

  toneDownloadCancel.addEventListener('click', () => showWizardStep(stepTone));

  let lastDownloadedFilename = '';

  toneDownloadStart.addEventListener('click', async () => {
    const name = toneDownloadName.value.trim();
    if (!name) { alert('Please enter a task tone name.'); return; }

    // Save button MUST remain disabled while the download is in progress.
    toneDownloadSave.disabled = true;
    toneDownloadStart.disabled = true;
    toneDownloadStatus.className = 'tone-download-status';
    toneDownloadStatus.innerHTML = `<span class="mini-spinner"></span> Downloading "${escHtml(name)}"...`;

    try {
      const data = await api(API.downloadTone, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      // Only now — after the tone is confirmed stored in task_tone/ — do we
      // enable Save. This mirrors the backend, which itself only returns
      // success once the file exists on disk.
      lastDownloadedFilename = data.filename;
      // Refresh the tone audio cache so this brand-new tone can be played
      // by the Task Execution Engine as soon as it's selected.
      await loadToneCache();
      toneDownloadStatus.className = 'tone-download-status success';
      toneDownloadStatus.innerHTML = `<i class="fas fa-check-circle"></i> Downloaded and added to Task Tone List.`;
      toneDownloadSave.disabled = false;
    } catch (e) {
      toneDownloadStatus.className = 'tone-download-status error';
      toneDownloadStatus.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${escHtml(e.message || 'Download failed.')}`;
      toneDownloadSave.disabled = true;
    } finally {
      toneDownloadStart.disabled = false;
    }
  });

  toneDownloadSave.addEventListener('click', () => {
    if (toneDownloadSave.disabled || !lastDownloadedFilename) return;
    // The freshly downloaded tone is appended to the end of the staged
    // playlist, preserving whatever order was already picked.
    if (wizardTones.indexOf(lastDownloadedFilename) === -1) {
      wizardTones.push(lastDownloadedFilename);
    }
    wizardSkip = false;
    finalizeSaveTask({ tones: wizardTones, skip: false, keepTone: false });
  });

  // ============================================================
  // DELETE TASK
  // ============================================================

  function renderDeleteList() {
    deleteTaskList.innerHTML = '';
    if (tasks.length === 0) {
      deleteTaskList.innerHTML = '<div class="task-card-empty">No tasks to delete.</div>';
      return;
    }
    tasks.forEach((task) => {
      const card = buildTaskCard(task, { checkbox: true });
      deleteTaskList.appendChild(card);
    });
    deleteTaskList.querySelectorAll('.task-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const cb = card.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = !cb.checked;
      });
    });
  }

  function refreshDeleteCheckedState() {
    // Re-render while preserving which checkboxes are currently checked.
    const checkedIds = new Set(
      Array.from(deleteTaskList.querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.dataset.id)
    );
    renderDeleteList();
    checkedIds.forEach((id) => {
      const cb = deleteTaskList.querySelector(`input[type="checkbox"][data-id="${id}"]`);
      if (cb) cb.checked = true;
    });
  }

  openDeleteTaskBtn.addEventListener('click', () => {
    renderDeleteList();
    openPopup(deleteTaskPopup);
  });

  cancelDeleteBtn.addEventListener('click', () => closePopup(deleteTaskPopup));

  deleteSelectedBtn.addEventListener('click', async () => {
    const checks = deleteTaskList.querySelectorAll('input[type="checkbox"]:checked');
    if (checks.length === 0) { alert('Select at least one task to delete.'); return; }
    if (!(await customConfirm(`Delete ${checks.length} task(s)?`))) return;
    const ids = Array.from(checks).map((c) => parseInt(c.dataset.id, 10));
    try {
      await api(API.deleteTasks, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      showToast(`${ids.length} task(s) deleted.`);
      await loadTasks();
      renderDeleteList();
      if (tasks.length === 0) closePopup(deleteTaskPopup);
    } catch (e) {
      alert(e.message || 'Failed to delete tasks.');
    }
  });

  // ============================================================
  // LIST TASKS
  // ============================================================

  function renderListTasks(container) {
    container.innerHTML = '';
    if (tasks.length === 0) {
      container.innerHTML = '<div class="task-card-empty">No tasks found.</div>';
      return;
    }
    const now = new Date();
    const sorted = [...tasks].sort(
      (a, b) => computeTaskState(a, now).start.getTime() - computeTaskState(b, now).start.getTime()
    );
    sorted.forEach((task) => container.appendChild(buildTaskCard(task, {})));
  }

  openListTaskBtn.addEventListener('click', () => {
    renderListTasks(listTasksContainer);
    openPopup(listTaskPopup);
  });

  closeListBtn.addEventListener('click', () => closePopup(listTaskPopup));

  // ---------- VIEW ALL UPCOMING ----------
  function renderAllUpcoming() {
    const now = new Date();
    const sorted = [...tasks].sort(
      (a, b) => computeTaskState(a, now).start.getTime() - computeTaskState(b, now).start.getTime()
    );
    allUpcomingList.innerHTML = '';
    if (sorted.length === 0) {
      allUpcomingList.innerHTML = '<div class="task-card-empty">No tasks scheduled.</div>';
    } else {
      sorted.forEach((task) => allUpcomingList.appendChild(buildTaskCard(task, { showRemaining: true })));
    }
  }

  viewAllUpcomingBtn.addEventListener('click', () => {
    renderAllUpcoming();
    openPopup(viewAllUpcomingPopup);
  });

  closeUpcomingAllBtn.addEventListener('click', () => closePopup(viewAllUpcomingPopup));

  // ---------- Open Set / Update ----------
  openSetTaskBtn.addEventListener('click', openWizardCreate);
  openUpdateTaskBtn.addEventListener('click', openWizardUpdate);

  // ---------- Close popups on overlay click ----------
  document.querySelectorAll('.popup-overlay').forEach((overlay) => {
    overlay.addEventListener('click', function (e) {
      if (e.target === this) closePopup(this);
    });
  });

  // ---------- HOME ----------
  homeBtn.addEventListener('click', () => {
    window.location.href = '/';
  });

  // ---------- INIT ----------
  loadToneCache();
  loadFireAlarm();
  loadTasks();
  setInterval(masterTick, TICK_MS);

  console.log('📋 S.N.E.T.C.H Daily Task Manager (web) ready — Task Execution Engine armed (playlist + fire-alarm warnings, no popup).');
})();

// ==========================================
// CUSTOM UI MODALS
// ==========================================
function showCustomModal({ title, isConfirm = false, onConfirm = null }) {
  const overlay = document.createElement('div');
  overlay.className = 'custom-modal-overlay';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    background: 'rgba(10, 10, 26, 0.7)', backdropFilter: 'blur(10px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: '10000', opacity: '0', transition: 'opacity 0.3s ease'
  });

  const modal = document.createElement('div');
  modal.className = 'custom-modal';
  Object.assign(modal.style, {
    background: 'linear-gradient(145deg, rgba(30,30,50,0.9), rgba(20,20,40,0.95))',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px',
    padding: '30px', width: '90%', maxWidth: '400px',
    boxShadow: '0 15px 35px rgba(0,0,0,0.5), 0 0 20px rgba(138, 43, 226, 0.2)',
    color: '#fff', fontFamily: "'Inter', sans-serif",
    transform: 'translateY(-20px) scale(0.95)', transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)'
  });

  const titleEl = document.createElement('h3');
  titleEl.textContent = title;
  Object.assign(titleEl.style, { margin: '0 0 20px 0', fontSize: '1.2rem', fontWeight: '600', lineHeight: '1.4' });
  modal.appendChild(titleEl);

  const btnContainer = document.createElement('div');
  Object.assign(btnContainer.style, { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' });

  const btnCancel = document.createElement('button');
  btnCancel.textContent = 'Cancel';
  Object.assign(btnCancel.style, {
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
    color: '#fff', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer',
    fontWeight: '500', transition: 'all 0.2s'
  });
  btnCancel.onmouseover = () => { btnCancel.style.background = 'rgba(255,255,255,0.1)'; };
  btnCancel.onmouseout = () => { btnCancel.style.background = 'rgba(255,255,255,0.05)'; };
  
  const btnConfirm = document.createElement('button');
  btnConfirm.textContent = 'OK';
  Object.assign(btnConfirm.style, {
    background: 'linear-gradient(135deg, #8a2be2, #4b0082)', border: 'none',
    color: '#fff', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer',
    fontWeight: '500', boxShadow: '0 4px 15px rgba(138,43,226,0.3)', transition: 'all 0.2s'
  });
  btnConfirm.onmouseover = () => { btnConfirm.style.transform = 'translateY(-2px)'; btnConfirm.style.boxShadow = '0 6px 20px rgba(138,43,226,0.4)'; };
  btnConfirm.onmouseout = () => { btnConfirm.style.transform = 'translateY(0)'; btnConfirm.style.boxShadow = '0 4px 15px rgba(138,43,226,0.3)'; };

  const close = (result) => {
    overlay.style.opacity = '0';
    modal.style.transform = 'translateY(20px) scale(0.95)';
    setTimeout(() => { document.body.removeChild(overlay); if (onConfirm) onConfirm(result); }, 300);
  };

  btnCancel.onclick = () => close(false);
  btnConfirm.onclick = () => { close(true); };

  btnContainer.appendChild(btnCancel);
  btnContainer.appendChild(btnConfirm);
  modal.appendChild(btnContainer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  void overlay.offsetWidth;
  overlay.style.opacity = '1';
  modal.style.transform = 'translateY(0) scale(1)';
}

function customConfirm(message) {
  return new Promise(resolve => {
    showCustomModal({ title: message, isConfirm: true, onConfirm: resolve });
  });
}