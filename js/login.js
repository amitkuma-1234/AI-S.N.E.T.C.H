/* ═══════════════════════════════════════════════════════════════
   CINEMATIC SPACE BACKGROUND
   ═══════════════════════════════════════════════════════════════ */
const canvas = document.getElementById('bg');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, T = 0;

var stars = [];
function buildStars() {
  stars = [];
  var count = Math.floor(W * H / 1400);
  for (var i = 0; i < count; i++) {
    var rnd = Math.random();
    stars.push({
      x: Math.random() * W, y: Math.random() * H,
      r: rnd < 0.55 ? 0.4 : rnd < 0.85 ? 0.8 : rnd < 0.96 ? 1.4 : 2.2,
      a: 0.3 + Math.random() * 0.7, ph: Math.random() * 6.28,
      sp: 0.4 + Math.random() * 1.4,
      hue: [0,0,0,210,260,40][Math.floor(Math.random()*6)],
      tinted: Math.random() < 0.25
    });
  }
}

function drawStars() {
  for (var i = 0; i < stars.length; i++) {
    var s = stars[i];
    var tw = s.a * (0.5 + 0.5 * Math.sin(T * s.sp + s.ph));
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.28);
    ctx.fillStyle = s.tinted ? 'hsla('+s.hue+',65%,88%,'+tw+')' : 'rgba(220,228,255,'+tw+')';
    ctx.fill();
    if (s.r > 1.3) {
      var g = ctx.createRadialGradient(s.x,s.y,0,s.x,s.y,s.r*8);
      g.addColorStop(0,'rgba(180,200,255,'+(tw*0.4)+')'); g.addColorStop(1,'rgba(0,0,0,0)');
      ctx.beginPath(); ctx.arc(s.x,s.y,s.r*8,0,6.28); ctx.fillStyle=g; ctx.fill();
    }
  }
}

var NEB = [
  {cx:0.12,cy:0.20,r:350,hue:255,a:0.055},{cx:0.85,cy:0.14,r:280,hue:195,a:0.048},
  {cx:0.58,cy:0.80,r:400,hue:305,a:0.042},{cx:0.30,cy:0.62,r:230,hue:225,a:0.036},
  {cx:0.72,cy:0.50,r:190,hue:165,a:0.030}
];
function drawNebulas() {
  for (var i = 0; i < NEB.length; i++) {
    var n = NEB[i], r = n.r * (1 + 0.04 * Math.sin(T * 0.2 + i));
    var g = ctx.createRadialGradient(n.cx*W,n.cy*H,0,n.cx*W,n.cy*H,r);
    g.addColorStop(0,'hsla('+n.hue+',80%,55%,'+n.a+')');
    g.addColorStop(0.5,'hsla('+n.hue+',65%,38%,'+(n.a*0.3)+')');
    g.addColorStop(1,'rgba(0,0,0,0)');
    ctx.save(); ctx.scale(1,0.6);
    ctx.beginPath(); ctx.arc(n.cx*W,n.cy*H/0.6,r,0,6.28);
    ctx.fillStyle=g; ctx.fill(); ctx.restore();
  }
}

var meteors = [], frags = [];
function spawnMeteor() {
  var fromLeft = Math.random() < 0.5;
  var speed = 8 + Math.random() * 14;
  var angle = fromLeft ? (0.15 + Math.random()*0.3) : (Math.PI - 0.15 - Math.random()*0.3);
  var cols = ['#ffffff','#c8d8ff','#C084FC','#38BDF8','#ffd580','#ff9eb5'];
  meteors.push({
    x: fromLeft ? -60 : W+60, y: H * (0.04 + Math.random()*0.6),
    vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed,
    len: 80+Math.random()*160, life: 1.0, fade: 0.010+Math.random()*0.014,
    width: 1.0+Math.random()*2.0, color: cols[Math.floor(Math.random()*cols.length)],
    burst: false, bThresh: 0.2+Math.random()*0.35
  });
}
function spawnFrags(x,y,vx,vy,color) {
  var n = 5+Math.floor(Math.random()*6);
  for (var i=0;i<n;i++) {
    var baseAng=Math.atan2(vy,vx), ang=baseAng+(Math.random()-0.5)*2.2, spd=1.5+Math.random()*3.5;
    frags.push({x,y,vx:Math.cos(ang)*spd+vx*0.08,vy:Math.sin(ang)*spd+vy*0.08,r:0.5+Math.random()*1.5,life:0.8+Math.random()*0.2,fade:0.020+Math.random()*0.025,color});
  }
}
function toHex(a){var v=Math.round(Math.max(0,Math.min(1,a))*255);return v.toString(16).padStart(2,'0')}

