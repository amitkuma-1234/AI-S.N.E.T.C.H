// ===== SONGPLAY.JS =====
// S.N.E.T.C.H AI Operating System · Premium AI Music Player
// Talks to /api/songplay/search and streams audio through
// /api/songplay/stream/<video_id> (see songplay.py + app.py).

(function () {
  "use strict";

  // --- DOM refs ---
  const songInput = document.getElementById("songInput");
  const playBtn = document.getElementById("playBtn");
  const feedback = document.getElementById("feedbackMsg");

  const playerPanel = document.getElementById("playerPanel");
  const playlistPanel = document.getElementById("playlistPanel");
  const playlistList = document.getElementById("playlistList");

  const coverArt = document.getElementById("coverArt");
  const coverRotator = document.getElementById("coverRotator");
  const coverParticles = document.getElementById("coverParticles");
  const trackTitle = document.getElementById("trackTitle");
  const trackArtist = document.getElementById("trackArtist");
  const trackAlbum = document.getElementById("trackAlbum");
  const equalizer = document.getElementById("equalizer");

  const progressTrack = document.getElementById("progressTrack");
  const progressFill = document.getElementById("progressFill");
  const progressHandle = document.getElementById("progressHandle");
  const currentTimeEl = document.getElementById("currentTime");
  const remainingTimeEl = document.getElementById("remainingTime");

  const shuffleBtn = document.getElementById("shuffleBtn");
  const prevBtn = document.getElementById("prevBtn");
  const seekBackBtn = document.getElementById("seekBackBtn");
  const playPauseBtn = document.getElementById("playPauseBtn");
  const playPauseIcon = document.getElementById("playPauseIcon");
  const seekFwdBtn = document.getElementById("seekFwdBtn");
  const nextBtn = document.getElementById("nextBtn");
  const repeatBtn = document.getElementById("repeatBtn");
  const restartBtn = document.getElementById("restartBtn");
  const stopBtn = document.getElementById("stopBtn");
  const muteBtn = document.getElementById("muteBtn");
  const volumeIcon = document.getElementById("volumeIcon");
  const volumeSlider = document.getElementById("volumeSlider");
  const playerFeedback = document.getElementById("playerFeedback");

  const audioEl = document.getElementById("audioEl");

  const PLAYLIST_KEY = "snetch_songplay_recent";
  const MAX_PLAYLIST = 15;
  const SEEK_STEP = 10; // seconds

  // --- State ---
  let playlist = loadPlaylist();
  let currentSong = null;
  let currentIndex = -1;
  let shuffleOn = false;
  let repeatMode = "off"; // 'off' | 'one' | 'all'
  let lastVolume = 0.8;
  let isSeeking = false;

  // ============================================================
  // Persistence helpers
  // ============================================================
  function loadPlaylist() {
    try {
      const raw = localStorage.getItem(PLAYLIST_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function savePlaylist() {
    try {
      localStorage.setItem(PLAYLIST_KEY, JSON.stringify(playlist));
    } catch (e) {
      /* storage unavailable — playlist just won't persist across reloads */
    }
  }

  // ============================================================
  // Feedback helpers
  // ============================================================
  function setFeedback(message, type) {
    feedback.textContent = message || "";
    feedback.className = "feedback-message" + (type ? " " + type : "");
  }

  function setPlayerFeedback(message) {
    playerFeedback.textContent = message || "";
  }

  function friendlyErrorFromFetch(err) {
    if (err && err.isSongError) return err.message;
    return "Network error. Please check your connection and try again.";
  }

  // ============================================================
  // Time formatting
  // ============================================================
  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "0:00";
    seconds = Math.floor(seconds);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // ============================================================
  // Floating music-note particles around the album cover
  // ============================================================
  function spawnParticles() {
    coverParticles.innerHTML = "";
    const count = 6;
    for (let i = 0; i < count; i++) {
      const span = document.createElement("span");
      const left = 10 + Math.random() * 80;
      const delay = Math.random() * 6;
      const duration = 5 + Math.random() * 3;
      span.style.left = `${left}%`;
      span.style.bottom = "10%";
      span.style.animationDelay = `${delay}s`;
      span.style.animationDuration = `${duration}s`;
      coverParticles.appendChild(span);
    }
  }

  // ============================================================
  // Playlist rendering
  // ============================================================
  function renderPlaylist() {
    if (!playlist.length) {
      playlistPanel.hidden = true;
      return;
    }
    playlistPanel.hidden = false;
    playlistList.innerHTML = "";
    playlist.forEach((song, idx) => {
      const item = document.createElement("div");
      item.className = "playlist-item" + (idx === currentIndex ? " active" : "");
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");

      const img = document.createElement("img");
      img.src = song.cover || "";
      img.alt = song.title;
      img.onerror = () => { img.style.visibility = "hidden"; };

      const meta = document.createElement("div");
      meta.className = "playlist-item-meta";
      const titleEl = document.createElement("div");
      titleEl.className = "playlist-item-title";
      titleEl.textContent = song.title;
      const artistEl = document.createElement("div");
      artistEl.className = "playlist-item-artist";
      artistEl.textContent = song.artist;
      meta.appendChild(titleEl);
      meta.appendChild(artistEl);

      const icon = document.createElement("i");
      icon.className = "playlist-item-icon fas " + (idx === currentIndex ? "fa-volume-up" : "fa-play");

      item.appendChild(img);
      item.appendChild(meta);
      item.appendChild(icon);

      item.addEventListener("click", () => playFromPlaylist(idx));
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          playFromPlaylist(idx);
        }
      });

      playlistList.appendChild(item);
    });
  }

  function addToPlaylist(song) {
    const existingIdx = playlist.findIndex((s) => s.video_id === song.video_id);
    if (existingIdx !== -1) {
      playlist.splice(existingIdx, 1);
    }
    playlist.unshift(song);
    if (playlist.length > MAX_PLAYLIST) playlist.length = MAX_PLAYLIST;
    currentIndex = 0;
    savePlaylist();
    renderPlaylist();
  }

  function playFromPlaylist(idx) {
    const song = playlist[idx];
    if (!song) return;
    currentIndex = idx;
    loadAndPlay(song, false);
    renderPlaylist();
  }

  // ============================================================
  // Core: load + play a song
  // ============================================================
  function loadAndPlay(song, addToHistory) {
    currentSong = song;

    // Reset UI for new song
    playerPanel.hidden = false;
    setPlayerFeedback("");
    progressFill.style.width = "0%";
    progressHandle.style.left = "0%";
    currentTimeEl.textContent = "0:00";
    remainingTimeEl.textContent = song.duration_formatted ? `-${song.duration_formatted}` : "-0:00";

    trackTitle.textContent = song.title || "Untitled";
    trackArtist.textContent = song.artist || "Unknown Artist";
    trackAlbum.textContent = song.album || "Single";
    coverArt.src = song.cover || "";
    coverArt.onerror = () => { coverArt.style.visibility = "hidden"; };
    coverArt.onload = () => { coverArt.style.visibility = "visible"; };
    spawnParticles();

    if (addToHistory) addToPlaylist(song);

    // Stop whatever is currently loaded, then load + auto-play the new track.
    audioEl.pause();
    audioEl.src = song.stream_url;
    audioEl.load();
    audioEl.volume = lastVolume;

    const playPromise = audioEl.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {
        // Autoplay might be blocked until a user gesture; the Play button
        // click that triggered this already counts as a gesture in almost
        // all browsers, but guard anyway.
        setPlayerFeedback("Tap play to start listening.");
        setPlayPauseIcon(false);
      });
    }
  }

  // ============================================================
  // Search + Play Song (main entry point)
  // ============================================================
  async function handlePlaySong() {
    const query = songInput.value;
    if (!query || query.trim() === "") {
      setFeedback("⚠️ Please enter a song name.", "error");
      songInput.parentElement.style.borderColor = "#ff7a7a";
      setTimeout(() => { songInput.parentElement.style.borderColor = ""; }, 600);
      return;
    }

    playBtn.disabled = true;
    setFeedback("🔎 Searching for the best match...", "info");

    try {
      const res = await fetch("/api/songplay/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim() }),
      });

      let payload;
      try {
        payload = await res.json();
      } catch (e) {
        throw { isSongError: true, message: "Server error. Please try again shortly." };
      }

      if (!res.ok || !payload.success) {
        const msg = (payload && payload.error) || "Song not found. Try another title.";
        throw { isSongError: true, message: msg };
      }

      const song = payload.data.result;
      setFeedback(`🎵 Now playing: "${song.title}" by ${song.artist}`, "success");
      loadAndPlay(song, true);
    } catch (err) {
      setFeedback("❌ " + friendlyErrorFromFetch(err), "error");
    } finally {
      playBtn.disabled = false;
    }
  }

  // ============================================================
  // Transport controls
  // ============================================================
  function setPlayPauseIcon(isPlaying) {
    playPauseIcon.className = isPlaying ? "fas fa-pause" : "fas fa-play";
    coverRotator.classList.toggle("spinning", isPlaying);
    equalizer.classList.toggle("playing", isPlaying);
  }

  function togglePlayPause() {
    if (!currentSong) return;
    if (audioEl.paused) {
      audioEl.play().catch(() => setPlayerFeedback("Playback failed. Please try again."));
    } else {
      audioEl.pause();
    }
  }

  function stopPlayback() {
    if (!currentSong) return;
    audioEl.pause();
    audioEl.currentTime = 0;
    setPlayPauseIcon(false);
    progressFill.style.width = "0%";
    progressHandle.style.left = "0%";
    currentTimeEl.textContent = "0:00";
  }

  function restartSong() {
    if (!currentSong) return;
    audioEl.currentTime = 0;
    audioEl.play().catch(() => {});
  }

  function seekBy(deltaSeconds) {
    if (!currentSong || !isFinite(audioEl.duration)) return;
    audioEl.currentTime = Math.min(Math.max(audioEl.currentTime + deltaSeconds, 0), audioEl.duration);
  }

  function playNext(fromEnded) {
    if (!playlist.length) return;
    let nextIdx;
    if (shuffleOn) {
      if (playlist.length === 1) {
        nextIdx = 0;
      } else {
        do {
          nextIdx = Math.floor(Math.random() * playlist.length);
        } while (nextIdx === currentIndex);
      }
    } else {
      nextIdx = currentIndex - 1; // playlist is newest-first, so "next" moves toward older entries
      if (nextIdx < 0) {
        if (fromEnded && repeatMode !== "all") return; // nothing more to play
        nextIdx = playlist.length - 1; // wrap
      }
    }
    currentIndex = nextIdx;
    loadAndPlay(playlist[nextIdx], false);
    renderPlaylist();
  }

  function playPrevious() {
    if (!playlist.length) return;
    // If more than a couple seconds into the song, restart it first (common UX).
    if (audioEl.currentTime > 3) {
      restartSong();
      return;
    }
    let prevIdx = currentIndex + 1; // move toward newer entries
    if (prevIdx >= playlist.length) prevIdx = 0;
    currentIndex = prevIdx;
    loadAndPlay(playlist[prevIdx], false);
    renderPlaylist();
  }

  function cycleRepeat() {
    const order = ["off", "all", "one"];
    const nextMode = order[(order.indexOf(repeatMode) + 1) % order.length];
    repeatMode = nextMode;
    repeatBtn.dataset.mode = repeatMode;
    repeatBtn.setAttribute("aria-pressed", repeatMode !== "off" ? "true" : "false");
    repeatBtn.title =
      repeatMode === "off" ? "Repeat Off" :
      repeatMode === "all" ? "Repeat All" : "Repeat One";
  }

  function toggleShuffle() {
    shuffleOn = !shuffleOn;
    shuffleBtn.setAttribute("aria-pressed", shuffleOn ? "true" : "false");
    shuffleBtn.title = shuffleOn ? "Shuffle On" : "Shuffle";
  }

  function toggleMute() {
    if (audioEl.volume > 0 || !audioEl.muted) {
      if (!audioEl.muted) {
        lastVolume = audioEl.volume;
        audioEl.muted = true;
      } else {
        audioEl.muted = false;
      }
    }
    updateVolumeUI();
  }

  function updateVolumeUI() {
    const effectiveVolume = audioEl.muted ? 0 : audioEl.volume;
    volumeSlider.value = Math.round(effectiveVolume * 100);
    if (audioEl.muted || effectiveVolume === 0) {
      volumeIcon.className = "fas fa-volume-mute";
    } else if (effectiveVolume < 0.5) {
      volumeIcon.className = "fas fa-volume-down";
    } else {
      volumeIcon.className = "fas fa-volume-up";
    }
  }

  // ============================================================
  // Progress bar interaction
  // ============================================================
  function updateProgressUI() {
    if (isSeeking || !isFinite(audioEl.duration) || audioEl.duration === 0) return;
    const pct = (audioEl.currentTime / audioEl.duration) * 100;
    progressFill.style.width = pct + "%";
    progressHandle.style.left = pct + "%";
    currentTimeEl.textContent = formatTime(audioEl.currentTime);
    remainingTimeEl.textContent = "-" + formatTime(audioEl.duration - audioEl.currentTime);
  }

  function seekToClientX(clientX) {
    if (!isFinite(audioEl.duration) || audioEl.duration === 0) return;
    const rect = progressTrack.getBoundingClientRect();
    let pct = (clientX - rect.left) / rect.width;
    pct = Math.min(Math.max(pct, 0), 1);
    progressFill.style.width = pct * 100 + "%";
    progressHandle.style.left = pct * 100 + "%";
    audioEl.currentTime = pct * audioEl.duration;
  }

  progressTrack.addEventListener("mousedown", (e) => {
    isSeeking = true;
    seekToClientX(e.clientX);
  });
  window.addEventListener("mousemove", (e) => {
    if (isSeeking) seekToClientX(e.clientX);
  });
  window.addEventListener("mouseup", () => { isSeeking = false; });

  progressTrack.addEventListener("touchstart", (e) => {
    isSeeking = true;
    seekToClientX(e.touches[0].clientX);
  }, { passive: true });
  progressTrack.addEventListener("touchmove", (e) => {
    if (isSeeking) seekToClientX(e.touches[0].clientX);
  }, { passive: true });
  progressTrack.addEventListener("touchend", () => { isSeeking = false; });

  // ============================================================
  // Audio element events
  // ============================================================
  audioEl.addEventListener("play", () => setPlayPauseIcon(true));
  audioEl.addEventListener("pause", () => setPlayPauseIcon(false));
  audioEl.addEventListener("timeupdate", updateProgressUI);
  audioEl.addEventListener("loadedmetadata", updateProgressUI);
  audioEl.addEventListener("waiting", () => setPlayerFeedback("Buffering..."));
  audioEl.addEventListener("playing", () => setPlayerFeedback(""));

  audioEl.addEventListener("ended", () => {
    if (repeatMode === "one") {
      restartSong();
      return;
    }
    if (repeatMode === "all" || shuffleOn) {
      playNext(true);
      return;
    }
    playNext(true);
  });

  audioEl.addEventListener("error", () => {
    setPlayPauseIcon(false);
    const err = audioEl.error;
    let message = "Playback failed. Please try another song.";
    if (err) {
      switch (err.code) {
        case err.MEDIA_ERR_NETWORK:
          message = "Network error while streaming this song.";
          break;
        case err.MEDIA_ERR_DECODE:
        case err.MEDIA_ERR_SRC_NOT_SUPPORTED:
          message = "Unsupported audio format for this song.";
          break;
        default:
          message = "Playback failed. Please try another song.";
      }
    }
    setPlayerFeedback("⚠️ " + message);
  });

  // ============================================================
  // Event bindings — controls
  // ============================================================
  function createRipple(e) {
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement("span");
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    ripple.classList.add("ripple");
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 700);
  }

  playBtn.addEventListener("click", (e) => {
    createRipple(e);
    handlePlaySong();
  });
  songInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      playBtn.click();
    }
  });
  songInput.addEventListener("focus", function () {
    this.parentElement.style.boxShadow =
      "0 0 50px rgba(160, 100, 255, 0.3), inset 0 0 40px rgba(100, 50, 200, 0.1)";
  });
  songInput.addEventListener("blur", function () {
    this.parentElement.style.boxShadow = "";
  });

  playPauseBtn.addEventListener("click", togglePlayPause);
  stopBtn.addEventListener("click", stopPlayback);
  restartBtn.addEventListener("click", restartSong);
  prevBtn.addEventListener("click", playPrevious);
  nextBtn.addEventListener("click", () => playNext(false));
  seekFwdBtn.addEventListener("click", () => seekBy(SEEK_STEP));
  seekBackBtn.addEventListener("click", () => seekBy(-SEEK_STEP));
  repeatBtn.addEventListener("click", cycleRepeat);
  shuffleBtn.addEventListener("click", toggleShuffle);
  muteBtn.addEventListener("click", toggleMute);

  volumeSlider.addEventListener("input", () => {
    const v = Number(volumeSlider.value) / 100;
    audioEl.muted = false;
    audioEl.volume = v;
    lastVolume = v;
    updateVolumeUI();
  });

  // ============================================================
  // Init
  // ============================================================
  audioEl.volume = lastVolume;
  updateVolumeUI();
  setFeedback("✨ Enter a song and press Play", "info");
  renderPlaylist();

  // Expose a little debug surface (harmless, mirrors project convention).
  window.__snetch_songplay = { playlist, get currentSong() { return currentSong; } };
})();