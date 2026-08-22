// ============================================================
// IMAGECREATER.JS — S.N.E.T.C.H Image Creator
// ============================================================

// ----- CONFIG -----
const MAX_IMAGES = 300; // mirrors the server-side sanity ceiling

// ----- STATE -----
let batchId = null;
let currentPrompt = '';
let selectedCount = 0;
let images = [];       // { index, filename, url }
let generating = false;

const EXAMPLE_PROMPTS = [
  'Neha Kakkar', 'Lion', 'Sunset', 'Taj Mahal',
  'Cyberpunk City', 'Mountain Landscape', 'Golden Retriever', 'Rose Flower'
];

const QUICK_PICKS = [1, 5, 10, 20, 50, 100];

// ----- DOM REFS -----
const idlePanel = document.getElementById('idlePanel');
const promptPanel = document.getElementById('promptPanel');
const countPanel = document.getElementById('countPanel');
const galleryPanel = document.getElementById('galleryPanel');

const startBtn = document.getElementById('startBtn');
const headerResetBtn = document.getElementById('headerResetBtn');

const promptInput = document.getElementById('promptInput');
const charCount = document.getElementById('charCount');
const exampleChips = document.getElementById('exampleChips');
const promptBackBtn = document.getElementById('promptBackBtn');
const promptNextBtn = document.getElementById('promptNextBtn');

const promptPreview = document.getElementById('promptPreview');
const countInput = document.getElementById('countInput');
const countQuickPicks = document.getElementById('countQuickPicks');
const countBackBtn = document.getElementById('countBackBtn');
const generateStartBtn = document.getElementById('generateStartBtn');

const progressInfo = document.getElementById('progressInfo');
const progressFill = document.getElementById('progressFill');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const galleryResetBtn = document.getElementById('galleryResetBtn');
const galleryGrid = document.getElementById('galleryGrid');

const toast = document.getElementById('toast');

// ----- UTIL -----
function sanitizeForFilename(text) {
  const cleaned = (text || '').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned || 'SNETCH_Image';
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 2600);
}

function showPanel(name) {
  idlePanel.hidden = name !== 'idle';
  promptPanel.hidden = name !== 'prompt';
  countPanel.hidden = name !== 'count';
  galleryPanel.hidden = name !== 'gallery';
  headerResetBtn.hidden = name === 'idle';
}

// ----- EXAMPLE CHIPS -----
function renderExampleChips() {
  exampleChips.innerHTML = '';
  EXAMPLE_PROMPTS.forEach(text => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = text;
    chip.addEventListener('click', () => {
      promptInput.value = text;
      promptInput.dispatchEvent(new Event('input'));
      exampleChips.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      promptInput.focus();
    });
    exampleChips.appendChild(chip);
  });
}

// ----- NUMBER-OF-IMAGES INPUT -----
function renderQuickPicks() {
  countQuickPicks.innerHTML = '';
  QUICK_PICKS.forEach(n => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'count-quick-pick';
    btn.textContent = n;
    btn.addEventListener('click', () => {
      countInput.value = n;
      applySelectedCount(n);
      countQuickPicks.querySelectorAll('.count-quick-pick').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    countQuickPicks.appendChild(btn);
  });
}

function applySelectedCount(n) {
  const parsed = parseInt(n, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    selectedCount = 0;
    generateStartBtn.disabled = true;
    return;
  }
  selectedCount = Math.min(parsed, MAX_IMAGES);
  generateStartBtn.disabled = false;
}

countInput.addEventListener('input', () => {
  countQuickPicks.querySelectorAll('.count-quick-pick').forEach(b => b.classList.remove('selected'));
  applySelectedCount(countInput.value);
});

// ----- SESSION -----
async function beginNewSession() {
  try {
    const res = await fetch('/api/imagecreater/new', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start a new session.');
    batchId = data.batch_id;
  } catch (e) {
    showToast(e.message || 'Could not start a new session.');
    return false;
  }

  // Reset all state — a completely fresh page for a new search.
  currentPrompt = '';
  selectedCount = 0;
  images = [];
  generating = false;

  promptInput.value = '';
  charCount.textContent = '0';
  promptNextBtn.disabled = true;
  exampleChips.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));

  countInput.value = '';
  countQuickPicks.querySelectorAll('.count-quick-pick').forEach(b => b.classList.remove('selected'));
  generateStartBtn.disabled = true;

  galleryGrid.innerHTML = '';
  downloadAllBtn.disabled = true;
  progressFill.style.width = '0%';

  showPanel('prompt');
  promptInput.focus();
  return true;
}

// ----- WIZARD NAVIGATION -----
promptInput.addEventListener('input', () => {
  charCount.textContent = String(promptInput.value.length);
  promptNextBtn.disabled = !promptInput.value.trim();
});

promptBackBtn.addEventListener('click', () => showPanel('idle'));

promptNextBtn.addEventListener('click', () => {
  currentPrompt = promptInput.value.trim();
  if (!currentPrompt) return;
  promptPreview.textContent = `Searching for \u201c${currentPrompt}\u201d`;
  showPanel('count');
});

countBackBtn.addEventListener('click', () => showPanel('prompt'));

generateStartBtn.addEventListener('click', () => {
  if (!selectedCount) return;
  startGeneration();
});

