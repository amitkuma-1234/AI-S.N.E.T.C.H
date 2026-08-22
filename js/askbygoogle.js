/**
 * askbygoogle.js — S.N.E.T.C.H Web AI Search
 *
 * Flow
 * ----
 * 1. User types query and clicks Send (or presses Enter).
 * 2. Frontend POSTs { query } to /api/askbygoogle/search.
 * 3. Backend optimises the query and returns { original, optimized, url }.
 * 4. Frontend opens Google in a new tab automatically.
 * 5. A chat-style history entry is appended showing user query,
 *    optimised query, timestamp, and an "Open in Google" link.
 */

(function () {
  "use strict";

  /* ── DOM refs ──────────────────────────────────────────────────── */
  const homeBtn        = document.getElementById("homeBtn");
  const welcomeScreen  = document.getElementById("welcomeScreen");
  const searchInput    = document.getElementById("searchInput");
  const searchBtn      = document.getElementById("searchBtn");
  const micBtn         = document.getElementById("micBtn");
  const suggestionChips = document.getElementById("suggestionChips");
  const chatHistory    = document.getElementById("chatHistory");
  const loadingOverlay = document.getElementById("loadingOverlay");

  /* ── state ─────────────────────────────────────────────────────── */
  let isListening = false;
  let hasSearched = false;   // tracks whether any search has been done

  /* ─────────────────────────────────────────────────────────────────
     VIEW HELPERS
  ───────────────────────────────────────────────────────────────── */

  function showChatView() {
    welcomeScreen.classList.add("hidden");
    suggestionChips.classList.add("hidden");
    chatHistory.classList.remove("hidden");
  }

  function showWelcomeView() {
    welcomeScreen.classList.remove("hidden");
    suggestionChips.classList.remove("hidden");
    chatHistory.classList.add("hidden");
    chatHistory.innerHTML = "";
    hasSearched = false;
  }

  function setLoading(on) {
    if (on) {
      loadingOverlay.classList.remove("hidden");
    } else {
      loadingOverlay.classList.add("hidden");
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     TIMESTAMP HELPER
  ───────────────────────────────────────────────────────────────── */

  function nowStamp() {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  /* ─────────────────────────────────────────────────────────────────
     APPEND CHAT ENTRY
     Shows: user bubble + status bubble (optimised query + open link)
  ───────────────────────────────────────────────────────────────── */

  function appendChatEntry(original, optimized, googleUrl) {
    const entry = document.createElement("div");
    entry.className = "chat-entry";

    /* User bubble */
    const userBubble = document.createElement("div");
    userBubble.className = "chat-user";
    userBubble.textContent = original;

    /* Status bubble */
    const statusBubble = document.createElement("div");
    statusBubble.className = "chat-status";

    const label = document.createElement("div");
    label.className = "status-label";
    label.textContent = "Search Status";

    const origLine = document.createElement("div");
    origLine.className = "status-original";
    origLine.textContent = `Original: ${original}`;

    const optLine = document.createElement("div");
    optLine.className = "status-optimized";
    optLine.textContent = `Query: ${optimized}`;

    const openBtn = document.createElement("a");
    openBtn.className = "open-google-btn";
    openBtn.href = googleUrl;
    openBtn.target = "_blank";
    openBtn.rel = "noopener noreferrer";
    openBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8
                 a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      Open in Google
    `;

    statusBubble.appendChild(label);
    statusBubble.appendChild(origLine);
    statusBubble.appendChild(optLine);
    statusBubble.appendChild(openBtn);

    /* Timestamp */
    const ts = document.createElement("div");
    ts.className = "chat-timestamp";
    ts.textContent = nowStamp();

    entry.appendChild(userBubble);
    entry.appendChild(statusBubble);
    entry.appendChild(ts);
    chatHistory.appendChild(entry);

    /* Scroll to bottom */
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }

  /* ─────────────────────────────────────────────────────────────────
     PERFORM SEARCH — calls /api/askbygoogle/search
  ───────────────────────────────────────────────────────────────── */

  async function performSearch(rawQuery) {
    const query = (rawQuery || "").trim();
    if (!query) {
      searchInput.focus();
      return;
    }

    /* Switch to chat view on first search */
    if (!hasSearched) {
      hasSearched = true;
      showChatView();
    }

    setLoading(true);
    searchInput.value = "";
    searchInput.focus();

    try {
      const response = await fetch("/api/askbygoogle/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        throw new Error(data.error || "Search failed.");
      }

      const { original, optimized, url } = data;

      /* Append chat entry BEFORE opening the new tab so the UI
         updates are visible instantly */
      appendChatEntry(original, optimized, url);

      /* Automatically open Google in a new tab */
      window.open(url, "_blank", "noopener,noreferrer");

    } catch (err) {
      console.error("[S.N.E.T.C.H] Search error:", err);

      /* Show inline error entry in chat */
      const errorEntry = document.createElement("div");
      errorEntry.className = "chat-entry";
      const errorBubble = document.createElement("div");
      errorBubble.className = "chat-status";
      errorBubble.innerHTML = `
        <div class="status-label">Error</div>
        <div class="status-original">${err.message || "An unexpected error occurred."}</div>
      `;
      errorEntry.appendChild(errorBubble);
      chatHistory.appendChild(errorEntry);
      chatHistory.scrollTop = chatHistory.scrollHeight;
    } finally {
      setLoading(false);
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     SEARCH BUTTON & ENTER KEY
  ───────────────────────────────────────────────────────────────── */

  searchBtn.addEventListener("click", () => performSearch(searchInput.value));

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      performSearch(searchInput.value);
    }
  });

  /* ─────────────────────────────────────────────────────────────────
     SUGGESTION CHIPS
  ───────────────────────────────────────────────────────────────── */

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", function () {
      const query = this.getAttribute("data-query") || this.textContent.trim();
      performSearch(query);
    });
  });

  /* ─────────────────────────────────────────────────────────────────
     HOME BUTTON — navigate back to dashboard
  ───────────────────────────────────────────────────────────────── */

  homeBtn.addEventListener("click", () => {
    window.location.href = "/";
  });

  /* ─────────────────────────────────────────────────────────────────
     VOICE SEARCH (microphone)
  ───────────────────────────────────────────────────────────────── */

  let recognition = null;
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => {
      isListening = true;
      micBtn.classList.add("listening");
    };

    recognition.onend = () => {
      isListening = false;
      micBtn.classList.remove("listening");
    };

    recognition.onerror = (evt) => {
      console.warn("[Voice] error:", evt.error);
      isListening = false;
      micBtn.classList.remove("listening");
    };

    recognition.onresult = (evt) => {
      const transcript = evt.results[0][0].transcript.trim();
      if (transcript) {
        searchInput.value = transcript;
        performSearch(transcript);
      }
    };
  } else {
    /* Voice not supported — dim the button */
    micBtn.style.opacity = "0.3";
    micBtn.title = "Voice search not supported in this browser";
    micBtn.style.cursor = "default";
  }

  micBtn.addEventListener("click", () => {
    if (!recognition) return;
    if (isListening) {
      try { recognition.stop(); } catch (_) {}
    } else {
      try { recognition.start(); } catch (_) {}
    }
  });

  /* ─────────────────────────────────────────────────────────────────
     PREMIUM SPACE BACKGROUND (canvas)
     Stars are dim/subtle, elegant shooting stars, deep nebula
  ───────────────────────────────────────────────────────────────── */

  (function initSpaceCanvas() {
    const canvas = document.getElementById("spaceCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let W, H;

    /* ── resize ── */
    function resize() {
      W = canvas.width  = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }
    window.addEventListener("resize", resize);
    resize();

    /* ── stars: fewer, dimmer, subtler ── */
    const NUM_STARS = 900;
    const stars = [];
    for (let i = 0; i < NUM_STARS; i++) {
      stars.push({
        x:       Math.random() * W,
        y:       Math.random() * H,
        r:       Math.random() * 1.1 + 0.2,          // smaller
        alpha:   Math.random() * 0.28 + 0.06,         // much dimmer
        twinkle: Math.random() * 0.012 + 0.003,
        drift:   (Math.random() - 0.5) * 0.008,
      });
    }

    /* ── shooting stars: smooth, cinematic ── */
    const NUM_SHOOTERS = 5;
    const shooters = [];
    for (let i = 0; i < NUM_SHOOTERS; i++) {
      shooters.push(createShooter());
    }

    function createShooter() {
      return {
        active:  false,
        x: 0, y: 0,
        vx: 0, vy: 0,
        tailLen: 0,
        alpha:   0,
        life:    0,
        maxLife: 0,
      };
    }

    function resetShooter(s) {
      s.active  = true;
      s.x       = Math.random() * W * 0.7;
      s.y       = Math.random() * H * 0.4;
      const angle = Math.PI / 4 + (Math.random() - 0.5) * 0.5;
      const speed = 3.5 + Math.random() * 5.5;
      s.vx      = Math.cos(angle) * speed;
      s.vy      = Math.sin(angle) * speed;
      s.tailLen = 55 + Math.random() * 90;
      s.life    = 0;
      s.maxLife = 55 + Math.random() * 55;
      s.alpha   = 0;
    }

    /* Stagger initial start times */
    shooters.forEach((s, i) => {
      setTimeout(() => {
        if (Math.random() > 0.5) resetShooter(s);
      }, i * 1800);
    });

    /* ── floating particles ── */
    const NUM_PARTICLES = 28;
    const particles = [];
    for (let i = 0; i < NUM_PARTICLES; i++) {
      particles.push({
        x:  Math.random() * W,
        y:  Math.random() * H,
        r:  Math.random() * 1.4 + 0.4,
        vy: -(Math.random() * 0.12 + 0.04),
        vx: (Math.random() - 0.5) * 0.06,
        alpha: Math.random() * 0.12 + 0.03,
        col: Math.random() > 0.5 ? "180,130,255" : "90,120,255",
      });
    }

    /* ── render loop ── */
    let frame = 0;
    function draw() {
      frame++;
      ctx.clearRect(0, 0, W, H);

      /* Deep space nebula layers */
      const neb1 = ctx.createRadialGradient(W * 0.25, H * 0.3, 0, W * 0.25, H * 0.3, W * 0.65);
      neb1.addColorStop(0, "rgba(80, 30, 180, 0.065)");
      neb1.addColorStop(0.5, "rgba(40, 15, 100, 0.03)");
      neb1.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = neb1;
      ctx.fillRect(0, 0, W, H);

      const neb2 = ctx.createRadialGradient(W * 0.75, H * 0.15, 0, W * 0.75, H * 0.15, W * 0.55);
      neb2.addColorStop(0, "rgba(30, 60, 200, 0.05)");
      neb2.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = neb2;
      ctx.fillRect(0, 0, W, H);

      const neb3 = ctx.createRadialGradient(W * 0.5, H * 0.75, 0, W * 0.5, H * 0.75, W * 0.5);
      neb3.addColorStop(0, "rgba(100, 40, 200, 0.04)");
      neb3.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = neb3;
      ctx.fillRect(0, 0, W, H);

      /* Stars — dim, soft twinkling */
      stars.forEach((s) => {
        const tw  = Math.sin(frame * s.twinkle + s.x) * 0.07;
        const a   = Math.max(0, Math.min(0.55, s.alpha + tw));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(230, 220, 255, ${a})`;
        ctx.fill();

        /* Very subtle glow only on larger stars */
        if (s.r > 0.85) {
          const gGrad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 3.5);
          gGrad.addColorStop(0, `rgba(200, 170, 255, ${a * 0.18})`);
          gGrad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = gGrad;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 3.5, 0, Math.PI * 2);
          ctx.fill();
        }

        s.x += s.drift;
        s.y += s.drift * 0.5;
        if (s.x < 0) s.x = W;
        if (s.x > W) s.x = 0;
        if (s.y < 0) s.y = H;
        if (s.y > H) s.y = 0;
      });

      /* Floating particles */
      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.y < -4) { p.y = H + 4; p.x = Math.random() * W; }
        const pGrad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3);
        pGrad.addColorStop(0, `rgba(${p.col}, ${p.alpha * 2.2})`);
        pGrad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = pGrad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2);
        ctx.fill();
      });

      /* Shooting stars — smooth fade in/out, cinematic tail */
      shooters.forEach((s) => {
        if (!s.active) {
          /* Random spawn chance — spread out over time */
          if (Math.random() < 0.0006) resetShooter(s);
          return;
        }
        s.life++;
        if (s.life > s.maxLife) { s.active = false; return; }

        const progress = s.life / s.maxLife;
        /* Ease-in ease-out opacity: peak at middle of life */
        const fade = progress < 0.25
          ? progress / 0.25
          : progress > 0.75
            ? (1 - progress) / 0.25
            : 1;
        const alpha = fade * 0.75;

        s.x += s.vx;
        s.y += s.vy;

        const tailX = s.x - s.vx * (s.tailLen / (Math.sqrt(s.vx * s.vx + s.vy * s.vy) || 1));
        const tailY = s.y - s.vy * (s.tailLen / (Math.sqrt(s.vx * s.vx + s.vy * s.vy) || 1));

        const grad = ctx.createLinearGradient(tailX, tailY, s.x, s.y);
        grad.addColorStop(0, `rgba(255, 255, 255, 0)`);
        grad.addColorStop(0.6, `rgba(210, 180, 255, ${alpha * 0.4})`);
        grad.addColorStop(1, `rgba(255, 255, 255, ${alpha})`);

        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(s.x, s.y);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.4 - progress * 0.8;
        ctx.shadowColor = "rgba(180, 130, 255, 0.6)";
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0;

        /* Head glow */
        const hGrad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 4);
        hGrad.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
        hGrad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = hGrad;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
        ctx.fill();
      });

      requestAnimationFrame(draw);
    }

    draw();
  })();

})();