function drawMeteors() {
  for (var i=meteors.length-1;i>=0;i--) {
    var m=meteors[i]; var spd=Math.sqrt(m.vx*m.vx+m.vy*m.vy);
    var tx=m.x-m.vx*(m.len/spd), ty=m.y-m.vy*(m.len/spd);
    var gr=ctx.createLinearGradient(m.x,m.y,tx,ty);
    gr.addColorStop(0,'rgba(255,255,255,'+(m.life*0.95)+')');
    gr.addColorStop(0.2,m.color+toHex(m.life*0.8));
    gr.addColorStop(0.7,m.color+toHex(m.life*0.2));
    gr.addColorStop(1,'rgba(0,0,0,0)');
    ctx.beginPath();ctx.moveTo(m.x,m.y);ctx.lineTo(tx,ty);
    ctx.strokeStyle=gr;ctx.lineWidth=m.width*m.life;ctx.lineCap='round';ctx.stroke();
    var hg=ctx.createRadialGradient(m.x,m.y,0,m.x,m.y,8*m.life);
    hg.addColorStop(0,'rgba(255,255,255,'+m.life+')');
    hg.addColorStop(0.4,m.color+toHex(m.life*0.5));
    hg.addColorStop(1,'rgba(0,0,0,0)');
    ctx.beginPath();ctx.arc(m.x,m.y,8*m.life,0,6.28);ctx.fillStyle=hg;ctx.fill();
    m.x+=m.vx;m.y+=m.vy;m.life-=m.fade;
    if(!m.burst&&m.life<m.bThresh){m.burst=true;spawnFrags(m.x,m.y,m.vx,m.vy,m.color)}
    if(m.life<=0||m.x<-300||m.x>W+300||m.y>H+200||m.y<-200)meteors.splice(i,1);
  }
}
function drawFrags() {
  for (var i=frags.length-1;i>=0;i--) {
    var f=frags[i];
    var g=ctx.createRadialGradient(f.x,f.y,0,f.x,f.y,f.r*4);
    g.addColorStop(0,'rgba(255,255,255,'+(f.life*0.85)+')');
    g.addColorStop(0.5,f.color+toHex(f.life*0.5));g.addColorStop(1,'rgba(0,0,0,0)');
    ctx.beginPath();ctx.arc(f.x,f.y,f.r*4,0,6.28);ctx.fillStyle=g;ctx.fill();
    f.x+=f.vx;f.y+=f.vy;f.vy+=0.035;f.life-=f.fade;f.r*=0.97;
    if(f.life<=0)frags.splice(i,1);
  }
}

(function spawnLoop(){spawnMeteor();setTimeout(spawnLoop,500+Math.random()*1200)})();

function draw() {
  var bg = ctx.createRadialGradient(W*0.5,H*0.42,0,W*0.5,H*0.42,Math.max(W,H)*0.9);
  bg.addColorStop(0,'#0e0b22');bg.addColorStop(0.4,'#070410');bg.addColorStop(1,'#010008');
  ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
  drawNebulas();drawStars();drawFrags();drawMeteors();
}
function tick(){T+=0.013;draw();requestAnimationFrame(tick)}
function resize(){W=canvas.width=window.innerWidth;H=canvas.height=window.innerHeight;buildStars()}
window.addEventListener('resize',resize);resize();tick();


