// ===== S.N.E.T.C.H — MAPS & NAVIGATION AI =====
document.addEventListener('DOMContentLoaded', () => {

  // ---- DOM refs ----
  const homeBtn = document.getElementById('homeBtn');
  const startBtn = document.getElementById('startBtn');
  const welcomeScreen = document.getElementById('welcomeScreen');
  const assistantScreen = document.getElementById('assistantScreen');
  const micBtn = document.getElementById('micBtn');
  const micStatus = document.getElementById('micStatus');
  const queryInput = document.getElementById('queryInput');
  const sendBtn = document.getElementById('sendBtn');
  const startVoiceBtn = document.getElementById('startVoiceBtn');
  const stopVoiceBtn = document.getElementById('stopVoiceBtn');
  const clearBtn = document.getElementById('clearBtn');
  const resultsFeed = document.getElementById('resultsFeed');
  const examplesList = document.getElementById('examplesList');

  // ---- State ----
  let userLat = null;
  let userLon = null;
  let locationDenied = false;
  let recognition = null;
  let isListening = false;
  let isProcessing = false;

  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ─────────────────────────────────────────
  //  GEOLOCATION
  // ─────────────────────────────────────────
  function requestLocation() {
    if (!('geolocation' in navigator)) {
      locationDenied = true;
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLat = pos.coords.latitude;
        userLon = pos.coords.longitude;
        locationDenied = false;
      },
      () => {
        locationDenied = true;
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }

  // ─────────────────────────────────────────
  //  ACTIVATION (Start Location AI)
  // ─────────────────────────────────────────
  function activate() {
    welcomeScreen.style.display = 'none';
    assistantScreen.classList.remove('hidden');
    requestLocation();
    startListening(); // auto-activate microphone
  }
  startBtn.addEventListener('click', activate);

  // ---- Home ----
  homeBtn.addEventListener('click', () => {
    window.location.href = '/';
  });

  // ─────────────────────────────────────────
  //  SPEECH RECOGNITION
  // ─────────────────────────────────────────
  function ensureRecognition() {
    if (recognition || !SpeechRecognitionCtor) return recognition;
    recognition = new SpeechRecognitionCtor();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isListening = true;
      micBtn.classList.add('listening');
      micStatus.textContent = 'Listening… speak your location request';
    };

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      // Show recognized text live; user may still edit it before sending.
      queryInput.value = transcript;
      autoGrow();
    };

    recognition.onerror = (event) => {
      isListening = false;
      micBtn.classList.remove('listening');
      if (event.error === 'not-allowed' || event.error === 'permission-denied') {
        micStatus.textContent = 'Microphone permission denied.';
        showError('Microphone access was denied. Please allow microphone permission in your browser settings to use voice input.');
      } else if (event.error === 'no-speech') {
        micStatus.textContent = 'No speech detected. Tap the mic to try again.';
      } else {
        micStatus.textContent = 'Voice recognition failed. Tap the mic to try again.';
        showError('Speech recognition failed. You can also type your question below.');
      }
    };

    recognition.onend = () => {
      isListening = false;
      micBtn.classList.remove('listening');
      if (queryInput.value.trim()) {
        micStatus.textContent = 'Got it! Edit if needed, then press send.';
      } else {
        micStatus.textContent = 'Tap the mic or type your question…';
      }
    };

    return recognition;
  }

  function startListening() {
    if (!SpeechRecognitionCtor) {
      micStatus.textContent = 'Voice input isn\u2019t supported in this browser — please type instead.';
      return;
    }
    const rec = ensureRecognition();
    if (!rec || isListening) return;
    try {
      rec.start();
    } catch (e) {
      // Recognition may already be starting; ignore duplicate start errors.
    }
  }

  function stopListening() {
    if (recognition && isListening) {
      recognition.stop();
    }
    isListening = false;
    micBtn.classList.remove('listening');
    micStatus.textContent = 'Voice stopped. Tap the mic or type your question…';
  }

  micBtn.addEventListener('click', () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });

  startVoiceBtn.addEventListener('click', startListening);
  stopVoiceBtn.addEventListener('click', stopListening);

  clearBtn.addEventListener('click', () => {
    queryInput.value = '';
    autoGrow();
    resultsFeed.innerHTML = '';
  });

  // ─────────────────────────────────────────
  //  INPUT HANDLING
  // ─────────────────────────────────────────
  function autoGrow() {
    queryInput.style.height = 'auto';
    queryInput.style.height = Math.min(queryInput.scrollHeight, 120) + 'px';
  }
  queryInput.addEventListener('input', autoGrow);
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitQuery();
    }
  });
  sendBtn.addEventListener('click', submitQuery);

  // ---- Example chips ----
  examplesList.addEventListener('click', (e) => {
    const chip = e.target.closest('.example-chip');
    if (!chip) return;
    if (assistantScreen.classList.contains('hidden')) {
      activate();
    }
    queryInput.value = chip.textContent.trim();
    autoGrow();
    submitQuery();
  });

  // ─────────────────────────────────────────
  //  SUBMIT — talk to /api/location/query
  // ─────────────────────────────────────────
  async function submitQuery() {
    const text = queryInput.value.trim();
    if (!text || isProcessing) return;

    queryInput.value = '';
    autoGrow();
    isProcessing = true;
    sendBtn.disabled = true;

    const loadingCard = showLoading(text);

    if (!navigator.onLine) {
      loadingCard.remove();
      showError('No internet connection. Please check your network and try again.', text);
      isProcessing = false;
      sendBtn.disabled = false;
      return;
    }

    try {
      const res = await fetch('/api/location/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lat: userLat, lon: userLon }),
      });
      const data = await res.json();
      loadingCard.remove();
      renderResult(data, text);
    } catch (err) {
      loadingCard.remove();
      showError('Something went wrong reaching the maps service. Please try again.', text);
    } finally {
      isProcessing = false;
      sendBtn.disabled = false;
    }
  }

  // ─────────────────────────────────────────
  //  RENDERING
  // ─────────────────────────────────────────
  function showLoading(queryText) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="query-echo">${escapeHtml(queryText)}</div>
      <div class="loading-dots"><span>●</span><span>●</span><span>●</span> Finding your answer…</div>
    `;
    resultsFeed.prepend(card);
    return card;
  }

  function showError(message, queryText) {
    const card = document.createElement('div');
    card.className = 'error-card';
    card.innerHTML = `
      <i class="fas fa-triangle-exclamation"></i>
      <div>
        ${queryText ? `<div class="query-echo">${escapeHtml(queryText)}</div>` : ''}
        <div>${escapeHtml(message)}</div>
      </div>
    `;
    resultsFeed.prepend(card);
  }

  function openLink(url) {
    if (url) window.open(url, '_blank', 'noopener');
  }

  function fieldHtml(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return `<div class="field"><strong>${escapeHtml(label)}</strong>${escapeHtml(String(value))}</div>`;
  }

  function renderResult(data, queryText) {
    if (!data || data.type === 'error') {
      showError((data && data.message) || 'Something went wrong. Please try again.', queryText);
      return;
    }

    if (data.type === 'open_maps') {
      openLink(data.google_maps_url);
      const card = document.createElement('div');
      card.className = 'result-card';
      card.innerHTML = `
        <div class="query-echo">${escapeHtml(queryText)}</div>
        <div class="headline">${escapeHtml(data.message)}</div>
        <div class="card-actions">
          <a class="card-btn" href="${data.google_maps_url}" target="_blank" rel="noopener">
            <i class="fas fa-map"></i> Open Google Maps
          </a>
        </div>
      `;
      resultsFeed.prepend(card);
      return;
    }

    if (data.type === 'current_location') {
      const card = document.createElement('div');
      card.className = 'result-card';
      card.innerHTML = `
        <div class="query-echo">${escapeHtml(queryText)}</div>
        <div class="headline"><i class="fas fa-location-dot"></i> ${escapeHtml(data.location_name)}</div>
        <div class="field-grid">
          ${fieldHtml('Address', data.address)}
          ${fieldHtml('Coordinates', `${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}`)}
        </div>
        <div class="card-actions">
          <a class="card-btn" href="${data.google_maps_url}" target="_blank" rel="noopener">
            <i class="fas fa-map"></i> Open in Google Maps
          </a>
        </div>
      `;
      resultsFeed.prepend(card);
      return;
    }

    if (data.type === 'weather') {
      const card = document.createElement('div');
      card.className = 'result-card';
      card.innerHTML = `
        <div class="query-echo">${escapeHtml(queryText)}</div>
        <div class="headline"><i class="fas fa-cloud-sun"></i> ${escapeHtml(data.location_name)}</div>
        <div class="field-grid">
          ${fieldHtml('Temperature', `${data.temperature_c}°C`)}
          ${fieldHtml('Wind Speed', `${data.windspeed_kmh} km/h`)}
        </div>
        <div class="card-actions">
          <a class="card-btn" href="${data.google_maps_url}" target="_blank" rel="noopener">
            <i class="fas fa-map"></i> View on Map
          </a>
        </div>
      `;
      resultsFeed.prepend(card);
      return;
    }

    if (data.type === 'nearby') {
      const items = (data.results || []).map((p) => `
        <div class="place-item">
          <div class="place-name">${escapeHtml(p.name)}</div>
          <div class="place-address">${escapeHtml(p.address)}</div>
          <div class="place-distance"><i class="fas fa-route"></i> ${p.distance_km} km away</div>
          <div class="card-actions">
            <a class="card-btn" href="${p.navigation_url}" target="_blank" rel="noopener">
              <i class="fas fa-diamond-turn-right"></i> Navigate
            </a>
            <a class="card-btn secondary" href="${p.google_maps_url}" target="_blank" rel="noopener">
              <i class="fas fa-map"></i> Open in Google Maps
            </a>
          </div>
        </div>
      `).join('');

      const card = document.createElement('div');
      card.className = 'result-card';
      card.innerHTML = `
        <div class="query-echo">${escapeHtml(queryText)}</div>
        <div class="headline"><i class="fas fa-list"></i> ${escapeHtml(data.message)}</div>
        <div class="place-list">${items}</div>
      `;
      resultsFeed.prepend(card);
      return;
    }

    if (data.type === 'navigate' || data.type === 'distance') {
      const summary = (data.route_summary || []).map(s => `• ${escapeHtml(s)}`).join('<br>');
      const card = document.createElement('div');
      card.className = 'result-card';
      card.innerHTML = `
        <div class="query-echo">${escapeHtml(queryText)}</div>
        <div class="headline"><i class="fas fa-diamond-turn-right"></i> ${escapeHtml(data.message)}</div>
        <div class="field-grid">
          ${fieldHtml('Starting Location', data.origin)}
          ${fieldHtml('Destination', data.destination)}
          ${fieldHtml('Total Distance', data.distance_km != null ? `${data.distance_km} km` : 'Unavailable')}
          ${fieldHtml('Estimated Time', data.duration_min != null ? `${data.duration_min} min` : 'Unavailable')}
        </div>
        ${data.note ? `<div class="note"><i class="fas fa-circle-info"></i> ${escapeHtml(data.note)}</div>` : ''}
        ${summary ? `<div class="route-summary">${summary}</div>` : ''}
        <div class="card-actions">
          ${data.navigation_url ? `
            <a class="card-btn" href="${data.navigation_url}" target="_blank" rel="noopener">
              <i class="fas fa-diamond-turn-right"></i> Open Navigation
            </a>` : ''}
          <a class="card-btn secondary" href="${data.google_maps_url}" target="_blank" rel="noopener">
            <i class="fas fa-map"></i> Open in Google Maps
          </a>
        </div>
      `;
      resultsFeed.prepend(card);
      return;
    }

    // Fallback — unknown but non-error type
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="query-echo">${escapeHtml(queryText)}</div>
      <div class="headline">${escapeHtml(data.message || 'Here is what I found.')}</div>
    `;
    resultsFeed.prepend(card);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  console.log('S.N.E.T.C.H Maps & Navigation AI ready.');
});