// ----- LIVE DOWNLOAD -----
function createPendingCard(index) {
  const card = document.createElement('div');
  card.className = 'image-card';
  card.dataset.index = index;
  card.innerHTML = `
    <div class="badge">#${index}</div>
    <div class="card-overlay">
      <div class="spinner"></div>
      <div class="status-text">Downloading…</div>
    </div>
  `;
  return card;
}

function fillCard(card, data) {
  const overlay = card.querySelector('.card-overlay');
  if (overlay) overlay.remove();

  const img = document.createElement('img');
  img.src = data.url;
  img.alt = `${currentPrompt} — image ${data.index}`;
  card.prepend(img);

  // --- Auto-delete countdown badge ---
  const AUTO_DELETE_SECONDS = 120;
  const timerBadge = document.createElement('div');
  timerBadge.className = 'auto-delete-timer';
  card.appendChild(timerBadge);

  let remaining = AUTO_DELETE_SECONDS;
  const renderTimer = () => {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    timerBadge.textContent = `Auto-delete in ${m}:${s.toString().padStart(2, '0')}`;
  };
  renderTimer();

  const timerInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(timerInterval);
      card.classList.add('expired-card');
      timerBadge.textContent = 'Expired — removed';
      setTimeout(() => {
        card.remove();
        images = images.filter(i => i.filename !== data.filename);
        downloadAllBtn.disabled = images.length === 0;
      }, 1500);
      return;
    }
    renderTimer();
  }, 1000);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.innerHTML = `
    <button class="card-download-btn"><i class="fas fa-download"></i> Download</button>
    <button class="card-delete-btn"><i class="fas fa-trash"></i> Delete</button>
  `;
  card.appendChild(actions);

  actions.querySelector('.card-download-btn').addEventListener('click', () => {
    const ext = (data.filename.split('.').pop() || 'jpg');
    const niceName = `${sanitizeForFilename(currentPrompt)}_${data.index}.${ext}`;
    const a = document.createElement('a');
    a.href = `/api/imagecreater/download/${batchId}/${data.filename}`;
    a.download = niceName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // File is safely downloaded — cancel the countdown and show that.
    clearInterval(timerInterval);
    timerBadge.textContent = 'Downloaded ✓';
    timerBadge.classList.add('downloaded');
  });

  actions.querySelector('.card-delete-btn').addEventListener('click', async () => {
    actions.querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      const res = await fetch('/api/imagecreater/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: batchId, filename: data.filename })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Delete failed.');
      clearInterval(timerInterval);
      card.remove();
      images = images.filter(i => i.filename !== data.filename);
      downloadAllBtn.disabled = images.length === 0;
      showToast(`Image #${data.index} deleted.`);
    } catch (e) {
      actions.querySelectorAll('button').forEach(b => b.disabled = false);
      showToast(e.message || 'Could not delete image.');
    }
  });
}

function markCardError(card, message) {
  card.classList.add('error-card');
  card.innerHTML = `<div class="status-text error-text"><i class="fas fa-triangle-exclamation"></i><br>${message || 'Could not download this image'}</div>`;
}

function updateProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
}

async function startGeneration() {
  showPanel('gallery');
  generating = true;
  galleryGrid.innerHTML = '';
  images = [];
  downloadAllBtn.disabled = true;
  progressInfo.textContent = `Downloading image 1 of ${selectedCount}…`;
  progressFill.style.width = '0%';

  let consecutiveFailures = 0;

  for (let index = 1; index <= selectedCount; index++) {
    progressInfo.textContent = `Downloading image ${index} of ${selectedCount}…`;
    const card = createPendingCard(index);
    galleryGrid.appendChild(card);

    try {
      const res = await fetch('/api/imagecreater/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_id: batchId,
          prompt: currentPrompt,
          index,
          count: selectedCount
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Download failed.');

      fillCard(card, data);
      images.push({ index, filename: data.filename, url: data.url });
      downloadAllBtn.disabled = false;
      consecutiveFailures = 0;
    } catch (e) {
      markCardError(card, e.message);
      consecutiveFailures++;
      // If the search has clearly run dry, stop hammering the server
      // with requests that can only fail the same way.
      if (/no more image|couldn.?t find/i.test(e.message || '') || consecutiveFailures >= 5) {
        updateProgress(index, selectedCount);
        showToast('No more images could be found for this search.');
        break;
      }
    }

    updateProgress(index, selectedCount);
  }

  generating = false;
  progressInfo.textContent = images.length
    ? `✓ ${images.length} of ${selectedCount} image${selectedCount > 1 ? 's' : ''} ready`
    : 'No images could be downloaded. Try a different search term.';
}

// ----- DOWNLOAD ALL -----
downloadAllBtn.addEventListener('click', () => {
  if (!batchId || images.length === 0) return;
  window.location.href = `/api/imagecreater/download-all/${batchId}`;
  showToast('Preparing your folder of images…');
});

// ----- RESET ENTRY POINTS -----
startBtn.addEventListener('click', beginNewSession);
headerResetBtn.addEventListener('click', async () => {
  if (generating && !(await customConfirm('Download is still in progress. Start a new session anyway?'))) return;
  beginNewSession();
});
galleryResetBtn.addEventListener('click', async () => {
  if (generating && !(await customConfirm('Download is still in progress. Start a new session anyway?'))) return;
  beginNewSession();
});

// ----- INIT -----
renderExampleChips();
renderQuickPicks();
showPanel('idle');

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