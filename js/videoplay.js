// ══════════════════════════════════════════════════════════════════
// S.N.E.T.C.H — AI VIDEO PLAYER
// Talks to /api/videoplay/search (videoplay.py) to find the best
// matching YouTube video, then plays it inside "YouTube Mode": a
// full-screen overlay using YouTube's official embeddable player.
// ══════════════════════════════════════════════════════════════════

// Inject YouTube Iframe API
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

let isYtApiReady = false;
window.onYouTubeIframeAPIReady = () => {
  isYtApiReady = true;
};

(() => {
  const SEARCH_ENDPOINT = "/api/videoplay/search";
  const RELATED_ENDPOINT = "/api/videoplay/related";

  // ---- Search screen elements ----
  const videoInput = document.getElementById("videoInput");
  const playBtn = document.getElementById("playBtn");
  const playBtnLabel = playBtn.querySelector(".play-btn-label");
  const statusMsg = document.getElementById("statusMessage");
  const homeBtn = document.getElementById("homeBtn");
  const exampleChips = document.getElementById("exampleChips");

  // ---- YouTube Mode elements ----
  const youtubeMode = document.getElementById("youtubeMode");
  const exitYtBtn = document.getElementById("exitYtBtn");
  const ytLoading = document.getElementById("ytLoading");
  const ytTitle = document.getElementById("ytTitle");
  const ytChannel = document.querySelector("#ytChannel span");
  const ytRelatedList = document.getElementById("ytRelatedList");
  const ytSearchInput = document.getElementById("ytSearchInput");
  const ytSearchBtn = document.getElementById("ytSearchBtn");
  const ytError = document.getElementById("ytError");
  const ytErrorMsg = document.getElementById("ytErrorMsg");
  const ytErrorBackBtn = document.getElementById("ytErrorBackBtn");

  // ---- Custom Overlay elements ----
  const customYtOverlay = document.getElementById("customYtOverlay");
  const customOverlayList = document.getElementById("customOverlayList");
  const customYtReplayBtn = document.getElementById("customYtReplayBtn");
  const customYtCloseBtn = document.getElementById("customYtCloseBtn");

  // ---- Double-tap elements ----
  const doubletapLeft = document.getElementById("ytDoubletapLeft");
  const doubletapRight = document.getElementById("ytDoubletapRight");
  const rippleLeft = document.getElementById("ytRippleLeft");
  const rippleRight = document.getElementById("ytRippleRight");

  // ---- Progress bar elements ----
  const progressContainer = document.getElementById("ytProgressContainer");
  const progressTrack = document.getElementById("ytProgressTrack");
  const progressBuffered = document.getElementById("ytProgressBuffered");
  const progressPlayed = document.getElementById("ytProgressPlayed");
  const progressDot = document.getElementById("ytProgressDot");
  const hoverTime = document.getElementById("ytHoverTime");
  const currentTimeEl = document.getElementById("ytCurrentTime");
  const durationEl = document.getElementById("ytDuration");

  // ---- Settings Menu elements ----
  const settingsBtn = document.getElementById("ytSettingsBtn");
  const settingsMenu = document.getElementById("ytSettingsMenu");
  const settingsBack = document.getElementById("ytSettingsBack");
  const settingsTitle = document.getElementById("ytSettingsTitle");
  const mainMenu = document.getElementById("ytMainMenu");
  const speedMenu = document.getElementById("ytSpeedMenu");
  const speedValue = document.getElementById("ytSpeedValue");
  const qualityMenu = document.getElementById("ytQualityMenu");
  const qualityValue = document.getElementById("ytQualityValue");
  const captionsMenu = document.getElementById("ytCaptionsMenu");
  const captionsValue = document.getElementById("ytCaptionsValue");

  // ---- Fullscreen elements ----
  const fullscreenBtn = document.getElementById("ytFullscreenBtn");

  let activeRequestToken = 0; 
  let player = null;
  let currentVideoId = null;

  // Infinite Scroll state
  let currentRelatedQuery = "";
  let currentRelatedOffset = 0;
  let isFetchingRelated = false;
  let observerMain = null;
  let observerOverlay = null;

  // Progress bar state
  let progressInterval = null;
  let isDragging = false;

  // Settings state
  let currentPlaybackRate = 1;
  let currentPlaybackQuality = "auto";
  let currentCaptionsState = false;

  // ───────────────────────── REPLAY / CLOSE BUTTON ─────────────────────────
  if (customYtReplayBtn) {
    customYtReplayBtn.addEventListener("click", () => {
      if (customYtOverlay) customYtOverlay.classList.add("hidden");
      if (player && player.playVideo) {
        player.playVideo();
      }
    });
  }
  
  if (customYtCloseBtn) {
    customYtCloseBtn.addEventListener("click", () => {
      if (customYtOverlay) customYtOverlay.classList.add("hidden");
    });
  }

  // ───────────────────────── HOME BUTTON ─────────────────────────
  homeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    window.location.href = "/";
  });

  // ───────────────────────── EXAMPLE CHIPS ─────────────────────────
  exampleChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    videoInput.value = chip.textContent.trim();
    videoInput.focus();
  });

  // ───────────────────────── VOICE SEARCH ─────────────────────────
  const voiceBtn = document.getElementById("voiceBtn");
  if (voiceBtn) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onstart = () => {
        voiceBtn.classList.add("listening");
      };

      recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        videoInput.value = transcript;
        playBtn.click();
      };

      recognition.onerror = (event) => {
        console.error("Speech recognition error", event.error);
        voiceBtn.classList.remove("listening");
      };

      recognition.onend = () => {
        voiceBtn.classList.remove("listening");
      };

      voiceBtn.addEventListener("click", () => {
        recognition.start();
      });
    } else {
      voiceBtn.title = "Voice search not supported in this browser";
      voiceBtn.addEventListener("click", () => {
        alert("Voice search is not supported in this browser.");
      });
    }
  }

  // ───────────────────────── STATUS HELPERS ─────────────────────────
  function setStatus(text, type) {
    statusMsg.className = "status-msg" + (type ? ` ${type}` : "");
    statusMsg.textContent = text || "";
  }

  function setPlayButtonLoading(isLoading) {
    playBtn.disabled = isLoading;
    playBtn.classList.toggle("is-loading", isLoading);
    if (isLoading) {
      playBtn.innerHTML = '<i class="fas fa-spinner"></i> <span class="play-btn-label">Searching YouTube...</span>';
    } else {
      playBtn.innerHTML = '<i class="fas fa-play"></i> <span class="play-btn-label">Play Video</span>';
    }
  }

  // ───────────────────────── BACKEND SEARCH ─────────────────────────
  async function fetchBestMatch(query) {
    const res = await fetch(SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error("The server sent back something unexpected. Please try again.");
    }

    if (!res.ok || !body.success) {
      throw new Error(body.error || "Could not find that video. Please try again.");
    }
    return body.data; // { query, result, related }
  }

  // ───────────────────────── MAIN SEARCH FLOW (search screen) ─────────────────────────
  playBtn.addEventListener("click", function (e) {
    // ripple effect
    const rect = this.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.classList.add("ripple-effect");
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + "px";
    ripple.style.left = e.clientX - rect.left - size / 2 + "px";
    ripple.style.top = e.clientY - rect.top - size / 2 + "px";
    this.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);

    handlePlayVideo();
  });

  videoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      playBtn.click();
    }
  });

  async function handlePlayVideo() {
    const query = videoInput.value.trim();
    setStatus("", "");

    if (!query) {
      setStatus("⚠️ Please enter a video name.", "error");
      return;
    }

    setPlayButtonLoading(true);
    try {
      const data = await fetchBestMatch(query);
      setStatus(`▶️ Found: ${data.result.title}`, "success");
      openYoutubeMode(data);
    } catch (err) {
      setStatus(`❌ ${err.message}`, "error");
    } finally {
      setPlayButtonLoading(false);
    }
  }

  // ───────────────────────── YOUTUBE MODE ─────────────────────────
  function openYoutubeMode(data) {
    youtubeMode.classList.add("active", "fading-in");
    youtubeMode.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    ytSearchInput.value = "";
    if (customYtOverlay) customYtOverlay.classList.add("hidden");
    renderVideo(data);
  }

  function closeYoutubeMode() {
    youtubeMode.classList.remove("active", "fading-in");
    youtubeMode.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    if (player && player.stopVideo) {
      player.stopVideo();
    }
    ytError.classList.remove("active");
    if (customYtOverlay) customYtOverlay.classList.add("hidden");
    stopProgressUpdater();
    videoInput.focus();
  }

  function showYtError(message) {
    ytErrorMsg.textContent = message;
    ytError.classList.add("active");
    ytLoading.classList.add("hidden");
  }

  function renderVideo(data) {
    const token = ++activeRequestToken;
    ytError.classList.remove("active");
    ytLoading.classList.remove("hidden");

    const { result, related } = data;

    if (!result || !result.video_id) {
      showYtError("This video can't be embedded here. Try another search.");
      return;
    }

    currentVideoId = result.video_id;
    ytTitle.textContent = result.title;
    ytChannel.textContent = result.channel;

    // Reset infinite scroll state
    currentRelatedQuery = result.title;
    currentRelatedOffset = (related && related.length) ? related.length + 1 : 1; 
    ytRelatedList.innerHTML = "";
    if (customOverlayList) customOverlayList.innerHTML = "";
    
    if (related && related.length) {
      appendRelated(related);
    } else {
      fetchMoreRelated();
    }

    // Reset progress bar
    resetProgressBar();

    // Use YouTube Iframe API
    if (!isYtApiReady) {
      const checkApi = setInterval(() => {
        if (isYtApiReady) {
          clearInterval(checkApi);
          if (token === activeRequestToken) initPlayer(currentVideoId, token);
        }
      }, 100);
    } else {
      initPlayer(currentVideoId, token);
    }
  }

  function initPlayer(videoId, token) {
    if (!player) {
      player = new YT.Player('ytIframe', {
        videoId: videoId,
        host: 'https://www.youtube.com',
        playerVars: {
          'autoplay': 1,
          'rel': 0,
          'controls': 0,
          'modestbranding': 1,
          'playsinline': 1,
          'iv_load_policy': 3,
          'disablekb': 1 // Disable YouTube's native keyboard shortcuts so ours take over
        },
        events: {
          'onReady': (event) => {
            if (token === activeRequestToken) {
              ytLoading.classList.add("hidden");
              startProgressUpdater();
            }
          },
          'onStateChange': onPlayerStateChange,
          'onError': (event) => {
            // event.data codes: 
            // 2 (invalid parameter)
            // 5 (HTML5 error)
            // 100 (not found/private)
            // 101/150 (embed not allowed)
            let errorMsg = "An error occurred while trying to play this video.";
            if (event.data === 101 || event.data === 150) {
              errorMsg = "The owner of this video has disabled playback outside of YouTube.";
            } else if (event.data === 100) {
              errorMsg = "This video is private, restricted, or has been removed.";
            }
            showYtError(errorMsg + " Please try searching for a different video.");
          }
        }
      });
    } else {
      player.loadVideoById(videoId);
      if (token === activeRequestToken) ytLoading.classList.add("hidden");
      startProgressUpdater();
    }
  }

  function onPlayerStateChange(event) {
    // Show custom overlay when video ends or is paused
    if (event.data === YT.PlayerState.ENDED || event.data === YT.PlayerState.PAUSED) {
      if (customYtOverlay) customYtOverlay.classList.remove("hidden");
      if (event.data === YT.PlayerState.ENDED) {
        stopProgressUpdater();
      }
    } else if (event.data === YT.PlayerState.PLAYING) {
      if (customYtOverlay) customYtOverlay.classList.add("hidden");
      startProgressUpdater();
    }

    // Detect if user clicked a new video from YouTube's native overlay
    if (player && player.getVideoData) {
      const newVideoId = player.getVideoData().video_id;
      if (newVideoId && newVideoId !== currentVideoId) {
        currentVideoId = newVideoId;
        const newTitle = player.getVideoData().title;
        
        // Sync our UI to the new video!
        ytTitle.textContent = newTitle || "Playing video...";
        ytChannel.textContent = player.getVideoData().author || "YouTube";
        
        // Reset related list for the new video
        currentRelatedQuery = newTitle || "video";
        currentRelatedOffset = 1;
        ytRelatedList.innerHTML = "";
        if (customOverlayList) customOverlayList.innerHTML = "";
        if (customYtOverlay) customYtOverlay.classList.add("hidden");
        resetProgressBar();
        fetchMoreRelated();
      }
    }
  }

  // ───────────────────────── DOUBLE-TAP SEEK ─────────────────────────

  function seekBy(seconds) {
    if (!player || !player.getCurrentTime || !player.seekTo) return;
    const currentTime = player.getCurrentTime();
    const duration = player.getDuration ? player.getDuration() : Infinity;
    const newTime = Math.max(0, Math.min(currentTime + seconds, duration));
    player.seekTo(newTime, true);
    // Ensure the video keeps playing after seeking
    if (player.getPlayerState && player.getPlayerState() !== YT.PlayerState.PLAYING) {
      player.playVideo();
    }
    // Close the custom overlay if it's visible
    if (customYtOverlay) customYtOverlay.classList.add("hidden");
    // Update the progress bar immediately
    updateProgressBar();
  }

  function triggerSeekRipple(rippleEl) {
    // Remove then re-add the class to restart animation
    rippleEl.classList.remove("active");
    // Force reflow
    void rippleEl.offsetWidth;
    rippleEl.classList.add("active");
    setTimeout(() => {
      rippleEl.classList.remove("active");
    }, 600);
  }

  // --- Double-tap detection ---
  // We implement a proper double-tap mechanism:
  // First tap = single tap (play/pause after a short delay).
  // Second tap within 300ms = double-tap (seek).
  let leftTapTimer = null;
  let rightTapTimer = null;
  const DOUBLE_TAP_DELAY = 300; // ms

  function handleDoubleTapZone(zone, rippleEl, seekSeconds) {
    let tapTimer = null;
    let lastTapTime = 0;

    const handleTap = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const now = Date.now();
      const timeSinceLastTap = now - lastTapTime;
      lastTapTime = now;

      if (timeSinceLastTap < DOUBLE_TAP_DELAY) {
        // Double-tap detected! Clear the single-tap timer and seek.
        if (tapTimer) {
          clearTimeout(tapTimer);
          tapTimer = null;
        }
        seekBy(seekSeconds);
        triggerSeekRipple(rippleEl);
      } else {
        // First tap — wait to see if a second tap comes.
        tapTimer = setTimeout(() => {
          // Single tap: toggle play/pause
          if (player && player.getPlayerState) {
            const state = player.getPlayerState();
            if (state === YT.PlayerState.PLAYING) {
              player.pauseVideo();
            } else {
              player.playVideo();
            }
          }
          tapTimer = null;
        }, DOUBLE_TAP_DELAY);
      }
    };

    // Support both touch and mouse events
    zone.addEventListener("touchend", handleTap, { passive: false });
    zone.addEventListener("click", (e) => {
      // Only handle click for non-touch devices (touchend already handled it)
      if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
      handleTap(e);
    });
  }

  if (doubletapLeft && rippleLeft) {
    handleDoubleTapZone(doubletapLeft, rippleLeft, -10);
  }
  if (doubletapRight && rippleRight) {
    handleDoubleTapZone(doubletapRight, rippleRight, 10);
  }

  // ───────────────────────── PROGRESS BAR ─────────────────────────

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return "0:00";
    seconds = Math.floor(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function resetProgressBar() {
    if (progressPlayed) progressPlayed.style.width = "0%";
    if (progressBuffered) progressBuffered.style.width = "0%";
    if (currentTimeEl) currentTimeEl.textContent = "0:00";
    if (durationEl) durationEl.textContent = "0:00";
  }

  function updateProgressBar() {
    if (!player || !player.getCurrentTime || !player.getDuration) return;

    const currentTime = player.getCurrentTime();
    const duration = player.getDuration();
    if (!duration || duration <= 0) return;

    const playedPercent = (currentTime / duration) * 100;

    // Update played bar
    if (progressPlayed && !isDragging) {
      progressPlayed.style.width = playedPercent + "%";
    }

    // Update buffered bar
    if (progressBuffered && player.getVideoLoadedFraction) {
      const bufferedPercent = player.getVideoLoadedFraction() * 100;
      progressBuffered.style.width = bufferedPercent + "%";
    }

    // Update time display
    if (currentTimeEl) currentTimeEl.textContent = formatTime(currentTime);
    if (durationEl) durationEl.textContent = formatTime(duration);
  }

  function startProgressUpdater() {
    stopProgressUpdater();
    updateProgressBar();
    progressInterval = setInterval(updateProgressBar, 250);
  }

  function stopProgressUpdater() {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
  }

  // --- Click to seek on progress bar ---
  function seekToPosition(e) {
    if (!player || !player.getDuration || !player.seekTo) return;
    const rect = progressTrack.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const fraction = clickX / rect.width;
    const duration = player.getDuration();
    const seekTime = fraction * duration;
    player.seekTo(seekTime, true);
    // Update the played bar immediately
    if (progressPlayed) progressPlayed.style.width = (fraction * 100) + "%";
    if (currentTimeEl) currentTimeEl.textContent = formatTime(seekTime);
    // Close overlay if open
    if (customYtOverlay) customYtOverlay.classList.add("hidden");
  }

  if (progressTrack) {
    progressTrack.addEventListener("click", (e) => {
      if (!isDragging) seekToPosition(e);
    });

    // --- Drag to seek ---
    progressTrack.addEventListener("mousedown", (e) => {
      isDragging = true;
      progressContainer.classList.add("dragging");
      seekToPosition(e);
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      // Update the played bar position while dragging
      const rect = progressTrack.getBoundingClientRect();
      const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const fraction = clickX / rect.width;
      if (progressPlayed) progressPlayed.style.width = (fraction * 100) + "%";
      if (player && player.getDuration) {
        const seekTime = fraction * player.getDuration();
        if (currentTimeEl) currentTimeEl.textContent = formatTime(seekTime);
      }
    });

    document.addEventListener("mouseup", (e) => {
      if (!isDragging) return;
      isDragging = false;
      progressContainer.classList.remove("dragging");
      seekToPosition(e);
    });

    // --- Touch support for drag ---
    progressTrack.addEventListener("touchstart", (e) => {
      isDragging = true;
      progressContainer.classList.add("dragging");
      const touch = e.touches[0];
      seekToPosition(touch);
      e.preventDefault();
    }, { passive: false });

    progressTrack.addEventListener("touchmove", (e) => {
      if (!isDragging) return;
      const touch = e.touches[0];
      const rect = progressTrack.getBoundingClientRect();
      const clickX = Math.max(0, Math.min(touch.clientX - rect.left, rect.width));
      const fraction = clickX / rect.width;
      if (progressPlayed) progressPlayed.style.width = (fraction * 100) + "%";
      if (player && player.getDuration) {
        const seekTime = fraction * player.getDuration();
        if (currentTimeEl) currentTimeEl.textContent = formatTime(seekTime);
      }
      e.preventDefault();
    }, { passive: false });

    progressTrack.addEventListener("touchend", (e) => {
      if (!isDragging) return;
      isDragging = false;
      progressContainer.classList.remove("dragging");
      // Seek to the last touch position
      if (e.changedTouches && e.changedTouches.length) {
        seekToPosition(e.changedTouches[0]);
      }
    });

    // --- Hover time preview ---
    progressTrack.addEventListener("mousemove", (e) => {
      if (!player || !player.getDuration) return;
      const rect = progressTrack.getBoundingClientRect();
      const hoverX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const fraction = hoverX / rect.width;
      const duration = player.getDuration();
      const time = fraction * duration;
      if (hoverTime) {
        hoverTime.textContent = formatTime(time);
        hoverTime.style.left = hoverX + "px";
      }
    });
  }

  // Show progress bar when mouse moves over player frame, hide after delay
  const playerFrame = document.querySelector(".yt-player-frame");
  let progressHideTimer = null;

  function isSettingsMenuOpen() {
    return settingsMenu && !settingsMenu.classList.contains("hidden");
  }

  if (playerFrame && progressContainer) {
    playerFrame.addEventListener("mousemove", () => {
      progressContainer.classList.add("visible");
      clearTimeout(progressHideTimer);
      progressHideTimer = setTimeout(() => {
        if (!isDragging && !isSettingsMenuOpen()) {
          progressContainer.classList.remove("visible");
        }
      }, 3000);
    });

    playerFrame.addEventListener("mouseleave", () => {
      if (!isDragging && !isSettingsMenuOpen()) {
        progressContainer.classList.remove("visible");
      }
    });

    // Touch: show progress bar on tap, hide after delay
    playerFrame.addEventListener("touchstart", () => {
      progressContainer.classList.add("visible");
      clearTimeout(progressHideTimer);
      progressHideTimer = setTimeout(() => {
        if (!isSettingsMenuOpen()) {
          progressContainer.classList.remove("visible");
        }
      }, 4000);
    }, { passive: true });
  }

  // ───────────────────────── SETTINGS MENU ─────────────────────────
  
  if (settingsBtn) {
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      settingsMenu.classList.toggle("hidden");
      if (!settingsMenu.classList.contains("hidden")) {
        showMainMenu();
      }
    });
  }

  // Hide menu when clicking outside
  document.addEventListener("click", (e) => {
    if (settingsMenu && !settingsMenu.contains(e.target) && e.target !== settingsBtn && !settingsBtn.contains(e.target)) {
      settingsMenu.classList.add("hidden");
    }
  });

  // Handle Main Menu clicks
  if (mainMenu) {
    mainMenu.addEventListener("click", (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      const menuType = li.getAttribute("data-menu");
      
      if (menuType === "speed") {
        showSpeedMenu();
      } else if (menuType === "quality") {
        showQualityMenu();
      } else if (menuType === "captions") {
        showCaptionsMenu();
      }
    });
  }

  // Handle Back button
  if (settingsBack) {
    settingsBack.addEventListener("click", (e) => {
      e.stopPropagation();
      showMainMenu();
    });
  }

  function showMainMenu() {
    settingsTitle.textContent = "Settings";
    settingsBack.classList.add("hidden");
    mainMenu.classList.remove("hidden");
    speedMenu.classList.add("hidden");
    if(qualityMenu) qualityMenu.classList.add("hidden");
    if(captionsMenu) captionsMenu.classList.add("hidden");
  }

  function showSpeedMenu() {
    settingsTitle.textContent = "Playback speed";
    settingsBack.classList.remove("hidden");
    mainMenu.classList.add("hidden");
    speedMenu.classList.remove("hidden");
    
    populateSpeedMenu();
  }

  function populateSpeedMenu() {
    if (!player || !player.getAvailablePlaybackRates) return;
    const rates = player.getAvailablePlaybackRates();
    if (!rates || rates.length === 0) return;
    
    speedMenu.innerHTML = "";
    
    rates.forEach(rate => {
      const li = document.createElement("li");
      const label = rate === 1 ? "Normal" : rate;
      li.textContent = label;
      
      if (rate === currentPlaybackRate) {
        li.classList.add("selected");
      }
      
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        setPlaybackSpeed(rate, label);
      });
      
      speedMenu.appendChild(li);
    });
  }

  function setPlaybackSpeed(rate, label) {
    if (!player || !player.setPlaybackRate) return;
    player.setPlaybackRate(rate);
    currentPlaybackRate = rate;
    if (speedValue) speedValue.textContent = label;
    settingsMenu.classList.add("hidden");
    
    // Resume hiding the progress bar
    clearTimeout(progressHideTimer);
    progressHideTimer = setTimeout(() => {
      if (!isDragging) progressContainer.classList.remove("visible");
    }, 1500);
  }

  function showQualityMenu() {
    settingsTitle.textContent = "Quality";
    settingsBack.classList.remove("hidden");
    mainMenu.classList.add("hidden");
    if(qualityMenu) qualityMenu.classList.remove("hidden");
    populateQualityMenu();
  }

  function populateQualityMenu() {
    if (!player || !player.getAvailableQualityLevels) return;
    const qualities = player.getAvailableQualityLevels();
    if (!qualities || qualities.length === 0) return;
    
    if(!qualityMenu) return;
    qualityMenu.innerHTML = "";
    
    const qualityLabels = {
      'highres': '1080p+',
      'hd1080': '1080p',
      'hd720': '720p',
      'large': '480p',
      'medium': '360p',
      'small': '240p',
      'tiny': '144p',
      'auto': 'Auto'
    };
    
    qualities.forEach(q => {
      const li = document.createElement("li");
      const label = qualityLabels[q] || q;
      li.textContent = label;
      
      if (q === currentPlaybackQuality) {
        li.classList.add("selected");
      }
      
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        setPlaybackQuality(q, label);
      });
      
      qualityMenu.appendChild(li);
    });
  }

  function setPlaybackQuality(quality, label) {
    if (!player || !player.setPlaybackQuality) return;
    player.setPlaybackQuality(quality); // Note: YouTube may override this automatically
    currentPlaybackQuality = quality;
    if (qualityValue) qualityValue.textContent = label;
    settingsMenu.classList.add("hidden");
    
    clearTimeout(progressHideTimer);
    progressHideTimer = setTimeout(() => {
      if (!isDragging) progressContainer.classList.remove("visible");
    }, 1500);
  }

  function showCaptionsMenu() {
    settingsTitle.textContent = "Captions";
    settingsBack.classList.remove("hidden");
    mainMenu.classList.add("hidden");
    if(captionsMenu) captionsMenu.classList.remove("hidden");
    populateCaptionsMenu();
  }

  function populateCaptionsMenu() {
    if(!captionsMenu) return;
    captionsMenu.innerHTML = "";
    
    const options = [
      { id: false, label: "Off" },
      { id: true, label: "On (English)" }
    ];
    
    options.forEach(opt => {
      const li = document.createElement("li");
      li.textContent = opt.label;
      
      if (opt.id === currentCaptionsState) {
        li.classList.add("selected");
      }
      
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        setCaptionsState(opt.id, opt.label);
      });
      
      captionsMenu.appendChild(li);
    });
  }

  function setCaptionsState(state, label) {
    if (player && player.loadModule) {
      if (state) {
        player.loadModule("captions");
        player.setOption("captions", "track", {languageCode: "en"});
      } else {
        player.unloadModule("captions");
      }
    }
    currentCaptionsState = state;
    if (captionsValue) captionsValue.textContent = label;
    settingsMenu.classList.add("hidden");
    
    clearTimeout(progressHideTimer);
    progressHideTimer = setTimeout(() => {
      if (!isDragging) progressContainer.classList.remove("visible");
    }, 1500);
  }

  // ───────────────────────── FULLSCREEN ─────────────────────────
  if (fullscreenBtn && playerFrame) {
    fullscreenBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!document.fullscreenElement) {
        if (playerFrame.requestFullscreen) {
          playerFrame.requestFullscreen();
        } else if (playerFrame.webkitRequestFullscreen) { /* Safari */
          playerFrame.webkitRequestFullscreen();
        } else if (playerFrame.msRequestFullscreen) { /* IE11 */
          playerFrame.msRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) { /* Safari */
          document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) { /* IE11 */
          document.msExitFullscreen();
        }
      }
    });

    document.addEventListener("fullscreenchange", () => {
      const icon = fullscreenBtn.querySelector("i");
      if (document.fullscreenElement) {
        icon.classList.remove("fa-expand");
        icon.classList.add("fa-compress");
      } else {
        icon.classList.remove("fa-compress");
        icon.classList.add("fa-expand");
      }
    });
  }

  // ───────────────────────── RELATED VIDEOS ─────────────────────────

  function createRelatedItem(item) {
    const el = document.createElement("div");
    el.className = "yt-related-item";
    el.innerHTML = `
      <img src="${item.thumbnail || ""}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
      <div class="yt-related-info">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.channel)}${item.duration ? " · " + item.duration : ""}</span>
      </div>
    `;
    el.addEventListener("click", () => {
      if (player && player.loadVideoById) {
        player.loadVideoById(item.video_id);
        currentVideoId = item.video_id;
        ytTitle.textContent = item.title;
        ytChannel.textContent = item.channel;
        
        if(customYtOverlay) customYtOverlay.classList.add("hidden");
        resetProgressBar();

        currentRelatedQuery = item.title;
        currentRelatedOffset = 1;
        ytRelatedList.innerHTML = "";
        if(customOverlayList) customOverlayList.innerHTML = "";
        fetchMoreRelated();
      }
    });
    return el;
  }

  function appendRelated(related) {
    related.forEach((item) => {
      ytRelatedList.appendChild(createRelatedItem(item));
      if(customOverlayList) customOverlayList.appendChild(createRelatedItem(item));
    });

    observeLastItem();
  }

  function setupObserver() {
    if (!observerMain) {
      observerMain = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && !isFetchingRelated) fetchMoreRelated();
      }, { root: ytRelatedList, rootMargin: '200px' });
    }
    if (!observerOverlay && customOverlayList) {
      observerOverlay = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && !isFetchingRelated) fetchMoreRelated();
      }, { root: customOverlayList, rootMargin: '200px' });
    }
  }

  function observeLastItem() {
    setupObserver();
    if(observerMain) observerMain.disconnect();
    const itemsMain = ytRelatedList.querySelectorAll('.yt-related-item');
    if (itemsMain.length > 0) {
      observerMain.observe(itemsMain[itemsMain.length - 1]);
    }

    if(observerOverlay) observerOverlay.disconnect();
    if(customOverlayList) {
      const itemsOverlay = customOverlayList.querySelectorAll('.yt-related-item');
      if (itemsOverlay.length > 0) {
        observerOverlay.observe(itemsOverlay[itemsOverlay.length - 1]);
      }
    }
  }

  async function fetchMoreRelated() {
    if (!currentRelatedQuery) return;
    isFetchingRelated = true;
    
    const createSpinner = () => {
      const spinner = document.createElement('div');
      spinner.className = 'yt-related-spinner';
      spinner.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> <span>Loading...</span>';
      return spinner;
    };

    const spinnerMain = createSpinner();
    ytRelatedList.appendChild(spinnerMain);
    
    let spinnerOverlay = null;
    if(customOverlayList) {
      spinnerOverlay = createSpinner();
      customOverlayList.appendChild(spinnerOverlay);
    }

    try {
      const res = await fetch(RELATED_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: currentRelatedQuery, offset: currentRelatedOffset, limit: 6 }),
      });
      const body = await res.json();
      
      if (spinnerMain.parentNode) spinnerMain.parentNode.removeChild(spinnerMain);
      if (spinnerOverlay && spinnerOverlay.parentNode) spinnerOverlay.parentNode.removeChild(spinnerOverlay);

      if (body.success && body.data && body.data.length > 0) {
        currentRelatedOffset += body.data.length;
        appendRelated(body.data);
      }
    } catch (e) {
      if (spinnerMain.parentNode) spinnerMain.parentNode.removeChild(spinnerMain);
      if (spinnerOverlay && spinnerOverlay.parentNode) spinnerOverlay.parentNode.removeChild(spinnerOverlay);
    }
    isFetchingRelated = false;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  // ───────────────────────── EXIT YOUTUBE ─────────────────────────
  exitYtBtn.addEventListener("click", closeYoutubeMode);
  ytErrorBackBtn.addEventListener("click", closeYoutubeMode);

  // ───────────────────────── KEYBOARD SHORTCUTS ─────────────────────────
  document.addEventListener("keydown", (e) => {
    // Ignore keyboard shortcuts if the user is typing in a search box
    if (document.activeElement && document.activeElement.tagName === "INPUT") return;

    if (youtubeMode.classList.contains("active")) {
      if (e.key === "Escape") {
        closeYoutubeMode();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekBy(10);
        triggerSeekRipple(rippleRight);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekBy(-10);
        triggerSeekRipple(rippleLeft);
      } else if (e.key === " ") { // Spacebar
        e.preventDefault();
        if (player && player.getPlayerState) {
          const state = player.getPlayerState();
          if (state === YT.PlayerState.PLAYING) {
            player.pauseVideo();
          } else {
            player.playVideo();
          }
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (player && player.getVolume && player.setVolume) {
          const vol = Math.min(100, player.getVolume() + 5);
          player.setVolume(vol);
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (player && player.getVolume && player.setVolume) {
          const vol = Math.max(0, player.getVolume() - 5);
          player.setVolume(vol);
        }
      } else if (e.key === "m" || e.key === "M") {
        if (player && player.isMuted && player.mute && player.unMute) {
          if (player.isMuted()) {
            player.unMute();
          } else {
            player.mute();
          }
        }
      }
    }
  });

  // ───────────────────────── SEARCH ANOTHER VIDEO (inside YouTube Mode) ─────────────────────────
  async function handleYtSearch() {
    const query = ytSearchInput.value.trim();
    if (!query) return;

    ytError.classList.remove("active");
    ytLoading.classList.remove("hidden");
    if (player && player.stopVideo) player.stopVideo();
    stopProgressUpdater();
    resetProgressBar();

    try {
      const data = await fetchBestMatch(query);
      renderVideo(data);
    } catch (err) {
      showYtError(err.message);
    }
  }

  ytSearchBtn.addEventListener("click", handleYtSearch);
  ytSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleYtSearch();
    }
  });

  // ───────────────────────── INITIAL FOCUS ─────────────────────────
  window.addEventListener("load", () => {
    videoInput.focus();
  });

  console.log("🎥 S.N.E.T.C.H AI Video Player ready.");
})();
