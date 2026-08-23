// =========================================================
// S.N.E.T.C.H · AI Recipe Assistant · foodrecipe.js
// Fully wired to the backend REST API (/api/foodrecipe/*)
// defined in app.py + foodracipie.py.
// =========================================================

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // ---------- DOM refs ----------
  const chatPanel = $('#chatPanel');
  const chatInput = $('#chatInput');
  const sendBtn = $('#sendBtn');
  const stopBtn = $('#stopBtn');
  const newChatBtn = $('#newChatBtn');
  const searchToggleBtn = $('#searchToggleBtn');
  const searchBarContainer = $('#searchBarContainer');
  const searchInput = $('#searchChatInput');
  const clearSearchBtn = $('#clearSearchBtn');
  const archiveToggleBtn = $('#archiveToggleBtn');
  const pinnedToggleBtn = $('#pinnedToggleBtn');
  const archiveModal = $('#archiveModal');
  const pinnedModal = $('#pinnedModal');
  const archiveList = $('#archiveList');
  const pinnedList = $('#pinnedList');
  const closeArchiveBtn = $('#closeArchiveBtn');
  const closePinnedBtn = $('#closePinnedBtn');
  const recentChatsList = $('#recentChatsList');
  const dropdownMenu = $('#dropdownMenu');
  const renameModal = $('#renameModal');
  const renameInput = $('#renameInput');
  const renameCancelBtn = $('#renameCancelBtn');
  const renameSaveBtn = $('#renameSaveBtn');
  const deleteModal = $('#deleteModal');
  const deleteCancelBtn = $('#deleteCancelBtn');
  const deleteConfirmBtn = $('#deleteConfirmBtn');
  const headerTitle = $('#headerChatTitle');

  // ---------- State ----------
  let chatsById = {};
  let currentChatId = null;
  let isStreaming = false;
  let currentAbortController = null;
  let dropdownTargetChatId = null;
  let renameTargetId = null;
  let deleteTargetId = null;
  let searchDebounceTimer = null;

  // =========================================================
  //  API HELPERS
  // =========================================================
  function authToken() { return localStorage.getItem('snetch_access_token') || ''; }

  async function apiRequest(url, options) {
    let res;
    const opts = options || {};
    opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + authToken() });
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new Error('Network error. Please check your connection.');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  function formatDateTime(unixSeconds) {
    if (!unixSeconds) return '';
    const d = new Date(unixSeconds * 1000);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return timeStr;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + timeStr;
  }

  function adjustTextareaHeight() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { chatPanel.scrollTop = chatPanel.scrollHeight; });
  }

  // =========================================================
  //  MINIMAL MARKDOWN -> PREMIUM RECIPE-CARD RENDERER
  // =========================================================
  function renderMarkdown(raw) {
    if (!raw) return '';
    let text = escapeHtml(raw);

    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        const level = h[1].length === 1 ? 3 : (h[1].length === 2 ? 4 : 5);
        out.push(`<h${level}>${h[2]}</h${level}>`);
        i++; continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line) && lines[i + 1] && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        const headerCells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        let j = i + 2;
        const rows = [];
        while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
          rows.push(lines[j].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
          j++;
        }
        let table = '<table><thead><tr>' + headerCells.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
        rows.forEach(r => { table += '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>'; });
        table += '</tbody></table>';
        out.push(table);
        i = j; continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(`<li>${lines[i].replace(/^\s*[-*]\s+/, '')}</li>`);
          i++;
        }
        out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${lines[i].replace(/^\s*\d+\.\s+/, '')}</li>`);
          i++;
        }
        out.push(`<ol>${items.join('')}</ol>`);
        continue;
      }

      if (line.trim() === '') { i++; continue; }

      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !/^\s*[-*]\s+/.test(lines[i]) &&
             !/^\s*\d+\.\s+/.test(lines[i]) && !/^#{1,3}\s+/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push(`<p>${para.join('<br>')}</p>`);
    }
    return out.join('');
  }

  function isRecipeContent(text) {
    return /^#\s+/.test((text || '').trim());
  }

  // =========================================================
  //  SIDEBAR — CHAT LIST
  // =========================================================
  function buildChatItem(chat) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (chat.id === currentChatId ? ' active' : '');
    div.dataset.chatId = chat.id;
    div.innerHTML = `
      <div class="chat-thumb">${chat.pinned ? '📌' : '🍽️'}</div>
      <div class="chat-info">
        <div class="chat-name">${escapeHtml(chat.title)}</div>
        <div class="chat-meta">
          <span>${formatDateTime(chat.updated_at)}</span>
        </div>
      </div>
      <div class="chat-actions">
        <button class="dot-menu" data-chat-id="${chat.id}" title="More"><i class="fas fa-ellipsis-v"></i></button>
      </div>
    `;
    div.querySelector('.dot-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      showDropdown(e, chat.id);
    });
    div.addEventListener('click', (e) => {
      if (e.target.closest('.dot-menu')) return;
      selectChat(chat.id);
    });
    return div;
  }

  function renderRecentChats(chats) {
    chatsById = {};
    chats.forEach(c => { chatsById[c.id] = c; });

    if (chats.length === 0) {
      recentChatsList.innerHTML = `<div style="color:#606080;font-size:13px;padding:20px 0;text-align:center;">No chats yet. Start a New Chat to begin.</div>`;
      return;
    }
    recentChatsList.innerHTML = '';
    chats.forEach(chat => recentChatsList.appendChild(buildChatItem(chat)));
  }

  async function loadChats(query) {
    try {
      const url = query ? `/api/foodrecipe/chats?q=${encodeURIComponent(query)}` : '/api/foodrecipe/chats';
      const data = await apiRequest(url);
      renderRecentChats(data.chats || []);
    } catch (e) {
      console.error('[FOODRECIPE] loadChats failed', e);
    }
  }

  // =========================================================
  //  CHAT PANEL
  // =========================================================
  function welcomeBubble(text) {
    return `
      <div class="chat-message ai-message">
        <div class="message-avatar"><i class="fas fa-robot"></i></div>
        <div class="message-bubble">
          <p>${text}</p>
          <span class="timestamp">Just now</span>
        </div>
      </div>
    `;
  }

  function clearChatPanel() {
    chatPanel.innerHTML = welcomeBubble('👋 Ask me for any recipe — from Paneer Butter Masala to Chocolate Cake!');
    currentChatId = null;
    headerTitle && (headerTitle.textContent = 'Food Recipe AI');
    highlightActive(null);
  }

  function highlightActive(chatId) {
    document.querySelectorAll('.chat-item').forEach(el => {
      el.classList.toggle('active', el.dataset.chatId === chatId);
    });
  }

  function buildMessageEl(msg, isLast) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-message ' + (msg.role === 'user' ? 'user-message' : 'ai-message');

    const bodyHtml = msg.role === 'user'
      ? `<p>${escapeHtml(msg.content)}</p>`
      : (isRecipeContent(msg.content)
          ? `<div class="recipe-card">${renderMarkdown(msg.content)}</div>`
          : renderMarkdown(msg.content));

    wrap.innerHTML = `
      <div class="message-avatar"><i class="fas ${msg.role === 'user' ? 'fa-user' : 'fa-robot'}"></i></div>
      <div class="message-bubble">
        ${bodyHtml}
        <span class="timestamp">${formatDateTime(msg.created_at)}</span>
        ${msg.role !== 'user' ? `
        <div class="msg-actions">
          <button type="button" data-action="copy" title="Copy"><i class="fas fa-copy"></i></button>
          <button type="button" data-action="like" title="Like"><i class="fas fa-thumbs-up"></i></button>
          <button type="button" data-action="dislike" title="Dislike"><i class="fas fa-thumbs-down"></i></button>
          ${isLast ? '<button type="button" data-action="regenerate" title="Regenerate"><i class="fas fa-rotate-right"></i></button>' : ''}
        </div>` : ''}
      </div>
    `;

    if (msg.role !== 'user') {
      const actions = wrap.querySelector('.msg-actions');
      const bubble = wrap.querySelector('.message-bubble');
      actions.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          if (action === 'copy') {
            navigator.clipboard?.writeText(msg.content || '').catch(() => {});
            btn.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1200);
          } else if (action === 'like') {
            btn.classList.toggle('active');
            actions.querySelector('[data-action="dislike"]').classList.remove('active');
          } else if (action === 'dislike') {
            btn.classList.toggle('active');
            actions.querySelector('[data-action="like"]').classList.remove('active');
          } else if (action === 'regenerate') {
            regenerateLastReply();
          }
        });
      });
    }

    return wrap;
  }

  function renderMessages(messages) {
    if (!messages.length) {
      clearChatPanel();
      return;
    }
    chatPanel.innerHTML = '';
    let lastAiIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') { lastAiIdx = i; break; }
    }
    messages.forEach((m, idx) => chatPanel.appendChild(buildMessageEl(m, idx === lastAiIdx)));
    scrollToBottom();
  }

  async function selectChat(chatId) {
    try {
      const data = await apiRequest(`/api/foodrecipe/chats/${chatId}`);
      currentChatId = chatId;
      headerTitle && (headerTitle.textContent = data.chat.title);
      renderMessages(data.chat.messages || []);
      highlightActive(chatId);
      if (window.innerWidth <= 900) document.getElementById('sidebar')?.classList.remove('open');
    } catch (e) {
      console.error('[FOODRECIPE] selectChat failed', e);
    }
  }

  // =========================================================
  //  NEW CHAT — always spins up a fresh backend chat, which is
  //  also a brand new LangGraph Thread with zero memory.
  // =========================================================
  async function createNewChat() {
    try {
      const data = await apiRequest('/api/foodrecipe/chats', { method: 'POST' });
      await loadChats(searchInput.value.trim() || undefined);
      currentChatId = data.chat.id;
      headerTitle && (headerTitle.textContent = data.chat.title);
      chatPanel.innerHTML = welcomeBubble('👋 New chat started! Just type a dish name to get its full recipe.');
      highlightActive(data.chat.id);
      chatInput.value = '';
      chatInput.focus();
      adjustTextareaHeight();
    } catch (e) {
      console.error('[FOODRECIPE] createNewChat failed', e);
    }
  }
  newChatBtn.addEventListener('click', (e) => { e.preventDefault(); createNewChat(); });

  // =========================================================
  //  SEND MESSAGE (STREAMING)
  // =========================================================
  function setStreaming(streaming) {
    isStreaming = streaming;
    if (streaming) {
      sendBtn.style.display = 'none';
      stopBtn.style.display = 'flex';
    } else {
      sendBtn.style.display = 'flex';
      stopBtn.style.display = 'none';
      sendBtn.disabled = chatInput.value.trim() === '';
    }
    chatInput.disabled = streaming;
  }

  async function streamIntoBubble(response, bubbleWrap) {
    const bubble = bubbleWrap.querySelector('.message-bubble');
    const loadingUI = bubble.querySelector('.loading-ui');
    if (loadingUI) loadingUI.remove();

    const textHolder = document.createElement('div');
    textHolder.className = 'streaming-text';
    bubble.prepend(textHolder);

    if (!response.body || !response.body.getReader) {
      const text = await response.text();
      finalizeAiBubble(bubbleWrap, text);
      return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let accumulated = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
      textHolder.innerHTML = renderMarkdown(accumulated) + '<span class="typing-cursor"></span>';
      scrollToBottom();
    }
    finalizeAiBubble(bubbleWrap, accumulated);
    return accumulated;
  }

  function finalizeAiBubble(bubbleWrap, text) {
    const bubble = bubbleWrap.querySelector('.message-bubble');
    const timestamp = bubble.querySelector('.timestamp');
    const streamingText = bubble.querySelector('.streaming-text');
    if (streamingText) streamingText.remove();
    const bodyHtml = isRecipeContent(text)
      ? `<div class="recipe-card">${renderMarkdown(text)}</div>`
      : renderMarkdown(text);
    const bodyWrap = document.createElement('div');
    bodyWrap.innerHTML = bodyHtml;
    bubble.insertBefore(bodyWrap, timestamp);
  }

  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || isStreaming) return;

    if (!currentChatId) {
      try {
        const data = await apiRequest('/api/foodrecipe/chats', { method: 'POST' });
        currentChatId = data.chat.id;
      } catch (e) {
        console.error('[FOODRECIPE] auto-create chat failed', e);
        return;
      }
    }

    chatInput.value = '';
    adjustTextareaHeight();

    if (chatPanel.querySelector('.ai-message') && chatPanel.children.length === 1 &&
        chatPanel.textContent.includes('Ask me for any recipe')) {
      chatPanel.innerHTML = '';
    }

    const userMsg = { role: 'user', content: text, created_at: Math.floor(Date.now() / 1000) };
    chatPanel.appendChild(buildMessageEl(userMsg, false));
    scrollToBottom();

    chatPanel.querySelectorAll('[data-action="regenerate"]').forEach(b => b.remove());

    const aiShell = { role: 'assistant', content: '', created_at: Math.floor(Date.now() / 1000) };
    const aiEl = buildMessageEl(aiShell, true);
    
    const bubble = aiEl.querySelector('.message-bubble');
    const loadingUI = document.createElement('div');
    loadingUI.className = 'loading-ui';
    loadingUI.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    bubble.prepend(loadingUI);

    chatPanel.appendChild(aiEl);
    scrollToBottom();

    setStreaming(true);
    currentAbortController = new AbortController();
    try {
      const res = await fetch(`/api/foodrecipe/chats/${currentChatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken() },
        body: JSON.stringify({ message: text }),
        signal: currentAbortController.signal
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        finalizeAiBubble(aiEl, errData.error || 'Something went wrong. Please try again.');
      } else {
        await streamIntoBubble(res, aiEl);
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        finalizeAiBubble(aiEl, '⚠️ Response generation stopped.');
      } else {
        finalizeAiBubble(aiEl, '⚠️ Network error. Please try again.');
      }
    } finally {
      setStreaming(false);
      currentAbortController = null;
      loadChats(searchInput.value.trim() || undefined);
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  stopBtn.addEventListener('click', () => {
    if (currentAbortController) {
      currentAbortController.abort();
    }
  });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  chatInput.addEventListener('input', () => {
    adjustTextareaHeight();
    sendBtn.disabled = chatInput.value.trim() === '' || isStreaming;
  });
  sendBtn.disabled = true;

  // =========================================================
  //  REGENERATE
  // =========================================================
  async function regenerateLastReply() {
    if (!currentChatId || isStreaming) return;
    const aiMessages = chatPanel.querySelectorAll('.ai-message');
    const lastAiEl = aiMessages[aiMessages.length - 1];
    if (!lastAiEl) return;
    const bodyEls = lastAiEl.querySelectorAll('.message-bubble > div, .message-bubble > p, .message-bubble > h3, .message-bubble > h4, .message-bubble > ul, .message-bubble > ol');
    bodyEls.forEach(el => { if (!el.classList.contains('msg-actions')) el.remove(); });
    
    const bubble = lastAiEl.querySelector('.message-bubble');
    const loadingUI = document.createElement('div');
    loadingUI.className = 'loading-ui';
    loadingUI.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    bubble.prepend(loadingUI);

    setStreaming(true);
    currentAbortController = new AbortController();
    try {
      const res = await fetch(`/api/foodrecipe/chats/${currentChatId}/regenerate`, { 
        method: 'POST',
        headers: { Authorization: 'Bearer ' + authToken() },
        signal: currentAbortController.signal
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        finalizeAiBubble(lastAiEl, errData.error || 'Something went wrong. Please try again.');
      } else {
        await streamIntoBubble(res, lastAiEl);
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        finalizeAiBubble(lastAiEl, '⚠️ Response generation stopped.');
      } else {
        finalizeAiBubble(lastAiEl, '⚠️ Network error. Please try again.');
      }
    } finally {
      setStreaming(false);
      currentAbortController = null;
      loadChats(searchInput.value.trim() || undefined);
    }
  }

  // =========================================================
  //  THREE-DOT DROPDOWN
  // =========================================================
  function showDropdown(e, chatId) {
    const chat = chatsById[chatId];
    if (!chat) return;
    dropdownTargetChatId = chatId;
    const rect = e.target.closest('.dot-menu').getBoundingClientRect();
    dropdownMenu.style.top = Math.min(rect.bottom + 6, window.innerHeight - 240) + 'px';
    dropdownMenu.style.left = Math.min(rect.left - 150, window.innerWidth - 210) + 'px';
    dropdownMenu.querySelector('[data-action="pin"]').innerHTML =
      chat.pinned ? '<i class="fas fa-thumbtack"></i> Unpin Chat' : '<i class="fas fa-thumbtack"></i> Pin Chat';
    dropdownMenu.querySelector('[data-action="archive"]').innerHTML =
      chat.archived ? '<i class="fas fa-box-open"></i> Restore Chat' : '<i class="fas fa-archive"></i> Archive Chat';
    dropdownMenu.classList.add('show');
  }
  function hideDropdown() {
    dropdownMenu.classList.remove('show');
    dropdownTargetChatId = null;
  }
  document.addEventListener('click', (e) => {
    if (!dropdownMenu.contains(e.target) && !e.target.closest('.dot-menu')) hideDropdown();
  });

  dropdownMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.dropdown-item');
    if (!item || !dropdownTargetChatId) return;
    const chatId = dropdownTargetChatId;
    const action = item.dataset.action;
    hideDropdown();

    if (action === 'download') {
      window.location.href = `/api/foodrecipe/chats/${chatId}/download`;
    } else if (action === 'rename') {
      openRenameModal(chatId);
    } else if (action === 'delete') {
      openDeleteModal(chatId);
    } else if (action === 'pin') {
      const chat = chatsById[chatId] || { pinned: false };
      await togglePin(chatId, !chat.pinned);
    } else if (action === 'archive') {
      const chat = chatsById[chatId] || { archived: false };
      await toggleArchive(chatId, !chat.archived);
    }
  });

  async function togglePin(chatId, pinned) {
    try {
      await apiRequest(`/api/foodrecipe/chats/${chatId}/pin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      });
      loadChats(searchInput.value.trim() || undefined);
    } catch (e) { console.error('[FOODRECIPE] togglePin failed', e); }
  }

  async function toggleArchive(chatId, archived) {
    try {
      await apiRequest(`/api/foodrecipe/chats/${chatId}/archive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      });
      if (archived && chatId === currentChatId) clearChatPanel();
      loadChats(searchInput.value.trim() || undefined);
      if (archiveModal.style.display !== 'none') renderArchiveModal();
    } catch (e) { console.error('[FOODRECIPE] toggleArchive failed', e); }
  }

  // =========================================================
  //  RENAME MODAL
  // =========================================================
  function openRenameModal(chatId) {
    renameTargetId = chatId;
    renameInput.value = chatsById[chatId] ? chatsById[chatId].title : '';
    renameModal.style.display = 'flex';
    setTimeout(() => renameInput.focus(), 50);
  }
  function closeRenameModal() { renameModal.style.display = 'none'; renameTargetId = null; }
  renameCancelBtn.addEventListener('click', closeRenameModal);
  renameModal.addEventListener('click', (e) => { if (e.target === renameModal) closeRenameModal(); });
  renameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') renameSaveBtn.click(); });
  renameSaveBtn.addEventListener('click', async () => {
    const title = renameInput.value.trim();
    if (!title || !renameTargetId) return closeRenameModal();
    try {
      await apiRequest(`/api/foodrecipe/chats/${renameTargetId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (renameTargetId === currentChatId) headerTitle && (headerTitle.textContent = title);
      loadChats(searchInput.value.trim() || undefined);
    } catch (e) { console.error('[FOODRECIPE] rename failed', e); }
    finally { closeRenameModal(); }
  });

  // =========================================================
  //  DELETE MODAL
  // =========================================================
  function openDeleteModal(chatId) { deleteTargetId = chatId; deleteModal.style.display = 'flex'; }
  function closeDeleteModal() { deleteModal.style.display = 'none'; deleteTargetId = null; }
  deleteCancelBtn.addEventListener('click', closeDeleteModal);
  deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) closeDeleteModal(); });
  deleteConfirmBtn.addEventListener('click', async () => {
    if (!deleteTargetId) return closeDeleteModal();
    const id = deleteTargetId;
    try {
      await apiRequest(`/api/foodrecipe/chats/${id}`, { method: 'DELETE' });
      if (id === currentChatId) clearChatPanel();
      loadChats(searchInput.value.trim() || undefined);
      if (archiveModal.style.display !== 'none') renderArchiveModal();
    } catch (e) { console.error('[FOODRECIPE] delete failed', e); }
    finally { closeDeleteModal(); }
  });

  // =========================================================
  //  SEARCH
  // =========================================================
  searchToggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const isVisible = searchBarContainer.style.display !== 'none';
    searchBarContainer.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) searchInput.focus();
  });
  clearSearchBtn.addEventListener('click', () => { searchInput.value = ''; loadChats(); });
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const value = searchInput.value.trim();
    searchDebounceTimer = setTimeout(() => loadChats(value || undefined), 280);
  });

  // =========================================================
  //  ARCHIVE PANEL
  // =========================================================
  async function renderArchiveModal() {
    try {
      const data = await apiRequest('/api/foodrecipe/chats?archived=true');
      const chats = data.chats || [];
      if (chats.length === 0) {
        archiveList.innerHTML = '<div style="color:#606080;padding:20px 0;">No archived chats.</div>';
        return;
      }
      archiveList.innerHTML = '';
      chats.forEach(chat => {
        const row = document.createElement('div');
        row.className = 'archive-item';
        row.innerHTML = `
          <span>${escapeHtml(chat.title)}</span>
          <div>
            <button class="restore-btn" data-id="${chat.id}">Restore</button>
            <button class="delete-archive-btn" data-id="${chat.id}" style="color:#f87171;">Delete</button>
          </div>
        `;
        row.querySelector('.restore-btn').addEventListener('click', () => toggleArchive(chat.id, false));
        row.querySelector('.delete-archive-btn').addEventListener('click', () => openDeleteModal(chat.id));
        archiveList.appendChild(row);
      });
    } catch (e) { console.error('[FOODRECIPE] renderArchiveModal failed', e); }
  }
  archiveToggleBtn.addEventListener('click', (e) => { e.preventDefault(); renderArchiveModal(); archiveModal.style.display = 'flex'; });
  closeArchiveBtn.addEventListener('click', () => { archiveModal.style.display = 'none'; });
  archiveModal.addEventListener('click', (e) => { if (e.target === archiveModal) archiveModal.style.display = 'none'; });

  // =========================================================
  //  PINNED PANEL
  // =========================================================
  async function renderPinnedModal() {
    try {
      const data = await apiRequest('/api/foodrecipe/chats');
      const pinned = (data.chats || []).filter(c => c.pinned);
      if (pinned.length === 0) {
        pinnedList.innerHTML = '<div style="color:#606080;padding:20px 0;">No pinned chats.</div>';
        return;
      }
      pinnedList.innerHTML = '';
      pinned.forEach(chat => {
        const row = document.createElement('div');
        row.className = 'archive-item';
        row.innerHTML = `<span>${escapeHtml(chat.title)}</span><button class="unpin-modal-btn" data-id="${chat.id}">Unpin</button>`;
        row.querySelector('.unpin-modal-btn').addEventListener('click', async () => {
          await togglePin(chat.id, false);
          renderPinnedModal();
        });
        pinnedList.appendChild(row);
      });
    } catch (e) { console.error('[FOODRECIPE] renderPinnedModal failed', e); }
  }
  pinnedToggleBtn.addEventListener('click', (e) => { e.preventDefault(); renderPinnedModal(); pinnedModal.style.display = 'flex'; });
  closePinnedBtn.addEventListener('click', () => { pinnedModal.style.display = 'none'; });
  pinnedModal.addEventListener('click', (e) => { if (e.target === pinnedModal) pinnedModal.style.display = 'none'; });

  // =========================================================
  //  HOME NAV
  // =========================================================
  document.querySelector('[data-nav="home"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = '/';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideDropdown();
      closeRenameModal();
      closeDeleteModal();
      archiveModal.style.display = 'none';
      pinnedModal.style.display = 'none';
    }
  });

  // =========================================================
  //  SPACE BACKGROUND — twinkling stars (canvas)
  // =========================================================
  function initStars() {
    const canvas = document.getElementById('starsCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w, h;
    const stars = [];
    const STAR_COUNT = 180;

    function resize() { w = canvas.width = window.innerWidth; h = canvas.height = window.innerHeight; }
    window.addEventListener('resize', resize);
    resize();

    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({ x: Math.random() * w, y: Math.random() * h, radius: Math.random() * 1.8 + 0.5, alpha: Math.random() * 0.8 + 0.2 });
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      stars.forEach(s => {
        s.alpha += (Math.random() - 0.5) * 0.02;
        s.alpha = Math.min(1, Math.max(0.1, s.alpha));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${s.alpha})`;
        ctx.fill();
        s.x += (Math.random() - 0.5) * 0.2;
        s.y += (Math.random() - 0.5) * 0.2;
        if (s.x < 0) s.x = w; if (s.x > w) s.x = 0;
        if (s.y < 0) s.y = h; if (s.y > h) s.y = 0;
      });
      requestAnimationFrame(draw);
    }
    draw();
  }

  // =========================================================
  //  MOBILE SIDEBAR TOGGLE
  // =========================================================
  const mobileMenuBtn = $('#mobileMenuBtn');
  const sidebar = $('#sidebar');
  mobileMenuBtn?.addEventListener('click', () => sidebar.classList.toggle('open'));

  // =========================================================
  //  QUICK DISH SUGGESTIONS
  // =========================================================
  document.querySelectorAll('.quick-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chatInput.value = chip.textContent.trim();
      adjustTextareaHeight();
      sendBtn.disabled = false;
      sendMessage();
    });
  });

  // =========================================================
  //  INIT
  // =========================================================
  initStars();
  chatInput.focus();
  loadChats();
});
