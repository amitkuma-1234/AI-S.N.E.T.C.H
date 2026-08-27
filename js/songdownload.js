// ============================================================
// songdownload.js
// S.N.E.T.C.H · AI Music Downloader
// Full backend integration · Real-time progress · Auto-reset
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

  // ── DOM refs ──────────────────────────────────────────────
  const songInput       = document.getElementById('songInput');
  const downloadBtn     = document.getElementById('downloadBtn');
  const searchSection   = document.getElementById('searchSection');
  const progressSection = document.getElementById('progressSection');
  const completeSection = document.getElementById('completeSection');
  const errorSection    = document.getElementById('errorSection');
  const searchWrapper   = document.getElementById('searchWrapper');

  // Progress elements
  const songCover       = document.getElementById('songCover');
  const songTitle       = document.getElementById('songTitle');
  const songArtist      = document.getElementById('songArtist');
  const songAlbum       = document.getElementById('songAlbum');
  const songDuration    = document.getElementById('songDuration');
  const progressLabel   = document.getElementById('progressLabel');
  const progressPct     = document.getElementById('progressPct');
  const progressFill    = document.getElementById('progressFill');
  const statSpeed       = document.getElementById('statSpeed');
  const statDownloaded  = document.getElementById('statDownloaded');
  const statTotal       = document.getElementById('statTotal');
  const statEta         = document.getElementById('statEta');
  const statusText      = document.getElementById('statusText');

  // Complete elements
  const completeCover    = document.getElementById('completeCover');
  const completeTitle    = document.getElementById('completeTitle');
  const completeArtist   = document.getElementById('completeArtist');
  const completeLocation = document.getElementById('completeLocation');

  // Error elements
  const errorTitle   = document.getElementById('errorTitle');
  const errorMessage = document.getElementById('errorMessage');
  const retryBtn     = document.getElementById('retryBtn');

  let pollTimer      = null;
  let isDownloading  = false;
  const POLL_INTERVAL = 600; // ms
  const AUTO_RESET_DELAY = 6000; // ms after completion

  // ── UI STATE MANAGEMENT ───────────────────────────────────

  function showSection(sectionId) {
    [searchSection, progressSection, completeSection, errorSection].forEach(s => {
      s.classList.add('hidden');
    });
    const target = document.getElementById(sectionId);
    if (target) target.classList.remove('hidden');
  }

  function resetUI() {
    stopPolling();
    isDownloading = false;

    // Reset input
    songInput.value = '';
    searchWrapper.classList.remove('error-state');

    // Reset button
    downloadBtn.innerHTML = '<i class="fas fa-download"></i> Download';
    downloadBtn.disabled = false;

    // Reset progress
    progressFill.style.width = '0%';
    progressPct.textContent = '0%';
    progressLabel.textContent = 'Downloading...';
    statSpeed.textContent = '—';
    statDownloaded.textContent = '—';
    statTotal.textContent = '—';
    statEta.textContent = '—';
    statusText.textContent = 'Preparing download...';
    songCover.src = '';
    songTitle.textContent = '—';
    songArtist.textContent = '—';
    songAlbum.textContent = '—';
    songDuration.textContent = '—';

    // Show search
    showSection('searchSection');
  }

  // ── DOWNLOAD WORKFLOW ─────────────────────────────────────

  downloadBtn.addEventListener('click', (e) => {
    createRipple(e);

    if (isDownloading) return;

    const query = songInput.value.trim();
    if (!query) {
      searchWrapper.classList.add('error-state');
      setTimeout(() => searchWrapper.classList.remove('error-state'), 800);
      showToast('🎵 Please enter a song name');
      return;
    }

    startDownloadFlow(query);
  });

  // Enter key
  songInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      downloadBtn.click();
    }
  });

  // Retry button
  retryBtn.addEventListener('click', () => {
    resetUI();
  });

  async function startDownloadFlow(query) {
    isDownloading = true;

    // Button loading state
    downloadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Searching...';
    downloadBtn.disabled = true;

    try {
      // ── Step 1: Search for the song ──
      const searchRes = await fetch('/api/songdownload/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });

      const searchData = await searchRes.json();

      if (!searchRes.ok || !searchData.success) {
        throw new Error(searchData.error || 'Song not found. Please try a different name.');
      }

      const song = searchData.data;

      // ── Step 2: Show progress UI with song info ──
      songCover.src = song.cover || '';
      songCover.onerror = () => { songCover.src = ''; songCover.style.display = 'none'; };
      songCover.onload = () => { songCover.style.display = ''; };
      songTitle.textContent = song.title || 'Unknown';
      songArtist.textContent = song.artist || 'Unknown Artist';
      songAlbum.textContent = song.album || 'Single';
      songDuration.textContent = song.duration_formatted || '—';

      showSection('progressSection');
      progressLabel.textContent = 'Starting download...';
      statusText.textContent = 'Connecting to server...';

      // ── Step 3: Start the download ──
      const startRes = await fetch('/api/songdownload/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: song.video_id,
          title: song.title,
        }),
      });

      const startData = await startRes.json();

      if (!startRes.ok || !startData.success) {
        throw new Error(startData.error || 'Failed to start download.');
      }

      const downloadId = startData.download_id;

      // ── Step 4: Poll for progress ──
      startPolling(downloadId, song);

    } catch (err) {
      showError(err.message || 'An unexpected error occurred.');
    }
  }

  // ── PROGRESS POLLING ──────────────────────────────────────

  function startPolling(downloadId, song) {
    stopPolling();

    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/songdownload/progress/${downloadId}`);
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Progress check failed.');
        }

        updateProgressUI(data);

        // Check terminal states
        if (data.status === 'completed') {
          stopPolling();
          showComplete(song, data.filename, downloadId);
        } else if (data.status === 'error') {
          stopPolling();
          showError(data.error || 'Download failed. Please try again.');
        }

      } catch (err) {
        // Network error during polling — don't immediately fail,
        // could be a transient glitch. After 3 consecutive failures, show error.
        if (!pollTimer._failCount) pollTimer._failCount = 0;
        pollTimer._failCount++;
        if (pollTimer._failCount > 5) {
          stopPolling();
          showError('Lost connection to the server. Please try again.');
        }
      }
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function updateProgressUI(data) {
    const pct = data.percentage || 0;
    progressFill.style.width = `${pct}%`;
    progressPct.textContent = `${pct}%`;

    // Speed
    statSpeed.textContent = data.speed || '—';

    // Downloaded
    statDownloaded.textContent = data.downloaded || '—';

    // Total
    statTotal.textContent = data.total || '—';

    // ETA
    statEta.textContent = data.eta || '—';

    // Status text
    const statusMap = {
      searching: 'Searching for song...',
      downloading: 'Downloading audio...',
      processing: 'Converting to MP3...',
      completed: 'Download complete!',
      error: 'Download failed',
    };
    const statusLabel = statusMap[data.status] || 'Processing...';
    statusText.textContent = statusLabel;

    // Progress label
    if (data.status === 'processing') {
      progressLabel.textContent = 'Converting to MP3...';
    } else if (data.status === 'downloading') {
      progressLabel.textContent = 'Downloading...';
    }
  }

  // ── COMPLETE STATE ────────────────────────────────────────

  function showComplete(song, filename, downloadId) {
    isDownloading = false;

    completeCover.src = song.cover || '';
    completeCover.onerror = () => { completeCover.style.display = 'none'; };
    completeTitle.textContent = song.title || 'Unknown';
    completeArtist.textContent = song.artist || 'Unknown Artist';

    // This used to show the SERVER's own filesystem folder (e.g.
    // "/home/ubuntu/Downloads"), which is meaningless to the person
    // using the site — that path is on the server, not their device.
    // What actually matters is that the file is now downloading to
    // THEIR computer, which the browser trigger below takes care of.
    const locationSpan = completeLocation.querySelector('span');
    locationSpan.textContent = 'Your Downloads folder';

    // Actually hand the file to the browser so it lands on the
    // person's own device — previously nothing ever did this, the
    // file only ever existed on the server's disk.
    if (downloadId) {
      const a = document.createElement('a');
      a.href = `/api/songdownload/file/${downloadId}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    showSection('completeSection');
    showToast('✅ Song downloaded successfully!');

    // Auto-reset after delay
    setTimeout(() => {
      resetUI();
    }, AUTO_RESET_DELAY);
  }

  // ── ERROR STATE ───────────────────────────────────────────

  function showError(message) {
    isDownloading = false;
    stopPolling();

    downloadBtn.innerHTML = '<i class="fas fa-download"></i> Download';
    downloadBtn.disabled = false;

    // Determine error type for title
    const lowerMsg = message.toLowerCase();
    let title = 'Something went wrong';
    if (lowerMsg.includes('not found') || lowerMsg.includes('no song')) {
      title = 'Song Not Found';
    } else if (lowerMsg.includes('network') || lowerMsg.includes('connection')) {
      title = 'Network Error';
    } else if (lowerMsg.includes('failed') || lowerMsg.includes('download')) {
      title = 'Download Failed';
    } else if (lowerMsg.includes('invalid')) {
      title = 'Invalid Song Name';
    } else if (lowerMsg.includes('server') || lowerMsg.includes('service')) {
      title = 'Server Error';
    }

    errorTitle.textContent = title;
    errorMessage.textContent = message;
    showSection('errorSection');
  }

  // ── RIPPLE EFFECT ─────────────────────────────────────────

  function createRipple(event) {
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;

    const ripple = document.createElement('span');
    ripple.classList.add('ripple');
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    button.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }

  // ── TOAST NOTIFICATIONS ───────────────────────────────────

  function showToast(msg) {
    const old = document.querySelector('.snetch-toast');
    if (old) old.remove();

    const toast = document.createElement('div');
    toast.className = 'snetch-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 350);
    }, 3500);
  }

  // ── EXTRA PARTICLES (dynamic, JS-created) ─────────────────

  function createExtraParticles() {
    const container = document.querySelector('.particle-container');
    if (!container) return;
    for (let i = 0; i < 6; i++) {
      const dot = document.createElement('div');
      dot.style.position = 'absolute';
      const size = (3 + Math.random() * 7) + 'px';
      dot.style.width = size;
      dot.style.height = size;
      const colors = [
        `rgba(168, 85, 247, ${0.08 + Math.random() * 0.12})`,
        `rgba(59, 130, 246, ${0.06 + Math.random() * 0.1})`,
        `rgba(6, 182, 212, ${0.05 + Math.random() * 0.08})`,
      ];
      dot.style.background = colors[Math.floor(Math.random() * colors.length)];
      dot.style.borderRadius = '50%';
      dot.style.boxShadow = '0 0 15px rgba(168, 85, 247, 0.08)';
      dot.style.top = Math.random() * 100 + '%';
      dot.style.left = Math.random() * 100 + '%';
      dot.style.animation = `particleFloat ${14 + Math.random() * 18}s infinite alternate ease-in-out`;
      dot.style.animationDelay = (Math.random() * 10) + 's';
      container.appendChild(dot);
    }
  }
  createExtraParticles();

  // ── READY ─────────────────────────────────────────────────
  console.log('🎵 S.N.E.T.C.H AI Music Downloader ready');
});