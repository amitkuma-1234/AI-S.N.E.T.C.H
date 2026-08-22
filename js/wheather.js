// ============================================================
// WHEATHER.JS — S.N.E.T.C.H AI Weather Center
// ============================================================

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  // ---------- CONFIG ----------
  const API_CURRENT = '/api/wheather/current';
  const API_SEARCH = '/api/wheather/search';

  const SOUND_MAP = {
    sunny: 'weather_sound/sunny.mp3',
    rainy: 'weather_sound/rainy.mp3',
    cloudy: 'weather_sound/cloudy.mp3',
    windy: 'weather_sound/windy.mp3',
    snowy: 'weather_sound/snowy.mp3',
  };

  const ICON_MAP = {
    sunny: 'fa-sun',
    rainy: 'fa-cloud-showers-heavy',
    cloudy: 'fa-bolt',
    windy: 'fa-wind',
    snowy: 'fa-snowflake',
  };

  // ---------- DOM REFS ----------
  const homeBtn = document.getElementById('homeBtn');
  const locationInput = document.getElementById('locationInput');
  const getWeatherBtn = document.getElementById('getWeatherBtn');
  const validationMsg = document.getElementById('validationMessage');
  const resultCard = document.getElementById('weatherResult');

  const currentStatus = document.getElementById('currentStatus');
  const currentCard = document.getElementById('currentWeatherCard');

  const sceneRoot = document.getElementById('weather-scene');
  const soundToggle = document.getElementById('soundToggle');
  const audioEl = document.getElementById('weatherAudio');

  const rainLayer = document.getElementById('rainLayer');
  const splashLayer = document.getElementById('splashLayer');
  const snowLayer = document.getElementById('snowLayer');
  const windLines = document.getElementById('windLines');
  const dustLayer = document.getElementById('dustLayer');
  const leavesLayer = document.getElementById('leavesLayer');

  let soundEnabled = false;
  let currentScene = null;

  // ---------- HOME NAVIGATION ----------
  homeBtn.addEventListener('click', function (e) {
    e.preventDefault();
    window.location.href = '/';
  });

  // ---------- SPACE BACKGROUND: STARS & PARTICLES ----------
  function createStars() {
    const starsContainer = document.getElementById('stars');
    if (!starsContainer) return;
    const count = 220;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const star = document.createElement('div');
      star.className = 'star';
      star.style.width = Math.random() * 2.5 + 0.5 + 'px';
      star.style.height = star.style.width;
      star.style.top = Math.random() * 100 + '%';
      star.style.left = Math.random() * 100 + '%';
      star.style.boxShadow = '0 0 6px rgba(200,160,255,0.6)';
      star.style.animationDuration = (2 + Math.random() * 4) + 's';
      star.style.animationDelay = Math.random() * 3 + 's';
      frag.appendChild(star);
    }
    starsContainer.appendChild(frag);
  }

  function createParticles() {
    const container = document.getElementById('particles');
    if (!container) return;
    const count = 30;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      const size = 3 + Math.random() * 6;
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.top = Math.random() * 100 + '%';
      p.style.left = Math.random() * 100 + '%';
      p.style.animationDuration = 14 + Math.random() * 20 + 's';
      p.style.animationDelay = Math.random() * 12 + 's';
      p.style.background = `radial-gradient(circle, rgba(200,170,255,${0.3 + Math.random() * 0.5}), rgba(120,70,200,0.2))`;
      frag.appendChild(p);
    }
    container.appendChild(frag);
  }
  createStars();
  createParticles();

  // ---------- RIPPLE CLICK EFFECT ----------
  getWeatherBtn.addEventListener('click', function (e) {
    const rect = this.getBoundingClientRect();
    const ripple = document.createElement('span');
    const size = Math.max(rect.width, rect.height);
    Object.assign(ripple.style, {
      position: 'absolute',
      width: size + 'px',
      height: size + 'px',
      left: (e.clientX - rect.left - size / 2) + 'px',
      top: (e.clientY - rect.top - size / 2) + 'px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.25)',
      transform: 'scale(0)',
      animation: 'rippleAnim 0.6s ease-out',
      pointerEvents: 'none',
    });
    this.style.position = 'relative';
    this.style.overflow = 'hidden';
    this.appendChild(ripple);
    setTimeout(() => ripple.remove(), 700);
  });
  const rippleStyle = document.createElement('style');
  rippleStyle.textContent = `@keyframes rippleAnim { 0% { transform: scale(0); opacity: 0.6; } 100% { transform: scale(2.5); opacity: 0; } }`;
  document.head.appendChild(rippleStyle);

  // ============================================================
  // SCENE ENGINE — particle spawning per weather category
  // ============================================================
  function clearChildren(el) {
    if (el) el.innerHTML = '';
  }

  function spawnRain() {
    clearChildren(rainLayer);
    clearChildren(splashLayer);
    const dropCount = 90;
    const dropFrag = document.createDocumentFragment();
    for (let i = 0; i < dropCount; i++) {
      const drop = document.createElement('span');
      drop.className = 'raindrop';
      drop.style.left = Math.random() * 100 + '%';
      const duration = 0.5 + Math.random() * 0.5;
      drop.style.animationDuration = duration + 's';
      drop.style.animationDelay = Math.random() * 2 + 's';
      drop.style.height = 50 + Math.random() * 40 + 'px';
      dropFrag.appendChild(drop);
    }
    rainLayer.appendChild(dropFrag);

    const splashFrag = document.createDocumentFragment();
    for (let i = 0; i < 24; i++) {
      const splash = document.createElement('span');
      splash.className = 'splash';
      splash.style.left = Math.random() * 100 + '%';
      splash.style.animationDuration = (0.6 + Math.random() * 0.5) + 's';
      splash.style.animationDelay = Math.random() * 2 + 's';
      splashFrag.appendChild(splash);
    }
    splashLayer.appendChild(splashFrag);
  }

  function spawnSnow() {
    clearChildren(snowLayer);
    const flakeCount = 70;
    const frag = document.createDocumentFragment();
    const glyphs = ['❄', '❅', '❆'];
    for (let i = 0; i < flakeCount; i++) {
      const flake = document.createElement('span');
      flake.className = 'snowflake';
      flake.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
      flake.style.left = Math.random() * 100 + '%';
      flake.style.fontSize = (0.6 + Math.random() * 1.2) + 'rem';
      flake.style.animationDuration = (6 + Math.random() * 8) + 's';
      flake.style.animationDelay = Math.random() * 8 + 's';
      frag.appendChild(flake);
    }
    snowLayer.appendChild(frag);
  }

  function spawnWind() {
    clearChildren(windLines);
    clearChildren(dustLayer);
    clearChildren(leavesLayer);

    const lineFrag = document.createDocumentFragment();
    for (let i = 0; i < 18; i++) {
      const line = document.createElement('span');
      line.className = 'wind-line';
      line.style.top = Math.random() * 100 + '%';
      line.style.width = (60 + Math.random() * 120) + 'px';
      line.style.animationDuration = (1 + Math.random() * 1.4) + 's';
      line.style.animationDelay = Math.random() * 2 + 's';
      lineFrag.appendChild(line);
    }
    windLines.appendChild(lineFrag);

    const dustFrag = document.createDocumentFragment();
    for (let i = 0; i < 40; i++) {
      const dust = document.createElement('span');
      dust.className = 'dust-particle';
      dust.style.top = 60 + Math.random() * 38 + '%';
      dust.style.animationDuration = (2 + Math.random() * 2) + 's';
      dust.style.animationDelay = Math.random() * 3 + 's';
      dustFrag.appendChild(dust);
    }
    dustLayer.appendChild(dustFrag);

    const leafFrag = document.createDocumentFragment();
    for (let i = 0; i < 14; i++) {
      const leaf = document.createElement('span');
      leaf.className = 'leaf';
      leaf.textContent = '🍃';
      leaf.style.top = Math.random() * 70 + '%';
      leaf.style.animationDuration = (3 + Math.random() * 2.5) + 's';
      leaf.style.animationDelay = Math.random() * 4 + 's';
      leafFrag.appendChild(leaf);
    }
    leavesLayer.appendChild(leafFrag);
  }

  function primeScene(sceneName) {
    // (Re)generate the particle-based layers for a scene right before it's shown.
    if (sceneName === 'rainy') spawnRain();
    if (sceneName === 'snowy') spawnSnow();
    if (sceneName === 'windy') spawnWind();
  }

  // ---------- SOUND MANAGEMENT ----------
  function stopSound() {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
  }

  function playSoundFor(sceneName) {
    if (!soundEnabled) return;
    const src = SOUND_MAP[sceneName];
    if (!src) return;
    stopSound();
    audioEl.src = src;
    audioEl.volume = 0.55;
    // Autoplay may still be blocked in some browsers even after a prior
    // gesture; fail silently rather than throwing an unhandled rejection.
    audioEl.play().catch(() => {});
  }

  soundToggle.addEventListener('click', function () {
    soundEnabled = !soundEnabled;
    soundToggle.classList.toggle('on', soundEnabled);
    soundToggle.innerHTML = soundEnabled
      ? '<i class="fas fa-volume-high"></i>'
      : '<i class="fas fa-volume-xmark"></i>';
    if (soundEnabled && currentScene) {
      playSoundFor(currentScene);
    } else {
      stopSound();
    }
  });

  // ---------- APPLY SCENE + SOUND FOR A CONDITION ----------
  function applyScene(conditionType) {
    const scene = SOUND_MAP[conditionType] ? conditionType : 'cloudy';
    if (scene === currentScene) return;
    currentScene = scene;
    primeScene(scene);
    sceneRoot.setAttribute('data-scene', scene);
    playSoundFor(scene);
  }

  // ============================================================
  // WEATHER CARD RENDERING (shared by current + search cards)
  // ============================================================
  function fillCard(card, data) {
    const set = (field, value) => {
      const el = card.querySelector(`[data-field="${field}"]`);
      if (el) el.textContent = (value === null || value === undefined || value === '') ? '--' : value;
    };
    set('location', data.location + (data.country ? `, ${data.country}` : ''));
    set('temperature', data.temperature);
    set('condition', data.condition_text);
    set('feels_like', data.feels_like);
    set('humidity', data.humidity);
    set('wind_speed', data.wind_speed);
    set('visibility', data.visibility);
    set('pressure', data.pressure);
    set('uv_index', data.uv_index);
    set('sunrise', data.sunrise);
    set('sunset', data.sunset);

    const updated = data.last_updated ? formatLastUpdated(data.last_updated) : 'just now';
    set('last_updated', updated);

    const iconEl = card.querySelector('[data-field="icon"]');
    if (iconEl) {
      iconEl.className = 'fas ' + (ICON_MAP[data.condition_type] || 'fa-cloud');
    }

    card.style.display = 'block';
    card.style.animation = 'none';
    requestAnimationFrame(() => { card.style.animation = 'fadeSlide 0.5s ease'; });
  }

  function formatLastUpdated(isoLike) {
    try {
      const dt = new Date(isoLike);
      if (isNaN(dt.getTime())) return isoLike;
      return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return isoLike;
    }
  }

  // ============================================================
  // CURRENT LOCATION WEATHER (auto, on load)
  // ============================================================
  function setCurrentStatus(html, cls) {
    currentStatus.innerHTML = html;
    currentStatus.className = 'status-msg' + (cls ? ' ' + cls : '');
    currentStatus.style.display = 'flex';
  }

  async function loadCurrentLocationWeather() {
    if (!('geolocation' in navigator)) {
      setCurrentStatus('<i class="fas fa-triangle-exclamation"></i> Location detection is not supported by this browser.', 'error');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        try {
          setCurrentStatus('<span class="spinner"></span> Fetching current weather...');
          const res = await fetch(`${API_CURRENT}?lat=${latitude}&lon=${longitude}`);
          const payload = await res.json();
          if (!res.ok || !payload.success) {
            throw new Error(payload.error || 'Could not load current weather.');
          }
          currentStatus.style.display = 'none';
          fillCard(currentCard, payload.data);
          applyScene(payload.data.condition_type);
        } catch (err) {
          setCurrentStatus(`<i class="fas fa-triangle-exclamation"></i> ${err.message}`, 'error');
        }
      },
      (error) => {
        let msg = 'Could not detect your location.';
        if (error.code === error.PERMISSION_DENIED) {
          msg = 'Location access denied — search for a city below instead.';
        }
        setCurrentStatus(`<i class="fas fa-location-crosshairs"></i> ${msg}`, 'error');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }

  // ============================================================
  // SEARCH WEATHER
  // ============================================================
  function setValidation(message, type) {
    validationMsg.textContent = message;
    validationMsg.className = 'validation-msg ' + (type || '');
    if (type === 'success' || type === 'error') {
      setTimeout(() => {
        if (validationMsg.textContent === message) {
          validationMsg.textContent = '';
          validationMsg.className = 'validation-msg';
        }
      }, 5000);
    }
  }

  async function handleGetWeather() {
    const city = locationInput.value.trim();
    if (!city) {
      setValidation('📍 Please enter a city name', 'error');
      resultCard.style.display = 'none';
      return;
    }

    setValidation('⏳ Fetching weather...', '');
    getWeatherBtn.disabled = true;

    try {
      const res = await fetch(`${API_SEARCH}?city=${encodeURIComponent(city)}`);
      const payload = await res.json();
      if (!res.ok || !payload.success) {
        throw new Error(payload.error || 'Could not fetch weather for that city.');
      }
      fillCard(resultCard, payload.data);
      applyScene(payload.data.condition_type);
      setValidation('✅ Weather Loaded Successfully', 'success');
    } catch (err) {
      setValidation('⚠️ ' + err.message, 'error');
      resultCard.style.display = 'none';
    } finally {
      getWeatherBtn.disabled = false;
    }
  }

  getWeatherBtn.addEventListener('click', handleGetWeather);
  locationInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleGetWeather();
    }
  });
  locationInput.addEventListener('input', function () {
    if (/Required|Not Found|Unable|enter a city/i.test(validationMsg.textContent)) {
      validationMsg.textContent = '';
      validationMsg.className = 'validation-msg';
    }
  });

  // ---------- INIT ----------
  resultCard.style.display = 'none';
  currentCard.style.display = 'none';
  applyScene('sunny'); // sensible default scene while current location loads
  loadCurrentLocationWeather();

  console.log('🌤️ S.N.E.T.C.H AI Weather Center ready');
});