/* ═══════════════════════════════════════════════════════════════
   AUTH LOGIC
   ═══════════════════════════════════════════════════════════════ */

const GOOGLE_CLIENT_ID = "{{ google_client_id }}";
const GOOGLE_CALLBACK_URI = "{{ google_callback_uri }}";

/* ── Auto-redirect: if user already has a valid token, skip login ── */
(function autoRedirect() {
  const token = localStorage.getItem('snetch_access_token');
  if (!token) return;
  // Quick check — if the token exists and isn't expired, go to dashboard
  fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => { if (r.ok) window.location.replace('/?authed=1'); })
    .catch(() => {});
})();
let _pendingOtpEmail = '';
let _pendingOtpPassword = '';
let _otpFlowSource = 'register'; // 'register' | 'login-recovery'
let _otpPurpose = 'verify_email';
let _otpTimerInterval = null;
let _otpResendCooldown = null;
let _resetTimerInterval = null;
let _resetResendCooldown = null;
let _pendingResetEmail = '';
let _resetToken = '';

/* ── Token Storage ── */
function storeTokens(data) {
  // If a different user is logging in, wipe previous user's cached data
  // to ensure complete workspace isolation between accounts.
  try {
    const prev = JSON.parse(localStorage.getItem('snetch_user') || '{}');
    if (data.user && prev.id && data.user.id !== prev.id) {
      // Different user logging in → clear everything from previous session
      const keysToKeep = [];   // nothing to keep
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith('snetch_')) {
          localStorage.removeItem(key);
        }
      }
    }
  } catch(e) { /* ignore parse errors */ }

  if (data.access_token) localStorage.setItem('snetch_access_token', data.access_token);
  if (data.refresh_token) localStorage.setItem('snetch_refresh_token', data.refresh_token);
  if (data.user) localStorage.setItem('snetch_user', JSON.stringify(data.user));
}

function clearTokens() {
  localStorage.removeItem('snetch_access_token');
  localStorage.removeItem('snetch_refresh_token');
  localStorage.removeItem('snetch_user');
}

/* ── Toast Notifications ── */
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; }, 3500);
  setTimeout(() => toast.remove(), 4000);
}

/* ── Tab Switching ── */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('content-' + tab).classList.add('active');
  hideAlert();
}

/* ── Alert ── */
function showAlert(msg, type = 'error') {
  const el = document.getElementById('global-alert');
  el.textContent = msg;
  el.className = 'global-alert show ' + type;
}
function hideAlert() {
  document.getElementById('global-alert').className = 'global-alert';
}

/* ── Shake ── */
function shakeField(fieldId) {
  const el = document.getElementById(fieldId);
  if (el) {
    const wrap = el.closest('.field');
    if (wrap) { wrap.classList.add('shake'); setTimeout(() => wrap.classList.remove('shake'), 400); }
  }
}

/* ── Password Toggle ── */
function togglePass(inputId) {
  const inp = document.getElementById(inputId);
  const btn = inp.parentElement.querySelector('.eye-btn svg');
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2"/>';
  } else {
    inp.type = 'password';
    btn.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  }
}

/* ── Password Strength ── */
function updateStrength(val) {
  const bar = document.getElementById('pwd-bar');
  let score = 0;
  if (val.length >= 6) score++;
  if (val.length >= 10) score++;
  if (/[A-Z]/.test(val)) score++;
  if (/[0-9]/.test(val)) score++;
  if (/[^A-Za-z0-9]/.test(val)) score++;
  const pct = [0,20,40,65,85,100][score];
  const colors = ['var(--border)','var(--danger)','#fb923c','#facc15','#4ade80','var(--success)'];
  bar.style.width = pct + '%';
  bar.style.background = colors[score];
}

