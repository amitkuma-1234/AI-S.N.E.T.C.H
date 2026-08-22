// ══════════════════════════════════════════════════════════════════
//  download_entertainment.js — S.N.E.T.C.H Entertainment Downloader
//  Frontend logic for category → search → download → progress flow
// ══════════════════════════════════════════════════════════════════

(() => {
  'use strict';

  // ── State ────────────────────────────────────────────────────────
  const S = {
    category: null,        // selected category key (e.g. "movies")
    results: [],           // search results from API
    selectedIdx: null,     // index of selected result
    torrentHash: null,     // hash of active download
    progressTimer: null,   // setInterval id for progress polling
    isSearching: false,
    isDownloading: false,
  };

  // ── DOM references ───────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const DOM = {};

  function cacheDom() {
    DOM.categorySection   = $('#category-section');
    DOM.categoryGrid      = $('#category-grid');
    DOM.searchSection      = $('#search-section');
    DOM.searchInput        = $('#search-input');
    DOM.searchBtn          = $('#search-btn');
    DOM.searchCatLabel     = $('#search-category-label');
    DOM.hintText           = $('#hint-text');
    DOM.resultsSection     = $('#results-section');
    DOM.resultsList        = $('#results-list');
    DOM.resultsCount       = $('#results-count');
    DOM.downloadBtn        = $('#download-btn');
    DOM.loadingSection     = $('#loading-section');
    DOM.loadingText        = $('#loading-text');
    DOM.progressSection    = $('#progress-section');
    DOM.progressTitle      = $('#progress-title');
    DOM.progressStatus     = $('#progress-status');
    DOM.progressFill       = $('#progress-fill');
    DOM.progressGlow       = $('#progress-glow');
    DOM.progressPct        = $('#progress-pct');
    DOM.statSpeed          = $('#stat-speed');
    DOM.statDownloaded     = $('#stat-downloaded');
    DOM.statTotal          = $('#stat-total');
    DOM.statEta            = $('#stat-eta');
    DOM.cancelBtn          = $('#cancel-btn');
    DOM.completeSection    = $('#complete-section');
    DOM.completeTitle      = $('#complete-title');
    DOM.completeFilename   = $('#complete-filename');
    DOM.completeLocation   = $('#complete-location');
    DOM.newDownloadBtn     = $('#new-download-btn');
    DOM.errorSection       = $('#error-section');
    DOM.errorTitle         = $('#error-title');
    DOM.errorMessage       = $('#error-message');
    DOM.errorRetryBtn      = $('#error-retry-btn');
    DOM.featureGrid        = $('#feature-grid');
    DOM.toastContainer     = $('#toast-container');
    DOM.spaceBg            = $('#space-bg');
    DOM.sidebar            = $('#sidebar');
  }

  // ── Category hint map ────────────────────────────────────────────
  const HINTS = {
    movies:  'Try "Avengers Endgame", "Breaking Bad S01", "The Witcher"...',
    pcgame:  'Try "GTA V", "Elden Ring", "Cyberpunk 2077"...',
    book:    'Try "Atomic Habits", "Sapiens", "1984 George Orwell"...',
    audio:   'Try "Alan Walker", "Beethoven Symphony", "Lo-fi beats"...',
    tv:      'Try "Game of Thrones", "Stranger Things", "The Office"...',
    others:  'Search for any content you want to download...',
  };

  // ── Sections helper ──────────────────────────────────────────────
  const SECTIONS = [
    'searchSection', 'resultsSection', 'loadingSection',
    'progressSection', 'completeSection', 'errorSection',
  ];

  function showSection(name) {
    SECTIONS.forEach(s => {
      if (DOM[s]) {
        DOM[s].classList.toggle('visible', s === name);
      }
    });
  }

  function hideAllSections() {
    SECTIONS.forEach(s => {
      if (DOM[s]) DOM[s].classList.remove('visible');
    });
  }

  // ── Toast notifications ──────────────────────────────────────────
  function toast(message, type = 'info') {
    const icons = { error: 'fa-exclamation-circle', success: 'fa-check-circle', info: 'fa-info-circle' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${message}</span>`;
    DOM.toastContainer.appendChild(el);
    setTimeout(() => {
      el.style.animation = 'toastOut 0.35s ease forwards';
      setTimeout(() => el.remove(), 350);
    }, 4000);
  }

  // ── Shooting stars generator ─────────────────────────────────────
  function createShootingStars() {
    if (!DOM.spaceBg) return;
    for (let i = 0; i < 4; i++) {
      const star = document.createElement('div');
      star.className = 'shooting-star';
      star.style.setProperty('--top', `${10 + Math.random() * 60}%`);
      star.style.setProperty('--left', `${-10 + Math.random() * 30}%`);
      star.style.setProperty('--dur', `${3 + Math.random() * 4}s`);
      star.style.setProperty('--delay', `${Math.random() * 10}s`);
      DOM.spaceBg.appendChild(star);
    }
  }

  // ── Mobile sidebar toggle ────────────────────────────────────────
  function createMobileToggle() {
    if (document.querySelector('.mobile-toggle')) return;
    const btn = document.createElement('button');
    btn.className = 'mobile-toggle';
    btn.innerHTML = '<i class="fas fa-bars"></i>';
    btn.addEventListener('click', () => {
      DOM.sidebar.classList.toggle('open');
    });
    document.body.appendChild(btn);

    // Close sidebar on outside click (mobile)
    document.addEventListener('click', (e) => {
      if (DOM.sidebar.classList.contains('open') &&
          !DOM.sidebar.contains(e.target) &&
          !btn.contains(e.target)) {
        DOM.sidebar.classList.remove('open');
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  CATEGORY SELECTION
  // ══════════════════════════════════════════════════════════════════

  function bindCategoryCards() {
    $$('.category-card').forEach(card => {
      card.addEventListener('click', () => {
        // Deselect all
        $$('.category-card').forEach(c => c.classList.remove('active'));
        // Select this
        card.classList.add('active');

        S.category = card.dataset.cat;
        S.results = [];
        S.selectedIdx = null;

        // Show search section
        DOM.searchCatLabel.textContent = card.querySelector('.cat-label').textContent;
        DOM.hintText.textContent = HINTS[S.category] || HINTS.others;
        DOM.searchInput.value = '';
        DOM.searchInput.placeholder = `Search for ${card.querySelector('.cat-label').textContent.toLowerCase()}...`;

        showSection('searchSection');
        // Hide results, features
        DOM.resultsSection.classList.remove('visible');
        if (DOM.featureGrid) DOM.featureGrid.style.display = 'none';

        // Focus input
        setTimeout(() => DOM.searchInput.focus(), 100);

        toast(`Category: ${card.querySelector('.cat-label').textContent}`, 'info');
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  SEARCH
  // ══════════════════════════════════════════════════════════════════

  async function doSearch() {
    const query = DOM.searchInput.value.trim();
    if (!query) {
      toast('Please enter a search term.', 'error');
      DOM.searchInput.focus();
      return;
    }
    if (!S.category) {
      toast('Please select a category first.', 'error');
      return;
    }
    if (S.isSearching) return;

    S.isSearching = true;
    S.results = [];
    S.selectedIdx = null;

    // Show loading
    DOM.loadingText.textContent = 'Searching across sources...';
    showSection('loadingSection');
    DOM.resultsSection.classList.remove('visible');

    try {
      const resp = await fetch('/api/entertainment/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: S.category, query }),
      });

      const data = await resp.json();

      if (!resp.ok || data.error) {
        throw new Error(data.error || `Search failed (${resp.status})`);
      }

      S.results = data.results || [];
      if (S.results.length === 0) {
        throw new Error('No results found. Try a different search term.');
      }

      renderResults();
      showSection('resultsSection');
      toast(`Found ${S.results.length} result${S.results.length !== 1 ? 's' : ''}`, 'success');

    } catch (err) {
      showError('Search Failed', err.message);
    } finally {
      S.isSearching = false;
    }
  }

  function bindSearch() {
    DOM.searchBtn.addEventListener('click', doSearch);
    DOM.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSearch();
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  RENDER RESULTS
  // ══════════════════════════════════════════════════════════════════

  function renderResults() {
    DOM.resultsCount.textContent = `(${S.results.length})`;
    DOM.downloadBtn.disabled = true;
    DOM.resultsList.innerHTML = '';

    // Category icon map
    const catIcons = {
      'Movie / Web Series': 'fa-film',
      'PC Game': 'fa-gamepad',
      'Book': 'fa-book',
      'Audio': 'fa-music',
      'TV': 'fa-tv',
      'Other': 'fa-ellipsis-h',
    };

    S.results.forEach((r, idx) => {
      const card = document.createElement('div');
      card.className = 'result-card';
      card.dataset.idx = idx;

      const icon = catIcons[r.category] || 'fa-file-alt';

      card.innerHTML = `
        <div class="result-radio">
          <div class="result-radio-dot"></div>
        </div>
        <div class="result-thumb">
          <i class="fas ${icon}"></i>
        </div>
        <div class="result-info">
          <div class="result-title" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</div>
          <div class="result-meta">
            <span class="result-tag"><i class="fas fa-hdd"></i> ${r.size}</span>
            <span class="result-tag quality"><i class="fas fa-signal"></i> ${r.quality}</span>
            <span class="result-tag seeders"><i class="fas fa-users"></i> ${r.seeders} seeders</span>
            ${r.year !== 'N/A' ? `<span class="result-tag"><i class="fas fa-calendar"></i> ${r.year}</span>` : ''}
            <span class="result-tag"><i class="fas fa-globe"></i> ${escapeHtml(r.source)}</span>
          </div>
        </div>
      `;

      card.addEventListener('click', () => selectResult(idx));
      DOM.resultsList.appendChild(card);
    });
  }

  function selectResult(idx) {
    S.selectedIdx = idx;

    // Update visual selection
    $$('.result-card').forEach((c, i) => {
      c.classList.toggle('selected', i === idx);
    });

    // Enable download button
    DOM.downloadBtn.disabled = false;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ══════════════════════════════════════════════════════════════════
  //  DOWNLOAD
  // ══════════════════════════════════════════════════════════════════

  async function startDownload() {
    if (S.selectedIdx === null || !S.results[S.selectedIdx]) {
      toast('Please select a result first.', 'error');
      return;
    }
    if (S.isDownloading) return;

    const result = S.results[S.selectedIdx];
    S.isDownloading = true;

    // Show loading
    DOM.loadingText.textContent = 'Starting download...';
    showSection('loadingSection');

    try {
      const resp = await fetch('/api/entertainment/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          magnet: result.magnet,
          title: result.title,
          category: S.category,
        }),
      });

      const data = await resp.json();

      if (!resp.ok || data.error) {
        throw new Error(data.error || `Download failed (${resp.status})`);
      }

      S.torrentHash = data.hash;

      // Show progress dashboard
      DOM.progressTitle.textContent = result.title;
      DOM.progressStatus.textContent = 'Connecting...';
      DOM.progressFill.style.width = '0%';
      DOM.progressGlow.style.width = '0%';
      DOM.progressPct.textContent = '0%';
      DOM.statSpeed.textContent = '0 B/s';
      DOM.statDownloaded.textContent = '0 B';
      DOM.statTotal.textContent = 'Calculating...';
      DOM.statEta.textContent = 'Calculating...';

      showSection('progressSection');
      toast('Download started!', 'success');

      // Start polling progress
      startProgressPolling();

    } catch (err) {
      showError('Download Failed', err.message);
    } finally {
      S.isDownloading = false;
    }
  }

  function bindDownload() {
    DOM.downloadBtn.addEventListener('click', startDownload);
  }

  // ══════════════════════════════════════════════════════════════════
  //  PROGRESS POLLING
  // ══════════════════════════════════════════════════════════════════

  function startProgressPolling() {
    stopProgressPolling();
    // Poll every 1.5 seconds
    pollProgress(); // immediate first poll
    S.progressTimer = setInterval(pollProgress, 1500);
  }

  function stopProgressPolling() {
    if (S.progressTimer) {
      clearInterval(S.progressTimer);
      S.progressTimer = null;
    }
  }

  async function pollProgress() {
    if (!S.torrentHash) return;

    try {
      const resp = await fetch(`/api/entertainment/progress/${S.torrentHash}`);
      const data = await resp.json();

      if (!resp.ok || data.error) {
        // Don't stop polling on transient errors
        console.warn('Progress poll error:', data.error);
        return;
      }

      // Update UI
      const pct = data.progress || 0;
      DOM.progressFill.style.width = `${pct}%`;
      DOM.progressGlow.style.width = `${pct}%`;
      DOM.progressPct.textContent = `${pct}%`;
      DOM.progressStatus.textContent = data.state || 'Downloading';
      DOM.statSpeed.textContent = data.download_speed || '0 B/s';
      DOM.statDownloaded.textContent = data.downloaded || '0 B';
      DOM.statTotal.textContent = data.total_size || 'Calculating...';
      DOM.statEta.textContent = data.eta || 'Calculating...';

      if (data.name) {
        DOM.progressTitle.textContent = data.name;
      }

      // Check completion
      if (data.is_complete) {
        stopProgressPolling();
        showComplete(data);
      }
    } catch (err) {
      console.warn('Progress poll failed:', err);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  CANCEL DOWNLOAD
  // ══════════════════════════════════════════════════════════════════

  async function cancelDownload() {
    if (!S.torrentHash) return;

    stopProgressPolling();

    try {
      await fetch(`/api/entertainment/cancel/${S.torrentHash}`, {
        method: 'POST',
      });
      toast('Download cancelled.', 'info');
    } catch (err) {
      console.warn('Cancel error:', err);
    }

    S.torrentHash = null;
    resetToSearch();
  }

  function bindCancel() {
    DOM.cancelBtn.addEventListener('click', cancelDownload);
  }

  // ══════════════════════════════════════════════════════════════════
  //  COMPLETE STATE
  // ══════════════════════════════════════════════════════════════════

  function showComplete(data) {
    DOM.completeTitle.textContent = data.name || DOM.progressTitle.textContent || 'Download';
    DOM.completeFilename.textContent = data.name || 'Completed file';
    DOM.completeLocation.textContent = data.save_path || 'Downloads folder';

    showSection('completeSection');
    toast('Download completed!', 'success');
    S.torrentHash = null;
  }

  function bindNewDownload() {
    DOM.newDownloadBtn.addEventListener('click', resetToInitial);
  }

  // ══════════════════════════════════════════════════════════════════
  //  ERROR STATE
  // ══════════════════════════════════════════════════════════════════

  function showError(title, message) {
    DOM.errorTitle.textContent = title || 'Something went wrong';
    DOM.errorMessage.textContent = message || 'An unexpected error occurred.';
    showSection('errorSection');
  }

  function bindErrorRetry() {
    DOM.errorRetryBtn.addEventListener('click', () => {
      if (S.category) {
        // Go back to search
        resetToSearch();
      } else {
        resetToInitial();
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  RESET HELPERS
  // ══════════════════════════════════════════════════════════════════

  function resetToSearch() {
    S.results = [];
    S.selectedIdx = null;
    S.torrentHash = null;
    stopProgressPolling();

    if (S.category) {
      showSection('searchSection');
    } else {
      resetToInitial();
    }
  }

  function resetToInitial() {
    S.category = null;
    S.results = [];
    S.selectedIdx = null;
    S.torrentHash = null;
    S.isSearching = false;
    S.isDownloading = false;
    stopProgressPolling();

    // Deselect categories
    $$('.category-card').forEach(c => c.classList.remove('active'));

    // Hide all sections
    hideAllSections();

    // Show feature grid
    if (DOM.featureGrid) DOM.featureGrid.style.display = '';

    // Clear search
    DOM.searchInput.value = '';
    DOM.resultsList.innerHTML = '';
    DOM.downloadBtn.disabled = true;
  }

  // ══════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════

  document.addEventListener('DOMContentLoaded', () => {
    cacheDom();
    createShootingStars();
    createMobileToggle();
    bindCategoryCards();
    bindSearch();
    bindDownload();
    bindCancel();
    bindNewDownload();
    bindErrorRetry();
  });

})();