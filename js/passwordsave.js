// ============================================================
// passwordsave.js
// S.N.E.T.C.H · Password Vault & Secure Document Manager
// Full frontend logic wired to /api/vault/* (see passwordsave.py)
// ============================================================

(function () {
  'use strict';

  const API = '/api/vault';

  // ---------- STATE ----------
  let vaultToken = null;   // short-lived "unlocked vault" session token
  let pendingFlowToken = null; // token for an in-progress master-key/email/otp flow
  let resendTimer = null;

  // ---------- DOM SHORTCUTS ----------
  const overlay = document.getElementById('vaultOverlay');
  const modalBody = document.getElementById('vaultModalBody');
  const closeBtn = document.getElementById('vaultModalClose');
  const toastRoot = document.getElementById('vaultToastRoot');

  function authToken() {
    return localStorage.getItem('snetch_access_token') || '';
  }

  function authHeaders(json) {
    const h = { Authorization: 'Bearer ' + authToken() };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  // ---------- API HELPER ----------
  async function api(path, { method = 'GET', body = null, form = null } = {}) {
    const opts = { method, headers: authHeaders(!form) };
    if (form) {
      opts.body = form; // FormData — browser sets multipart boundary
    } else if (body) {
      opts.body = JSON.stringify(body);
    }
    let resp, data;
    try {
      resp = await fetch(path, opts);
    } catch (e) {
      throw new Error('Network error. Please check your connection.');
    }
    try {
      data = await resp.json();
    } catch (e) {
      data = {};
    }
    if (!resp.ok) {
      throw new Error(data.error || 'Something went wrong.');
    }
    return data;
  }

  // ---------- TOAST ----------
  function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = 'vault-toast';
    const icon = type === 'error' ? '✖' : type === 'success' ? '✔' : '✦';
    const color = type === 'error' ? '#ff8fa3' : type === 'success' ? '#8ef0bd' : '#b488ff';
    el.style.cssText = `
      position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%) translateY(20px);
      background: rgba(20,10,40,0.85); backdrop-filter: blur(16px) saturate(1.4);
      border: 1px solid rgba(180,130,255,0.3); border-radius: 60px; padding: 0.9rem 2rem;
      color: #eee6ff; font-weight: 500; font-size: 0.92rem;
      box-shadow: 0 20px 50px rgba(0,0,0,0.7), 0 0 30px rgba(140,80,255,0.15);
      z-index: 10001; opacity: 0; transition: opacity 0.3s ease, transform 0.4s cubic-bezier(0.2,0.9,0.3,1.1);
      display: flex; align-items: center; gap: 0.7rem; max-width: 90%;
    `;
    el.innerHTML = `<span style="color:${color};font-size:1.1rem;">${icon}</span><span>${message}</span>`;
    toastRoot.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(20px)';
      setTimeout(() => el.remove(), 400);
    }, 3200);
  }

  // ---------- MODAL ----------
  function openModal() {
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => overlay.classList.add('open'));
    document.addEventListener('keydown', escHandler);
  }
  function closeModal() {
    overlay.classList.remove('open');
    document.removeEventListener('keydown', escHandler);
    setTimeout(() => {
      overlay.classList.add('hidden');
      modalBody.innerHTML = '';
      vaultToken = null;
      pendingFlowToken = null;
      clearInterval(resendTimer);
    }, 250);
  }
  function escHandler(e) {
    if (e.key === 'Escape') closeModal();
  }
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  function setBody(html) {
    modalBody.innerHTML = html;
  }

  function alertHtml(msg, type = 'error') {
    return msg ? `<div class="vault-alert ${type}">${msg}</div>` : '';
  }

  function loadingHtml(label = 'Loading…') {
    return `<div class="vault-loading"><div class="vault-spinner"></div><span>${label}</span></div>`;
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ============================================================
  // CARD -> ENTRY POINTS
  // ============================================================
  const cards = document.querySelectorAll('.card');
  cards.forEach((card) => {
    const cardNum = card.getAttribute('data-card');
    const btn = card.querySelector('.card-btn');
    const trigger = (e) => { e.stopPropagation(); handleCard(cardNum); };
    if (btn) btn.addEventListener('click', trigger);
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-btn')) return;
      handleCard(cardNum);
    });
  });

  async function handleCard(cardNum) {
    openModal();
    setBody(loadingHtml());
    try {
      switch (cardNum) {
        case '1': await routeMasterKeyEntry(); break;
        case '2': renderForgotStart(); break;
        case '3': await routeUpdateEmailEntry(); break;
        case '4': renderUnlockGate('Add Password or Document', afterUnlockAdd); break;
        case '5': renderUnlockGate('Show Password or Document', afterUnlockShow); break;
        case '6': renderUnlockGate('Delete Password or Document', afterUnlockDelete); break;
        case '7': renderUnlockGate('Update Password or Document', afterUnlockUpdate); break;
        default: closeModal();
      }
    } catch (e) {
      setBody(alertHtml(e.message) + backLinkHtml());
      bindBackLink(() => closeModal());
    }
  }

  function backLinkHtml(label = 'Close') {
    return `<button class="vault-back-link" id="vaultBack"><i class="fas fa-arrow-left"></i> ${label}</button>`;
  }
  function bindBackLink(fn) {
    const el = document.getElementById('vaultBack');
    if (el) el.addEventListener('click', fn);
  }

  // ============================================================
  // 1. CREATE / UPDATE MASTER KEY
  // ============================================================
  async function routeMasterKeyEntry() {
    const status = await api(`${API}/status`);
    if (!status.has_master_key) renderCreateStart();
    else renderUpdateStart();
  }

  function renderCreateStart() {
    setBody(`
      <h2><i class="fas fa-key"></i> Create Master Key</h2>
      <p class="vault-sub">Your Master Key locks and unlocks your entire vault. Choose something strong you'll remember — it is never stored anywhere in plain text.</p>
      <div class="vault-field">
        <label>Master Key</label>
        <input type="password" id="mkNew" placeholder="At least 10 characters" autocomplete="new-password">
        <div class="vault-hint">Minimum 10 characters. Letters, numbers and symbols allowed.</div>
      </div>
      <div class="vault-field">
        <label>Recovery Email Address</label>
        <input type="email" id="mkEmail" placeholder="you@example.com">
      </div>
      <div id="mkAlert"></div>
      <div class="vault-btn-row">
        <button class="vault-btn" id="mkContinue"><i class="fas fa-arrow-right"></i> Continue</button>
      </div>
    `);
    document.getElementById('mkContinue').addEventListener('click', async () => {
      const master_key = document.getElementById('mkNew').value;
      const recovery_email = document.getElementById('mkEmail').value.trim();
      const btn = document.getElementById('mkContinue');
      if (master_key.length < 10) return showFieldError('mkAlert', 'Master Key must be at least 10 characters.');
      if (!recovery_email.includes('@')) return showFieldError('mkAlert', 'Enter a valid recovery email address.');
      btn.disabled = true;
      try {
        const resp = await api(`${API}/master/create/start`, { method: 'POST', body: { master_key, recovery_email } });
        pendingFlowToken = resp.token;
        renderOtpScreen({
          purpose: 'create_master',
          message: resp.message,
          onVerified: () => {
            setBody(`<h2><i class="fas fa-check-circle"></i> Master Key Created</h2>
              <p class="vault-sub">Your vault is ready. You can now add passwords and documents.</p>
              <div class="vault-btn-row"><button class="vault-btn" id="mkDone">Done</button></div>`);
            document.getElementById('mkDone').addEventListener('click', closeModal);
          },
        });
      } catch (e) {
        showFieldError('mkAlert', e.message);
        btn.disabled = false;
      }
    });
  }

  function renderUpdateStart() {
    setBody(`
      <h2><i class="fas fa-key"></i> Update Master Key</h2>
      <p class="vault-sub">Enter your current Master Key to continue. We'll send a one-time code to your registered recovery email before letting you set a new one.</p>
      <div class="vault-field">
        <label>Current Master Key</label>
        <input type="password" id="mkCurrent" placeholder="Enter current Master Key" autocomplete="current-password">
      </div>
      <div id="mkAlert"></div>
      <div class="vault-btn-row">
        <button class="vault-btn" id="mkContinue"><i class="fas fa-arrow-right"></i> Continue</button>
      </div>
    `);
    document.getElementById('mkContinue').addEventListener('click', async () => {
      const current_master_key = document.getElementById('mkCurrent').value;
      const btn = document.getElementById('mkContinue');
      btn.disabled = true;
      try {
        const resp = await api(`${API}/master/update/start`, { method: 'POST', body: { current_master_key } });
        pendingFlowToken = resp.token;
        renderOtpScreen({
          purpose: 'update_master',
          message: resp.message,
          onVerified: () => renderSetNewMasterKey(),
        });
      } catch (e) {
        showFieldError('mkAlert', e.message);
        btn.disabled = false;
      }
    });
  }

  function renderSetNewMasterKey() {
    setBody(`
      <h2><i class="fas fa-key"></i> Enter New Master Key</h2>
      <p class="vault-sub">All your existing passwords and documents stay intact — only the key that unlocks them changes.</p>
      <div class="vault-field">
        <label>New Master Key</label>
        <input type="password" id="mkNewFinal" placeholder="At least 10 characters" autocomplete="new-password">
      </div>
      <div class="vault-field">
        <label>Confirm New Master Key</label>
        <input type="password" id="mkNewFinalConfirm" placeholder="Re-enter new Master Key" autocomplete="new-password">
      </div>
      <div id="mkAlert"></div>
      <div class="vault-btn-row">
        <button class="vault-btn" id="mkCreateNew"><i class="fas fa-check"></i> Create New Master Key</button>
      </div>
    `);
    document.getElementById('mkCreateNew').addEventListener('click', async () => {
      const a = document.getElementById('mkNewFinal').value;
      const b = document.getElementById('mkNewFinalConfirm').value;
      const btn = document.getElementById('mkCreateNew');
      if (a.length < 10) return showFieldError('mkAlert', 'Master Key must be at least 10 characters.');
      if (a !== b) return showFieldError('mkAlert', 'The two Master Keys do not match.');
      btn.disabled = true;
      try {
        await api(`${API}/master/set-new`, { method: 'POST', body: { token: pendingFlowToken, new_master_key: a } });
        toast('Master Key updated successfully.', 'success');
        closeModal();
      } catch (e) {
        showFieldError('mkAlert', e.message);
        btn.disabled = false;
      }
    });
  }

  // ============================================================
  // 2. FORGOT MASTER KEY
  // ============================================================
  function renderForgotStart() {
    setBody(`
      <h2><i class="fas fa-question-circle"></i> Forgot Master Key</h2>
      <p class="vault-sub">Enter your registered recovery email address. We'll send a one-time code to verify it's really you.</p>
      <div class="vault-field">
        <label>Recovery Email Address</label>
        <input type="email" id="fgEmail" placeholder="you@example.com">
      </div>
      <div id="mkAlert"></div>
      <div class="vault-btn-row">
        <button class="vault-btn" id="fgContinue"><i class="fas fa-arrow-right"></i> Continue</button>
      </div>
    `);
    document.getElementById('fgContinue').addEventListener('click', async () => {
      const recovery_email = document.getElementById('fgEmail').value.trim();
      const btn = document.getElementById('fgContinue');
      btn.disabled = true;
      try {
        const resp = await api(`${API}/master/forgot/start`, { method: 'POST', body: { recovery_email } });
        pendingFlowToken = resp.token;
        renderOtpScreen({
          purpose: 'forgot_master',
          message: resp.message,
          onVerified: () => renderSetNewMasterKey(),
        });
      } catch (e) {
        showFieldError('mkAlert', e.message);
        btn.disabled = false;
      }
    });
  }

  // ============================================================
  // 3. UPDATE RECOVERY EMAIL
  // ============================================================
  async function routeUpdateEmailEntry() {
    const status = await api(`${API}/status`);
    if (!status.has_master_key) {
      setBody(alertHtml('Please create a Master Key first.') + backLinkHtml());
      bindBackLink(closeModal);
      return;
    }
    renderEmailStart();
  }

  function renderEmailStart() {
    setBody(`
      <h2><i class="fas fa-envelope"></i> Update Recovery Email Address</h2>
      <p class="vault-sub">Confirm your Master Key, then enter the new recovery email address.</p>
      <div class="vault-field">
        <label>Current Master Key</label>
        <input type="password" id="emCurrent" placeholder="Enter current Master Key">
      </div>
      <div class="vault-field">
        <label>New Recovery Email Address</label>
        <input type="email" id="emNew" placeholder="new-email@example.com">
      </div>
      <div id="mkAlert"></div>
      <div class="vault-btn-row">
        <button class="vault-btn" id="emContinue"><i class="fas fa-arrow-right"></i> Continue</button>
      </div>
    `);
    document.getElementById('emContinue').addEventListener('click', async () => {
      const current_master_key = document.getElementById('emCurrent').value;
      const new_recovery_email = document.getElementById('emNew').value.trim();
      const btn = document.getElementById('emContinue');
      btn.disabled = true;
      try {
        const resp = await api(`${API}/email/start`, { method: 'POST', body: { current_master_key, new_recovery_email } });
        pendingFlowToken = resp.token;
        renderOtpScreen({
          purpose: 'update_email',
          message: resp.message,
          onVerified: () => {
            toast('Recovery email updated successfully.', 'success');
            closeModal();
          },
        });
      } catch (e) {
        showFieldError('mkAlert', e.message);
        btn.disabled = false;
      }
    });
  }

  // ============================================================
  // SHARED OTP SCREEN
  // ============================================================
  function renderOtpScreen({ message, onVerified }) {
    setBody(`
      <h2><i class="fas fa-shield-alt"></i> Verify OTP</h2>
      <p class="vault-sub">${message || 'A 6-digit code has been sent to your email.'} The code expires in 10 minutes.</p>
      <div class="vault-otp-row">
        <input type="text" id="otpInput" inputmode="numeric" maxlength="6" placeholder="••••••">
      </div>
      <div style="margin-bottom:1rem;">
        <button class="vault-resend" id="otpResend">Resend OTP</button>
        <span id="otpTimer" style="color:#8f7bb0;font-size:0.78rem;margin-left:0.6rem;"></span>
      </div>
      <div id="mkAlert"></div>
      <div class="vault-btn-row">
        <button class="vault-btn secondary" id="otpBack"><i class="fas fa-arrow-left"></i> Back</button>
        <button class="vault-btn" id="otpVerify"><i class="fas fa-check"></i> Verify</button>
      </div>
    `);

    startResendCooldown();

    document.getElementById('otpBack').addEventListener('click', closeModal);

    document.getElementById('otpResend').addEventListener('click', async () => {
      const rbtn = document.getElementById('otpResend');
      rbtn.disabled = true;
      try {
        const resp = await api(`${API}/otp/resend`, { method: 'POST', body: { token: pendingFlowToken } });
        toast(resp.message || 'OTP resent.', 'success');
        startResendCooldown();
      } catch (e) {
        showFieldError('mkAlert', e.message);
        rbtn.disabled = false;
      }
    });

    document.getElementById('otpVerify').addEventListener('click', async () => {
      const otp = document.getElementById('otpInput').value.trim();
      const btn = document.getElementById('otpVerify');
      if (otp.length !== 6) return showFieldError('mkAlert', 'Enter the 6-digit code.');
      btn.disabled = true;
      try {
        const resp = await api(`${API}/otp/verify`, { method: 'POST', body: { token: pendingFlowToken, otp } });
        onVerified(resp);
      } catch (e) {
        showFieldError('mkAlert', e.message);
        btn.disabled = false;
        btn.classList.add('error-shake');
        setTimeout(() => btn.classList.remove('error-shake'), 400);
      }
    });
  }

  function startResendCooldown() {
    clearInterval(resendTimer);
    let seconds = 30;
    const rbtn = document.getElementById('otpResend');
    const timerEl = document.getElementById('otpTimer');
    if (!rbtn) return;
    rbtn.disabled = true;
    timerEl.textContent = `Available in ${seconds}s`;
    resendTimer = setInterval(() => {
      seconds -= 1;
      if (seconds <= 0) {
        clearInterval(resendTimer);
        rbtn.disabled = false;
        timerEl.textContent = '';
      } else {
        timerEl.textContent = `Available in ${seconds}s`;
      }
    }, 1000);
  }

  function showFieldError(elId, msg) {
    const el = document.getElementById(elId);
    if (el) el.innerHTML = alertHtml(msg);
  }

  // ============================================================
  // UNLOCK GATE (Master Key check before Add/Show/Update/Delete)
  // ============================================================
  function renderUnlockGate(title, onUnlocked) {
    setBody(`
      <h2><i class="fas fa-lock"></i> ${title}</h2>
      <p class="vault-sub">Enter your Master Key to continue.</p>
      <div class="vault-field">
        <label>Master Key</label>
        <input type="password" id="ulKey" placeholder="Enter your Master Key" autocomplete="current-password">
      </div>
      <div id="mkAlert"></div>
      <div class="vault-btn-row">
        <button class="vault-btn" id="ulContinue"><i class="fas fa-unlock"></i> Unlock</button>
      </div>
    `);
    const input = document.getElementById('ulKey');
    input.focus();
    const submit = async () => {
      const master_key = input.value;
      const btn = document.getElementById('ulContinue');
      btn.disabled = true;
      try {
        const resp = await api(`${API}/unlock`, { method: 'POST', body: { master_key } });
        vaultToken = resp.vault_token;
        onUnlocked();
      } catch (e) {
        showFieldError('mkAlert', e.message);
        btn.disabled = false;
      }
    };
    document.getElementById('ulContinue').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  // ============================================================
  // 4. ADD PASSWORD OR DOCUMENT
  // ============================================================
  function afterUnlockAdd() {
    setBody(`
      <h2><i class="fas fa-plus-circle"></i> Add Password or Document</h2>
      <p class="vault-sub">Choose what you'd like to add to your vault.</p>
      <div class="vault-choice-grid">
        <div class="vault-choice-card" id="choiceAddPw"><i class="fas fa-key"></i>Add Password</div>
        <div class="vault-choice-card" id="choiceAddDoc"><i class="fas fa-file-alt"></i>Add Document</div>
      </div>
    `);
    document.getElementById('choiceAddPw').addEventListener('click', renderAddPasswordForm);
    document.getElementById('choiceAddDoc').addEventListener('click', renderAddDocumentForm);
  }

  function renderAddPasswordForm() {
    setBody(`
      ${backLinkHtml('Back')}
      <h2><i class="fas fa-key"></i> Add Password</h2>
      <div class="vault-field">
        <label>Password Name</label>
        <input type="text" id="pwName" placeholder="e.g. Gmail, Netflix, Bank of ...">
      </div>
      <div class="vault-field">
        <label>Password</label>
        <input type="text" id="pwValue" placeholder="Enter password">
      </div>
      <div id="mkAlert"></div>
      <div class="vault-btn-row">
        <button class="vault-btn" id="pwSave"><i class="fas fa-save"></i> Save</button>
      </div>
    `);
    bindBackLink(afterUnlockAdd);
    document.getElementById('pwSave').addEventListener('click', async () => {
      const name = document.getElementById('pwName').value.trim();
      const password = document.getElementById('pwValue').value;
      const btn = document.getElementById('pwSave');
      btn.disabled = true;
      try {
        await api(`${API}/passwords/add`, { method: 'POST', body: { vault_token: vaultToken, name, password } });
        toast('Password saved.', 'success');
        document.getElementById('pwName').value = '';
        document.getElementById('pwValue').value = '';
        btn.disabled = false;
        btn.classList.add('success-pulse');
        setTimeout(() => btn.classList.remove('success-pulse'), 500);
      } catch (e) {
        showFieldError('mkAlert', e.message);
        btn.disabled = false;
      }
    });
  }

  function renderAddDocumentForm() {
    setBody(`
      ${backLinkHtml('Back')}
      <h2><i class="fas fa-file-alt"></i> Add Document</h2>
      <div class="vault-field">
        <label>Document Name</label>
        <input type="text" id="docName" placeholder="e.g. Passport, Insurance Policy">
      </div>
      <div class="vault-field">
        <label>Document File</label>
        <div class="vault-field-file">
          <label class="file-btn" for="docFile"><i class="fas fa-folder-open"></i> Browse</label>
          <input type="file" id="docFile" style="display:none;">
          <span class="file-name" id="docFileName">No file selected</span>
        </div>
      </div>
      <div id="mkAlert"></div>
      <div class="vault-btn-row">
        <button class="vault-btn" id="docSave"><i class="fas fa-save"></i> Save</button>
      </div>
    `);
    bindBackLink(afterUnlockAdd);
    document.getElementById('docFile').addEventListener('change', (e) => {
      const f = e.target.files[0];
      document.getElementById('docFileName').textContent = f ? f.name : 'No file selected';
    });
    document.getElementById('docSave').addEventListener('click', async () => {
      const name = document.getElementById('docName').value.trim();
      const file = document.getElementById('docFile').files[0];
      const btn = document.getElementById('docSave');
      if (!name) return showFieldError('mkAlert', 'Document Name is required.');
      if (!file) return showFieldError('mkAlert', 'Please choose a document to upload.');
      btn.disabled = true;
      const fd = new FormData();
      fd.append('vault_token', vaultToken);
      fd.append('name', name);
      fd.append('file', file);
      try {
        await api(`${API}/documents/add`, { method: 'POST', form: fd });
        toast('Document saved.', 'success');
        renderAddDocumentForm();
      } catch (e) {
        showFieldError('mkAlert', e.message);
        btn.disabled = false;
      }
    });
  }

  // ============================================================
  // 5. SHOW PASSWORD OR DOCUMENT
  // ============================================================
  function afterUnlockShow() {
    setBody(`
      <h2><i class="fas fa-eye"></i> Show Password or Document</h2>
      <p class="vault-sub">Choose what you'd like to view.</p>
      <div class="vault-choice-grid">
        <div class="vault-choice-card" id="choiceShowPw"><i class="fas fa-key"></i>Show Password</div>
        <div class="vault-choice-card" id="choiceShowDoc"><i class="fas fa-file-alt"></i>Show Document</div>
      </div>
    `);
    document.getElementById('choiceShowPw').addEventListener('click', () => renderPasswordList('show'));
    document.getElementById('choiceShowDoc').addEventListener('click', () => renderDocumentList('show'));
  }

  function afterUnlockDelete() {
    setBody(`
      <h2><i class="fas fa-trash-alt"></i> Delete Password or Document</h2>
      <p class="vault-sub">Choose what you'd like to delete.</p>
      <div class="vault-choice-grid">
        <div class="vault-choice-card" id="choiceDelPw"><i class="fas fa-key"></i>Delete Password</div>
        <div class="vault-choice-card" id="choiceDelDoc"><i class="fas fa-file-alt"></i>Delete Document</div>
      </div>
    `);
    document.getElementById('choiceDelPw').addEventListener('click', () => renderPasswordList('delete'));
    document.getElementById('choiceDelDoc').addEventListener('click', () => renderDocumentList('delete'));
  }

  function afterUnlockUpdate() {
    setBody(`
      <h2><i class="fas fa-sync-alt"></i> Update Password or Document</h2>
      <p class="vault-sub">Choose what you'd like to update.</p>
      <div class="vault-choice-grid">
        <div class="vault-choice-card" id="choiceUpdPw"><i class="fas fa-key"></i>Update Password</div>
        <div class="vault-choice-card" id="choiceUpdDoc"><i class="fas fa-file-alt"></i>Update Document</div>
      </div>
    `);
    document.getElementById('choiceUpdPw').addEventListener('click', () => renderPasswordList('update'));
    document.getElementById('choiceUpdDoc').addEventListener('click', () => renderDocumentList('update'));
  }

  // ---------- PASSWORD LIST (show / delete / update) ----------
  async function renderPasswordList(mode) {
    setBody(`${backLinkHtml('Back')}
      <h2><i class="fas fa-key"></i> ${titleFor(mode)} Password</h2>
      <div id="pwListWrap">${loadingHtml()}</div>`);
    bindBackLink(() => backToChoiceFor(mode, 'password'));

    let items;
    try {
      const resp = await api(`${API}/passwords/list`, { method: 'POST', body: { vault_token: vaultToken } });
      items = resp.items;
    } catch (e) {
      document.getElementById('pwListWrap').innerHTML = alertHtml(e.message);
      return;
    }

    if (!items.length) {
      document.getElementById('pwListWrap').innerHTML = `<div class="vault-empty"><i class="fas fa-inbox" style="font-size:1.8rem;display:block;margin-bottom:0.6rem;"></i>No saved passwords yet.</div>`;
      return;
    }

    const isDelete = mode === 'delete';
    const rows = items.map((it) => `
      <div class="vault-list-item" data-id="${it.id}">
        ${isDelete ? `<input type="checkbox" class="pwCheck" data-id="${it.id}">` : ''}
        <span class="item-name">${escapeHtml(it.name)}</span>
        ${mode === 'show' ? `
          <button class="vault-item-btn pwShowBtn" data-id="${it.id}"><i class="fas fa-eye"></i> Show</button>
          <button class="vault-item-btn pwDownloadBtn" data-id="${it.id}"><i class="fas fa-download"></i> Download</button>
        ` : ''}
        ${mode === 'update' ? `<button class="vault-item-btn pwUpdateBtn" data-id="${it.id}" data-name="${escapeHtml(it.name)}"><i class="fas fa-pen"></i> Update</button>` : ''}
      </div>
    `).join('');

    document.getElementById('pwListWrap').innerHTML = `
      ${isDelete ? `<div style="margin-bottom:0.6rem;"><label style="font-size:0.85rem;color:#c9b6f0;"><input type="checkbox" id="pwSelectAll"> Select all</label></div>` : ''}
      <div class="vault-list">${rows}</div>
      ${isDelete ? `<div class="vault-btn-row"><button class="vault-btn danger" id="pwDeleteSelected"><i class="fas fa-trash"></i> Delete Selected</button></div>` : ''}
    `;

    if (mode === 'show') {
      document.querySelectorAll('.pwShowBtn').forEach((b) => b.addEventListener('click', () => revealPassword(b.dataset.id)));
      document.querySelectorAll('.pwDownloadBtn').forEach((b) => b.addEventListener('click', () => {
        window.open(`${API}/passwords/download?vault_token=${vaultToken}&id=${b.dataset.id}`, '_blank');
      }));
    }
    if (mode === 'update') {
      document.querySelectorAll('.pwUpdateBtn').forEach((b) => b.addEventListener('click', () => renderEditPasswordForm(b.dataset.id, b.dataset.name)));
    }
    if (isDelete) {
      const selectAll = document.getElementById('pwSelectAll');
      selectAll.addEventListener('change', () => {
        document.querySelectorAll('.pwCheck').forEach((cb) => { cb.checked = selectAll.checked; });
      });
      document.getElementById('pwDeleteSelected').addEventListener('click', async () => {
        const ids = Array.from(document.querySelectorAll('.pwCheck:checked')).map((cb) => Number(cb.dataset.id));
        if (!ids.length) return toast('Select at least one password to delete.', 'error');
        if (!(await customConfirm(`Permanently delete ${ids.length} password(s)?`))) return;
        try {
          const resp = await api(`${API}/passwords/delete`, { method: 'POST', body: { vault_token: vaultToken, ids } });
          toast(resp.message, 'success');
          renderPasswordList('delete');
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    }
  }

  async function revealPassword(id) {
    setBody(`${backLinkHtml('Back to list')}<h2><i class="fas fa-eye"></i> Password</h2><div id="revealWrap">${loadingHtml()}</div>`);
    bindBackLink(() => renderPasswordList('show'));
    try {
      const resp = await api(`${API}/passwords/reveal`, { method: 'POST', body: { vault_token: vaultToken, id: Number(id) } });
      document.getElementById('revealWrap').innerHTML = `
        <div class="vault-field"><label>Password Name</label><div class="vault-reveal-box">${escapeHtml(resp.name)}</div></div>
        <div class="vault-field"><label>Password</label><div class="vault-reveal-box"><span id="revealPw">${escapeHtml(resp.password)}</span>
          <button class="vault-item-btn" id="copyPwBtn"><i class="fas fa-copy"></i> Copy</button></div></div>
      `;
      document.getElementById('copyPwBtn').addEventListener('click', () => {
        navigator.clipboard.writeText(resp.password).then(() => toast('Copied to clipboard.', 'success'));
      });
    } catch (e) {
      document.getElementById('revealWrap').innerHTML = alertHtml(e.message);
    }
  }

  async function renderEditPasswordForm(id, name) {
    setBody(`${backLinkHtml('Back to list')}<h2><i class="fas fa-pen"></i> Update Password</h2><div id="editPwWrap">${loadingHtml()}</div>`);
    bindBackLink(() => renderPasswordList('update'));
    let existing;
    try {
      existing = await api(`${API}/passwords/reveal`, { method: 'POST', body: { vault_token: vaultToken, id: Number(id) } });
    } catch (e) {
      document.getElementById('editPwWrap').innerHTML = alertHtml(e.message);
      return;
    }
    document.getElementById('editPwWrap').innerHTML = `
      <div class="vault-field"><label>Password Name</label><input type="text" id="editPwName" value="${escapeHtml(existing.name)}"></div>
      <div class="vault-field"><label>Password</label><input type="text" id="editPwValue" value="${escapeHtml(existing.password)}"></div>
      <div id="mkAlert"></div>
      <div class="vault-btn-row"><button class="vault-btn" id="editPwSave"><i class="fas fa-save"></i> Save</button></div>
    `;
    document.getElementById('editPwSave').addEventListener('click', async () => {
      const newName = document.getElementById('editPwName').value.trim();
      const newValue = document.getElementById('editPwValue').value;
      const btn = document.getElementById('editPwSave');
      btn.disabled = true;
      try {
        await api(`${API}/passwords/update`, { method: 'POST', body: { vault_token: vaultToken, id: Number(id), name: newName, password: newValue } });
        toast('Password updated.', 'success');
        renderPasswordList('update');
      } catch (e) {
        showFieldError('mkAlert', e.message);
        btn.disabled = false;
      }
    });
  }

  // ---------- DOCUMENT LIST (show / delete / update) ----------
  async function renderDocumentList(mode) {
    setBody(`${backLinkHtml('Back')}
      <h2><i class="fas fa-file-alt"></i> ${titleFor(mode)} Document</h2>
      <div id="docListWrap">${loadingHtml()}</div>`);
    bindBackLink(() => backToChoiceFor(mode, 'document'));

    let items;
    try {
      const resp = await api(`${API}/documents/list`, { method: 'POST', body: { vault_token: vaultToken } });
      items = resp.items;
    } catch (e) {
      document.getElementById('docListWrap').innerHTML = alertHtml(e.message);
      return;
    }

    if (!items.length) {
      document.getElementById('docListWrap').innerHTML = `<div class="vault-empty"><i class="fas fa-folder-open" style="font-size:1.8rem;display:block;margin-bottom:0.6rem;"></i>No saved documents yet.</div>`;
      return;
    }

    const isDelete = mode === 'delete';
    const rows = items.map((it) => `
      <div class="vault-list-item" data-id="${it.id}">
        ${isDelete ? `<input type="checkbox" class="docCheck" data-id="${it.id}">` : ''}
        <span class="item-name">${escapeHtml(it.name)}<br><span class="item-meta">${(it.size_bytes / 1024).toFixed(1)} KB</span></span>
        ${mode === 'show' ? `
          <button class="vault-item-btn docShowBtn" data-id="${it.id}"><i class="fas fa-eye"></i> Show</button>
          <button class="vault-item-btn docDownloadBtn" data-id="${it.id}"><i class="fas fa-download"></i> Download</button>
        ` : ''}
        ${mode === 'update' ? `<button class="vault-item-btn docUpdateBtn" data-id="${it.id}" data-name="${escapeHtml(it.name)}"><i class="fas fa-pen"></i> Update</button>` : ''}
      </div>
    `).join('');

    document.getElementById('docListWrap').innerHTML = `
      ${isDelete ? `<div style="margin-bottom:0.6rem;"><label style="font-size:0.85rem;color:#c9b6f0;"><input type="checkbox" id="docSelectAll"> Select all</label></div>` : ''}
      <div class="vault-list">${rows}</div>
      ${isDelete ? `<div class="vault-btn-row"><button class="vault-btn danger" id="docDeleteSelected"><i class="fas fa-trash"></i> Delete Selected</button></div>` : ''}
    `;

    if (mode === 'show') {
      document.querySelectorAll('.docShowBtn').forEach((b) => b.addEventListener('click', () => {
        window.open(`${API}/documents/view?vault_token=${vaultToken}&id=${b.dataset.id}`, '_blank');
      }));
      document.querySelectorAll('.docDownloadBtn').forEach((b) => b.addEventListener('click', () => {
        window.open(`${API}/documents/download?vault_token=${vaultToken}&id=${b.dataset.id}`, '_blank');
      }));
    }
    if (mode === 'update') {
      document.querySelectorAll('.docUpdateBtn').forEach((b) => b.addEventListener('click', () => renderEditDocumentForm(b.dataset.id, b.dataset.name)));
    }
    if (isDelete) {
      const selectAll = document.getElementById('docSelectAll');
      selectAll.addEventListener('change', () => {
        document.querySelectorAll('.docCheck').forEach((cb) => { cb.checked = selectAll.checked; });
      });
      document.getElementById('docDeleteSelected').addEventListener('click', async () => {
        const ids = Array.from(document.querySelectorAll('.docCheck:checked')).map((cb) => Number(cb.dataset.id));
        if (!ids.length) return toast('Select at least one document to delete.', 'error');
        if (!(await customConfirm(`Permanently delete ${ids.length} document(s)?`))) return;
        try {
          const resp = await api(`${API}/documents/delete`, { method: 'POST', body: { vault_token: vaultToken, ids } });
          toast(resp.message, 'success');
          renderDocumentList('delete');
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    }
  }

  function renderEditDocumentForm(id, name) {
    setBody(`${backLinkHtml('Back to list')}
      <h2><i class="fas fa-pen"></i> Update Document</h2>
      <div class="vault-field"><label>Document Name</label><input type="text" id="editDocName" value="${escapeHtml(name)}"></div>
      <div class="vault-field">
        <label>Replace Document (optional)</label>
        <div class="vault-field-file">
          <label class="file-btn" for="editDocFile"><i class="fas fa-folder-open"></i> Browse</label>
          <input type="file" id="editDocFile" style="display:none;">
          <span class="file-name" id="editDocFileName">Keep existing file</span>
        </div>
      </div>
      <div id="mkAlert"></div>
      <div class="vault-btn-row"><button class="vault-btn" id="editDocSave"><i class="fas fa-save"></i> Save</button></div>
    `);
    bindBackLink(() => renderDocumentList('update'));
    document.getElementById('editDocFile').addEventListener('change', (e) => {
      const f = e.target.files[0];
      document.getElementById('editDocFileName').textContent = f ? f.name : 'Keep existing file';
    });
    document.getElementById('editDocSave').addEventListener('click', async () => {
      const newName = document.getElementById('editDocName').value.trim();
      const file = document.getElementById('editDocFile').files[0];
      const btn = document.getElementById('editDocSave');
      btn.disabled = true;
      const fd = new FormData();
      fd.append('vault_token', vaultToken);
      fd.append('id', id);
      fd.append('name', newName);
      if (file) fd.append('file', file);
      try {
        await api(`${API}/documents/update`, { method: 'POST', form: fd });
        toast('Document updated.', 'success');
        renderDocumentList('update');
      } catch (e) {
        showFieldError('mkAlert', e.message);
        btn.disabled = false;
      }
    });
  }

  function titleFor(mode) {
    return mode === 'show' ? 'Show' : mode === 'delete' ? 'Delete' : 'Update';
  }
  function backToChoiceFor(mode, kind) {
    if (mode === 'show') afterUnlockShow();
    else if (mode === 'delete') afterUnlockDelete();
    else afterUnlockUpdate();
  }

  console.log('🔐 S.N.E.T.C.H Password Vault ready.');
})();

// ==========================================
// CUSTOM UI MODALS
// ==========================================
function showCustomModal({ title, isConfirm = false, onConfirm = null }) {
  const overlay = document.createElement('div');
  overlay.className = 'custom-modal-overlay';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    background: 'rgba(10, 10, 26, 0.7)', backdropFilter: 'blur(10px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: '10000', opacity: '0', transition: 'opacity 0.3s ease'
  });

  const modal = document.createElement('div');
  modal.className = 'custom-modal';
  Object.assign(modal.style, {
    background: 'linear-gradient(145deg, rgba(30,30,50,0.9), rgba(20,20,40,0.95))',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px',
    padding: '30px', width: '90%', maxWidth: '400px',
    boxShadow: '0 15px 35px rgba(0,0,0,0.5), 0 0 20px rgba(138, 43, 226, 0.2)',
    color: '#fff', fontFamily: "'Inter', sans-serif",
    transform: 'translateY(-20px) scale(0.95)', transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)'
  });

  const titleEl = document.createElement('h3');
  titleEl.textContent = title;
  Object.assign(titleEl.style, { margin: '0 0 20px 0', fontSize: '1.2rem', fontWeight: '600', lineHeight: '1.4' });
  modal.appendChild(titleEl);

  const btnContainer = document.createElement('div');
  Object.assign(btnContainer.style, { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' });

  const btnCancel = document.createElement('button');
  btnCancel.textContent = 'Cancel';
  Object.assign(btnCancel.style, {
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
    color: '#fff', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer',
    fontWeight: '500', transition: 'all 0.2s'
  });
  btnCancel.onmouseover = () => { btnCancel.style.background = 'rgba(255,255,255,0.1)'; };
  btnCancel.onmouseout = () => { btnCancel.style.background = 'rgba(255,255,255,0.05)'; };
  
  const btnConfirm = document.createElement('button');
  btnConfirm.textContent = 'OK';
  Object.assign(btnConfirm.style, {
    background: 'linear-gradient(135deg, #8a2be2, #4b0082)', border: 'none',
    color: '#fff', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer',
    fontWeight: '500', boxShadow: '0 4px 15px rgba(138,43,226,0.3)', transition: 'all 0.2s'
  });
  btnConfirm.onmouseover = () => { btnConfirm.style.transform = 'translateY(-2px)'; btnConfirm.style.boxShadow = '0 6px 20px rgba(138,43,226,0.4)'; };
  btnConfirm.onmouseout = () => { btnConfirm.style.transform = 'translateY(0)'; btnConfirm.style.boxShadow = '0 4px 15px rgba(138,43,226,0.3)'; };

  const close = (result) => {
    overlay.style.opacity = '0';
    modal.style.transform = 'translateY(20px) scale(0.95)';
    setTimeout(() => { document.body.removeChild(overlay); if (onConfirm) onConfirm(result); }, 300);
  };

  btnCancel.onclick = () => close(false);
  btnConfirm.onclick = () => { close(true); };

  btnContainer.appendChild(btnCancel);
  btnContainer.appendChild(btnConfirm);
  modal.appendChild(btnContainer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  void overlay.offsetWidth;
  overlay.style.opacity = '1';
  modal.style.transform = 'translateY(0) scale(1)';
}

function customConfirm(message) {
  return new Promise(resolve => {
    showCustomModal({ title: message, isConfirm: true, onConfirm: resolve });
  });
}