/* ── Email Login ── */
async function handleLogin() {
  hideAlert();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('login-btn');
  let valid = true;

  document.getElementById('login-email-err').classList.remove('show');
  document.getElementById('login-pass-err').classList.remove('show');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('login-email-err').classList.add('show');
    shakeField('login-email'); valid = false;
  }
  if (password.length < 6) {
    document.getElementById('login-pass-err').classList.add('show');
    shakeField('login-password'); valid = false;
  }
  if (!valid) return;

  btn.classList.add('loading');
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const d = await r.json();

    if (r.ok && d.status === 'ok') {
      storeTokens(d);
      btn.classList.remove('loading');
      document.getElementById('card').classList.add('success');
      btn.querySelector('.btn-text').textContent = '✓ Signed in';
      showToast('Welcome back!', 'success');
      setTimeout(() => { window.location.href = '/?authed=1'; }, 1000);
    } else {
      btn.classList.remove('loading');
      if (d.needs_verification) {
        _pendingOtpEmail = d.email || email;
        _pendingOtpPassword = password;
        _otpFlowSource = 'login-recovery';
        openOTPModal();
        showToast('Please verify your email first.', 'info');
      } else {
        showAlert(d.error || 'Login failed.');
        if (d.remaining_attempts !== undefined) {
          showToast(`${d.remaining_attempts} attempts remaining`, 'error');
        }
      }
    }
  } catch (e) {
    btn.classList.remove('loading');
    showAlert('Network error. Please try again.');
  }
}

/* ── Email Registration ── */
async function handleRegister() {
  hideAlert();
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm = document.getElementById('reg-confirm').value;
  const btn = document.getElementById('register-btn');
  let valid = true;

  ['reg-user-err','reg-email-err','reg-pass-err','reg-confirm-err'].forEach(
    id => document.getElementById(id).classList.remove('show')
  );

  if (!username || username.length < 2) {
    document.getElementById('reg-user-err').classList.add('show');
    shakeField('reg-username'); valid = false;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('reg-email-err').classList.add('show');
    shakeField('reg-email'); valid = false;
  }
  if (password.length < 6) {
    document.getElementById('reg-pass-err').classList.add('show');
    shakeField('reg-password'); valid = false;
  }
  if (password !== confirm) {
    document.getElementById('reg-confirm-err').classList.add('show');
    shakeField('reg-confirm'); valid = false;
  }
  if (!valid) return;

  btn.classList.add('loading');
  try {
    const r = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, password })
    });
    const d = await r.json();

    btn.classList.remove('loading');

    if (d.status === 'otp_sent') {
      _pendingOtpEmail = email;
      _pendingOtpPassword = password;
      _otpFlowSource = 'register';
      showToast(d.message || 'Verification code sent!', 'success');
      openOTPModal();
    } else {
      showAlert(d.error || 'Registration failed.');
    }
  } catch (e) {
    btn.classList.remove('loading');
    showAlert('Network error. Please try again.');
  }
}

/* ── Google Sign-In (server redirect — no origin_mismatch) ── */
function handleGoogleSignIn() {
  window.location.href = '/api/auth/google/start';
}

/* ── OTP Modal ── */
function openOTPModal() {
  _otpPurpose = 'verify_email';
  const modal = document.getElementById('otp-modal');
  document.getElementById('otp-email-display').textContent = _pendingOtpEmail;
  modal.classList.add('show');

  const inputs = document.querySelectorAll('#otp-inputs .otp-input');
  inputs.forEach(inp => { inp.value = ''; });
  inputs[0].focus();

  // Start timer
  startOtpTimer(600); // 10 minutes
  startResendCooldown(30); // 30 second cooldown
}

function closeOTPModal() {
  document.getElementById('otp-modal').classList.remove('show');
  if (_otpTimerInterval) clearInterval(_otpTimerInterval);
  if (_otpResendCooldown) clearInterval(_otpResendCooldown);
}

