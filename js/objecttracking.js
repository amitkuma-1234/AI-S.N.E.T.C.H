// ============================================================
// objecttracking.js
// S.N.E.T.C.H · Object Tracking (YOLOv11s)
// Image detect / Video track+speed+count / Live camera feed
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

  const API = '/api/objecttracking';

  // ----- shared -----
  const homeBtn = document.getElementById('homeBtn');
  const methodCards = document.querySelectorAll('.method-card');
  const panels = {
    image: document.getElementById('panel-image'),
    video: document.getElementById('panel-video'),
    webcam: document.getElementById('panel-webcam'),
  };

  const confSlider = document.getElementById('confSlider');
  const confVal = document.getElementById('confVal');
  const ppmSlider = document.getElementById('ppmSlider');
  const ppmVal = document.getElementById('ppmVal');

  const errorToast = document.getElementById('errorToast');
  const errorMessage = document.getElementById('errorMessage');
  const errorCloseBtn = document.getElementById('errorCloseBtn');

  let currentMode = 'image';

  function showError(msg) {
    errorMessage.textContent = msg || 'Something went wrong.';
    errorToast.classList.remove('hidden');
  }
  errorCloseBtn.addEventListener('click', () => errorToast.classList.add('hidden'));

  if (homeBtn) homeBtn.addEventListener('click', () => { window.location.href = '/'; });

  confSlider.addEventListener('input', () => { confVal.textContent = parseFloat(confSlider.value).toFixed(2); });
  ppmSlider.addEventListener('input', () => { ppmVal.textContent = ppmSlider.value; });

  function getConf() { return parseFloat(confSlider.value); }
  function getPPM() { return parseFloat(ppmSlider.value); }

  // ------------------------------------------------------------
  // MODE SWITCHING
  // ------------------------------------------------------------
  function setActiveMode(mode) {
    currentMode = mode;
    methodCards.forEach(c => c.classList.toggle('active', c.dataset.mode === mode));
    Object.entries(panels).forEach(([key, el]) => el.classList.toggle('hidden', key !== mode));

    // Leaving webcam mode should stop the camera / stream.
    if (mode !== 'webcam') stopWebcam();
  }

  methodCards.forEach(card => {
    card.addEventListener('click', () => setActiveMode(card.dataset.mode));
  });

  // ============================================================
  // IMAGE MODE
  // ============================================================
  const imageDropzone = document.getElementById('imageDropzone');
  const imageInput = document.getElementById('imageInput');
  const imagePreviewRow = document.getElementById('imagePreviewRow');
  const imageOriginal = document.getElementById('imageOriginal');
  const imageResultSlot = document.getElementById('imageResultSlot');
  const imageCounts = document.getElementById('imageCounts');
  const imageDetectBtn = document.getElementById('imageDetectBtn');

  let selectedImageFile = null;

  function setupDropzone(zone, input, onFile) {
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); });
    ['dragover', 'dragenter'].forEach(evt =>
      zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.add('drag-over'); })
    );
    ['dragleave', 'drop'].forEach(evt =>
      zone.addEventListener(evt, e => { e.preventDefault(); zone.classList.remove('drag-over'); })
    );
    zone.addEventListener('drop', e => {
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    });
  }

  setupDropzone(imageDropzone, imageInput, (file) => {
    if (!file.type.startsWith('image/')) { showError('Please select a valid image file.'); return; }
    selectedImageFile = file;
    imageOriginal.src = URL.createObjectURL(file);
    imagePreviewRow.classList.remove('hidden');
    imageResultSlot.innerHTML = '<span style="color:#8f80b8;font-size:12.5px;">Click "Detect Objects" →</span>';
    imageCounts.innerHTML = '';
    imageDetectBtn.disabled = false;
  });

  imageDetectBtn.addEventListener('click', async () => {
    if (!selectedImageFile) return;
    imageDetectBtn.disabled = true;
    imageResultSlot.innerHTML = '<div class="spinner"></div>';
    imageCounts.innerHTML = '';

    try {
      const fd = new FormData();
      fd.append('file', selectedImageFile);
      fd.append('conf', getConf());

      const res = await fetch(`${API}/image`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Detection failed.');

      imageResultSlot.innerHTML = `<img src="${data.image_base64}" alt="Detected objects" />`;

      imageCounts.innerHTML = '';
      const totalChip = document.createElement('span');
      totalChip.className = 'count-chip';
      totalChip.innerHTML = `<i class="fas fa-bullseye"></i> Total: <b>${data.total}</b>`;
      imageCounts.appendChild(totalChip);

      Object.entries(data.counts).forEach(([name, count]) => {
        const chip = document.createElement('span');
        chip.className = 'count-chip';
        chip.innerHTML = `${name}: <b>${count}</b>`;
        imageCounts.appendChild(chip);
      });
    } catch (err) {
      showError(err.message);
      imageResultSlot.innerHTML = '<span style="color:#ff9d9d;font-size:12.5px;">Detection failed.</span>';
    } finally {
      imageDetectBtn.disabled = false;
    }
  });

  // ============================================================
  // VIDEO MODE
  // ============================================================
  const videoDropzone = document.getElementById('videoDropzone');
  const videoInput = document.getElementById('videoInput');
  const videoFileChip = document.getElementById('videoFileChip');
  const videoFileName = document.getElementById('videoFileName');
  const videoFileClear = document.getElementById('videoFileClear');
  const videoStartBtn = document.getElementById('videoStartBtn');

  const videoProgressCard = document.getElementById('videoProgressCard');
  const videoStatusPill = document.getElementById('videoStatusPill');
  const videoBarFill = document.getElementById('videoBarFill');
  const videoPercent = document.getElementById('videoPercent');
  const videoFrameStat = document.getElementById('videoFrameStat');
  const videoUniqueStat = document.getElementById('videoUniqueStat');
  const videoCancelBtn = document.getElementById('videoCancelBtn');

  const videoCompleteCard = document.getElementById('videoCompleteCard');
  const videoResultPlayer = document.getElementById('videoResultPlayer');
  const videoDownloadBtn = document.getElementById('videoDownloadBtn');
  const videoResetBtn = document.getElementById('videoResetBtn');

  let selectedVideoFile = null;
  let activeVideoJobId = null;
  let videoPollTimer = null;

  setupDropzone(videoDropzone, videoInput, (file) => {
    if (!file.type.startsWith('video/')) { showError('Please select a valid video file.'); return; }
    selectedVideoFile = file;
    videoFileName.textContent = file.name;
    videoFileChip.classList.remove('hidden');
    videoDropzone.classList.add('hidden');
    videoStartBtn.disabled = false;
  });

  videoFileClear.addEventListener('click', () => {
    selectedVideoFile = null;
    videoInput.value = '';
    videoFileChip.classList.add('hidden');
    videoDropzone.classList.remove('hidden');
    videoStartBtn.disabled = true;
  });

  function resetVideoUI() {
    selectedVideoFile = null;
    activeVideoJobId = null;
    if (videoPollTimer) clearInterval(videoPollTimer);
    videoInput.value = '';
    videoFileChip.classList.add('hidden');
    videoDropzone.classList.remove('hidden');
    videoStartBtn.disabled = true;
    videoProgressCard.classList.add('hidden');
    videoCompleteCard.classList.add('hidden');
    videoBarFill.style.width = '0%';
    videoPercent.textContent = '0%';
  }

  videoStartBtn.addEventListener('click', async () => {
    if (!selectedVideoFile) return;
    videoStartBtn.disabled = true;
    videoDropzone.classList.add('hidden');
    videoFileChip.classList.add('hidden');
    videoProgressCard.classList.remove('hidden');
    videoStatusPill.textContent = 'Queued…';

    try {
      const fd = new FormData();
      fd.append('file', selectedVideoFile);
      fd.append('conf', getConf());
      fd.append('ppm', getPPM());

      const res = await fetch(`${API}/video/start`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Could not start tracking.');

      activeVideoJobId = data.job_id;
      videoPollTimer = setInterval(pollVideoProgress, 1000);
      pollVideoProgress();
    } catch (err) {
      showError(err.message);
      resetVideoUI();
    }
  });

  async function pollVideoProgress() {
    if (!activeVideoJobId) return;
    try {
      const res = await fetch(`${API}/video/progress/${activeVideoJobId}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Lost track of this job.');

      videoStatusPill.textContent =
        data.status === 'queued' ? 'Queued…' :
        data.status === 'processing' ? 'Tracking in progress…' :
        data.status === 'finished' ? 'Finished' :
        data.status === 'cancelled' ? 'Cancelled' :
        data.status === 'error' ? 'Error' : data.status;

      videoBarFill.style.width = `${data.percent || 0}%`;
      videoPercent.textContent = `${data.percent || 0}%`;
      videoFrameStat.textContent = `${data.frame_count || 0} / ${data.total_frames || 0}`;
      videoUniqueStat.textContent = data.unique_count || 0;

      if (data.status === 'finished') {
        clearInterval(videoPollTimer);
        videoProgressCard.classList.add('hidden');
        videoCompleteCard.classList.remove('hidden');
        const url = `${API}/video/download/${activeVideoJobId}`;
        videoResultPlayer.src = url;
        videoDownloadBtn.href = url;
      } else if (data.status === 'cancelled') {
        clearInterval(videoPollTimer);
        showError('Video tracking cancelled.');
        resetVideoUI();
      } else if (data.status === 'error') {
        clearInterval(videoPollTimer);
        showError(data.error || 'Video processing failed.');
        resetVideoUI();
      }
    } catch (err) {
      clearInterval(videoPollTimer);
      showError(err.message);
      resetVideoUI();
    }
  }

  videoCancelBtn.addEventListener('click', async () => {
    if (!activeVideoJobId) return;
    try { await fetch(`${API}/video/cancel/${activeVideoJobId}`, { method: 'POST' }); } catch (_) {}
  });

  videoResetBtn.addEventListener('click', resetVideoUI);

  // ============================================================
  // WEBCAM MODE
  // ============================================================
  const webcamStream = document.getElementById('webcamStream');
  const webcamPlaceholder = document.getElementById('webcamPlaceholder');
  const liveBadge = document.getElementById('liveBadge');
  const webcamUniqueStat = document.getElementById('webcamUniqueStat');
  const webcamFrameStat = document.getElementById('webcamFrameStat');
  const webcamStartBtn = document.getElementById('webcamStartBtn');
  const webcamStopBtn = document.getElementById('webcamStopBtn');

  let webcamActive = false;
  let localStream = null;
  let _abortCtrl = null;

  const MAX_SEND_DIM = 640; // match YOLOv11s input size

  async function startWebcam() {
    if (webcamActive) return;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch (err) {
      showError('Camera access denied or unavailable.');
      return;
    }

    const localVideo = document.getElementById('localVideo');
    localVideo.srcObject = localStream;

    try {
      await fetch(`${API}/webcam/start`, { method: 'POST' });
    } catch (err) {
      showError('Could not start tracking on server.');
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      localVideo.srcObject = null;
      return;
    }

    webcamActive = true;
    document.getElementById('fullscreenCamContainer').classList.remove('hide-cam');

    // Start the sequential frame loop.
    sendNextFrame();
  }

  function stopWebcam() {
    if (!webcamActive) return;
    webcamActive = false;

    // Abort any in-flight request immediately.
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    const localVideo = document.getElementById('localVideo');
    localVideo.srcObject = null;
    document.getElementById('fullscreenCamContainer').classList.add('hide-cam');

    // Clear overlay canvas.
    const oc = document.getElementById('overlayCanvas');
    const octx = oc.getContext('2d');
    octx.clearRect(0, 0, oc.width, oc.height);

    fetch(`${API}/webcam/stop`, { method: 'POST' }).catch(() => {});
  }

  // ---- Sequential frame loop: capture → downscale → send → draw → repeat ----
  function sendNextFrame() {
    if (!webcamActive) return;

    const video = document.getElementById('localVideo');
    if (video.readyState < 2 || video.videoWidth === 0) {
      // Video not ready yet — retry shortly.
      requestAnimationFrame(sendNextFrame);
      return;
    }

    // Downscale to MAX_SEND_DIM while preserving aspect ratio.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(MAX_SEND_DIM / vw, MAX_SEND_DIM / vh, 1);
    const sw = Math.round(vw * scale);
    const sh = Math.round(vh * scale);

    // Recreate canvas every frame to prevent hardware backing-store corruption on mobile browsers
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sw;
    tempCanvas.height = sh;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(video, 0, 0, sw, sh);

    tempCanvas.toBlob(async (blob) => {
      if (!webcamActive) return;
      if (!blob) {
         requestAnimationFrame(sendNextFrame);
         return;
      }

      const fd = new FormData();
      fd.append('frame', blob, 'f.jpg');
      fd.append('conf', getConf());
      fd.append('ppm', getPPM());

      _abortCtrl = new AbortController();

      try {
        const res = await fetch(`${API}/webcam/process_frame`, {
          method: 'POST', body: fd, signal: _abortCtrl.signal,
        });
        const data = await res.json();

        if (data.ok && webcamActive) {
          try {
            drawOverlay(data.d || []);
          } catch (e) {
            console.error("Overlay error:", e);
          }

          const uc = data.uc || 0;
          const fc = data.fc || 0;
          document.getElementById('fsUniqueStat').textContent = uc;
          document.getElementById('fsFrameStat').textContent = fc;
          webcamUniqueStat.textContent = uc;
          webcamFrameStat.textContent = fc;
        } else if (!data.ok) {
          console.error("Tracking API error:", data.error);
        }
      } catch (err) {
        // AbortError is expected on stop — ignore silently.
        if (err.name !== 'AbortError') {
          console.error("Frame processing failed:", err);
        }
      }
      _abortCtrl = null;

      // Schedule the next frame capture only after the current one completes.
      if (webcamActive) requestAnimationFrame(sendNextFrame);
    }, 'image/jpeg', 0.65);
  }

  // ---- Client-side overlay renderer ----
  function drawOverlay(detections) {
    const video = document.getElementById('localVideo');
    const canvas = document.getElementById('overlayCanvas');
    if (!video || !canvas) return;

    // Match canvas internal resolution to the video's rendered size for crisp drawing.
    const rect = video.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Account for object-fit: contain letterboxing.
    const videoRatio = video.videoWidth / video.videoHeight;
    const containerRatio = rect.width / rect.height;
    let drawW, drawH, offsetX, offsetY;
    if (videoRatio > containerRatio) {
      drawW = rect.width;
      drawH = rect.width / videoRatio;
      offsetX = 0;
      offsetY = (rect.height - drawH) / 2;
    } else {
      drawH = rect.height;
      drawW = rect.height * videoRatio;
      offsetX = (rect.width - drawW) / 2;
      offsetY = 0;
    }

    const fontSize = Math.max(12, drawW * 0.018);
    ctx.font = `600 ${fontSize}px Inter, sans-serif`;
    ctx.lineWidth = Math.max(2, drawW * 0.003);

    for (const det of detections) {
      const cx = offsetX + det.cx * drawW;
      const cy = offsetY + det.cy * drawH;
      const bw = det.bw * drawW;
      const bh = det.bh * drawH;
      const x1 = cx - bw / 2;
      const y1 = cy - bh / 2;

      // Box
      ctx.strokeStyle = '#00ff66';
      ctx.strokeRect(x1, y1, bw, bh);

      // Label
      let label = `${det.cls} ID:${det.id} (${Math.round(det.conf * 100)}%)`;
      if (det.spd > 0) label += ` ${det.spd} km/h`;

      const tw = ctx.measureText(label).width;
      const labelH = fontSize + 8;
      const labelY = Math.max(y1 - labelH, 0);

      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(x1, labelY, tw + 10, labelH);

      ctx.fillStyle = '#00ff66';
      ctx.fillText(label, x1 + 5, labelY + fontSize + 1);
    }
  }

  webcamStartBtn.addEventListener('click', startWebcam);
  webcamStopBtn.addEventListener('click', stopWebcam);
  document.getElementById('camCloseBtn').addEventListener('click', stopWebcam);
  window.addEventListener('beforeunload', stopWebcam);

  // ------------------------------------------------------------
  // SPACE BACKGROUND (Canvas) — stars, nebula, shooting stars, particles
  // (same visual language as the rest of S.N.E.T.C.H)
  // ------------------------------------------------------------
  function initSpace() {
    const canvas = document.getElementById('spaceCanvas');
    const ctx = canvas.getContext('2d');
    let W, H;

    function resize() {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    const stars = [];
    const NUM_STARS = 220;
    for (let i = 0; i < NUM_STARS; i++) {
      stars.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.8 + 0.5, a: Math.random() * 0.8 + 0.2 });
    }

    let shootingStars = [];
    function spawnShootingStar() {
      if (Math.random() < 0.005) {
        shootingStars.push({
          x: Math.random() * W * 0.6 + W * 0.1, y: Math.random() * H * 0.3,
          len: Math.random() * 100 + 60, speed: Math.random() * 6 + 4,
          angle: Math.PI / 4 + (Math.random() - 0.5) * 0.3, life: 1,
        });
      }
    }

    const particles = [];
    for (let i = 0; i < 40; i++) {
      particles.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 3 + 1.5, dx: (Math.random() - 0.5) * 0.3, dy: (Math.random() - 0.5) * 0.3, a: Math.random() * 0.4 + 0.1 });
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);

      const grad = ctx.createRadialGradient(W * 0.3, H * 0.2, 100, W * 0.5, H * 0.5, W * 0.8);
      grad.addColorStop(0, '#1c103f'); grad.addColorStop(0.4, '#130b2a');
      grad.addColorStop(0.8, '#07050f'); grad.addColorStop(1, '#020103');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

      const nebGrad = ctx.createRadialGradient(W * 0.7, H * 0.3, 10, W * 0.6, H * 0.2, W * 0.5);
      nebGrad.addColorStop(0, 'rgba(120, 40, 200, 0.08)'); nebGrad.addColorStop(0.5, 'rgba(60, 20, 140, 0.06)'); nebGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = nebGrad; ctx.fillRect(0, 0, W, H);

      const nebGrad2 = ctx.createRadialGradient(W * 0.2, H * 0.7, 10, W * 0.1, H * 0.6, W * 0.4);
      nebGrad2.addColorStop(0, 'rgba(30, 60, 200, 0.06)'); nebGrad2.addColorStop(0.6, 'rgba(20, 40, 160, 0.04)'); nebGrad2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = nebGrad2; ctx.fillRect(0, 0, W, H);

      stars.forEach(s => {
        s.a += (Math.random() - 0.5) * 0.02;
        s.a = Math.min(1, Math.max(0.1, s.a));
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 240, 255, ${s.a})`; ctx.fill();
      });

      particles.forEach(p => {
        p.x += p.dx; p.y += p.dy;
        if (p.x < 0 || p.x > W) p.dx *= -1;
        if (p.y < 0 || p.y > H) p.dy *= -1;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(180, 140, 255, ${p.a})`; ctx.fill();
      });

      spawnShootingStar();
      shootingStars = shootingStars.filter(ss => ss.life > 0);
      shootingStars.forEach(ss => {
        ss.x += Math.cos(ss.angle) * ss.speed;
        ss.y += Math.sin(ss.angle) * ss.speed;
        ss.life -= 0.01;
        ctx.beginPath(); ctx.moveTo(ss.x, ss.y);
        ctx.lineTo(ss.x - Math.cos(ss.angle) * ss.len, ss.y - Math.sin(ss.angle) * ss.len);
        ctx.strokeStyle = `rgba(255, 220, 255, ${ss.life * 0.7})`;
        ctx.lineWidth = 1.8; ctx.shadowColor = '#b78aff'; ctx.shadowBlur = 20;
        ctx.stroke(); ctx.shadowBlur = 0;
      });

      requestAnimationFrame(draw);
    }
    draw();
  }

  // ------------------------------------------------------------
  // INIT
  // ------------------------------------------------------------
  function init() {
    setActiveMode('image');
    initSpace();
    console.log('S.N.E.T.C.H Object Tracking ready');
  }

  init();

});