// ════════════════════════════════════════════════════════════════
// SPACE BACKGROUND — Deep Space + Purple Nebula + Blue Galaxy +
// Soft Twinkling Stars + Falling Shooting Stars + Floating Particles
// ════════════════════════════════════════════════════════════════
(function initSpace() {
  const canvas = document.getElementById('spaceCanvas');
  const ctx = canvas.getContext('2d');
  let w, h;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  // Stars
  const stars = [];
  const STAR_COUNT = 300;
  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.8 + 0.5,
      a: Math.random() * 0.8 + 0.2,
      speed: Math.random() * 0.008 + 0.003,
      phase: Math.random() * Math.PI * 2,
    });
  }

  // Shooting stars
  const shooting = [];
  const SHOOT_MAX = 4;

  function spawnShooting() {
    if (shooting.length < SHOOT_MAX && Math.random() < 0.008) {
      const angle = Math.PI / 4 + Math.random() * 0.6;
      const speed = 8 + Math.random() * 10;
      shooting.push({
        x: Math.random() * w * 0.8,
        y: Math.random() * h * 0.3,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        len: 60 + Math.random() * 70,
        width: 1.6 + Math.random() * 1.8,
      });
    }
  }

  // Nebula particles (floating)
  const particles = [];
  const PARTICLE_COUNT = 65;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 2 + Math.random() * 6,
      dx: (Math.random() - 0.5) * 0.2,
      dy: (Math.random() - 0.5) * 0.2,
      hue: 240 + Math.random() * 60,
      alpha: 0.08 + Math.random() * 0.12,
    });
  }

  function drawBackground() {
    // Deep space gradient
    const grad = ctx.createRadialGradient(w * 0.5, h * 0.4, 100, w * 0.5, h * 0.5, w * 0.9);
    grad.addColorStop(0, '#18142f');
    grad.addColorStop(0.4, '#0f0c24');
    grad.addColorStop(0.8, '#08061a');
    grad.addColorStop(1, '#03020e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Purple nebula glow (left)
    const neb1 = ctx.createRadialGradient(w * 0.1, h * 0.2, 10, w * 0.1, h * 0.2, w * 0.6);
    neb1.addColorStop(0, 'rgba(140, 80, 255, 0.09)');
    neb1.addColorStop(0.5, 'rgba(100, 50, 200, 0.05)');
    neb1.addColorStop(1, 'rgba(40, 20, 100, 0)');
    ctx.fillStyle = neb1;
    ctx.fillRect(0, 0, w, h);

    // Blue galaxy (right)
    const neb2 = ctx.createRadialGradient(w * 0.85, h * 0.7, 20, w * 0.85, h * 0.7, w * 0.5);
    neb2.addColorStop(0, 'rgba(50, 100, 255, 0.07)');
    neb2.addColorStop(0.6, 'rgba(30, 60, 200, 0.04)');
    neb2.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = neb2;
    ctx.fillRect(0, 0, w, h);

    // Floating particles
    for (const p of particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 70%, 70%, ${p.alpha})`;
      ctx.shadowColor = `hsla(${p.hue}, 80%, 70%, 0.2)`;
      ctx.shadowBlur = 28;
      ctx.fill();
      p.x += p.dx;
      p.y += p.dy;
      if (p.x < 0 || p.x > w) p.dx *= -1;
      if (p.y < 0 || p.y > h) p.dy *= -1;
    }

    // Stars twinkling
    for (const s of stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(Date.now() * s.speed + s.phase);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 240, 255, ${s.a * twinkle})`;
      ctx.shadowColor = 'rgba(200, 180, 255, 0.1)';
      ctx.shadowBlur = 12;
      ctx.fill();
    }

    // Shooting stars
    for (let i = shooting.length - 1; i >= 0; i--) {
      const s = shooting[i];
      s.x += s.vx;
      s.y += s.vy;
      s.life -= 0.008;
      if (s.life <= 0 || s.x > w || s.y > h) {
        shooting.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = s.life * 0.9;
      ctx.shadowColor = '#b88aff';
      ctx.shadowBlur = 40;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.4 - s.len * 0.3, s.y - s.vy * 0.4 - s.len * 0.3);
      ctx.strokeStyle = `rgba(210, 180, 255, ${s.life * 0.8})`;
      ctx.lineWidth = s.width;
      ctx.stroke();
      ctx.restore();
    }

    ctx.shadowBlur = 0;
    requestAnimationFrame(drawBackground);
  }

  setInterval(spawnShooting, 300);
  drawBackground();
})();