function startOtpTimer(seconds) {
  if (_otpTimerInterval) clearInterval(_otpTimerInterval);
  let remaining = seconds;
  const el = document.getElementById('otp-timer');
  const update = () => {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    el.innerHTML = `Code expires in <strong>${m}:${String(s).padStart(2,'0')}</strong>`;
    if (remaining <= 0) {
      clearInterval(_otpTimerInterval);
      el.innerHTML = '<strong style="color:var(--danger)">Code expired — request a new one</strong>';
    }
    remaining--;
  };
  update();
  _otpTimerInterval = setInterval(update, 1000);
}

function startResendCooldown(seconds) {
  if (_otpResendCooldown) clearInterval(_otpResendCooldown);
  const btn = document.getElementById('otp-resend');
  let remaining = seconds;
  btn.disabled = true;
  const update = () => {
    if (remaining <= 0) {
      clearInterval(_otpResendCooldown);
      btn.disabled = false;
      btn.textContent = 'Resend code';
    } else {
      btn.textContent = `Resend code (${remaining}s)`;
      remaining--;
    }
  };
  update();
  _otpResendCooldown = setInterval(update, 1000);
}

async function resendOTP() {
  const btn = document.getElementById('otp-resend');
  btn.disabled = true;
  try {
    const r = await fetch('/api/auth/resend-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: _pendingOtpEmail, purpose: _otpPurpose })
    });
    const d = await r.json();
    showToast(d.message || 'Code sent!', r.ok ? 'success' : 'error');
    if (r.ok) {
      startOtpTimer(600);
      startResendCooldown(60);
    } else {
      btn.disabled = false;
    }
  } catch (e) {
    showToast('Failed to resend. Try again.', 'error');
    btn.disabled = false;
  }
}

async function verifyOTP() {
    const inputs = document.querySelectorAll('#otp-inputs .otp-input');
  const code = Array.from(inputs).map(i => i.value).join('');
  if (code.length !== 6) { showToast('Enter all 6 digits.', 'error'); return; }

  const btn = document.getElementById('otp-verify-btn');
  btn.classList.add('loading');

  try {
    const r = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: _pendingOtpEmail, code })
    });
    const d = await r.json();

    btn.classList.remove('loading');

    if (r.ok && d.status === 'ok') {
      closeOTPModal();

      if (_otpFlowSource === 'register') {
        // Spec: after verifying a brand-new account, return to the Login
        // page with the just-used credentials pre-filled — the user only
        // has to click "Login" once more.
        switchTab('signin');
        document.getElementById('login-email').value = _pendingOtpEmail;
        document.getElementById('login-password').value = _pendingOtpPassword;
        document.getElementById('login-email-err').classList.remove('show');
        document.getElementById('login-pass-err').classList.remove('show');
        showToast('Email verified! Please sign in to continue.', 'success');
        document.getElementById('login-btn').focus();
      } else {
        // Verification triggered mid-login (account already had the right
        // password checked once) — safe to finish signing them in directly.
        storeTokens(d);
        showToast('Email verified! Redirecting...', 'success');
        document.getElementById('card').classList.add('success');
        setTimeout(() => { window.location.href = '/?authed=1'; }, 1000);
      }
    } else {
      showToast(d.error || 'Verification failed.', 'error');
      inputs.forEach(i => { i.value = ''; });
      inputs[0].focus();
    }
  } catch (e) {
    btn.classList.remove('loading');
    showToast('Network error. Try again.', 'error');
  }
}

