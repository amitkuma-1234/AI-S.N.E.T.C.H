// ============================================================
// spaim_mail.js · S.N.E.T.C.H Spam Mail Checker (Redesigned)
// ============================================================

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // ---------- DOM REFS ----------
  const viewInitial = $('#viewInitial');
  const viewInput = $('#viewInput');
  const viewLoading = $('#viewLoading');
  const viewResult = $('#viewResult');

  const btnStartCheck = $('#btnStartCheck');
  const btnCheckSpam = $('#btnCheckSpam');
  const btnClear = $('#btnClear');
  const btnStartOver = $('#btnStartOver');

  const emailInput = $('#emailInput');
  const charCount = $('#charCount');

  const resultBadge = $('#resultBadge');
  const resultBadgeIcon = $('#resultBadgeIcon');
  const resultBadgeText = $('#resultBadgeText');
  const confidenceFill = $('#confidenceFill');
  const confidenceValue = $('#confidenceValue');
  const spamProbValue = $('#spamProbValue');
  
  const resultError = $('#resultError');
  const resultErrorText = $('#resultErrorText');

  // ---------- VIEW MANAGEMENT ----------
  function showView(viewToShow) {
    [viewInitial, viewInput, viewLoading, viewResult].forEach((view) => {
      if (view) view.hidden = (view !== viewToShow);
    });
  }

  // ---------- ACTIONS ----------
  function handleStartCheck() {
    emailInput.value = '';
    charCount.textContent = '0 characters';
    showView(viewInput);
    // slight delay to let DOM display before focusing
    setTimeout(() => emailInput.focus(), 50);
  }

  function handleClear() {
    emailInput.value = '';
    charCount.textContent = '0 characters';
    emailInput.focus();
  }

  async function handleCheckSpam() {
    const text = emailInput.value.trim();
    if (!text) return; // Prevent empty submit

    showView(viewLoading);

    try {
      const res = await fetch('/api/spaim_mail/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        showError(data.error || 'Something went wrong. Please try again.');
        return;
      }

      renderResult(data);
    } catch (err) {
      console.error('[SNETCH] spam check failed:', err);
      showError('Could not reach the server. Please try again.');
    }
  }

  function showError(msg) {
    resultErrorText.textContent = msg;
    resultError.hidden = false;
    
    // Hide success elements
    resultBadge.hidden = true;
    $('.confidence-block').hidden = true;
    $('.result-meta').hidden = true;
    
    showView(viewResult);
  }

  function renderResult(data) {
    const isSpam = !!data.is_spam;

    resultError.hidden = true;
    resultBadge.hidden = false;
    $('.confidence-block').hidden = false;
    $('.result-meta').hidden = false;

    resultBadge.className = 'result-badge ' + (isSpam ? 'is-spam' : 'is-ham');
    resultBadgeIcon.className = 'fas ' + (isSpam ? 'fa-triangle-exclamation' : 'fa-circle-check');
    resultBadgeText.textContent = isSpam ? 'SPAM DETECTED' : 'SAFE / NOT SPAM';

    const confidencePct = Math.round((data.confidence || 0) * 100);
    confidenceValue.textContent = confidencePct + '%';
    
    // Reset width before animation
    confidenceFill.style.width = '0%';
    confidenceFill.className = 'confidence-fill ' + (isSpam ? 'is-spam' : 'is-ham');
    
    // Trigger reflow for animation
    void confidenceFill.offsetWidth; 
    
    confidenceFill.style.width = confidencePct + '%';

    spamProbValue.textContent = Math.round((data.spam_probability || 0) * 100) + '%';

    showView(viewResult);
  }

  // ---------- EVENTS ----------
  emailInput.addEventListener('input', () => {
    charCount.textContent = `${emailInput.value.length} characters`;
  });

  emailInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleCheckSpam();
    }
  });

  if (btnStartCheck) btnStartCheck.addEventListener('click', handleStartCheck);
  if (btnClear) btnClear.addEventListener('click', handleClear);
  if (btnCheckSpam) btnCheckSpam.addEventListener('click', handleCheckSpam);
  if (btnStartOver) btnStartOver.addEventListener('click', handleStartCheck);

  // ---------- INIT ----------
  showView(viewInitial);

})();