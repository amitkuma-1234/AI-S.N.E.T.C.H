// ============================================================
// barcode_qr_scanner.js — S.N.E.T.C.H Barcode & QR Scanner
// Handles: mode switching, live camera auto-scan loop, drag/drop
// upload, calling the backend, and rendering simple result cards.
// ============================================================
(function () {
  'use strict';

  const el = (id) => document.getElementById(id);

  // ---------- space background (shared visual style) ----------
  (function spaceBg() {
    const canvas = el('spaceCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W, H, stars = [];
    function resize() {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
      stars = Array.from({ length: 140 }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        r: Math.random() * 1.4 + 0.2, s: Math.random() * 0.5 + 0.1,
      }));
    }
    function draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#c9a8ff';
      stars.forEach((st) => {
        ctx.globalAlpha = 0.4 + Math.sin(Date.now() * 0.001 * st.s) * 0.4;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      requestAnimationFrame(draw);
    }
    window.addEventListener('resize', resize);
    resize();
    draw();
  })();

  if (el('homeBtn')) {
    el('homeBtn').addEventListener('click', () => { window.location.href = '/'; });
  }

  // ---------- API endpoints ----------
  const API_SCAN_UPLOAD = '/api/barcode_qr/scan';
  const API_SCAN_WEBCAM = '/api/barcode_qr/scan_webcam';

  // ---------- panels ----------
  const panels = {
    camera: el('cameraPanel'),
    upload: el('uploadPanel'),
  };
  const loadingPanel = el('loadingPanel');
  const resultsPanel = el('resultsPanel');
  const emptyPanel = el('emptyPanel');
  const emptyMessage = el('emptyMessage');

  function showOnly(panelKey) {
    Object.keys(panels).forEach((k) => panels[k].classList.toggle('hidden', k !== panelKey));
  }
  function hideStatusPanels() {
    loadingPanel.classList.add('hidden');
    resultsPanel.classList.add('hidden');
    emptyPanel.classList.add('hidden');
    resultsPanel.innerHTML = '';
  }

  // ---------- mode switching ----------
  const methodCards = document.querySelectorAll('.method-card');
  methodCards.forEach((card) => {
    card.addEventListener('click', () => {
      methodCards.forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      const mode = card.dataset.mode;
      showOnly(mode);
      hideStatusPanels();
      if (mode !== 'camera') stopCamera();
    });
  });

  // ============================================================
  // LIVE CAMERA MODE
  // ============================================================
  const cameraVideo = el('cameraVideo');
  const captureCanvas = el('captureCanvas');
  const scanBox = el('scanBox');
  const cameraHint = el('cameraHint');
  const startCameraBtn = el('startCameraBtn');
  const stopCameraBtn = el('stopCameraBtn');
  const switchCameraBtn = el('switchCameraBtn');

  let cameraStream = null;
  let scanLoopTimer = null;
  let scanInFlight = false;
  let currentFacingMode = 'environment'; // back camera by default (better for scanning)
  let foundThisSession = false;

  async function startCamera() {
    hideStatusPanels();
    foundThisSession = false;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: currentFacingMode },
        audio: false,
      });
    } catch (err) {
      cameraHint.textContent = 'Could not access camera. Check browser permissions.';
      return;
    }
    cameraVideo.srcObject = cameraStream;
    startCameraBtn.classList.add('hidden');
    stopCameraBtn.classList.remove('hidden');
    switchCameraBtn.classList.remove('hidden');
    cameraHint.textContent = 'Point the camera at a barcode or QR code';
    scanBox.classList.add('hidden');
    beginScanLoop();
  }

  function stopCamera() {
    clearTimeout(scanLoopTimer);
    scanLoopTimer = null;
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    cameraVideo.srcObject = null;
    startCameraBtn.classList.remove('hidden');
    stopCameraBtn.classList.add('hidden');
    switchCameraBtn.classList.add('hidden');
    scanBox.classList.add('hidden');
  }

  async function switchCamera() {
    currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
    stopCamera();
    await startCamera();
  }

  function beginScanLoop() {
    // Grabs a frame roughly every 700ms and sends it to the backend.
    // Stops automatically the moment something is found.
    const tick = async () => {
      if (!cameraStream || foundThisSession) return;
      if (!scanInFlight && cameraVideo.videoWidth > 0) {
        scanInFlight = true;
        try {
          const dataUrl = grabFrame();
          const res = await fetch(API_SCAN_WEBCAM, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_base64: dataUrl }),
          });
          const json = await res.json();
          if (json.success && json.results && json.results.length > 0) {
            foundThisSession = true;
            scanBox.classList.remove('hidden');
            cameraHint.textContent = 'Code found!';
            renderResults(json.results);
            // Give the user a beat to see the green box before we
            // freeze on the result (camera keeps running underneath).
          }
        } catch (err) {
          // Silent — just retries on the next tick. A single dropped
          // frame shouldn't interrupt live scanning with an error toast.
        }
        scanInFlight = false;
      }
      if (!foundThisSession) {
        scanLoopTimer = setTimeout(tick, 700);
      }
    };
    scanLoopTimer = setTimeout(tick, 500);
  }

  function grabFrame() {
    const w = cameraVideo.videoWidth;
    const h = cameraVideo.videoHeight;
    captureCanvas.width = w;
    captureCanvas.height = h;
    const ctx = captureCanvas.getContext('2d');
    ctx.drawImage(cameraVideo, 0, 0, w, h);
    return captureCanvas.toDataURL('image/jpeg', 0.85);
  }

  startCameraBtn.addEventListener('click', startCamera);
  stopCameraBtn.addEventListener('click', () => {
    stopCamera();
    hideStatusPanels();
  });
  switchCameraBtn.addEventListener('click', switchCamera);

  // "Scan again" (added dynamically after a successful camera scan)
  function resumeCameraScanning() {
    foundThisSession = false;
    hideStatusPanels();
    scanBox.classList.add('hidden');
    cameraHint.textContent = 'Point the camera at a barcode or QR code';
    if (cameraStream) beginScanLoop();
  }

  // ============================================================
  // UPLOAD MODE
  // ============================================================
  const dropzone = el('dropzone');
  const fileInput = el('fileInput');
  const uploadPreviewWrap = el('uploadPreviewWrap');
  const uploadPreview = el('uploadPreview');
  const analyzeUploadBtn = el('analyzeUploadBtn');
  const clearUploadBtn = el('clearUploadBtn');

  let selectedFile = null;

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFileSelect(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFileSelect(fileInput.files[0]);
  });

  function handleFileSelect(file) {
    selectedFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      uploadPreview.src = e.target.result;
      dropzone.classList.add('hidden');
      uploadPreviewWrap.classList.remove('hidden');
      hideStatusPanels();
    };
    reader.readAsDataURL(file);
  }

  clearUploadBtn.addEventListener('click', resetUpload);

  function resetUpload() {
    selectedFile = null;
    fileInput.value = '';
    uploadPreviewWrap.classList.add('hidden');
    dropzone.classList.remove('hidden');
    hideStatusPanels();
  }

  analyzeUploadBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    hideStatusPanels();
    loadingPanel.classList.remove('hidden');

    const formData = new FormData();
    formData.append('image', selectedFile);

    try {
      const res = await fetch(API_SCAN_UPLOAD, { method: 'POST', body: formData });
      const json = await res.json();
      loadingPanel.classList.add('hidden');

      if (!json.success) {
        showEmpty(json.message || 'Something went wrong while scanning this image.');
        return;
      }
      if (!json.results || json.results.length === 0) {
        showEmpty('No barcode or QR code found in this image. Try a clearer or closer photo.');
        return;
      }
      renderResults(json.results);
    } catch (err) {
      loadingPanel.classList.add('hidden');
      showEmpty('Could not reach the server. Please try again.');
    }
  });

  function showEmpty(message) {
    hideStatusPanels();
    emptyMessage.textContent = message;
    emptyPanel.classList.remove('hidden');
  }

  // ============================================================
  // RESULT RENDERING (shared by both camera + upload modes)
  // ============================================================
  const resultTemplate = el('resultCardTemplate');

  const CATEGORY_ICONS = {
    'URL / Link': 'fa-link',
    'WiFi Network': 'fa-wifi',
    'UPI Payment': 'fa-indian-rupee-sign',
    'Contact (vCard)': 'fa-address-card',
    'Email Address': 'fa-envelope',
    'Phone Number': 'fa-phone',
    'SMS': 'fa-comment-sms',
    'Location (GPS)': 'fa-location-dot',
    'Product Barcode': 'fa-barcode',
    'Plain Text': 'fa-align-left',
  };

  function renderResults(results) {
    hideStatusPanels();
    resultsPanel.innerHTML = '';

    if (results.length > 1) {
      const countLine = document.createElement('div');
      countLine.className = 'results-count';
      countLine.textContent = `Found ${results.length} codes`;
      resultsPanel.appendChild(countLine);
    }

    results.forEach((r) => resultsPanel.appendChild(buildResultCard(r)));

    // If this came from a live camera scan, add a "Scan Again" button.
    if (!panels.camera.classList.contains('hidden')) {
      const again = document.createElement('button');
      again.className = 'primary-btn';
      again.style.alignSelf = 'center';
      again.innerHTML = '<i class="fas fa-rotate-right"></i> Scan Another Code';
      again.addEventListener('click', resumeCameraScanning);
      resultsPanel.appendChild(again);
    }

    resultsPanel.classList.remove('hidden');
  }

  function buildResultCard(result) {
    const node = resultTemplate.content.cloneNode(true);
    const iconEl = node.querySelector('.result-icon i');
    const categoryEl = node.querySelector('.result-category');
    const summaryEl = node.querySelector('.result-summary');
    const actionsEl = node.querySelector('.result-actions');
    const rawTextEl = node.querySelector('.result-raw-text');
    const copyBtn = node.querySelector('.copy-btn');

    iconEl.className = `fas ${CATEGORY_ICONS[result.category] || 'fa-qrcode'}`;
    categoryEl.textContent = result.category;
    summaryEl.textContent = result.summary;
    rawTextEl.textContent = result.data;

    buildActionButtons(result).forEach((btn) => actionsEl.appendChild(btn));

    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(result.data).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<i class="fas fa-check"></i> Copied';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = '<i class="fas fa-copy"></i> Copy';
        }, 1500);
      });
    });

    return node;
  }

  function makeActionLink(label, icon, href) {
    const a = document.createElement('a');
    a.className = 'secondary-btn';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.innerHTML = `<i class="fas ${icon}"></i> ${label}`;
    return a;
  }
  function makeActionButton(label, icon, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'secondary-btn';
    b.innerHTML = `<i class="fas ${icon}"></i> ${label}`;
    b.addEventListener('click', onClick);
    return b;
  }

  function buildActionButtons(result) {
    const buttons = [];
    const extra = result.extra || {};

    switch (result.category) {
      case 'URL / Link':
        buttons.push(makeActionLink('Open Link', 'fa-arrow-up-right-from-square', result.data));
        break;

      case 'WiFi Network':
        if (extra.password) {
          buttons.push(makeActionButton('Copy Password', 'fa-key', () => {
            navigator.clipboard.writeText(extra.password);
          }));
        }
        break;

      case 'UPI Payment':
        buttons.push(makeActionLink('Open in Payment App', 'fa-mobile-screen-button', result.data));
        if (extra.upi_id) {
          buttons.push(makeActionButton('Copy UPI ID', 'fa-copy', () => {
            navigator.clipboard.writeText(extra.upi_id);
          }));
        }
        break;

      case 'Contact (vCard)':
        if (extra.phone) buttons.push(makeActionLink('Call', 'fa-phone', `tel:${extra.phone}`));
        if (extra.email) buttons.push(makeActionLink('Email', 'fa-envelope', `mailto:${extra.email}`));
        break;

      case 'Email Address':
        buttons.push(makeActionLink('Send Email', 'fa-envelope', `mailto:${extra.email || result.data.replace('mailto:', '')}`));
        break;

      case 'Phone Number':
        buttons.push(makeActionLink('Call Number', 'fa-phone', `tel:${extra.phone || result.data.replace('tel:', '')}`));
        break;

      case 'Location (GPS)':
        if (extra.latitude && extra.longitude) {
          buttons.push(makeActionLink('Open in Maps', 'fa-map', `https://maps.google.com/?q=${extra.latitude},${extra.longitude}`));
        }
        break;

      default:
        break;
    }

    return buttons;
  }
})();