/* ── OTP Input Navigation ── */
function setupOtpInputs(selector, onComplete) {
  const inputs = document.querySelectorAll(selector);
  inputs.forEach((input, idx, arr) => {
    input.addEventListener('click', () => {
      input.select();
    });
    input.addEventListener('focus', () => {
      input.select();
    });
    input.addEventListener('input', e => {
      const val = e.target.value.replace(/\D/g, '');
      e.target.value = val.slice(-1);
      if (val && idx < arr.length - 1) {
        arr[idx + 1].focus();
        arr[idx + 1].select();
      }
      if (val && idx === arr.length - 1 && onComplete) onComplete();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace') {
        if (e.target.value) {
          e.target.value = '';
        } else if (idx > 0) {
          arr[idx - 1].focus();
          arr[idx - 1].value = '';
          arr[idx - 1].select();
        }
        e.preventDefault();
      } else if (e.key === 'ArrowLeft' && idx > 0) {
        arr[idx - 1].focus();
        arr[idx - 1].select();
        e.preventDefault();
      } else if (e.key === 'ArrowRight' && idx < arr.length - 1) {
        arr[idx + 1].focus();
        arr[idx + 1].select();
        e.preventDefault();
      } else if (e.key === 'Delete') {
        e.target.value = '';
        e.preventDefault();
      }
    });
    input.addEventListener('paste', e => {
      e.preventDefault();
      const paste = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      paste.split('').forEach((ch, i) => { if (arr[i]) arr[i].value = ch; });
      const focusIdx = Math.min(paste.length, arr.length - 1);
      arr[focusIdx].focus();
      arr[focusIdx].select();
      if (paste.length === 6 && onComplete) onComplete();
    });
  });
}

setupOtpInputs('#otp-inputs .otp-input', verifyOTP);
setupOtpInputs('.reset-otp-input');

/* ── Forgot Password ── */
function showForgotOtpSection() {
  document.getElementById('forgot-step-otp').style.display = '';
  document.getElementById('forgot-step-password').style.display = 'none';
}

function showForgotPasswordSection() {
  if (_resetTimerInterval) clearInterval(_resetTimerInterval);
  if (_resetResendCooldown) clearInterval(_resetResendCooldown);
  document.getElementById('forgot-step-otp').style.display = 'none';
  document.getElementById('forgot-step-password').style.display = '';
  document.getElementById('forgot-modal-title').textContent = 'Set new password';
}

function resetForgotPasswordState() {
  _resetToken = '';
  showForgotOtpSection();
  document.getElementById('reset-verify-btn').classList.remove('loading');
  document.getElementById('reset-submit-btn').classList.remove('loading');
  document.getElementById('reset-password').value = '';
  document.getElementById('reset-confirm').value = '';
  document.querySelectorAll('.reset-otp-input').forEach(i => {
    i.value = '';
    i.disabled = false;
  });
  document.getElementById('forgot-modal-subtitle').style.display = '';
  document.getElementById('forgot-modal-title').textContent = 'Reset your password';
}

function openForgotModal(e) {
  if (e) e.preventDefault();
  const loginEmail = document.getElementById('login-email').value.trim();
  document.getElementById('forgot-email').value = loginEmail;
  document.getElementById('forgot-step-email').style.display = '';
  document.getElementById('forgot-step-reset').style.display = 'none';
  document.getElementById('forgot-modal-title').textContent = 'Reset your password';
  document.getElementById('forgot-modal-subtitle').textContent = "Enter your email and we'll send you a reset code.";
  resetForgotPasswordState();
  document.getElementById('forgot-modal').classList.add('show');
  document.getElementById('forgot-email').focus();
}

function closeForgotModal() {
  document.getElementById('forgot-modal').classList.remove('show');
  if (_resetTimerInterval) clearInterval(_resetTimerInterval);
  if (_resetResendCooldown) clearInterval(_resetResendCooldown);
  resetForgotPasswordState();
}

function showResetCodeStep(email) {
  _pendingResetEmail = email;
  _resetToken = '';
  document.getElementById('forgot-email-display').textContent = email;
  document.getElementById('forgot-step-email').style.display = 'none';
  document.getElementById('forgot-step-reset').style.display = '';
  showForgotOtpSection();
  document.getElementById('forgot-modal-title').textContent = 'Enter reset code';
  document.getElementById('forgot-modal-subtitle').style.display = 'none';
  document.querySelectorAll('.reset-otp-input').forEach(i => {
    i.value = '';
    i.disabled = false;
  });
  document.querySelector('.reset-otp-input').focus();
  startResetTimer(600);
  startResetResendCooldown(30);
}

