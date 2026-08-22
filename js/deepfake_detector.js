// ============================================================
// deepfake_detector.js — S.N.E.T.C.H Deepfake Detector
// Handles: mode switching, drag/drop upload, live webcam capture,
// calling the backend, and rendering the verdict + history.
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

  // ---------- home button ----------
  if (el('homeBtn')) {
    el('homeBtn').addEventListener('click', () => { window.location.href = '/'; });
  }

  // ---------- mode switching ----------
  const uploadPanel = el('uploadPanel');
  const videoPanel = el('videoPanel');
  const webcamPanel = el('webcamPanel');
  document.querySelectorAll('.method-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.method-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      const mode = card.dataset.mode;
      uploadPanel.classList.toggle('hidden', mode !== 'upload');
      videoPanel.classList.toggle('hidden', mode !== 'video');
      webcamPanel.classList.toggle('hidden', mode !== 'webcam');
      if (mode !== 'webcam') stopCamera();
      hideResult();
    });
  });

  // ---------- UPLOAD MODE ----------
  const dropzone = el('dropzone');
  const fileInput = el('fileInput');
  const uploadPreviewWrap = el('uploadPreviewWrap');
  const uploadPreview = el('uploadPreview');
  let selectedFile = null;

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFileSelect(fileInput.files[0]);
  });

  function handleFileSelect(file) {
    selectedFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      uploadPreview.src = e.target.result;
      uploadPreviewWrap.classList.remove('hidden');
      dropzone.classList.add('hidden');
    };
    reader.readAsDataURL(file);
    hideResult();
  }

  el('clearUploadBtn').addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    uploadPreviewWrap.classList.add('hidden');
    dropzone.classList.remove('hidden');
    hideResult();
  });

  el('analyzeUploadBtn').addEventListener('click', async () => {
    if (!selectedFile) return;
    setBusy(el('analyzeUploadBtn'), true, 'Analyzing...');
    try {
      const formData = new FormData();
      formData.append('image', selectedFile);
      const res = await fetch('/api/deepfake/analyze', { method: 'POST', body: formData });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Analysis failed.');
      renderResult(data);
      loadHistory();
    } catch (err) {
      alert(err.message || 'Something went wrong analyzing this image.');
    } finally {
      setBusy(el('analyzeUploadBtn'), false, '<i class="fas fa-search"></i> Analyze Image');
    }
  });

  // ---------- VIDEO MODE ----------
  const videoDropzone = el('videoDropzone');
  const videoFileInput = el('videoFileInput');
  const videoPreviewWrap = el('videoPreviewWrap');
  const videoPreview = el('videoPreview');
  let selectedVideoFile = null;

  videoDropzone.addEventListener('click', () => videoFileInput.click());
  videoDropzone.addEventListener('dragover', (e) => { e.preventDefault(); videoDropzone.classList.add('dragover'); });
  videoDropzone.addEventListener('dragleave', () => videoDropzone.classList.remove('dragover'));
  videoDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    videoDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleVideoSelect(e.dataTransfer.files[0]);
  });
  videoFileInput.addEventListener('change', () => {
    if (videoFileInput.files.length) handleVideoSelect(videoFileInput.files[0]);
  });

  function handleVideoSelect(file) {
    selectedVideoFile = file;
    videoPreview.src = URL.createObjectURL(file);
    videoPreviewWrap.classList.remove('hidden');
    videoDropzone.classList.add('hidden');
    hideResult();
  }

  el('clearVideoBtn').addEventListener('click', () => {
    selectedVideoFile = null;
    videoFileInput.value = '';
    videoPreview.removeAttribute('src');
    videoPreviewWrap.classList.add('hidden');
    videoDropzone.classList.remove('hidden');
    el('videoProgressText').classList.add('hidden');
    hideResult();
  });

  el('analyzeVideoBtn').addEventListener('click', async () => {
    if (!selectedVideoFile) return;
    const progressText = el('videoProgressText');
    progressText.textContent = 'Uploading & sampling frames from the video — this can take a moment...';
    progressText.classList.remove('hidden');
    setBusy(el('analyzeVideoBtn'), true, 'Analyzing...');
    try {
      const formData = new FormData();
      formData.append('video', selectedVideoFile);
      const res = await fetch('/api/deepfake/analyze_video', { method: 'POST', body: formData });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Video analysis failed.');
      renderResult(data);
      progressText.textContent = `Analyzed ${data.frames_analyzed} sampled frame(s) from the video.`;
      loadHistory();
    } catch (err) {
      progressText.classList.add('hidden');
      alert(err.message || 'Something went wrong analyzing this video.');
    } finally {
      setBusy(el('analyzeVideoBtn'), false, '<i class="fas fa-search"></i> Analyze Video');
    }
  });

  // ---------- WEBCAM MODE ----------
  const video = el('webcamVideo');
  const camCanvas = el('webcamCanvas');
  let stream = null;

  el('startCamBtn').addEventListener('click', startCamera);
  el('stopCamBtn').addEventListener('click', stopCamera);
  el('captureBtn').addEventListener('click', captureAndAnalyze);

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      video.srcObject = stream;
      el('startCamBtn').classList.add('hidden');
      el('captureBtn').classList.remove('hidden');
      el('stopCamBtn').classList.remove('hidden');
    } catch (err) {
      alert('Could not access camera: ' + err.message);
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    el('startCamBtn').classList.remove('hidden');
    el('captureBtn').classList.add('hidden');
    el('stopCamBtn').classList.add('hidden');
  }

  async function captureAndAnalyze() {
    if (!stream) return;
    camCanvas.width = video.videoWidth;
    camCanvas.height = video.videoHeight;
    const ctx = camCanvas.getContext('2d');
    ctx.drawImage(video, 0, 0, camCanvas.width, camCanvas.height);
    const dataUrl = camCanvas.toDataURL('image/jpeg', 0.9);

    setBusy(el('captureBtn'), true, 'Analyzing...');
    try {
      const res = await fetch('/api/deepfake/analyze_webcam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: dataUrl }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Analysis failed.');
      renderResult(data);
      loadHistory();
    } catch (err) {
      alert(err.message || 'Something went wrong analyzing this frame.');
    } finally {
      setBusy(el('captureBtn'), false, '<i class="fas fa-camera"></i> Capture & Analyze');
    }
  }

  // ---------- RESULT RENDERING ----------
  function renderResult(data) {
    const panel = el('resultPanel');
    panel.classList.remove('hidden');

    const badge = el('verdictBadge');
    badge.className = 'verdict-badge ' + data.verdict;
    const icon = data.verdict === 'real' ? 'fa-check-circle'
      : data.verdict === 'fake' ? 'fa-robot' : 'fa-question-circle';
    const label = data.verdict === 'real' ? 'Looks Real'
      : data.verdict === 'fake' ? 'Likely AI / Manipulated' : 'Uncertain';
    badge.innerHTML = `<i class="fas ${icon}"></i><span>${label} · ${data.confidence.toFixed(1)}% confidence</span>`;

    el('realBar').style.width = data.real_score + '%';
    el('fakeBar').style.width = data.fake_score + '%';
    el('realScoreVal').textContent = data.real_score.toFixed(1) + '%';
    el('fakeScoreVal').textContent = data.fake_score.toFixed(1) + '%';

    const methodLabel = data.method === 'model' ? 'AI model' : 'Local heuristic (ELA + noise analysis)';
    el('methodBadge').innerHTML = `<i class="fas fa-microchip"></i> ${methodLabel}`;
    el('detailsText').textContent = data.details || '';

    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideResult() {
    el('resultPanel').classList.add('hidden');
  }

  // ---------- HISTORY ----------
  async function loadHistory() {
    try {
      const res = await fetch('/api/deepfake/history');
      const data = await res.json();
      const list = el('historyList');
      if (!data.success || !data.history.length) {
        list.innerHTML = '<p class="empty-hint">No scans yet — analyze an image to see it here.</p>';
        return;
      }
      list.innerHTML = data.history.map((h) => `
        <div class="history-item" data-id="${h.id}">
          <div class="h-left">
            <span class="h-verdict ${h.verdict}">${h.verdict}</span>
            <span class="h-meta">${h.source} · ${h.confidence.toFixed(1)}% · ${h.method} · ${new Date(h.created_at).toLocaleString()}</span>
          </div>
          <button class="h-del" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      `).join('');

      list.querySelectorAll('.h-del').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const item = e.target.closest('.history-item');
          const id = item.dataset.id;
          const res = await fetch('/api/deepfake/history/' + id, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) item.remove();
        });
      });
    } catch (err) {
      console.warn('[SNETCH] deepfake history load failed:', err);
    }
  }

  el('refreshHistoryBtn').addEventListener('click', loadHistory);

  function setBusy(btn, busy, html) {
    btn.disabled = busy;
    btn.innerHTML = html;
  }

  // initial load
  loadHistory();
})();