// ════════════════════════════════════════════════════════════════
// API HELPERS
// ════════════════════════════════════════════════════════════════
const API_BASE = '/api/filesystem';

async function apiGet(path) {
  const res = await fetch(API_BASE + path);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ════════════════════════════════════════════════════════════════
// TOASTS
// ════════════════════════════════════════════════════════════════
const toastContainer = document.getElementById('toastContainer');

function showToast(message, type = 'info') {
  const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${escapeHtml(message)}</span>`;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

// ════════════════════════════════════════════════════════════════
// MODAL SHELL
// ════════════════════════════════════════════════════════════════
const overlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalSteps = document.getElementById('modalSteps');
const modalBody = document.getElementById('modalBody');
const closeBtn = document.getElementById('closeModalBtn');

function setModalTitle(text) {
  modalTitle.textContent = text;
}

function renderStepDots(total, currentIndex) {
  if (!total || total <= 1) {
    modalSteps.innerHTML = '';
    return;
  }
  let html = '';
  for (let i = 0; i < total; i++) {
    const cls = i === currentIndex ? 'active' : (i < currentIndex ? 'done' : '');
    html += `<div class="step-dot ${cls}"></div>`;
  }
  modalSteps.innerHTML = html;
}

function renderBody(html) {
  modalBody.innerHTML = html;
  // restart the step-fade animation
  modalBody.style.animation = 'none';
  // eslint-disable-next-line no-unused-expressions
  modalBody.offsetHeight;
  modalBody.style.animation = '';
}

function openModal() {
  overlay.classList.remove('hidden');
}

function closeModal() {
  overlay.classList.add('hidden');
  modalBody.innerHTML = '';
  modalSteps.innerHTML = '';
}

closeBtn.addEventListener('click', closeModal);
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal();
});

// ════════════════════════════════════════════════════════════════
// SHARED UI FRAGMENTS
// ════════════════════════════════════════════════════════════════
function choiceGrid(items) {
  // items: [{ value, icon, label }]
  return `<div class="choice-grid">${items.map(it => `
    <div class="choice-card" data-value="${it.value}">
      <i class="fas ${it.icon}"></i>
      <span>${escapeHtml(it.label)}</span>
    </div>`).join('')}</div>`;
}

function resultItemHtml(item, inputType, checked) {
  const metaBits = [];
  if (!item.is_dir) metaBits.push(item.size);
  if (item.modified) metaBits.push(item.modified);
  return `
    <label class="result-item ${checked ? 'selected' : ''}" data-path="${escapeHtml(item.path)}">
      <input type="${inputType}" name="resultPick" ${checked ? 'checked' : ''} />
      <i class="fas ${item.icon} result-icon"></i>
      <div class="result-info">
        <div class="result-name">${escapeHtml(item.name)}${item.extension ? `<span class="ext-badge">${escapeHtml(item.extension)}</span>` : ''}</div>
        <div class="result-path">${escapeHtml(item.path)}</div>
      </div>
      <div class="result-meta">${metaBits.map(m => `<span>${escapeHtml(m)}</span>`).join('')}</div>
    </label>`;
}

function targetSummaryHtml(item) {
  return `
    <div class="target-summary">
      <i class="fas ${item.icon} result-icon"></i>
      <div class="result-info">
        <div class="result-name">${escapeHtml(item.name)}</div>
        <div class="result-path">${escapeHtml(item.path)}</div>
      </div>
    </div>`;
}

/**
 * Mounts a live search-and-select picker inside `container`.
 * options: { kind: 'file'|'folder'|'any', multiple: bool, excludePaths: string[], placeholder }
 * Returns a controller: { getSelected(), onChange(cb) }
 */
function mountSearchPicker(container, options) {
  const { kind = 'any', multiple = false, excludePaths = [], placeholder = 'Type a name to search…' } = options;
  const excludeSet = new Set(excludePaths);
  const selected = new Map(); // path -> item
  let changeCb = null;
  let latestToken = 0;

  container.innerHTML = `
    <div class="modal-search-wrapper">
      <i class="fas fa-magnifying-glass"></i>
      <input type="text" class="picker-input" placeholder="${escapeHtml(placeholder)}" />
      <div class="search-spinner"></div>
    </div>
    <div class="results-toolbar" style="display:none;">
      <span class="results-count"></span>
      <div class="toolbar-actions">
        ${multiple ? '<button type="button" class="select-all-btn">Select All</button>' : ''}
        <button type="button" class="clear-btn">Clear Selection</button>
      </div>
    </div>
    <div class="results-list"></div>
  `;

  const input = container.querySelector('.picker-input');
  const spinner = container.querySelector('.search-spinner');
  const list = container.querySelector('.results-list');
  const toolbar = container.querySelector('.results-toolbar');
  const countLabel = container.querySelector('.results-count');
  const selectAllBtn = container.querySelector('.select-all-btn');
  const clearBtn = container.querySelector('.clear-btn');

  let lastResults = [];

  function emitChange() {
    if (changeCb) changeCb(Array.from(selected.values()));
  }

  function updateResultVisualState() {
    list.querySelectorAll('.result-item').forEach(row => {
      const path = row.dataset.path;
      const on = selected.has(path);
      row.classList.toggle('selected', on);
      const input2 = row.querySelector('input');
      if (input2) input2.checked = on;
    });
    countLabel.textContent = selected.size > 0
      ? `${selected.size} selected`
      : `${lastResults.length} result${lastResults.length === 1 ? '' : 's'}`;
  }

  function toggleSelect(item) {
    if (!multiple) {
      selected.clear();
      selected.set(item.path, item);
    } else if (selected.has(item.path)) {
      selected.delete(item.path);
    } else {
      selected.set(item.path, item);
    }
    updateResultVisualState();
    emitChange();
  }

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.result-item');
    if (!row) return;
    e.preventDefault();
    const item = lastResults.find(r => r.path === row.dataset.path);
    if (item) toggleSelect(item);
  });

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      lastResults.forEach(item => selected.set(item.path, item));
      updateResultVisualState();
      emitChange();
    });
  }

  clearBtn.addEventListener('click', () => {
    selected.clear();
    updateResultVisualState();
    emitChange();
  });

  async function runSearch(query) {
    if (!query) {
      lastResults = [];
      list.innerHTML = '';
      toolbar.style.display = 'none';
      return;
    }
    const token = ++latestToken;
    spinner.classList.add('active');
    list.innerHTML = `<div class="results-loading"><i class="fas fa-circle-notch fa-spin"></i>Searching your system…</div>`;
    try {
      const data = await apiGet(`/search?q=${encodeURIComponent(query)}&kind=${kind}`);
      if (token !== latestToken) return; // stale response
      spinner.classList.remove('active');
      lastResults = (data.results || []).filter(r => !excludeSet.has(r.path));
      if (lastResults.length === 0) {
        list.innerHTML = `<div class="results-empty"><i class="fas fa-ghost"></i> No matches found.</div>`;
        toolbar.style.display = 'none';
        return;
      }
      toolbar.style.display = 'flex';
      const inputType = multiple ? 'checkbox' : 'radio';
      list.innerHTML = lastResults.map(item => resultItemHtml(item, inputType, selected.has(item.path))).join('');
      updateResultVisualState();
    } catch (err) {
      if (token !== latestToken) return;
      spinner.classList.remove('active');
      list.innerHTML = `<div class="results-empty"><i class="fas fa-triangle-exclamation"></i> Search failed. Try again.</div>`;
    }
  }

  input.addEventListener('input', debounce((e) => runSearch(e.target.value.trim()), 350));

  return {
    getSelected: () => Array.from(selected.values()),
    onChange: (cb) => { changeCb = cb; },
    presetQuery: (q) => { input.value = q; runSearch(q); },
  };
}

/**
 * Mounts common-location chips + an inline folder search picker for
 * multi-destination selection (used by Create File / Create Folder).
 */
function mountDestinationPicker(container) {
  const selected = new Map(); // path -> {path, label}
  let changeCb = null;

  container.innerHTML = `
    <label>Common Locations</label>
    <div class="location-chips" id="locChips"><span class="field-hint">Loading locations…</span></div>
    <label style="margin-top:8px;">Or Search Any Folder</label>
    <div id="destSearchArea"></div>
  `;

  const chipsWrap = container.querySelector('#locChips');
  const destSearchArea = container.querySelector('#destSearchArea');

  function emitChange() {
    if (changeCb) changeCb(Array.from(selected.values()));
  }

  apiGet('/locations').then(data => {
    const locations = (data.locations || []).filter(l => l.exists);
    if (locations.length === 0) {
      chipsWrap.innerHTML = `<span class="field-hint">No common locations found on this system.</span>`;
      return;
    }
    const iconMap = { desktop: 'fa-desktop', documents: 'fa-file-lines', downloads: 'fa-download',
      pictures: 'fa-image', videos: 'fa-video', music: 'fa-music' };
    chipsWrap.innerHTML = locations.map(loc => `
      <div class="location-chip" data-path="${escapeHtml(loc.path)}">
        <i class="fas ${iconMap[loc.key] || 'fa-folder'}"></i><span>${escapeHtml(loc.label)}</span>
      </div>`).join('');

    chipsWrap.querySelectorAll('.location-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const path = chip.dataset.path;
        if (selected.has(path)) {
          selected.delete(path);
          chip.classList.remove('selected');
        } else {
          selected.set(path, { path, name: chip.textContent.trim() });
          chip.classList.add('selected');
        }
        emitChange();
      });
    });
  }).catch(() => {
    chipsWrap.innerHTML = `<span class="field-hint">Could not load common locations.</span>`;
  });

  const picker = mountSearchPicker(destSearchArea, {
    kind: 'folder',
    multiple: true,
    placeholder: 'e.g. Project',
  });
  picker.onChange((items) => {
    // Track folder-search selections separately; merged with chip selections on read.
    picker._current = items;
    emitChange();
  });

  return {
    getSelected: () => {
      const merged = new Map(selected);
      (picker._current || []).forEach(item => merged.set(item.path, item));
      return Array.from(merged.values());
    },
    onChange: (cb) => { changeCb = cb; },
  };
}

// ════════════════════════════════════════════════════════════════
// GENERIC "TYPE" FIRST STEP  (File vs Folder)
// ════════════════════════════════════════════════════════════════
function renderTypeStep(onPick, opts = {}) {
  const label1 = opts.fileLabel || 'File';
  const label2 = opts.folderLabel || 'Folder';
  renderStepDots(opts.totalSteps, 0);
  renderBody(`
    <p style="color:#b0a6d0; font-size:14.5px; margin-bottom:4px;">${opts.prompt || 'What would you like to work with?'}</p>
    ${choiceGrid([
      { value: 'file', icon: 'fa-file', label: label1 },
      { value: 'folder', icon: 'fa-folder', label: label2 },
    ])}
  `);
  modalBody.querySelectorAll('.choice-card').forEach(card => {
    card.addEventListener('click', () => onPick(card.dataset.value));
  });
}

// ════════════════════════════════════════════════════════════════
// FLOW: CREATE FILE / FOLDER
// ════════════════════════════════════════════════════════════════
function startCreateFlow() {
  setModalTitle('✨ Create File or Folder');
  renderTypeStep((kind) => renderCreateNameStep(kind), { totalSteps: 3 });
}

function renderCreateNameStep(kind) {
  renderStepDots(3, 1);
  const isFile = kind === 'file';
  renderBody(`
    <div class="field-block">
      <label>${isFile ? 'File Name (extension is mandatory)' : 'Folder Name'}</label>
      <input type="text" id="itemName" placeholder="${isFile ? 'e.g. report.pdf, main.py, photo.png' : 'e.g. Project Alpha'}" autofocus />
      ${isFile ? '<div class="field-hint">Examples: report.pdf · resume.docx · main.py · photo.png · video.mp4 · notes.txt</div>' : ''}
    </div>
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
      <button type="button" class="primary" id="nextBtn">Next</button>
    </div>
  `);
  document.getElementById('backBtn').addEventListener('click', () => startCreateFlow());
  document.getElementById('nextBtn').addEventListener('click', () => {
    const name = document.getElementById('itemName').value.trim();
    if (!name) return showToast('Please enter a name.', 'error');
    if (isFile && !name.includes('.')) return showToast('File name must include an extension, e.g. notes.txt', 'error');
    renderCreateDestinationStep(kind, name);
  });
}

function renderCreateDestinationStep(kind, name) {
  renderStepDots(3, 2);
  renderBody(`
    <div class="target-summary">
      <i class="fas ${kind === 'file' ? 'fa-file' : 'fa-folder'} result-icon"></i>
      <div class="result-info">
        <div class="result-name">${escapeHtml(name)}</div>
        <div class="result-path">Where do you want to create this ${kind}?</div>
      </div>
    </div>
    <div id="destPickerArea"></div>
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
      <button type="button" class="primary" id="createBtn" disabled>Create</button>
    </div>
  `);
  const picker = mountDestinationPicker(document.getElementById('destPickerArea'));
  const createBtn = document.getElementById('createBtn');
  picker.onChange((items) => { createBtn.disabled = items.length === 0; });

  document.getElementById('backBtn').addEventListener('click', () => renderCreateNameStep(kind));
  createBtn.addEventListener('click', async () => {
    const destinations = picker.getSelected().map(d => d.path);
    if (destinations.length === 0) return showToast('Select at least one destination.', 'error');
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    try {
      const res = await apiPost('/create', { kind, name, destinations });
      showToast(res.message || (res.success ? 'Created successfully.' : 'Something went wrong.'), res.success ? 'success' : 'error');
      if (res.success) closeModal();
    } catch (e) {
      showToast('Request failed. Please try again.', 'error');
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = 'Create';
    }
  });
}

// ════════════════════════════════════════════════════════════════
// FLOW: UPDATE FILE / FOLDER
// ════════════════════════════════════════════════════════════════
function startUpdateFlow() {
  setModalTitle('✏️ Update File or Folder');
  renderTypeStep((kind) => {
    if (kind === 'file') renderUpdateFileTargetStep();
    else renderUpdateFolderTargetStep();
  }, { totalSteps: 3 });
}

function renderUpdateFileTargetStep() {
  renderStepDots(3, 1);
  renderBody(`
    <div class="field-block">
      <label>Which file do you want to replace?</label>
      <div id="targetSearchArea"></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
      <button type="button" class="primary" id="nextBtn" disabled>Next</button>
    </div>
  `);
  const picker = mountSearchPicker(document.getElementById('targetSearchArea'), {
    kind: 'file', multiple: false, placeholder: 'Enter file name (no extension needed)…',
  });
  const nextBtn = document.getElementById('nextBtn');
  picker.onChange(items => { nextBtn.disabled = items.length !== 1; });
  document.getElementById('backBtn').addEventListener('click', () => startUpdateFlow());
  nextBtn.addEventListener('click', () => {
    const target = picker.getSelected()[0];
    renderUpdateFileReplacementStep(target);
  });
}

function renderUpdateFileReplacementStep(target) {
  renderStepDots(3, 2);
  renderBody(`
    ${targetSummaryHtml(target)}
    <div class="field-block">
      <label>Which file should replace it?</label>
      <div id="replSearchArea"></div>
      <div class="field-hint">The replacement file will be removed from its original location after the update.</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
      <button type="button" class="primary" id="updateBtn" disabled>Update</button>
    </div>
  `);
  const picker = mountSearchPicker(document.getElementById('replSearchArea'), {
    kind: 'file', multiple: false, excludePaths: [target.path], placeholder: 'Enter replacement file name…',
  });
  const updateBtn = document.getElementById('updateBtn');
  picker.onChange(items => { updateBtn.disabled = items.length !== 1; });
  document.getElementById('backBtn').addEventListener('click', () => renderUpdateFileTargetStep());
  updateBtn.addEventListener('click', async () => {
    const replacement = picker.getSelected()[0];
    updateBtn.disabled = true;
    updateBtn.textContent = 'Updating…';
    try {
      const res = await apiPost('/update/file', { target: target.path, replacement: replacement.path });
      showToast(res.message, res.success ? 'success' : 'error');
      if (res.success) closeModal();
    } catch {
      showToast('Request failed. Please try again.', 'error');
    } finally {
      updateBtn.disabled = false;
      updateBtn.textContent = 'Update';
    }
  });
}

function renderUpdateFolderTargetStep() {
  renderStepDots(4, 1);
  renderBody(`
    <div class="field-block">
      <label>Which folder do you want to update?</label>
      <div id="targetSearchArea"></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
      <button type="button" class="primary" id="nextBtn" disabled>Next</button>
    </div>
  `);
  const picker = mountSearchPicker(document.getElementById('targetSearchArea'), {
    kind: 'folder', multiple: false, placeholder: 'Enter folder name…',
  });
  const nextBtn = document.getElementById('nextBtn');
  picker.onChange(items => { nextBtn.disabled = items.length !== 1; });
  document.getElementById('backBtn').addEventListener('click', () => startUpdateFlow());
  nextBtn.addEventListener('click', () => {
    const target = picker.getSelected()[0];
    renderUpdateFolderOptionStep(target);
  });
}

function renderUpdateFolderOptionStep(target) {
  renderStepDots(4, 2);
  renderBody(`
    ${targetSummaryHtml(target)}
    <p style="color:#b0a6d0; font-size:14.5px;">What would you like to do with this folder?</p>
    ${choiceGrid([
      { value: 'add', icon: 'fa-square-plus', label: 'Add Existing File / Folder' },
      { value: 'replace', icon: 'fa-arrows-rotate', label: 'Replace Folder' },
    ])}
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
    </div>
  `);
  document.getElementById('backBtn').addEventListener('click', () => renderUpdateFolderTargetStep());
  modalBody.querySelectorAll('.choice-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.dataset.value === 'add') renderUpdateFolderAddTypeStep(target);
      else renderUpdateFolderReplaceStep(target);
    });
  });
}

function renderUpdateFolderAddTypeStep(target) {
  renderStepDots(4, 3);
  renderBody(`
    ${targetSummaryHtml(target)}
    <p style="color:#b0a6d0; font-size:14.5px;">Add a file or a folder into this target?</p>
    ${choiceGrid([
      { value: 'file', icon: 'fa-file', label: 'File' },
      { value: 'folder', icon: 'fa-folder', label: 'Folder' },
    ])}
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
    </div>
  `);
  document.getElementById('backBtn').addEventListener('click', () => renderUpdateFolderOptionStep(target));
  modalBody.querySelectorAll('.choice-card').forEach(card => {
    card.addEventListener('click', () => renderUpdateFolderAddSearchStep(target, card.dataset.value));
  });
}

function renderUpdateFolderAddSearchStep(target, kind) {
  renderStepDots(4, 4);
  renderBody(`
    ${targetSummaryHtml(target)}
    <div class="field-block">
      <label>${kind === 'file' ? 'File Name' : 'Folder Name'} (no extension needed)</label>
      <div id="addSearchArea"></div>
      <div class="field-hint">Selected items will be moved into "${escapeHtml(target.name)}" and removed from their original location.</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
      <button type="button" class="primary" id="addBtn" disabled>Add</button>
    </div>
  `);
  const picker = mountSearchPicker(document.getElementById('addSearchArea'), {
    kind, multiple: true, excludePaths: [target.path], placeholder: `Search for a ${kind}…`,
  });
  const addBtn = document.getElementById('addBtn');
  picker.onChange(items => { addBtn.disabled = items.length === 0; });
  document.getElementById('backBtn').addEventListener('click', () => renderUpdateFolderAddTypeStep(target));
  addBtn.addEventListener('click', async () => {
    const sources = picker.getSelected().map(i => i.path);
    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';
    try {
      const res = await apiPost('/update/folder/add', { target: target.path, sources });
      showToast(res.message, res.success ? 'success' : 'error');
      if (res.success) closeModal();
    } catch {
      showToast('Request failed. Please try again.', 'error');
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
    }
  });
}

function renderUpdateFolderReplaceStep(target) {
  renderStepDots(4, 3);
  renderBody(`
    ${targetSummaryHtml(target)}
    <div class="field-block">
      <label>Which folder should replace it?</label>
      <div id="replSearchArea"></div>
      <div class="field-hint">The replacement folder will be removed from its original location after the swap.</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
      <button type="button" class="primary danger" id="replaceBtn" disabled>Replace</button>
    </div>
  `);
  const picker = mountSearchPicker(document.getElementById('replSearchArea'), {
    kind: 'folder', multiple: false, excludePaths: [target.path], placeholder: 'Enter replacement folder name…',
  });
  const replaceBtn = document.getElementById('replaceBtn');
  picker.onChange(items => { replaceBtn.disabled = items.length !== 1; });
  document.getElementById('backBtn').addEventListener('click', () => renderUpdateFolderOptionStep(target));
  replaceBtn.addEventListener('click', async () => {
    const replacement = picker.getSelected()[0];
    replaceBtn.disabled = true;
    replaceBtn.textContent = 'Replacing…';
    try {
      const res = await apiPost('/update/folder/replace', { target: target.path, replacement: replacement.path });
      showToast(res.message, res.success ? 'success' : 'error');
      if (res.success) closeModal();
    } catch {
      showToast('Request failed. Please try again.', 'error');
    } finally {
      replaceBtn.disabled = false;
      replaceBtn.textContent = 'Replace';
    }
  });
}

// ════════════════════════════════════════════════════════════════
// FLOW: DELETE FILE / FOLDER
// ════════════════════════════════════════════════════════════════
function startDeleteFlow() {
  setModalTitle('🗑️ Delete File or Folder');
  renderTypeStep((kind) => renderDeleteSearchStep(kind), { totalSteps: 2 });
}

function renderDeleteSearchStep(kind) {
  renderStepDots(2, 1);
  renderBody(`
    <div class="field-block">
      <label>${kind === 'file' ? 'File Name' : 'Folder Name'} (no extension needed)</label>
      <div id="delSearchArea"></div>
      <div class="field-hint" style="color:#ff9aa8;">⚠️ This action is permanent and cannot be undone.</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
      <button type="button" class="primary danger" id="delBtn" disabled>Delete</button>
    </div>
  `);
  const picker = mountSearchPicker(document.getElementById('delSearchArea'), {
    kind, multiple: true, placeholder: `Search for a ${kind}…`,
  });
  const delBtn = document.getElementById('delBtn');
  picker.onChange(items => { delBtn.disabled = items.length === 0; });
  document.getElementById('backBtn').addEventListener('click', () => startDeleteFlow());
  delBtn.addEventListener('click', async () => {
    const items = picker.getSelected();
    if (items.length === 0) return;
    if (!(await customConfirm(`Delete ${items.length} item(s)? This cannot be undone.`))) return;
    delBtn.disabled = true;
    delBtn.textContent = 'Deleting…';
    try {
      const res = await apiPost('/delete', { paths: items.map(i => i.path) });
      showToast(res.message, res.success ? 'success' : 'error');
      if (res.success) closeModal();
    } catch {
      showToast('Request failed. Please try again.', 'error');
    } finally {
      delBtn.disabled = false;
      delBtn.textContent = 'Delete';
    }
  });
}

// ════════════════════════════════════════════════════════════════
// FLOW: RENAME FILE / FOLDER
// ════════════════════════════════════════════════════════════════
function startRenameFlow() {
  setModalTitle('✏️ Rename File or Folder');
  renderTypeStep((kind) => renderRenameSearchStep(kind), { totalSteps: 3 });
}

function renderRenameSearchStep(kind) {
  renderStepDots(3, 1);
  renderBody(`
    <div class="field-block">
      <label>${kind === 'file' ? 'File Name' : 'Folder Name'} (no extension needed)</label>
      <div id="renSearchArea"></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
      <button type="button" class="primary" id="nextBtn" disabled>Next</button>
    </div>
  `);
  const picker = mountSearchPicker(document.getElementById('renSearchArea'), {
    kind, multiple: false, placeholder: `Search for a ${kind}…`,
  });
  const nextBtn = document.getElementById('nextBtn');
  picker.onChange(items => { nextBtn.disabled = items.length !== 1; });
  document.getElementById('backBtn').addEventListener('click', () => startRenameFlow());
  nextBtn.addEventListener('click', () => {
    const target = picker.getSelected()[0];
    renderRenameFormStep(kind, target);
  });
}

function renderRenameFormStep(kind, target) {
  renderStepDots(3, 2);
  const dotIndex = target.name.lastIndexOf('.');
  const stem = kind === 'file' && dotIndex > 0 ? target.name.slice(0, dotIndex) : target.name;
  const ext = kind === 'file' && dotIndex > 0 ? target.name.slice(dotIndex + 1) : '';

  renderBody(`
    ${targetSummaryHtml(target)}
    <div class="field-block">
      <label>New ${kind === 'file' ? 'File Name' : 'Folder Name'}</label>
      <input type="text" id="newName" value="${escapeHtml(stem)}" />
    </div>
    ${kind === 'file' ? `
      <div class="field-block">
        <label>New Extension</label>
        <input type="text" id="newExt" value="${escapeHtml(ext)}" placeholder="e.g. pdf" />
      </div>` : ''}
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
      <button type="button" class="primary" id="renameBtn">Rename</button>
    </div>
  `);
  document.getElementById('backBtn').addEventListener('click', () => renderRenameSearchStep(kind));
  document.getElementById('renameBtn').addEventListener('click', async () => {
    const nameVal = document.getElementById('newName').value.trim();
    if (!nameVal) return showToast('Please enter a name.', 'error');
    let newName = nameVal;
    if (kind === 'file') {
      const extVal = document.getElementById('newExt').value.trim().replace(/^\./, '');
      if (!extVal) return showToast('Please enter a file extension.', 'error');
      newName = `${nameVal}.${extVal}`;
    }
    const btn = document.getElementById('renameBtn');
    btn.disabled = true;
    btn.textContent = 'Renaming…';
    try {
      const res = await apiPost('/rename', { path: target.path, new_name: newName });
      showToast(res.message, res.success ? 'success' : 'error');
      if (res.success) closeModal();
    } catch {
      showToast('Request failed. Please try again.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Rename';
    }
  });
}

// ════════════════════════════════════════════════════════════════
// FLOW: OPEN FILE / FOLDER
// ════════════════════════════════════════════════════════════════
function startOpenFlow() {
  setModalTitle('📂 Open File or Folder');
  renderTypeStep((kind) => renderOpenSearchStep(kind), { totalSteps: 2 });
}

function renderOpenSearchStep(kind) {
  renderStepDots(2, 1);
  renderBody(`
    <div class="field-block">
      <label>${kind === 'file' ? 'File Name' : 'Folder Name'} (no extension needed)</label>
      <div id="openSearchArea"></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="ghost" id="backBtn">Back</button>
      <button type="button" class="primary" id="openBtn" disabled>Open</button>
    </div>
  `);
  const picker = mountSearchPicker(document.getElementById('openSearchArea'), {
    kind, multiple: true, placeholder: `Search for a ${kind}…`,
  });
  const openBtn = document.getElementById('openBtn');
  picker.onChange(items => { openBtn.disabled = items.length === 0; });
  document.getElementById('backBtn').addEventListener('click', () => startOpenFlow());
  openBtn.addEventListener('click', async () => {
    const items = picker.getSelected();
    if (items.length === 0) return;
    openBtn.disabled = true;
    openBtn.textContent = 'Opening…';
    try {
      const res = await apiPost('/open', { paths: items.map(i => i.path) });
      showToast(res.message, res.success ? 'success' : 'error');
      if (res.success) closeModal();
    } catch {
      showToast('Request failed. Please try again.', 'error');
    } finally {
      openBtn.disabled = false;
      openBtn.textContent = 'Open';
    }
  });
}

// ════════════════════════════════════════════════════════════════
// WIRE UP CARDS → FLOWS
// ════════════════════════════════════════════════════════════════
const FLOWS = {
  create: startCreateFlow,
  update: startUpdateFlow,
  delete: startDeleteFlow,
  rename: startRenameFlow,
  open: startOpenFlow,
};

document.querySelectorAll('.card-btn[data-flow]').forEach(btn => {
  btn.addEventListener('click', () => {
    const flow = FLOWS[btn.dataset.flow];
    if (flow) {
      openModal();
      flow();
    }
  });
});

// ════════════════════════════════════════════════════════════════
// HOME BUTTON
// ════════════════════════════════════════════════════════════════
document.getElementById('homeBtn').addEventListener('click', () => {
  window.location.href = '/';
});

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