function forgotPasswordErrorMessage(d, fallback) {
  if (d && d.error) return d.error;
  return fallback;
}

async function sendResetCode() {
  const email = document.getElementById('forgot-email').value.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Please enter a valid email address.', 'error');
    return;
  }

  const btn = document.getElementById('forgot-send-btn');
  btn.classList.add('loading');

  try {
    const r = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const d = await r.json();
    btn.classList.remove('loading');

    if (r.ok) {
      showResetCodeStep(email);
      showToast(d.message || 'Reset code sent!', 'success');
    } else {
      showToast(forgotPasswordErrorMessage(d, 'Failed to send reset code.'), 'error');
    }
  } catch (e) {
    btn.classList.remove('loading');
    showToast('Network error. Please check your connection and try again.', 'error');
  }
}

function startResetTimer(seconds) {
  if (_resetTimerInterval) clearInterval(_resetTimerInterval);
  let remaining = seconds;
  const el = document.getElementById('reset-otp-timer');
  const update = () => {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    el.innerHTML = `Code expires in <strong>${m}:${String(s).padStart(2,'0')}</strong>`;
    if (remaining <= 0) {
      clearInterval(_resetTimerInterval);
      el.innerHTML = '<strong style="color:var(--danger)">Code expired — request a new one</strong>';
    }
    remaining--;
  };
  update();
  _resetTimerInterval = setInterval(update, 1000);
}

function startResetResendCooldown(seconds) {
  if (_resetResendCooldown) clearInterval(_resetResendCooldown);
  const btn = document.getElementById('reset-otp-resend');
  let remaining = seconds;
  btn.disabled = true;
  const update = () => {
    if (remaining <= 0) {
      clearInterval(_resetResendCooldown);
      btn.disabled = false;
      btn.textContent = 'Resend code';
    } else {
      btn.textContent = `Resend code (${remaining}s)`;
      remaining--;
    }
  };
  update();
  _resetResendCooldown = setInterval(update, 1000);
}

async function resendResetCode() {
  const btn = document.getElementById('reset-otp-resend');
  btn.disabled = true;
  try {
    const r = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: _pendingResetEmail })
    });
    const d = await r.json();
    showToast(r.ok ? (d.message || 'Code sent!') : forgotPasswordErrorMessage(d, 'Failed to resend code.'), r.ok ? 'success' : 'error');
    if (r.ok) {
      startResetTimer(600);
      startResetResendCooldown(60);
      _resetToken = '';
      showForgotOtpSection();
      document.querySelectorAll('.reset-otp-input').forEach(i => {
        i.disabled = false;
        i.value = '';
      });
      document.querySelector('.reset-otp-input').focus();
    } else {
      btn.disabled = false;
    }
  } catch (e) {
    showToast('Network error. Please check your connection and try again.', 'error');
    btn.disabled = false;
  }
}

async function verifyResetCode() {
  const inputs = document.querySelectorAll('.reset-otp-input');
  const code = Array.from(inputs).map(i => i.value).join('');

  if (code.length !== 6) {
    showToast('Enter all 6 digits.', 'error');
    return;
  }

  const btn = document.getElementById('reset-verify-btn');
  btn.classList.add('loading');

  try {
    const r = await fetch('/api/auth/verify-reset-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: _pendingResetEmail, code })
    });
    const d = await r.json();
    btn.classList.remove('loading');

    if (r.ok && d.status === 'ok') {
      _resetToken = d.reset_token;
      showForgotPasswordSection();
      document.getElementById('reset-password').focus();
      showToast(d.message || 'Code verified!', 'success');
    } else {
      showForgotOtpSection();
      showToast(forgotPasswordErrorMessage(d, 'Verification failed.'), 'error');
      if (d.error && d.error.toLowerCase().includes('incorrect')) {
        inputs.forEach(i => { i.value = ''; });
        inputs[0].focus();
      }
    }
  } catch (e) {
    btn.classList.remove('loading');
    showToast('Network error. Please check your connection and try again.', 'error');
  }
}

