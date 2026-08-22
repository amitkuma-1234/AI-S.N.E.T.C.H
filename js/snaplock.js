// ============================================================
// snaplock.js
// S.N.E.T.C.H · SnapLock — AI Powered Object Security Vault
// Frontend logic wired to /api/snaplock/* (see snaplock.py)
// ============================================================

(function () {
  'use strict';

  const API = '/api/snaplock';
  const REQUIRED_ANGLES = ['front', 'back', 'left', 'right', 'top'];
  const OPTIONAL_ANGLES = ['bottom'];
  const ANGLE_INSTRUCTIONS = {
    front: 'Point the camera at the FRONT of the object',
    back: 'Now show the BACK of the object',
    left: 'Now show the LEFT side',
    right: 'Now show the RIGHT side',
    top: 'Now show the TOP of the object',
    bottom: 'Optional: show the BOTTOM of the object',
  };

  // ---------- DOM SHORTCUTS ----------
  const overlay = document.getElementById('snapOverlay');
  const modalBody = document.getElementById('snapModalBody');
  const closeBtn = document.getElementById('snapModalClose');
  const toastRoot = document.getElementById('snapToastRoot');

  // ---------- WEB AUDIO API SOUNDS ----------
  const SoundFX = {
    ctx: null,
    scanOsc: null,
    scanGain: null,
    init() {
      if (!this.ctx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();
      }
    },
    playScan() {
      this.init();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.stopScan();
      
      const t = this.ctx.currentTime;
      
      // 1. Low drone (motor/hum)
      this.droneOsc = this.ctx.createOscillator();
      this.droneOsc.type = 'sine';
      this.droneOsc.frequency.value = 55; // 55Hz hum
      this.droneGain = this.ctx.createGain();
      this.droneGain.gain.value = 0.15;
      this.droneOsc.connect(this.droneGain);
      this.droneGain.connect(this.ctx.destination);
      this.droneOsc.start(t);
      
      // 2. Data processing / Scanning Sweep (White Noise + Bandpass Filter)
      const bufferSize = this.ctx.sampleRate * 2; // 2 seconds of noise
      const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }
      this.noiseSource = this.ctx.createBufferSource();
      this.noiseSource.buffer = noiseBuffer;
      this.noiseSource.loop = true;
      
      this.noiseFilter = this.ctx.createBiquadFilter();
      this.noiseFilter.type = 'bandpass';
      this.noiseFilter.Q.value = 20; // Highly resonant for a sharp sci-fi sweeping sound
      
      // Sweep the filter up and down to sound like scanning
      this.noiseFilter.frequency.setValueAtTime(400, t);
      
      this.scanInterval = setInterval(() => {
        if (!this.noiseFilter) return;
        const ct = this.ctx.currentTime;
        this.noiseFilter.frequency.linearRampToValueAtTime(2500, ct + 1.2);
        this.noiseFilter.frequency.linearRampToValueAtTime(400, ct + 2.4);
      }, 2400);
      
      // Initial sweep
      this.noiseFilter.frequency.linearRampToValueAtTime(2500, t + 1.2);
      this.noiseFilter.frequency.linearRampToValueAtTime(400, t + 2.4);
      
      this.noiseGain = this.ctx.createGain();
      this.noiseGain.gain.value = 0.25; 
      
      this.noiseSource.connect(this.noiseFilter);
      this.noiseFilter.connect(this.noiseGain);
      this.noiseGain.connect(this.ctx.destination);
      this.noiseSource.start(t);
    },
    stopScan() {
      if (this.scanInterval) { clearInterval(this.scanInterval); this.scanInterval = null; }
      if (this.droneOsc) { try { this.droneOsc.stop(); this.droneOsc.disconnect(); } catch (e) {} this.droneOsc = null; }
      if (this.droneGain) { try { this.droneGain.disconnect(); } catch (e) {} this.droneGain = null; }
      if (this.noiseSource) { try { this.noiseSource.stop(); this.noiseSource.disconnect(); } catch (e) {} this.noiseSource = null; }
      if (this.noiseFilter) { try { this.noiseFilter.disconnect(); } catch (e) {} this.noiseFilter = null; }
      if (this.noiseGain) { try { this.noiseGain.disconnect(); } catch (e) {} this.noiseGain = null; }
    },
    playGranted() {
      this.init();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      
      const t = this.ctx.currentTime;
      const duration = 1.2;
      
      const masterGain = this.ctx.createGain();
      masterGain.gain.setValueAtTime(0, t);
      masterGain.gain.linearRampToValueAtTime(0.3, t + 0.1);
      masterGain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      masterGain.connect(this.ctx.destination);
      
      // Play a lush major 7th chord (C5, E5, G5, B5) with a slight delay for arpeggio effect
      const freqs = [523.25, 659.25, 783.99, 987.77];
      freqs.forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(800, t + (i*0.05));
        filter.frequency.exponentialRampToValueAtTime(3000, t + (i*0.05) + 0.1);
        filter.frequency.exponentialRampToValueAtTime(500, t + duration);
        
        osc.connect(filter);
        filter.connect(masterGain);
        
        osc.start(t + (i*0.05));
        osc.stop(t + duration);
      });
    },
    playDenied() {
      this.init();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      
      const t = this.ctx.currentTime;
      const duration = 0.5;
      
      const masterGain = this.ctx.createGain();
      masterGain.gain.setValueAtTime(0, t);
      masterGain.gain.linearRampToValueAtTime(0.3, t + 0.05);
      masterGain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      masterGain.connect(this.ctx.destination);
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2000, t);
      filter.frequency.exponentialRampToValueAtTime(200, t + duration);
      filter.connect(masterGain);
      
      // Two detuned sawtooth waves create a harsh futuristic buzz
      const freqs = [150, 156];
      freqs.forEach(freq => {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.8, t + duration);
        
        osc.connect(filter);
        osc.start(t);
        osc.stop(t + duration);
      });
    }
  };

  const objectsList = document.getElementById('objectsList');

  const scannerOverlay = document.getElementById('scannerOverlay');
  const scannerVideo = document.getElementById('scannerVideo');
  const scannerCanvas = document.getElementById('scannerCanvas');
  const grantedStage = document.getElementById('grantedStage');
  const deniedStage = document.getElementById('deniedStage');
  const verifyStage = document.getElementById('verifyStage');
  const wrongPassStage = document.getElementById('wrongPassStage');
  const contentStage = document.getElementById('contentStage');

  // New scanner circle UI elements
  const scanStatusText = document.getElementById('scanStatusText');
  const scanStatusSub = document.getElementById('scanStatusSub');
  const scanProgressValue = document.getElementById('scanProgressValue');
  const scanBtnLabel = document.getElementById('scanBtnLabel');
  const scanBtnIcon = document.getElementById('scanBtnIcon');
  const scannerMain = document.querySelector('.scanner-main');

  // ---------- STATE ----------
  let liveStream = null;          // camera stream shared by wizard + scanner
  let wizard = null;              // in-progress registration state
  let scanBusy = false;
  let currentMatchedObject = null; // {object_id, object_name, confidence}
  let contentSnapToken = null;

  function authToken() { return localStorage.getItem('snetch_access_token') || ''; }
  function authHeaders(json) {
    const h = { Authorization: 'Bearer ' + authToken() };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  // ---------- API HELPER ----------
  async function api(path, { method = 'GET', body = null, form = null } = {}) {
    const opts = { method, headers: authHeaders(!form) };
    if (form) opts.body = form;
    else if (body) opts.body = JSON.stringify(body);
    let resp, data;
    try { resp = await fetch(API + path, opts); }
    catch (e) { throw new Error('Network error. Please check your connection.'); }
    try { data = await resp.json(); } catch (e) { data = {}; }
    if (!resp.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  // ---------- TOAST ----------
  function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = 'snap-toast' + (type === 'success' ? ' success' : type === 'error' ? ' error' : '');
    el.textContent = message;
    toastRoot.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  // ---------- MODAL ----------
  function openModal(html) {
    modalBody.innerHTML = html;
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => overlay.classList.add('open'));
  }
  function closeModal() {
    overlay.classList.remove('open');
    setTimeout(() => overlay.classList.add('hidden'), 200);
    stopWizardCamera();
  }
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  // ============================================================
  // MODE GRID (Camera Mode / Scanner Mode)
  // ============================================================
  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      const mode = card.getAttribute('data-mode');
      if (mode === 'camera') startCameraWizard();
      if (mode === 'scanner') startScannerMode();
    });
  });

  // ============================================================
  // CAMERA MODE — REGISTRATION WIZARD
  // ============================================================
  function newWizardState() {
    return {
      step: 'capture',
      angleIndex: 0,
      images: {},       // angle -> Blob
      objectName: '',
      accessPassword: '',
      objectId: null,
      snapToken: null,
      contentChoice: null,
    };
  }

  async function startCameraWizard() {
    wizard = newWizardState();
    renderCaptureStep();
  }

  function allAngles() { return REQUIRED_ANGLES.concat(OPTIONAL_ANGLES); }

  function renderCaptureStep() {
    const angles = allAngles();
    const doneCount = Object.keys(wizard.images).length;
    const chips = angles.map(a => {
      const cls = wizard.images[a] ? 'done' : (a === currentAngle() ? 'active' : '');
      return `<div class="angle-chip ${cls}">${a}</div>`;
    }).join('');

    openModal(`
      <h2><i class="fas fa-camera-retro"></i> Camera Mode</h2>
      <p class="snap-sub">${ANGLE_INSTRUCTIONS[currentAngle()] || 'Capture complete'}</p>
      <div class="angle-progress">${chips}</div>
      <div class="capture-view" id="captureView">
        <video id="wizardVideo" autoplay playsinline muted></video>
        <div class="capture-hud-frame"></div>
        <div class="capture-caption" id="captureCaption">${(currentAngle() || '').toUpperCase()}</div>
      </div>
      <div class="quality-grid" id="qualityGrid">
        ${qualityRowHtml('Capture Quality', 0)}
        ${qualityRowHtml('Lighting Quality', 0)}
        ${qualityRowHtml('Focus Quality', 0)}
        ${qualityRowHtml('Object Visibility', 0)}
      </div>
      <div class="capture-actions">
        <button class="snap-btn-primary" id="captureShotBtn"><i class="fas fa-bolt"></i> Capture ${currentAngle() || ''}</button>
      </div>
      ${doneCount >= REQUIRED_ANGLES.length ? `<button class="snap-btn-secondary" id="continueRegBtn"><i class="fas fa-arrow-right"></i> Continue</button>` : ''}
    `);

    initWizardCamera();
    document.getElementById('captureShotBtn').addEventListener('click', captureCurrentAngle);
    const cont = document.getElementById('continueRegBtn');
    if (cont) cont.addEventListener('click', renderNamingStep);
  }

  function qualityRowHtml(label, pct) {
    return `<div class="quality-item"><div class="ql-label"><span>${label}</span><span>${pct}%</span></div>
      <div class="quality-bar"><span style="width:${pct}%"></span></div></div>`;
  }

  function currentAngle() {
    const angles = allAngles();
    for (const a of angles) if (!wizard.images[a]) return a;
    return null;
  }

  async function initWizardCamera() {
    const video = document.getElementById('wizardVideo');
    try {
      if (!liveStream) {
        liveStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      }
      video.srcObject = liveStream;
      analyzeLoop(video);
    } catch (e) {
      toast('Camera access denied or unavailable.', 'error');
    }
  }

  let analyzeHandle = null;
  function analyzeLoop(video) {
    cancelAnimationFrame(analyzeHandle);
    const tick = () => {
      if (!document.getElementById('wizardVideo')) return; // modal closed
      updateQualityReadout(video);
      analyzeHandle = requestAnimationFrame(() => setTimeout(tick, 400));
    };
    tick();
  }

  function frameStats(video) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 48;
    const ctx = c.getContext('2d');
    try { ctx.drawImage(video, 0, 0, c.width, c.height); } catch (e) { return null; }
    let data;
    try { data = ctx.getImageData(0, 0, c.width, c.height).data; } catch (e) { return null; }
    let sum = 0, sumSq = 0, edge = 0, n = c.width * c.height;
    const gray = new Float32Array(n);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      gray[p] = g;
      sum += g;
    }
    const mean = sum / n;
    for (let p = 0; p < n; p++) sumSq += (gray[p] - mean) * (gray[p] - mean);
    const variance = sumSq / n;
    for (let y = 1; y < c.height - 1; y++) {
      for (let x = 1; x < c.width - 1; x++) {
        const idx = y * c.width + x;
        const lap = Math.abs(4 * gray[idx] - gray[idx - 1] - gray[idx + 1] - gray[idx - c.width] - gray[idx + c.width]);
        edge += lap;
      }
    }
    const sharpness = edge / n;
    return { mean, variance, sharpness };
  }

  function updateQualityReadout(video) {
    const stats = frameStats(video);
    const grid = document.getElementById('qualityGrid');
    if (!stats || !grid) return;
    const lighting = Math.max(0, Math.min(100, Math.round(100 - Math.abs(stats.mean - 130) / 1.3)));
    const focus = Math.max(0, Math.min(100, Math.round(stats.sharpness * 6)));
    const visibility = Math.max(0, Math.min(100, Math.round((stats.variance / 40))));
    const capture = Math.round((lighting + focus + visibility) / 3);
    grid.innerHTML = `
      ${qualityRowHtml('Capture Quality', capture)}
      ${qualityRowHtml('Lighting Quality', lighting)}
      ${qualityRowHtml('Focus Quality', focus)}
      ${qualityRowHtml('Object Visibility', visibility)}
    `;
  }

  function captureCurrentAngle() {
    const angle = currentAngle();
    if (!angle) return;
    const video = document.getElementById('wizardVideo');
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 640;
    c.height = video.videoHeight || 480;
    const ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      wizard.images[angle] = blob;
      toast(`${angle.toUpperCase()} captured`, 'success');
      renderCaptureStep();
    }, 'image/jpeg', 0.9);
  }

  function stopWizardCamera() {
    cancelAnimationFrame(analyzeHandle);
    // Stream is reused across steps/scanner; only stop when nothing needs it.
  }

  function fullyStopCamera() {
    if (liveStream) {
      liveStream.getTracks().forEach(t => t.stop());
      liveStream = null;
    }
  }

  function renderNamingStep() {
    openModal(`
      <h2><i class="fas fa-tag"></i> Name This Object</h2>
      <p class="snap-sub">This name is only for your own reference.</p>
      <div class="snap-field">
        <label class="snap-label">Object Name</label>
        <input type="text" id="objectNameInput" class="snap-input" placeholder="e.g. My Wallet, Office Laptop, Home Keys">
      </div>
      <button class="snap-btn-primary" id="namingNextBtn"><i class="fas fa-arrow-right"></i> Continue</button>
      <button class="snap-btn-secondary" id="namingBackBtn"><i class="fas fa-arrow-left"></i> Back</button>
    `);
    document.getElementById('namingNextBtn').addEventListener('click', () => {
      const val = document.getElementById('objectNameInput').value.trim();
      if (!val) { toast('Please enter an object name.', 'error'); return; }
      wizard.objectName = val;
      renderPasswordStep();
    });
    document.getElementById('namingBackBtn').addEventListener('click', renderCaptureStep);
  }

  function renderPasswordStep() {
    openModal(`
      <h2><i class="fas fa-key"></i> Set Access Password</h2>
      <p class="snap-sub">You'll need this password every time you unlock <strong>${escapeHtml(wizard.objectName)}</strong>.</p>
      <div class="snap-field">
        <label class="snap-label">Access Password</label>
        <input type="password" id="accessPasswordInput" class="snap-input" placeholder="Minimum 6 characters">
      </div>
      <div class="snap-field">
        <label class="snap-label">Confirm Password</label>
        <input type="password" id="confirmPasswordInput" class="snap-input" placeholder="Re-enter password">
      </div>
      <button class="snap-btn-primary" id="passwordNextBtn"><i class="fas fa-arrow-right"></i> Register Object</button>
      <button class="snap-btn-secondary" id="passwordBackBtn"><i class="fas fa-arrow-left"></i> Back</button>
    `);
    document.getElementById('passwordNextBtn').addEventListener('click', submitRegistration);
    document.getElementById('passwordBackBtn').addEventListener('click', renderNamingStep);
  }

  async function submitRegistration() {
    const pw = document.getElementById('accessPasswordInput').value;
    const cpw = document.getElementById('confirmPasswordInput').value;
    if (pw.length < 6) { toast('Password must be at least 6 characters.', 'error'); return; }
    if (pw !== cpw) { toast('Passwords do not match.', 'error'); return; }

    const btn = document.getElementById('passwordNextBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Registering…';

    const form = new FormData();
    form.append('object_name', wizard.objectName);
    form.append('access_password', pw);
    form.append('confirm_password', cpw);
    for (const [angle, blob] of Object.entries(wizard.images)) {
      form.append(angle, blob, `${angle}.jpg`);
    }

    try {
      const data = await api('/objects/register', { method: 'POST', form });
      wizard.objectId = data.object_id;
      wizard.snapToken = data.snap_token;
      toast('Object registered and secured.', 'success');
      renderSaveContentChoice();
      refreshObjectsList();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-arrow-right"></i> Register Object';
    }
  }

  function renderSaveContentChoice() {
    openModal(`
      <h2><i class="fas fa-box-open"></i> Save Content</h2>
      <p class="snap-sub">What would you like to lock inside <strong>${escapeHtml(wizard.objectName)}</strong>?</p>
      <div class="choice-row">
        <div class="choice-card" id="choicePassword"><i class="fas fa-key"></i>Save Password</div>
        <div class="choice-card" id="choiceDocument"><i class="fas fa-file-shield"></i>Save Document</div>
      </div>
      <button class="snap-btn-secondary" id="skipContentBtn">Skip for now</button>
    `);
    document.getElementById('choicePassword').addEventListener('click', renderSavePasswordForm);
    document.getElementById('choiceDocument').addEventListener('click', renderSaveDocumentForm);
    document.getElementById('skipContentBtn').addEventListener('click', () => { closeModal(); fullyStopCamera(); });
  }

  function renderSavePasswordForm() {
    openModal(`
      <h2><i class="fas fa-key"></i> Save Password</h2>
      <p class="snap-sub">Linked to <strong>${escapeHtml(wizard.objectName)}</strong> and your Access Password.</p>
      <div class="snap-field">
        <label class="snap-label">Password Title</label>
        <input type="text" id="pwTitleInput" class="snap-input" placeholder="e.g. Instagram, WiFi, Bank, UPI PIN">
      </div>
      <div class="snap-field">
        <label class="snap-label">Password</label>
        <input type="text" id="pwValueInput" class="snap-input" placeholder="Enter password">
      </div>
      <button class="snap-btn-primary" id="pwSaveBtn"><i class="fas fa-lock"></i> Save</button>
      <button class="snap-btn-secondary" id="pwBackBtn"><i class="fas fa-arrow-left"></i> Back</button>
    `);
    document.getElementById('pwBackBtn').addEventListener('click', renderSaveContentChoice);
    document.getElementById('pwSaveBtn').addEventListener('click', async () => {
      const title = document.getElementById('pwTitleInput').value.trim();
      const password = document.getElementById('pwValueInput').value;
      if (!title || !password) { toast('Both fields are required.', 'error'); return; }
      try {
        await api('/passwords/add', { method: 'POST', body: { snap_token: wizard.snapToken, title, password } });
        toast('Password saved and locked inside the object.', 'success');
        closeModal();
        fullyStopCamera();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  function renderSaveDocumentForm() {
    openModal(`
      <h2><i class="fas fa-file-shield"></i> Save Document</h2>
      <p class="snap-sub">Linked to <strong>${escapeHtml(wizard.objectName)}</strong>.</p>
      <div class="snap-field">
        <label class="snap-label">Document Name</label>
        <input type="text" id="docNameInput" class="snap-input" placeholder="e.g. Passport Scan, Rent Agreement">
      </div>
      <div class="snap-field">
        <label class="snap-label">File</label>
        <input type="file" id="docFileInput" class="snap-input">
      </div>
      <button class="snap-btn-primary" id="docSaveBtn"><i class="fas fa-upload"></i> Save</button>
      <button class="snap-btn-secondary" id="docBackBtn"><i class="fas fa-arrow-left"></i> Back</button>
    `);
    document.getElementById('docBackBtn').addEventListener('click', renderSaveContentChoice);
    document.getElementById('docSaveBtn').addEventListener('click', async () => {
      const name = document.getElementById('docNameInput').value.trim();
      const file = document.getElementById('docFileInput').files[0];
      if (!name || !file) { toast('Name and file are required.', 'error'); return; }
      const form = new FormData();
      form.append('snap_token', wizard.snapToken);
      form.append('name', name);
      form.append('file', file);
      try {
        await api('/documents/add', { method: 'POST', form });
        toast('Document saved and locked inside the object.', 'success');
        closeModal();
        fullyStopCamera();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function updateScanProgressUI(pctString) {
    if (typeof scanProgressValue !== 'undefined' && scanProgressValue) scanProgressValue.textContent = pctString;
    const fill = document.getElementById('cyberProgressFill');
    if (fill) fill.style.width = pctString;
  }

  // ============================================================
  // SCANNER MODE
  // ============================================================
  async function startScannerMode() {
    resetScannerStages();
    scannerOverlay.classList.remove('hidden');
    scanStatusText.textContent = 'INITIALIZING';
    scanStatusSub.textContent = 'Starting camera…';
    updateScanProgressUI('0%');
    try {
      const count = await api('/objects/list').then(d => d.items.length).catch(() => 0);
      document.getElementById('hudObjectCount').textContent = count;
    } catch (e) { /* non-fatal */ }

    try {
      if (!liveStream) {
        liveStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      }
      scannerVideo.srcObject = liveStream;
      scannerVideo.play().catch(e => console.warn('Video play error:', e));
      scanStatusText.textContent = 'READY';
      scanStatusSub.textContent = 'Point camera at object';
      scanBtnLabel.textContent = 'SCAN NOW';
      scanBtnIcon.className = 'fas fa-crosshairs';
    } catch (e) {
      scanStatusText.textContent = 'ERROR';
      scanStatusSub.textContent = 'Camera unavailable';
      toast('Camera access denied or unavailable.', 'error');
    }
  }

  function resetScannerStages() {
    SoundFX.stopScan();
    // Show main scanner, hide all result stages
    const sm = document.getElementById('scannerMain');
    if (sm) sm.style.display = 'flex';
    grantedStage.classList.add('hidden');
    deniedStage.classList.add('hidden');
    verifyStage.classList.add('hidden');
    wrongPassStage.classList.add('hidden');
    contentStage.classList.add('hidden');
    
    // Restore live video, hide canvas snapshot and laser
    if (scannerVideo) scannerVideo.classList.remove('hidden');
    if (scannerCanvas) scannerCanvas.classList.add('hidden');
    const laser = document.getElementById('scannerLaser');
    if (laser) laser.style.display = 'none';

    updateScanProgressUI('0%');
    scanStatusText.textContent = 'READY';
    scanStatusSub.textContent = 'Point camera at object';
    scanBtnLabel.textContent = 'SCAN NOW';
    scanBtnIcon.className = 'fas fa-crosshairs';
    currentMatchedObject = null;
    contentSnapToken = null;
  }

  document.getElementById('scannerClose').addEventListener('click', () => {
    SoundFX.stopScan();
    scannerOverlay.classList.add('hidden');
    fullyStopCamera();
  });

  document.getElementById('scanCaptureBtn').addEventListener('click', runScan);
  document.getElementById('retryScanBtn').addEventListener('click', () => { startScannerMode(); });
  document.getElementById('retryPasswordBtn').addEventListener('click', () => { showVerifyStage(currentMatchedObject); });

  async function runScan() {
    if (scanBusy) return;
    scanBusy = true;
    SoundFX.playScan();
    const btn = document.getElementById('scanCaptureBtn');
    btn.disabled = true;
    scanStatusText.textContent = 'SCANNING...';
    scanStatusSub.textContent = 'Please hold steady';
    scanBtnLabel.textContent = 'STOP SCAN';
    scanBtnIcon.className = 'fas fa-stop';

    // Animate progress while AI processes
    let fakeProgress = 0;
    const progressTimer = setInterval(() => {
      fakeProgress = Math.min(fakeProgress + Math.random() * 8 + 2, 92);
      updateScanProgressUI(Math.round(fakeProgress) + '%');
    }, 200);

    scannerCanvas.width = scannerVideo.videoWidth || 640;
    scannerCanvas.height = scannerVideo.videoHeight || 480;
    const ctx = scannerCanvas.getContext('2d');
    ctx.drawImage(scannerVideo, 0, 0, scannerCanvas.width, scannerCanvas.height);

    // Freeze video by hiding it and showing captured canvas frame
    scannerVideo.classList.add('hidden');
    scannerCanvas.classList.remove('hidden');
    
    // Show scanning laser animation
    const laser = document.getElementById('scannerLaser');
    if (laser) laser.style.display = 'block';

    scannerCanvas.toBlob(async (blob) => {
      const form = new FormData();
      form.append('frame', blob, 'frame.jpg');
      try {
        const data = await api('/scan/match', { method: 'POST', form });
        clearInterval(progressTimer);
        const pct = data.confidence || 0;
        updateScanProgressUI(pct + '%');
        if (data.matched) {
          scanStatusText.textContent = 'MATCH FOUND';
          scanStatusSub.textContent = data.object_name;
          updateScanProgressUI(pct + '%');
          currentMatchedObject = { object_id: data.object_id, object_name: data.object_name, confidence: data.confidence };
          setTimeout(() => showGrantedStage(currentMatchedObject), 600);
        } else {
          scanStatusText.textContent = 'NO MATCH';
          scanStatusSub.textContent = 'Object not recognized';
          setTimeout(() => showDeniedStage(), 600);
        }
      } catch (e) {
        clearInterval(progressTimer);
        SoundFX.stopScan();
        toast(e.message, 'error');
        scanStatusText.textContent = 'ERROR';
        scanStatusSub.textContent = 'Scan failed';
        updateScanProgressUI('0%');
      } finally {
        scanBusy = false;
        SoundFX.stopScan();
        btn.disabled = false;
        scanBtnLabel.textContent = 'SCAN NOW';
        scanBtnIcon.className = 'fas fa-crosshairs';
        if (laser) laser.style.display = 'none';
      }
    }, 'image/jpeg', 0.85);
  }

  function showGrantedStage(obj) {
    SoundFX.stopScan();
    SoundFX.playGranted();
    const sm = document.getElementById('scannerMain');
    if (sm) sm.style.display = 'none';
    grantedStage.classList.remove('hidden');
    document.getElementById('grantedObjectName').textContent = obj.object_name;
    document.getElementById('grantedConfidence').textContent = `Similarity: ${obj.confidence}%`;
    setTimeout(() => {
      grantedStage.classList.add('hidden');
      showVerifyStage(obj);
    }, 1800);
  }

  function showDeniedStage() {
    SoundFX.stopScan();
    SoundFX.playDenied();
    const sm = document.getElementById('scannerMain');
    if (sm) sm.style.display = 'none';
    deniedStage.classList.remove('hidden');
  }

  function showVerifyStage(obj) {
    verifyStage.classList.remove('hidden');
    document.getElementById('verifyObjectName').textContent = obj.object_name;
    document.getElementById('verifyError').classList.add('hidden');
    const input = document.getElementById('verifyPasswordInput');
    input.value = '';
    setTimeout(() => input.focus(), 50);
  }

  document.getElementById('verifySubmitBtn').addEventListener('click', submitVerifyPassword);
  document.getElementById('verifyPasswordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitVerifyPassword();
  });

  async function submitVerifyPassword() {
    if (!currentMatchedObject) return;
    const password = document.getElementById('verifyPasswordInput').value;
    const errEl = document.getElementById('verifyError');
    errEl.classList.add('hidden');
    try {
      const data = await api(`/objects/${currentMatchedObject.object_id}/verify-password`, {
        method: 'POST', body: { access_password: password },
      });
      contentSnapToken = data.snap_token;
      verifyStage.classList.add('hidden');
      await showContentStage(currentMatchedObject.object_name);
    } catch (e) {
      verifyStage.classList.add('hidden');
      wrongPassStage.classList.remove('hidden');
    }
  }

  async function showContentStage(objectName) {
    contentStage.classList.remove('hidden');
    document.getElementById('contentObjectName').textContent = objectName;
    const listEl = document.getElementById('contentList');
    listEl.innerHTML = '<div class="content-empty"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';

    try {
      const [pwData, docData] = await Promise.all([
        api('/passwords/list', { method: 'POST', body: { snap_token: contentSnapToken } }),
        api('/documents/list', { method: 'POST', body: { snap_token: contentSnapToken } }),
      ]);
      const items = [];
      pwData.items.forEach(p => items.push({ type: 'password', ...p }));
      docData.items.forEach(d => items.push({ type: 'document', ...d }));

      if (items.length === 0) {
        listEl.innerHTML = '<div class="content-empty">Nothing stored inside this object yet.</div>';
        return;
      }

      listEl.innerHTML = items.map(it => {
        if (it.type === 'password') {
          return `<div class="content-item">
            <div class="ci-title"><span><i class="fas fa-key"></i> ${escapeHtml(it.title)}</span></div>
            <div class="ci-value" id="pw-val-${it.id}">••••••••</div>
            <div class="ci-actions">
              <button data-reveal-pw="${it.id}"><i class="fas fa-eye"></i> Reveal</button>
              <button data-copy-pw="${it.id}"><i class="fas fa-copy"></i> Copy</button>
              <button data-download-pw="${it.id}"><i class="fas fa-download"></i> Download</button>
            </div>
          </div>`;
        }
        return `<div class="content-item">
          <div class="ci-title"><span><i class="fas fa-file"></i> ${escapeHtml(it.name)}</span></div>
          <div class="ci-value">${escapeHtml(it.original_filename)} · ${formatBytes(it.size_bytes)}</div>
          <div class="ci-actions">
            <button data-view-doc="${it.id}"><i class="fas fa-eye"></i> Preview</button>
            <button data-download-doc="${it.id}"><i class="fas fa-download"></i> Download</button>
          </div>
        </div>`;
      }).join('');

      wireContentActions();
    } catch (e) {
      listEl.innerHTML = `<div class="content-empty">${escapeHtml(e.message)}</div>`;
    }
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
  }

  function wireContentActions() {
    document.querySelectorAll('[data-reveal-pw]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-reveal-pw');
        try {
          const data = await api('/passwords/reveal', { method: 'POST', body: { snap_token: contentSnapToken, id: Number(id) } });
          document.getElementById(`pw-val-${id}`).textContent = data.password;
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    document.querySelectorAll('[data-copy-pw]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-copy-pw');
        try {
          const data = await api('/passwords/reveal', { method: 'POST', body: { snap_token: contentSnapToken, id: Number(id) } });
          await navigator.clipboard.writeText(data.password);
          toast('Password copied to clipboard.', 'success');
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    document.querySelectorAll('[data-download-pw]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-download-pw');
        window.location.href = `${API}/passwords/download?snap_token=${encodeURIComponent(contentSnapToken)}&id=${id}`;
      });
    });
    document.querySelectorAll('[data-view-doc]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-view-doc');
        window.open(`${API}/documents/view?snap_token=${encodeURIComponent(contentSnapToken)}&id=${id}`, '_blank');
      });
    });
    document.querySelectorAll('[data-download-doc]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-download-doc');
        window.location.href = `${API}/documents/download?snap_token=${encodeURIComponent(contentSnapToken)}&id=${id}`;
      });
    });
  }

  // ============================================================
  // REGISTERED OBJECTS LIST (on the SnapLock home page)
  // ============================================================
  async function refreshObjectsList() {
    try {
      const data = await api('/objects/list');
      if (!data.items.length) {
        objectsList.innerHTML = '<div class="objects-empty">No objects registered yet. Use <strong>Camera Mode</strong> to secure your first object.</div>';
        return;
      }
      objectsList.innerHTML = data.items.map(o => `
        <div class="object-item">
          <div class="oi-name"><i class="fas fa-cube"></i> ${escapeHtml(o.object_name)}</div>
          <div class="oi-meta">Registered ${new Date(o.created_at * 1000).toLocaleDateString()}</div>
          <div class="oi-actions">
            <button class="oi-btn danger" data-delete-object="${o.id}"><i class="fas fa-trash-alt"></i> Delete</button>
          </div>
        </div>
      `).join('');
      document.querySelectorAll('[data-delete-object]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!(await customConfirm('Delete this object and everything locked inside it? This cannot be undone.'))) return;
          const id = btn.getAttribute('data-delete-object');
          try {
            await api(`/objects/${id}/delete`, { method: 'POST', body: {} });
            toast('Object deleted.', 'success');
            refreshObjectsList();
          } catch (e) { toast(e.message, 'error'); }
        });
      });
    } catch (e) {
      objectsList.innerHTML = `<div class="objects-empty">${escapeHtml(e.message)}</div>`;
    }
  }

  // ---------- INIT ----------
  document.addEventListener('DOMContentLoaded', () => {
    refreshObjectsList();
  });
  if (document.readyState !== 'loading') refreshObjectsList();
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