// ============================================================
// time.js — S.N.E.T.C.H Real‑Time Clock Dashboard
// Analog + Digital · Live updates · Space background
// Server-synced time · "Time Never Stops" cinematic stage
// ============================================================

(function() {
  'use strict';

  // ----- DOM refs -----
  const canvas = document.getElementById('analogCanvas');
  const ctx = canvas.getContext('2d');
  const digitalEl = document.getElementById('digitalClock');
  const ampmEl = document.getElementById('ampmDisplay');

  const dateEl = document.getElementById('dateValue');
  const monthEl = document.getElementById('monthValue');
  const yearEl = document.getElementById('yearValue');
  const dayEl = document.getElementById('dayValue');
  const weekEl = document.getElementById('weekValue');
  const syncStatusEl = document.getElementById('syncStatus');

  // home button
  const homeBtn = document.getElementById('homeBtn');

  // ----- BACKEND SYNC -----
  // Keeps the frontend clock aligned with the authoritative server time
  // (time.py -> /api/time/now), while still animating smoothly every
  // frame off the local clock in between syncs.
  let serverOffsetMs = 0;
  let serverSynced = false;

  function nowMs() {
    return Date.now() + serverOffsetMs;
  }

  function applyServerPayload(data) {
    serverOffsetMs = data.epoch_ms - Date.now();
    serverSynced = true;
    if (dateEl) dateEl.textContent = data.date;
    if (monthEl) monthEl.textContent = data.month;
    if (yearEl) yearEl.textContent = data.year;
    if (dayEl) dayEl.textContent = data.day;
    if (weekEl) weekEl.textContent = `Week ${data.week_number}`;
    if (syncStatusEl) syncStatusEl.textContent = 'Running...';
  }

  function syncServerTime() {
    fetch('/api/time/now', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('bad response');
        return res.json();
      })
      .then(applyServerPayload)
      .catch(() => {
        // Offline / route unavailable — keep running on the local clock.
        if (syncStatusEl) syncStatusEl.textContent = 'Running (local)';
      });
  }

  syncServerTime();
  setInterval(syncServerTime, 20000);

  // ----- space canvas (background) -----
  const spaceCanvas = document.getElementById('spaceCanvas');
  const sCtx = spaceCanvas.getContext('2d');
  let w, h;

  function resizeSpace() {
    w = spaceCanvas.width = window.innerWidth;
    h = spaceCanvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeSpace);
  resizeSpace();

  // ----- space objects -----
  const stars = [];
  const shootingStars = [];
  const asteroids = [];
  const nebulaPoints = [];

  // stars
  for (let i = 0; i < 280; i++) {
    stars.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.8 + 0.5,
      alpha: Math.random() * 0.8 + 0.2,
      speed: 0.002 + Math.random() * 0.008,
      phase: Math.random() * Math.PI * 2
    });
  }

  // shooting stars
  for (let i = 0; i < 5; i++) {
    shootingStars.push({
      x: Math.random() * w * 0.8,
      y: Math.random() * h * 0.5,
      len: 60 + Math.random() * 120,
      speed: 3 + Math.random() * 5,
      angle: -Math.PI / 4 + (Math.random() - 0.5) * 0.4,
      alpha: 0,
      life: 0,
      maxLife: 120 + Math.random() * 180,
      delay: Math.random() * 400
    });
  }

  // asteroids (floating dots)
  for (let i = 0; i < 20; i++) {
    asteroids.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 2 + Math.random() * 5,
      dx: (Math.random() - 0.5) * 0.3,
      dy: (Math.random() - 0.5) * 0.3,
      alpha: 0.2 + Math.random() * 0.3
    });
  }

  // nebula clouds (soft blobs)
  for (let i = 0; i < 12; i++) {
    nebulaPoints.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 120 + Math.random() * 300,
      alpha: 0.03 + Math.random() * 0.06,
      color: `hsla(${260 + Math.random() * 60}, 80%, 50%, `
    });
  }

  // ----- draw space background (animated) -----
  let frame = 0;

  function drawSpace() {
    sCtx.clearRect(0, 0, w, h);

    // deep space gradient
    const grad = sCtx.createRadialGradient(w*0.3, h*0.3, 100, w*0.5, h*0.5, w*0.9);
    grad.addColorStop(0, '#0f0620');
    grad.addColorStop(0.5, '#1a0a30');
    grad.addColorStop(1, '#05010e');
    sCtx.fillStyle = grad;
    sCtx.fillRect(0, 0, w, h);

    // nebula clouds
    nebulaPoints.forEach((n, i) => {
      const x = n.x + Math.sin(frame * 0.0003 + i) * 20;
      const y = n.y + Math.cos(frame * 0.0004 + i*1.2) * 15;
      const grd = sCtx.createRadialGradient(x, y, 10, x, y, n.r);
      const hue = 260 + i * 12 + Math.sin(frame * 0.001 + i) * 15;
      grd.addColorStop(0, `hsla(${hue}, 80%, 55%, ${n.alpha * 1.2})`);
      grd.addColorStop(0.6, `hsla(${hue + 30}, 70%, 40%, ${n.alpha * 0.6})`);
      grd.addColorStop(1, `hsla(${hue + 60}, 60%, 20%, 0)`);
      sCtx.fillStyle = grd;
      sCtx.beginPath();
      sCtx.arc(x, y, n.r, 0, Math.PI * 2);
      sCtx.fill();
    });

    // stars (twinkling)
    stars.forEach(s => {
      const alpha = s.alpha * (0.7 + 0.3 * Math.sin(frame * s.speed + s.phase));
      sCtx.beginPath();
      sCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      sCtx.fillStyle = `rgba(255, 240, 255, ${alpha})`;
      sCtx.fill();
      // glow
      if (s.r > 1.2) {
        sCtx.shadowColor = `rgba(200, 180, 255, ${alpha * 0.3})`;
        sCtx.shadowBlur = 12;
        sCtx.fill();
        sCtx.shadowBlur = 0;
      }
    });

    // asteroids (floating)
    asteroids.forEach(a => {
      a.x += a.dx;
      a.y += a.dy;
      if (a.x < 0 || a.x > w) a.dx *= -1;
      if (a.y < 0 || a.y > h) a.dy *= -1;
      sCtx.beginPath();
      sCtx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      sCtx.fillStyle = `rgba(180, 150, 220, ${a.alpha * 0.6})`;
      sCtx.fill();
      sCtx.shadowColor = `rgba(160, 120, 255, 0.1)`;
      sCtx.shadowBlur = 15;
      sCtx.fill();
      sCtx.shadowBlur = 0;
    });

    // shooting stars
    shootingStars.forEach(ss => {
      if (ss.delay > 0) { ss.delay -= 1; return; }
      ss.life += 1;
      if (ss.life > ss.maxLife) {
        ss.life = 0;
        ss.delay = 200 + Math.random() * 400;
        ss.x = Math.random() * w * 0.7;
        ss.y = Math.random() * h * 0.4;
        ss.len = 50 + Math.random() * 120;
        ss.speed = 3 + Math.random() * 6;
        ss.angle = -Math.PI / 4 + (Math.random() - 0.5) * 0.5;
        return;
      }
      const progress = ss.life / ss.maxLife;
      const alpha = Math.sin(progress * Math.PI) * 0.9;
      const x1 = ss.x + ss.life * ss.speed * Math.cos(ss.angle);
      const y1 = ss.y + ss.life * ss.speed * Math.sin(ss.angle);
      const x2 = x1 - ss.len * Math.cos(ss.angle);
      const y2 = y1 - ss.len * Math.sin(ss.angle);

      sCtx.beginPath();
      sCtx.moveTo(x1, y1);
      sCtx.lineTo(x2, y2);
      sCtx.strokeStyle = `rgba(255, 230, 255, ${alpha})`;
      sCtx.lineWidth = 1.8 + Math.random() * 0.5;
      sCtx.shadowColor = `rgba(200, 160, 255, ${alpha * 0.5})`;
      sCtx.shadowBlur = 30;
      sCtx.stroke();
      sCtx.shadowBlur = 0;
    });

    // light rays (subtle animated)
    for (let i = 0; i < 3; i++) {
      const angle = frame * 0.0005 + i * 2.1;
      const x = w * 0.5 + Math.sin(angle) * w * 0.35;
      const y = h * 0.5 + Math.cos(angle * 0.7) * h * 0.25;
      const grd = sCtx.createRadialGradient(x, y, 10, x, y, 200 + 100 * Math.sin(frame * 0.001 + i));
      grd.addColorStop(0, `rgba(160, 100, 255, 0.02)`);
      grd.addColorStop(1, `rgba(100, 50, 200, 0)`);
      sCtx.fillStyle = grd;
      sCtx.beginPath();
      sCtx.arc(x, y, 250, 0, Math.PI * 2);
      sCtx.fill();
    }

    frame++;
    requestAnimationFrame(drawSpace);
  }
  drawSpace();

  // ----- ANALOG CLOCK (canvas) -----
  function drawAnalogClock() {
    const now = new Date(nowMs());
    const hours = now.getHours() % 12;
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const millis = now.getMilliseconds();

    // smooth seconds with sub-frame
    const secFraction = (seconds + millis / 1000) / 60;
    const minFraction = (minutes + secFraction) / 60;
    const hourFraction = (hours + minFraction) / 12;

    const size = canvas.width;
    const center = size / 2;
    const radius = size * 0.42;

    ctx.clearRect(0, 0, size, size);

    // ---- outer glow ring ----
    ctx.shadowColor = '#8a4aff44';
    ctx.shadowBlur = 40;
    ctx.beginPath();
    ctx.arc(center, center, radius + 6, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(180, 130, 255, 0.08)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // ---- face (glass) ----
    const grd = ctx.createRadialGradient(center-20, center-20, 20, center, center, radius);
    grd.addColorStop(0, 'rgba(30, 18, 60, 0.3)');
    grd.addColorStop(0.8, 'rgba(10, 5, 25, 0.5)');
    grd.addColorStop(1, 'rgba(5, 2, 15, 0.7)');
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.shadowBlur = 0;

    // ---- inner glow ----
    const innerGrd = ctx.createRadialGradient(center-10, center-10, 10, center, center, radius*0.9);
    innerGrd.addColorStop(0, 'rgba(180, 140, 255, 0.03)');
    innerGrd.addColorStop(1, 'rgba(80, 40, 200, 0)');
    ctx.beginPath();
    ctx.arc(center, center, radius*0.92, 0, Math.PI * 2);
    ctx.fillStyle = innerGrd;
    ctx.fill();

    // ---- hour marks (neon) ----
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const isMain = i % 3 === 0;
      const len = isMain ? radius * 0.15 : radius * 0.08;
      const width = isMain ? 3 : 1.8;
      const x1 = center + Math.cos(angle) * (radius * 0.78);
      const y1 = center + Math.sin(angle) * (radius * 0.78);
      const x2 = center + Math.cos(angle) * (radius * 0.78 + len);
      const y2 = center + Math.sin(angle) * (radius * 0.78 + len);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = isMain ? '#d4c0ff' : '#a090cc';
      ctx.shadowColor = isMain ? '#b28affaa' : '#7a5acc66';
      ctx.shadowBlur = isMain ? 20 : 10;
      ctx.lineWidth = width;
      ctx.stroke();
    }

    // ---- minute marks (small) ----
    for (let i = 0; i < 60; i++) {
      if (i % 5 === 0) continue;
      const angle = (i / 60) * Math.PI * 2 - Math.PI / 2;
      const x1 = center + Math.cos(angle) * (radius * 0.82);
      const y1 = center + Math.sin(angle) * (radius * 0.82);
      const x2 = center + Math.cos(angle) * (radius * 0.88);
      const y2 = center + Math.sin(angle) * (radius * 0.88);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = 'rgba(160, 140, 210, 0.25)';
      ctx.lineWidth = 1;
      ctx.shadowBlur = 0;
      ctx.stroke();
    }

    // ---- neon numbers (12,3,6,9) ----
    ctx.shadowBlur = 0;
    ctx.font = `600 ${radius * 0.13}px 'Orbitron', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const numPos = [
      { num: '12', angle: -Math.PI/2 },
      { num: '3', angle: 0 },
      { num: '6', angle: Math.PI/2 },
      { num: '9', angle: Math.PI }
    ];
    numPos.forEach(({ num, angle }) => {
      const x = center + Math.cos(angle) * (radius * 0.7);
      const y = center + Math.sin(angle) * (radius * 0.7);
      ctx.fillStyle = '#d8c8ff';
      ctx.shadowColor = '#8a5effaa';
      ctx.shadowBlur = 18;
      ctx.fillText(num, x, y);
    });

    ctx.shadowBlur = 0;

    // ---- HOUR HAND ----
    const hourAngle = hourFraction * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(center, center);
    ctx.lineTo(center + Math.cos(hourAngle) * radius * 0.48, center + Math.sin(hourAngle) * radius * 0.48);
    ctx.strokeStyle = '#c6b0ff';
    ctx.lineWidth = 5;
    ctx.shadowColor = '#a06effcc';
    ctx.shadowBlur = 25;
    ctx.stroke();

    // ---- MINUTE HAND ----
    const minAngle = minFraction * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(center, center);
    ctx.lineTo(center + Math.cos(minAngle) * radius * 0.65, center + Math.sin(minAngle) * radius * 0.65);
    ctx.strokeStyle = '#b8d0ff';
    ctx.lineWidth = 3.5;
    ctx.shadowColor = '#3f9effaa';
    ctx.shadowBlur = 28;
    ctx.stroke();

    // ---- SECOND HAND (smooth) ----
    const secAngle = (seconds + millis / 1000) / 60 * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(center - Math.cos(secAngle) * radius * 0.15, center - Math.sin(secAngle) * radius * 0.15);
    ctx.lineTo(center + Math.cos(secAngle) * radius * 0.72, center + Math.sin(secAngle) * radius * 0.72);
    ctx.strokeStyle = '#ff8aae';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#ff6a9ecc';
    ctx.shadowBlur = 35;
    ctx.stroke();

    // ---- center cap (glowing) ----
    ctx.shadowBlur = 40;
    ctx.shadowColor = '#aa80ff';
    ctx.beginPath();
    ctx.arc(center, center, radius * 0.055, 0, Math.PI * 2);
    ctx.fillStyle = '#e0d0ff';
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // ----- UPDATE DIGITAL & INFO CARDS -----
  function updateDigitalAndCards() {
    const now = new Date(nowMs());
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const ampm = now.getHours() >= 12 ? 'PM' : 'AM';

    digitalEl.textContent = `${hh}:${mm}:${ss}`;
    ampmEl.textContent = ampm;

    // date / month / year / day / week are authoritative from the server
    // sync (/api/time/now) once it succeeds; until then, keep them fresh
    // from the local clock so the cards are never stuck or stale.
    if (!serverSynced) {
      const day = String(now.getDate()).padStart(2, '0');
      dateEl.textContent = day;

      const monthNames = ['January','February','March','April','May','June',
                          'July','August','September','October','November','December'];
      monthEl.textContent = monthNames[now.getMonth()];

      yearEl.textContent = now.getFullYear();

      const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      dayEl.textContent = dayNames[now.getDay()];

      const firstDayOfYear = new Date(now.getFullYear(), 0, 1);
      const pastDaysOfYear = (now - firstDayOfYear) / 86400000;
      const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
      weekEl.textContent = `Week ${weekNum}`;
    }
  }

  // ============================================================
  // "TIME NEVER STOPS" — cinematic SVG stage
  // A single, continuous, real-time 60-second cycle:
  //   • The character is permanently attached behind the real
  //     Second Hand, rotating with it, always inside the clock.
  //   • A thick rope connects them; the character pulls backward
  //     against the hand's rotation with visible, exhausting effort.
  //   • The Second Hand never slows, pauses, or stutters.
  //   • The character grows across every minute (small -> large),
  //     resetting instantly at the top of each new minute.
  //   • Premium barriers rise at 10s / 25s / 40s / 55s of every
  //     minute; each is progressively cracked, shattered, and
  //     finally destroyed in a cinematic explosion — forever.
  // No text communicates the story; it is told entirely through motion.
  // ============================================================
  const stageSvg = document.getElementById('stageSvg');

  if (stageSvg) {
    const stageWrapEl = document.getElementById('stageWrap');
    const handPivotEl = document.getElementById('handPivot');
    const hourHandEl = document.getElementById('hourHand');
    const minuteHandEl = document.getElementById('minuteHand');
    const hourTicksEl = document.getElementById('hourTicks');
    const minuteTicksEl = document.getElementById('minuteTicks');
    const ropePathEl = document.getElementById('ropePath');
    const ropeHighlightEl = document.getElementById('ropePathHighlight');
    const characterGroupEl = document.getElementById('characterGroup');
    const characterLeanEl = document.getElementById('characterLean');
    const barriersGroupEl = document.getElementById('barriersGroup');
    const debrisGroupEl = document.getElementById('debrisGroup');
    const explosionGroupEl = document.getElementById('explosionGroup');
    const cycleLabelEl = document.getElementById('cycleLabel');
    const stageParticlesEl = document.getElementById('stageParticles');

    const upperArmBackEl = document.getElementById('upperArmBack');
    const forearmBackEl = document.getElementById('forearmBack');
    const handBackEl = document.getElementById('handBack');
    const upperArmFrontEl = document.getElementById('upperArmFront');
    const forearmFrontEl = document.getElementById('forearmFront');
    const handFrontGripEl = document.getElementById('handFrontGrip');
    const thighBackEl = document.getElementById('thighBack');
    const shinBackEl = document.getElementById('shinBack');
    const footBackEl = document.getElementById('footBack');
    const thighFrontEl = document.getElementById('thighFront');
    const shinFrontEl = document.getElementById('shinFront');
    const footFrontEl = document.getElementById('footFront');
    const torsoEl = document.getElementById('torso');
    const headGroupEl = document.getElementById('headGroup');

    const NS = 'http://www.w3.org/2000/svg';
    const HAND_LEN = 150;      // second-hand tip radius
    const CHAR_R0 = 60;        // fixed radius of the character's base (hips)
    const MIN_SCALE = 0.30;
    const MAX_SCALE = 0.64;
    const BARRIER_R = 152;     // barriers sit right where the tip sweeps
    const BARRIER_SECONDS = [10, 25, 40, 55];

    // ---- draw static hour/minute ticks once ----
    (function drawTicks() {
      for (let i = 0; i < 60; i++) {
        const isHour = i % 5 === 0;
        const a = (i / 60) * Math.PI * 2;
        const rOuter = 148;
        const rInner = isHour ? 134 : 141;
        const x1 = Math.sin(a) * rOuter, y1 = -Math.cos(a) * rOuter;
        const x2 = Math.sin(a) * rInner, y2 = -Math.cos(a) * rInner;
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', x1.toFixed(1)); line.setAttribute('y1', y1.toFixed(1));
        line.setAttribute('x2', x2.toFixed(1)); line.setAttribute('y2', y2.toFixed(1));
        line.setAttribute('stroke', isHour ? '#d4c0ff' : 'rgba(160,140,210,0.3)');
        line.setAttribute('stroke-width', isHour ? '2.4' : '1');
        (isHour ? hourTicksEl : minuteTicksEl).appendChild(line);
      }
    })();

    // ---- floating cosmic dust particles confined to this panel ----
    (function spawnStageParticles() {
      const COUNT = 16;
      for (let i = 0; i < COUNT; i++) {
        const p = document.createElement('span');
        const startX = Math.random() * 100;
        const startY = 40 + Math.random() * 60;
        const dx = (Math.random() - 0.5) * 90;
        const dy = -120 - Math.random() * 140;
        const dur = 9 + Math.random() * 10;
        const delay = Math.random() * 10;
        p.style.left = startX + '%';
        p.style.top = startY + '%';
        p.style.setProperty('--dust-dx', dx.toFixed(0) + 'px');
        p.style.setProperty('--dust-dy', dy.toFixed(0) + 'px');
        p.style.animationDuration = dur.toFixed(1) + 's';
        p.style.animationDelay = '-' + delay.toFixed(1) + 's';
        stageParticlesEl.appendChild(p);
      }
    })();

    // ---- rotate a local point by degrees, matching SVG rotate() semantics ----
    function rotPt(x, y, deg) {
      const r = deg * Math.PI / 180;
      const c = Math.cos(r), s = Math.sin(r);
      return { x: x * c - y * s, y: x * s + y * c };
    }

    // ---- pre-build the 4 barrier elements once; only their stage/visibility change ----
    const barriers = BARRIER_SECONDS.map((sec) => {
      const angleDeg = (sec / 60) * 360;
      const rad = angleDeg * Math.PI / 180;
      const bx = Math.sin(rad) * BARRIER_R;
      const by = -Math.cos(rad) * BARRIER_R;

      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'barrier-group');
      g.setAttribute('transform', `translate(${bx.toFixed(1)},${by.toFixed(1)}) rotate(${angleDeg.toFixed(1)})`);

      const shape = document.createElementNS(NS, 'rect');
      shape.setAttribute('x', -30); shape.setAttribute('y', -10);
      shape.setAttribute('width', 60); shape.setAttribute('height', 20);
      shape.setAttribute('rx', 5);
      shape.setAttribute('class', 'barrier-shape');
      g.appendChild(shape);

      const core = document.createElementNS(NS, 'rect');
      core.setAttribute('x', -22); core.setAttribute('y', -5);
      core.setAttribute('width', 44); core.setAttribute('height', 10);
      core.setAttribute('rx', 3);
      core.setAttribute('class', 'barrier-core');
      g.appendChild(core);

      // crack paths (progressively revealed by CSS via data-stage)
      const crackDefs = [
        { cls: 'c1', d: 'M -6 -9 L 2 -1 L -3 4 L 5 9' },
        { cls: 'c2', d: 'M 10 -9 L 4 -2 L 12 6' },
        { cls: 'c1', d: 'M -20 -6 L -12 0 L -20 6' },
        { cls: 'c2', d: 'M 20 -7 L 16 1 L 22 8' }
      ];
      crackDefs.forEach((c) => {
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', c.d);
        p.setAttribute('class', 'barrier-crack ' + c.cls);
        g.appendChild(p);
      });

      // sparks
      for (let i = 0; i < 4; i++) {
        const sp = document.createElementNS(NS, 'circle');
        sp.setAttribute('r', 1.4);
        sp.setAttribute('cx', (-20 + i * 13).toFixed(1));
        sp.setAttribute('cy', (-6 + (i % 2 === 0 ? -3 : 5)).toFixed(1));
        sp.setAttribute('class', 'barrier-spark');
        g.appendChild(sp);
      }

      barriersGroupEl.appendChild(g);
      return { sec, angleDeg, bx, by, el: g, firedThisCycle: false, timers: [] };
    });

    function clearBarrierTimers(b) {
      b.timers.forEach((id) => clearTimeout(id));
      b.timers = [];
    }

    function resetBarrier(b) {
      clearBarrierTimers(b);
      b.el.removeAttribute('data-stage');
      b.el.style.opacity = '1';
      b.firedThisCycle = false;
    }

    function shake(intensity) {
      const cls = intensity === 'heavy' ? 'cam-shake-heavy' : 'cam-shake-light';
      stageWrapEl.classList.remove('cam-shake-light', 'cam-shake-heavy');
      // force reflow so the animation can restart if triggered again quickly
      void stageWrapEl.offsetWidth;
      stageWrapEl.classList.add(cls);
      setTimeout(() => stageWrapEl.classList.remove(cls), 500);
    }

    function spawnDebris(x, y, count, kinds) {
      for (let i = 0; i < count; i++) {
        const el = document.createElementNS(NS, kinds && Math.random() < 0.35 ? 'circle' : 'rect');
        const size = 3 + Math.random() * 6;
        const kindClass = ['metal', 'crystal', 'spark-frag'][Math.floor(Math.random() * 3)];
        if (el.tagName === 'circle') {
          el.setAttribute('r', size / 2);
        } else {
          el.setAttribute('x', -size / 2);
          el.setAttribute('y', -size / 2);
          el.setAttribute('width', size);
          el.setAttribute('height', size);
        }
        el.setAttribute('class', 'debris-piece ' + kindClass);
        // Position purely via CSS transform (never mix with the SVG
        // `transform` attribute, which CSS would silently override).
        el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
        el.style.transformBox = 'fill-box';
        el.style.transformOrigin = 'center';
        el.style.transition = `transform ${0.5 + Math.random() * 0.4}s cubic-bezier(.16,.84,.4,1), opacity 0.7s ease`;
        debrisGroupEl.appendChild(el);

        const ang = Math.random() * Math.PI * 2;
        const dist = 30 + Math.random() * 90;
        requestAnimationFrame(() => {
          el.style.transform = `translate(${(x + Math.cos(ang) * dist).toFixed(1)}px, ${(y + Math.sin(ang) * dist - 20).toFixed(1)}px) rotate(${Math.floor(Math.random() * 500)}deg)`;
          el.style.opacity = '0';
        });
        setTimeout(() => el.remove(), 950);
      }
    }

    function spawnExplosion(x, y) {
      const burst = document.createElementNS(NS, 'circle');
      burst.setAttribute('cx', x); burst.setAttribute('cy', y);
      burst.setAttribute('r', 6);
      burst.setAttribute('class', 'explosion-burst');
      burst.style.transformBox = 'fill-box';
      burst.style.transformOrigin = 'center';
      explosionGroupEl.appendChild(burst);

      const shock = document.createElementNS(NS, 'circle');
      shock.setAttribute('cx', x); shock.setAttribute('cy', y);
      shock.setAttribute('r', 4);
      shock.setAttribute('class', 'explosion-shock');
      shock.style.transformBox = 'fill-box';
      shock.style.transformOrigin = 'center';
      explosionGroupEl.appendChild(shock);

      const flash = document.createElementNS(NS, 'circle');
      flash.setAttribute('cx', x); flash.setAttribute('cy', y);
      flash.setAttribute('r', 60);
      flash.setAttribute('class', 'explosion-flash');
      explosionGroupEl.appendChild(flash);

      requestAnimationFrame(() => {
        burst.style.transition = 'transform 0.4s ease-out, opacity 0.45s ease-out';
        burst.style.transform = 'scale(9)';
        burst.style.opacity = '0.9';
        shock.style.transition = 'transform 0.5s ease-out, opacity 0.5s ease-out';
        shock.style.transform = 'scale(14)';
        shock.style.opacity = '0';
        flash.style.transition = 'opacity 0.35s ease-out';
        flash.style.opacity = '0';
      });

      setTimeout(() => { burst.style.opacity = '0'; }, 220);
      setTimeout(() => { burst.remove(); shock.remove(); flash.remove(); }, 650);

      spawnDebris(x, y, 14, true);
      shake('heavy');
    }

    function triggerBarrierDestruction(b) {
      b.firedThisCycle = true;
      b.el.setAttribute('data-stage', '1');
      shake('light');

      b.timers.push(setTimeout(() => { b.el.setAttribute('data-stage', '2'); shake('light'); }, 140));
      b.timers.push(setTimeout(() => { b.el.setAttribute('data-stage', '3'); shake('light'); }, 280));
      b.timers.push(setTimeout(() => {
        b.el.setAttribute('data-stage', '4');
        spawnExplosion(b.bx, b.by);
        // Fade only (never touch the g's transform attribute — CSS transform
        // on inner shapes handles the shrink so the group's position/rotation
        // set via the SVG `transform` attribute is never overridden).
        b.el.style.transition = 'opacity 0.18s ease';
        b.el.style.opacity = '0';
      }, 410));
    }

    let lastIntSecond = -1;

    function updateStage() {
      const t = nowMs();
      const nowDate = new Date(t);
      const hours = nowDate.getHours() % 12;
      const minutes = nowDate.getMinutes();
      const seconds = nowDate.getSeconds();
      const ms = nowDate.getMilliseconds();
      const secFrac = seconds + ms / 1000;

      // ---- new minute detection: reset growth cycle + all barriers ----
      const intSecond = seconds;
      if (intSecond < lastIntSecond) {
        barriers.forEach(resetBarrier);
      }
      lastIntSecond = intSecond;

      // ---- hour / minute hands (real, continuous) ----
      const minFrac = (minutes + secFrac / 60) / 60;
      const hourFrac = (hours + minFrac) / 12;
      hourHandEl.setAttribute('transform', `rotate(${(hourFrac * 360).toFixed(2)})`);
      minuteHandEl.setAttribute('transform', `rotate(${(minFrac * 360).toFixed(2)})`);

      // ---- giant second hand: always smooth, never pauses ----
      const secAngleDeg = (secFrac / 60) * 360;
      handPivotEl.setAttribute('transform', `rotate(${secAngleDeg.toFixed(3)})`);
      const rad = secAngleDeg * Math.PI / 180;
      const tipX = Math.sin(rad) * HAND_LEN;
      const tipY = -Math.cos(rad) * HAND_LEN;

      // ---- character growth across this minute, resets each minute ----
      const growth = secFrac / 60;
      const scale = MIN_SCALE + (MAX_SCALE - MIN_SCALE) * growth;

      // ---- character permanently attached behind the second hand ----
      const baseX = Math.sin(rad) * CHAR_R0;
      const baseY = -Math.cos(rad) * CHAR_R0;
      characterGroupEl.setAttribute('transform', `translate(${baseX.toFixed(2)},${baseY.toFixed(2)}) rotate(${secAngleDeg.toFixed(3)}) scale(${scale.toFixed(3)})`);

      // ---- continuous straining / pulling motion (opposite the rotation) ----
      const lean = -16 + Math.sin(t / 240) * 3.2 + Math.sin(t / 63) * 1.1;   // strain + tiny shake
      const breath = 1 + Math.sin(t / 480) * 0.02;
      const slide = Math.sin(t / 170) * 3.5;
      const shoulderSway = Math.sin(t / 210) * 6;
      const gripFlex = Math.sin(t / 140) * 5;
      const headBob = Math.sin(t / 300) * 3;

      characterLeanEl.setAttribute('transform', `rotate(${lean.toFixed(2)})`);
      torsoEl.setAttribute('transform', `scale(1, ${breath.toFixed(3)})`);
      headGroupEl.setAttribute('transform', `translate(0, ${headBob.toFixed(2)})`);

      // front arm — reaching back opposite the rotation, gripping the rope hard
      const faShoulder = { x: 10, y: -78 };
      const faElbowOffset = rotPt(24, -20, -18 - shoulderSway);
      const faElbow = { x: faShoulder.x + faElbowOffset.x, y: faShoulder.y + faElbowOffset.y };
      upperArmFrontEl.setAttribute('x1', faShoulder.x); upperArmFrontEl.setAttribute('y1', faShoulder.y);
      upperArmFrontEl.setAttribute('x2', faElbow.x.toFixed(1)); upperArmFrontEl.setAttribute('y2', faElbow.y.toFixed(1));
      const faHand = { x: faElbow.x + rotPt(20, 16, gripFlex).x, y: faElbow.y + rotPt(20, 16, gripFlex).y };
      forearmFrontEl.setAttribute('x1', faElbow.x.toFixed(1)); forearmFrontEl.setAttribute('y1', faElbow.y.toFixed(1));
      forearmFrontEl.setAttribute('x2', faHand.x.toFixed(1)); forearmFrontEl.setAttribute('y2', faHand.y.toFixed(1));
      handFrontGripEl.setAttribute('transform', `translate(${faHand.x.toFixed(1)},${faHand.y.toFixed(1)}) rotate(${(gripFlex * 2).toFixed(1)})`);

      // back arm — braced, swinging slightly for counterbalance
      const baShoulder = { x: -10, y: -78 };
      const baElbow = { x: baShoulder.x + rotPt(-20, 26, shoulderSway * 0.6).x, y: baShoulder.y + rotPt(-20, 26, shoulderSway * 0.6).y };
      upperArmBackEl.setAttribute('x1', baShoulder.x); upperArmBackEl.setAttribute('y1', baShoulder.y);
      upperArmBackEl.setAttribute('x2', baElbow.x.toFixed(1)); upperArmBackEl.setAttribute('y2', baElbow.y.toFixed(1));
      const baHand = { x: baElbow.x + rotPt(-10, 28, -shoulderSway * 0.4).x, y: baElbow.y + rotPt(-10, 28, -shoulderSway * 0.4).y };
      forearmBackEl.setAttribute('x1', baElbow.x.toFixed(1)); forearmBackEl.setAttribute('y1', baElbow.y.toFixed(1));
      forearmBackEl.setAttribute('x2', baHand.x.toFixed(1)); forearmBackEl.setAttribute('y2', baHand.y.toFixed(1));
      handBackEl.setAttribute('cx', baHand.x.toFixed(1)); handBackEl.setAttribute('cy', baHand.y.toFixed(1));

      // legs — pushing / sliding for grip against the pull
      thighBackEl.setAttribute('x2', (-22 + slide).toFixed(1));
      shinBackEl.setAttribute('x1', (-22 + slide).toFixed(1));
      shinBackEl.setAttribute('x2', (-30 + slide * 1.4).toFixed(1));
      footBackEl.setAttribute('d', `M ${(-30 + slide * 1.4).toFixed(1)} 66 L ${(-42 + slide * 1.6).toFixed(1)} 70`);

      thighFrontEl.setAttribute('x2', (20 - slide).toFixed(1));
      shinFrontEl.setAttribute('x1', (20 - slide).toFixed(1));
      shinFrontEl.setAttribute('x2', (26 - slide * 1.4).toFixed(1));
      footFrontEl.setAttribute('d', `M ${(26 - slide * 1.4).toFixed(1)} 68 L ${(40 - slide * 1.6).toFixed(1)} 73`);

      // ---- rope: character's gripping hand -> hand tip, with tension + sway ----
      const gripLocal = { x: faHand.x, y: faHand.y };
      const gripAfterLean = rotPt(gripLocal.x, gripLocal.y, lean);
      const gripScaled = { x: gripAfterLean.x * scale, y: gripAfterLean.y * scale };
      const gripRotated = rotPt(gripScaled.x, gripScaled.y, secAngleDeg);
      const gripWorld = { x: baseX + gripRotated.x, y: baseY + gripRotated.y };

      const wobble1 = Math.sin(t / 95) * 5;
      const wobble2 = Math.sin(t / 47 + 1.3) * 2.2;
      const midX = (gripWorld.x + tipX) / 2 + Math.cos(rad) * (wobble1 + wobble2);
      const midY = (gripWorld.y + tipY) / 2 + Math.sin(rad) * (wobble1 + wobble2);
      const d = `M ${gripWorld.x.toFixed(1)} ${gripWorld.y.toFixed(1)} Q ${midX.toFixed(1)} ${midY.toFixed(1)} ${tipX.toFixed(1)} ${tipY.toFixed(1)}`;
      ropePathEl.setAttribute('d', d);
      ropeHighlightEl.setAttribute('d', d);
      ropePathEl.setAttribute('stroke-dasharray', '9 3');

      // ---- barrier collision check: fire once per pass, right as the hand reaches it ----
      barriers.forEach((b) => {
        const diff = Math.abs(secFrac - b.sec);
        const wrapped = Math.abs(secFrac - b.sec - 60);
        const closeEnough = Math.min(diff, wrapped) < 0.09;
        if (closeEnough && !b.firedThisCycle) {
          triggerBarrierDestruction(b);
        }
      });

      // ---- live label (numbers only, no story text — motion tells the story) ----
      if (cycleLabelEl) {
        cycleLabelEl.textContent = String(seconds).padStart(2, '0') + 's';
      }

      requestAnimationFrame(updateStage);
    }

    updateStage();
  }

  // ----- LOOP (60 fps) -----
  function tick() {
    drawAnalogClock();
    updateDigitalAndCards();
    requestAnimationFrame(tick);
  }

  // ----- HOME BUTTON (navigation) -----
  homeBtn.addEventListener('click', function() {
    window.location.href = '/';
  });

  // ----- INIT -----
  // handle canvas sizing
  function resizeCanvas() {
    const wrapper = canvas.parentElement;
    const rect = wrapper.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height, 400);
    canvas.width = size;
    canvas.height = size;
    // redraw immediately
    drawAnalogClock();
  }

  window.addEventListener('resize', resizeCanvas);
  // initial size after layout
  setTimeout(resizeCanvas, 50);

  // start tick loop
  tick();

  // also update on visibility change (keep accurate)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      updateDigitalAndCards();
    }
  });

})();