async function submitPasswordReset() {
  if (!_resetToken) {
    showToast('Please verify your code first.', 'error');
    return;
  }

  const password = document.getElementById('reset-password').value;
  const confirm = document.getElementById('reset-confirm').value;

  if (password.length < 6) { showToast('Password must be at least 6 characters.', 'error'); return; }
  if (password !== confirm) { showToast('Passwords do not match.', 'error'); return; }

  const btn = document.getElementById('reset-submit-btn');
  btn.classList.add('loading');

  try {
    const r = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset_token: _resetToken, password })
    });
    const d = await r.json();
    btn.classList.remove('loading');

    if (r.ok && d.status === 'ok') {
      showToast('Password reset successfully! Please sign in.', 'success');
      closeForgotModal();
      switchTab('signin');
      document.getElementById('login-email').value = _pendingResetEmail;
      // Spec: auto-fill email + the new password so the user only has to
      // click "Login" once more.
      document.getElementById('login-password').value = password;
      document.getElementById('login-email-err').classList.remove('show');
      document.getElementById('login-pass-err').classList.remove('show');
      document.getElementById('login-btn').focus();
    } else {
      showToast(d.error || 'Password reset failed.', 'error');
      if (d.error && d.error.toLowerCase().includes('expired')) {
        _resetToken = '';
        showForgotOtpSection();
        document.querySelectorAll('.reset-otp-input').forEach(i => {
          i.disabled = false;
          i.value = '';
        });
        document.querySelector('.reset-otp-input').focus();
      }
    }
  } catch (e) {
    btn.classList.remove('loading');
    showToast('Network error. Please check your connection and try again.', 'error');
  }
}

/* ── Keyboard Shortcuts ── */
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (document.getElementById('forgot-modal').classList.contains('show')) {
      if (document.getElementById('forgot-step-password').style.display !== 'none') {
        submitPasswordReset();
      } else if (document.getElementById('forgot-step-reset').style.display !== 'none') {
        verifyResetCode();
      } else {
        sendResetCode();
      }
    } else if (document.getElementById('otp-modal').classList.contains('show')) {
      verifyOTP();
    } else if (document.getElementById('content-signin').classList.contains('active')) {
      handleLogin();
    } else {
      handleRegister();
    }
  }
});

/* ── Auto-redirect if already logged in ── */
(function checkExistingAuth() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('logout') === 'true') {
    localStorage.removeItem('snetch_access_token');
    localStorage.removeItem('snetch_refresh_token');
    localStorage.removeItem('snetch_user');
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const token = localStorage.getItem('snetch_access_token');
  if (!token) return;

  fetch('/api/auth/me', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => {
    if (!r.ok) {
      clearTokens();
      return null;
    }
    return r.json();
  }).then(d => {
    if (d && d.status === 'ok') window.location.replace('/');
  }).catch(() => {});
})();

/* ── Init: show Google OAuth errors from redirect ── */
(function handleAuthErrors() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  const sessionError = params.get('session_error');

  if (sessionError) {
    showAlert('Session check failed: ' + decodeURIComponent(sessionError));
    window.history.replaceState({}, document.title, window.location.pathname);
    return;
  }

  if (!error) return;

  const messages = {
    google_cancelled: 'Google sign-in was cancelled.',
    google_failed: 'Google sign-in failed. Add this redirect URI in Google Cloud Console: ' + GOOGLE_CALLBACK_URI,
    google_not_configured: 'Google Sign-In is not configured on the server.',
    account_not_found: 'Account not found. Please create an account first.',
  };
  showAlert(messages[error] || 'Authentication error. Please try again.');
  window.history.replaceState({}, document.title, window.location.pathname);
})();