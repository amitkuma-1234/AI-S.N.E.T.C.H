// ============================================================
// downloadvideo.js
// S.N.E.T.C.H · YouTube Video Downloader
// Link / Name / Voice input → resolve → download → progress → reset
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

  const API = '/api/downloadvideo';

  // ----- DOM refs -----
  const homeBtn = document.getElementById('homeBtn');
  const methodCards = document.querySelectorAll('.method-card');
  const mainInput = document.getElementById('mainInput');
  const micBtn = document.getElementById('micBtn');
  const voiceHint = document.getElementById('voiceHint');
  const downloadBtn = document.getElementById('downloadBtn');

  const heroScreen = document.getElementById('heroScreen');
  const progressScreen = document.getElementById('progressScreen');
  const completeScreen = document.getElementById('completeScreen');

  const progThumb = document.getElementById('progThumb');
  const progTitle = document.getElementById('progTitle');
  const progChannel = document.getElementById('progChannel');
  const progDuration = document.getElementById('progDuration');
  const progStatus = document.getElementById('progStatus');
  const progBarFill = document.getElementById('progBarFill');
  const progPercent = document.getElementById('progPercent');
  const statSpeed = document.getElementById('statSpeed');
  const statDownloaded = document.getElementById('statDownloaded');
  const statTotal = document.getElementById('statTotal');
  const statEta = document.getElementById('statEta');
  const cancelBtn = document.getElementById('cancelBtn');

  const doneThumb = document.getElementById('doneThumb');
  const doneTitle = document.getElementById('doneTitle');
  const doneLocation = document.getElementById('doneLocation');
  const resetCountdown = document.getElementById('resetCountdown');

  const errorToast = document.getElementById('errorToast');
  const errorMessage = document.getElementById('errorMessage');
  const errorCloseBtn = document.getElementById('errorCloseBtn');

  let currentMethod = 'link';
  let activeJobId = null;
  let pollTimer = null;
  let recognition = null;

  // ------------------------------------------------------------
  // HOME
  // ------------------------------------------------------------
  homeBtn.addEventListener('click', () => {
    window.location.href = '/';
  });

  // ------------------------------------------------------------
  // METHOD TABS
  // ------------------------------------------------------------
  methodCards.forEach(card => {
    card.addEventListener('click', () => setActiveMethod(card.dataset.method));
  });

  function setActiveMethod(method) {
    currentMethod = method;
    methodCards.forEach(c => c.classList.toggle('active', c.dataset.method === method));

    if (method === 'link') {
      mainInput.placeholder = 'Paste YouTube URL...';
    } else if (method === 'name') {
      mainInput.placeholder = 'Type the video name, e.g. Alan Walker Faded';
    } else {
      mainInput.placeholder = 'Tap the mic and speak the video name...';
    }

    if (method === 'voice') {
      startVoiceSearch();
    }
  }

  // ------------------------------------------------------------
  // VOICE SEARCH (Web Speech API)
  // ------------------------------------------------------------
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function startVoiceSearch() {
    if (!SpeechRecognition) {
      showError('Voice search is not supported in this browser. Try Chrome or Edge.');
      return;
    }

    if (recognition) {
      try { recognition.stop(); } catch (e) { /* noop */ }
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    micBtn.classList.add('recording');
    voiceHint.classList.remove('hidden');

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      mainInput.value = transcript;
    };

    recognition.onerror = () => {
      stopVoiceSearch();
      showError('Couldn\'t hear you clearly. Please try again.');
    };

    recognition.onend = () => {
      stopVoiceSearch();
    };

    recognition.start();
  }

  function stopVoiceSearch() {
    micBtn.classList.remove('recording');
    voiceHint.classList.add('hidden');
  }

  micBtn.addEventListener('click', () => {
    setActiveMethod('voice');
    startVoiceSearch();
  });

  // ------------------------------------------------------------
  // ENTER KEY TRIGGERS DOWNLOAD
  // ------------------------------------------------------------
  mainInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      downloadBtn.click();
    }
  });

  // ------------------------------------------------------------
  // DOWNLOAD FLOW
  // ------------------------------------------------------------
  downloadBtn.addEventListener('click', async () => {
    const query = mainInput.value.trim();

    if (!query) {
      shakeInput();
      showError('Please paste a YouTube link, type a video name, or use voice search.');
      return;
    }

    setDownloadBtnLoading(true, 'Searching…');

    try {
      const resolveRes = await fetch(`${API}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });

      const contentType = resolveRes.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error('Server returned an unexpected response. Please restart the server and try again.');
      }
      const resolveData = await resolveRes.json();

      if (!resolveData.ok) {
        throw new Error(resolveData.error || 'Video not found.');
      }

      showProgressScreen(resolveData);
      setDownloadBtnLoading(false);

      const startRes = await fetch(`${API}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_url: resolveData.video_url,
          title: resolveData.title,
          channel: resolveData.channel,
          duration: resolveData.duration,
          thumbnail: resolveData.thumbnail,
          browser: resolveData.browser,
        }),
      });

      const startCt = startRes.headers.get('content-type') || '';
      if (!startCt.includes('application/json')) {
        throw new Error('Server returned an unexpected response. Please restart the server and try again.');
      }
      const startData = await startRes.json();

      if (!startData.ok) {
        throw new Error(startData.error || 'Could not start the download.');
      }

      activeJobId = startData.job_id;
      pollProgress();

    } catch (err) {
      setDownloadBtnLoading(false);
      goToHero();
      showError(err.message || 'Something went wrong. Please try again.');
    }
  });

  cancelBtn.addEventListener('click', async () => {
    if (!activeJobId) return;
    try {
      await fetch(`${API}/cancel/${activeJobId}`, { method: 'POST' });
    } catch (e) { /* noop */ }
    stopPolling();
    goToHero();
  });

  // ------------------------------------------------------------
  // PROGRESS SCREEN
  // ------------------------------------------------------------
  function showProgressScreen(meta) {
    heroScreen.classList.add('hidden');
    completeScreen.classList.add('hidden');
    progressScreen.classList.remove('hidden');

    progThumb.src = meta.thumbnail || '';
    progTitle.textContent = meta.title || 'Preparing download…';
    progChannel.innerHTML = `<i class="fas fa-user-circle"></i> ${escapeHtml(meta.channel || '—')}`;
    progDuration.innerHTML = `<i class="fas fa-clock"></i> ${escapeHtml(meta.duration || '—')}`;
    progStatus.textContent = 'Starting…';

    progBarFill.style.width = '0%';
    progPercent.textContent = '0%';
    statSpeed.textContent = '—';
    statDownloaded.textContent = '—';
    statTotal.textContent = '—';
    statEta.textContent = '—';
  }

  function pollProgress() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (!activeJobId) return;

      try {
        const res = await fetch(`${API}/progress/${activeJobId}`);
        const data = await res.json();

        if (!data.ok) {
          throw new Error(data.error || 'Lost connection to the download job.');
        }

        updateProgressUI(data);

        if (data.status === 'finished') {
          stopPolling();
          showCompleteScreen(data);
        } else if (data.status === 'error') {
          stopPolling();
          goToHero();
          showError(data.error || 'Download failed. Please try again.');
        } else if (data.status === 'cancelled') {
          stopPolling();
          goToHero();
        }
      } catch (err) {
        stopPolling();
        goToHero();
        showError(err.message || 'Lost connection to the download job.');
      }
    }, 800);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function updateProgressUI(data) {
    const percent = Math.max(0, Math.min(100, data.percent || 0));
    progBarFill.style.width = `${percent}%`;
    progPercent.textContent = `${percent.toFixed(1)}%`;

    statSpeed.textContent = data.speed || '—';
    statDownloaded.textContent = data.downloaded || '—';
    statTotal.textContent = data.total || '—';
    statEta.textContent = data.eta || '—';

    if (data.title) progTitle.textContent = data.title;
    if (data.thumbnail) progThumb.src = data.thumbnail;

    const statusLabels = {
      queued: 'Queued…',
      downloading: 'Downloading…',
      processing: 'Processing…',
      finished: 'Completed',
    };
    progStatus.textContent = statusLabels[data.status] || data.status;
  }

  // ------------------------------------------------------------
  // COMPLETE SCREEN + AUTO RESET
  // ------------------------------------------------------------
  function showCompleteScreen(data) {
    progressScreen.classList.add('hidden');
    completeScreen.classList.remove('hidden');

    doneThumb.src = data.thumbnail || '';
    doneTitle.textContent = data.title || 'Video downloaded';
    doneLocation.textContent = data.downloads_folder || 'Downloads';

    let seconds = 3;
    resetCountdown.textContent = seconds;
    const countdown = setInterval(() => {
      seconds -= 1;
      resetCountdown.textContent = Math.max(seconds, 0);
      if (seconds <= 0) {
        clearInterval(countdown);
        resetToHome();
      }
    }, 1000);
  }

  function resetToHome() {
    activeJobId = null;
    mainInput.value = '';
    setActiveMethod('link');
    goToHero();
  }

  function goToHero() {
    progressScreen.classList.add('hidden');
    completeScreen.classList.add('hidden');
    heroScreen.classList.remove('hidden');
  }

  // ------------------------------------------------------------
  // UI HELPERS
  // ------------------------------------------------------------
  function setDownloadBtnLoading(loading, label) {
    downloadBtn.disabled = loading;
    downloadBtn.innerHTML = loading
      ? `<i class="fas fa-spinner fa-spin"></i> <span>${label}</span>`
      : `<i class="fas fa-cloud-download-alt"></i> <span>Download Video</span>`;
  }

  function shakeInput() {
    mainInput.style.borderColor = '#f87171';
    mainInput.parentElement.style.boxShadow = '0 0 24px rgba(248, 113, 113, 0.3)';
    setTimeout(() => {
      mainInput.style.borderColor = '';
      mainInput.parentElement.style.boxShadow = '';
    }, 700);
  }

  let errorTimer = null;
  function showError(msg) {
    errorMessage.textContent = msg;
    errorToast.classList.remove('hidden');
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => errorToast.classList.add('hidden'), 5000);
  }
  errorCloseBtn.addEventListener('click', () => errorToast.classList.add('hidden'));

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ------------------------------------------------------------
  // SPACE BACKGROUND (Canvas) — stars, nebula, shooting stars, particles
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
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.8 + 0.5,
        a: Math.random() * 0.8 + 0.2,
      });
    }

    let shootingStars = [];
    function spawnShootingStar() {
      if (Math.random() < 0.005) {
        shootingStars.push({
          x: Math.random() * W * 0.6 + W * 0.1,
          y: Math.random() * H * 0.3,
          len: Math.random() * 100 + 60,
          speed: Math.random() * 6 + 4,
          angle: Math.PI / 4 + (Math.random() - 0.5) * 0.3,
          life: 1,
        });
      }
    }

    const particles = [];
    for (let i = 0; i < 40; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 3 + 1.5,
        dx: (Math.random() - 0.5) * 0.3,
        dy: (Math.random() - 0.5) * 0.3,
        a: Math.random() * 0.4 + 0.1,
      });
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);

      const grad = ctx.createRadialGradient(W * 0.3, H * 0.2, 100, W * 0.5, H * 0.5, W * 0.8);
      grad.addColorStop(0, '#1c103f');
      grad.addColorStop(0.4, '#130b2a');
      grad.addColorStop(0.8, '#07050f');
      grad.addColorStop(1, '#020103');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      const nebGrad = ctx.createRadialGradient(W * 0.7, H * 0.3, 10, W * 0.6, H * 0.2, W * 0.5);
      nebGrad.addColorStop(0, 'rgba(120, 40, 200, 0.08)');
      nebGrad.addColorStop(0.5, 'rgba(60, 20, 140, 0.06)');
      nebGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = nebGrad;
      ctx.fillRect(0, 0, W, H);

      const nebGrad2 = ctx.createRadialGradient(W * 0.2, H * 0.7, 10, W * 0.1, H * 0.6, W * 0.4);
      nebGrad2.addColorStop(0, 'rgba(30, 60, 200, 0.06)');
      nebGrad2.addColorStop(0.6, 'rgba(20, 40, 160, 0.04)');
      nebGrad2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = nebGrad2;
      ctx.fillRect(0, 0, W, H);

      stars.forEach(s => {
        s.a += (Math.random() - 0.5) * 0.02;
        s.a = Math.min(1, Math.max(0.1, s.a));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 240, 255, ${s.a})`;
        ctx.fill();
      });

      particles.forEach(p => {
        p.x += p.dx;
        p.y += p.dy;
        if (p.x < 0 || p.x > W) p.dx *= -1;
        if (p.y < 0 || p.y > H) p.dy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(180, 140, 255, ${p.a})`;
        ctx.fill();
      });

      spawnShootingStar();
      shootingStars = shootingStars.filter(ss => ss.life > 0);
      shootingStars.forEach(ss => {
        ss.x += Math.cos(ss.angle) * ss.speed;
        ss.y += Math.sin(ss.angle) * ss.speed;
        ss.life -= 0.01;
        ctx.beginPath();
        ctx.moveTo(ss.x, ss.y);
        ctx.lineTo(ss.x - Math.cos(ss.angle) * ss.len, ss.y - Math.sin(ss.angle) * ss.len);
        ctx.strokeStyle = `rgba(255, 220, 255, ${ss.life * 0.7})`;
        ctx.lineWidth = 1.8;
        ctx.shadowColor = '#b78aff';
        ctx.shadowBlur = 20;
        ctx.stroke();
        ctx.shadowBlur = 0;
      });

      requestAnimationFrame(draw);
    }
    draw();
  }

  // ------------------------------------------------------------
  // INIT
  // ------------------------------------------------------------
  function init() {
    setActiveMethod('link');
    initSpace();
    console.log('S.N.E.T.C.H Video Downloader ready');
  }

  init();

});
