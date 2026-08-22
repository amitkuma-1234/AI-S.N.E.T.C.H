// ============================================================
// Entertainment.js · S.N.E.T.C.H Entertainment AI Assistant
// Fully wired to the backend REST API (/api/entertainment/*)
// defined in app.py + Entertainment.py.
// ============================================================

(function () {
  'use strict';

  // ---------- DOM REFS ----------
  const $ = (sel) => document.querySelector(sel);

  const homeBtn = $('#homeBtn');
  const sidebar = $('#entSidebar');
  const sidebarCloseBtn = $('#sidebarCloseBtn');
  const sidebarBackdrop = $('#sidebarBackdrop');
  const mobileMenuBtn = $('#mobileMenuBtn');

  const newChatBtn = $('#newChatBtn');
  const searchInput = $('#searchChatsInput');
  const archiveChatsBtn = $('#archiveChatsBtn');

  const pinnedSection = $('#pinnedSection');
  const pinnedList = $('#pinnedList');
  const recentSection = $('#recentSection');
  const recentList = $('#recentList');
  const chatsEmptyState = $('#chatsEmptyState');

  const chatTitleDisplay = $('#chatTitleDisplay');
  const chatScroll = $('#chatScroll');
  const entWelcome = $('#entWelcome');
  const entSuggestions = $('#entSuggestions');
  const messagesContainer = $('#messagesContainer');

  const chatInput = $('#chatInput');
  const micBtn = $('#micBtn');
  const sendBtn = $('#sendBtn');

  const renameModal = $('#renameModal');
  const renameInput = $('#renameInput');
  const renameCancelBtn = $('#renameCancelBtn');
  const renameSaveBtn = $('#renameSaveBtn');

  const deleteModal = $('#deleteModal');
  const deleteCancelBtn = $('#deleteCancelBtn');
  const deleteConfirmBtn = $('#deleteConfirmBtn');

  const archiveModal = $('#archiveModal');
  const archivedList = $('#archivedList');
  const archiveEmptyState = $('#archiveEmptyState');
  const archiveCloseBtn = $('#archiveCloseBtn');

  const chatDropdown = $('#chatDropdown');

  const API = '/api/entertainment';
  const CARD_MARKER = '\u0000CARDS\u0000';

  // ---------- STATE ----------
  let currentChatId = null;
  let chatsById = {};
  let isStreaming = false;
  let dropdownChatId = null;
  let recognition = null;
  let isListening = false;
  let searchDebounceTimer = null;
  let currentUtterance = null;

  // ============================================================
  //  API HELPERS
  // ============================================================
  async function apiRequest(url, options) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      throw new Error('Network error. Please check your connection.');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  // ============================================================
  //  HOME NAVIGATION
  // ============================================================
  homeBtn.addEventListener('click', () => { window.location.href = '/'; });

  // ============================================================
  //  MOBILE SIDEBAR TOGGLE
  // ============================================================
  function openSidebar() { sidebar.classList.add('open'); sidebarBackdrop.classList.add('active'); }
  function closeSidebar() { sidebar.classList.remove('open'); sidebarBackdrop.classList.remove('active'); }
  mobileMenuBtn.addEventListener('click', openSidebar);
  sidebarCloseBtn.addEventListener('click', closeSidebar);
  sidebarBackdrop.addEventListener('click', closeSidebar);

  // ============================================================
  //  HELPERS
  // ============================================================
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatDateTime(unixSeconds) {
    if (!unixSeconds) return '';
    const d = new Date(unixSeconds * 1000);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return timeStr;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${timeStr}`;
  }

  function autoResizeTextarea() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
  }

  // ============================================================
  //  MINIMAL MARKDOWN RENDERER (headers, bold, lists, tables, paragraphs)
  // ============================================================
  function renderMarkdown(raw) {
    if (!raw) return '';
    let text = escapeHtml(raw);
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

    const lines = text.split('\n');
    const htmlParts = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      const headerMatch = line.match(/^(#{1,3})\s+(.*)$/);
      if (headerMatch) {
        const level = headerMatch[1].length + 3;
        htmlParts.push(`<h${level}>${headerMatch[2]}</h${level}>`);
        i++; continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line) && lines[i + 1] && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        const headerCells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        let j = i + 2; const rows = [];
        while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
          rows.push(lines[j].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())); j++;
        }
        let table = '<table><thead><tr>' + headerCells.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
        rows.forEach(r => { table += '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>'; });
        table += '</tbody></table>';
        htmlParts.push(table); i = j; continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(`<li>${lines[i].replace(/^\s*[-*]\s+/, '')}</li>`); i++; }
        htmlParts.push(`<ul>${items.join('')}</ul>`); continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(`<li>${lines[i].replace(/^\s*\d+\.\s+/, '')}</li>`); i++; }
        htmlParts.push(`<ol>${items.join('')}</ol>`); continue;
      }

      if (line.trim() === '') { i++; continue; }

      const para = [line]; i++;
      while (i < lines.length && lines[i].trim() !== '' &&
        !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^#{1,3}\s+/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      htmlParts.push(`<p>${para.join('<br>')}</p>`);
    }
    return htmlParts.join('');
  }

  // ============================================================
  //  PREMIUM IMAGE CARDS
  // ============================================================
  function renderCards(cards) {
    if (!cards || !cards.length) return '';
    const isHero = cards.length <= 6;
    const items = cards.map((c, idx) => {
      const personClass = c.kind === 'person' ? ' ent-card-person' : '';
      const badge = c.kind && c.kind !== 'multi'
        ? `<span class="ent-card-badge">${escapeHtml(c.kind)}</span>` : '';
      return `
        <div class="ent-card${personClass}" style="--i:${idx}">
          ${badge}
          <div class="ent-card-img-wrap"><img src="${escapeHtml(c.image)}" alt="${escapeHtml(c.title)}" loading="lazy"></div>
          <div class="ent-card-body">
            <div class="ent-card-title">${escapeHtml(c.title)}</div>
            ${c.subtitle ? `<div class="ent-card-subtitle">${escapeHtml(c.subtitle)}</div>` : ''}
            ${c.meta ? `<div class="ent-card-meta">${escapeHtml(c.meta)}</div>` : ''}
          </div>
        </div>`;
    }).join('');
    return `<div class="ent-card-grid${isHero ? ' ent-hero-grid' : ''}">${items}</div>`;
  }

  // ============================================================
  //  CHAT LIST (SIDEBAR)
  // ============================================================
  function buildChatItem(chat) {
    const li = document.createElement('li');
    li.className = 'ent-chat-item' + (chat.id === currentChatId ? ' active' : '');
    li.dataset.chatId = chat.id;

    const main = document.createElement('div');
    main.className = 'ent-chat-item-main';
    const title = document.createElement('div');
    title.className = 'ent-chat-item-title';
    title.textContent = chat.title;
    const date = document.createElement('div');
    date.className = 'ent-chat-item-date';
    date.textContent = formatDateTime(chat.updated_at);
    main.appendChild(title); main.appendChild(date);

    if (chat.pinned) {
      const pin = document.createElement('i');
      pin.className = 'fas fa-thumbtack ent-chat-item-pin-icon';
      li.appendChild(pin);
    }

    const menuBtn = document.createElement('button');
    menuBtn.className = 'ent-chat-item-menu';
    menuBtn.title = 'More';
    menuBtn.innerHTML = '<i class="fas fa-ellipsis-vertical"></i>';
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openDropdown(menuBtn, chat); });

    li.appendChild(main); li.appendChild(menuBtn);
    li.addEventListener('click', () => { selectChat(chat.id); if (window.innerWidth <= 1024) closeSidebar(); });
    return li;
  }

  function renderChatLists(chats) {
    chatsById = {};
    pinnedList.innerHTML = ''; recentList.innerHTML = '';
    const pinned = chats.filter(c => c.pinned);
    const recent = chats.filter(c => !c.pinned);
    chats.forEach(c => { chatsById[c.id] = c; });
    pinned.forEach(c => pinnedList.appendChild(buildChatItem(c)));
    recent.forEach(c => recentList.appendChild(buildChatItem(c)));
    pinnedSection.classList.toggle('hidden', pinned.length === 0);
    recentSection.classList.toggle('hidden', recent.length === 0);
    chatsEmptyState.classList.toggle('visible', chats.length === 0);
  }

  async function loadChats(query) {
    try {
      const url = query ? `${API}/chats?q=${encodeURIComponent(query)}` : `${API}/chats`;
      const data = await apiRequest(url);
      renderChatLists(data.chats || []);
    } catch (e) { console.error('[ENTERTAINMENT] loadChats failed', e); }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const value = searchInput.value.trim();
    searchDebounceTimer = setTimeout(() => loadChats(value || undefined), 280);
  });

  // ============================================================
  //  CHAT PANEL — LOAD / RENDER
  // ============================================================
  function clearChatPanel() {
    messagesContainer.innerHTML = '';
    entWelcome.classList.remove('hidden');
    chatTitleDisplay.textContent = 'Entertainment AI Assistant';
    currentChatId = null;
    highlightActiveChat(null);
  }

  function highlightActiveChat(chatId) {
    document.querySelectorAll('.ent-chat-item').forEach(li => li.classList.toggle('active', li.dataset.chatId === chatId));
  }

  function buildMessageEl(msg, isLast) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ent-msg ' + (msg.role === 'user' ? 'ent-msg-user' : 'ent-msg-ai');

    if (msg.role !== 'user') {
      const avatar = document.createElement('div');
      avatar.className = 'ent-msg-avatar';
      avatar.innerHTML = '<i class="fas fa-clapperboard"></i>';
      wrapper.appendChild(avatar);
    }

    const content = document.createElement('div');
    content.className = 'ent-msg-content';

    const bubble = document.createElement('div');
    bubble.className = 'ent-msg-bubble';
    bubble.innerHTML = msg.role === 'user' ? escapeHtml(msg.content) : renderMarkdown(msg.content);
    content.appendChild(bubble);

    if (msg.cards && msg.cards.length) {
      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'ent-cards-wrap';
      cardsWrap.innerHTML = renderCards(msg.cards);
      content.appendChild(cardsWrap);
    }

    if (msg.role !== 'user') {
      const actions = document.createElement('div');
      actions.className = 'ent-msg-actions';
      actions.innerHTML = `
        <button type="button" data-action="copy" title="Copy"><i class="fas fa-copy"></i></button>
        <button type="button" data-action="like" title="Like"><i class="fas fa-thumbs-up"></i></button>
        <button type="button" data-action="dislike" title="Dislike"><i class="fas fa-thumbs-down"></i></button>
        <button type="button" data-action="speak" title="Read aloud"><i class="fas fa-volume-high"></i></button>
        ${isLast ? '<button type="button" data-action="regenerate" title="Regenerate"><i class="fas fa-rotate-right"></i></button>' : ''}
      `;
      content.appendChild(actions);
      wireMessageActions(actions, bubble);
    }

    const time = document.createElement('div');
    time.className = 'ent-msg-time';
    time.textContent = formatDateTime(msg.created_at);
    content.appendChild(time);

    wrapper.appendChild(content);
    return wrapper;
  }

  function wireMessageActions(actionsEl, bubbleEl) {
    actionsEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'copy') {
          navigator.clipboard?.writeText(bubbleEl.innerText).catch(() => {});
          btn.innerHTML = '<i class="fas fa-check"></i>';
          setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1200);
        } else if (action === 'like') {
          btn.classList.toggle('active');
          actionsEl.querySelector('[data-action="dislike"]').classList.remove('active');
        } else if (action === 'dislike') {
          btn.classList.toggle('active');
          actionsEl.querySelector('[data-action="like"]').classList.remove('active');
        } else if (action === 'speak') {
          toggleSpeak(bubbleEl.innerText, btn);
        } else if (action === 'regenerate') {
          regenerateLastReply();
        }
      });
    });
  }

  // ============================================================
  //  TEXT-TO-SPEECH
  // ============================================================
  function toggleSpeak(text, btn) {
    if (!window.speechSynthesis) return;
    if (currentUtterance && !window.speechSynthesis.paused && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      document.querySelectorAll('.ent-speaking').forEach(b => b.classList.remove('ent-speaking'));
      if (currentUtterance._btn === btn) { currentUtterance = null; return; }
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1; utter.pitch = 1;
    utter._btn = btn;
    utter.onend = () => { btn.classList.remove('ent-speaking'); currentUtterance = null; };
    currentUtterance = utter;
    btn.classList.add('ent-speaking');
    window.speechSynthesis.speak(utter);
  }

  function renderMessages(messages) {
    messagesContainer.innerHTML = '';
    const lastAiIndex = (() => {
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role !== 'user') return i;
      return -1;
    })();
    messages.forEach((m, idx) => messagesContainer.appendChild(buildMessageEl(m, idx === lastAiIndex)));
    entWelcome.classList.toggle('hidden', messages.length > 0);
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { chatScroll.scrollTop = chatScroll.scrollHeight; });
  }

  async function selectChat(chatId) {
    try {
      const data = await apiRequest(`${API}/chats/${chatId}`);
      currentChatId = chatId;
      chatTitleDisplay.textContent = data.chat.title;
      renderMessages(data.chat.messages || []);
      highlightActiveChat(chatId);
    } catch (e) { console.error('[ENTERTAINMENT] selectChat failed', e); }
  }

  // ============================================================
  //  NEW CHAT
  // ============================================================
  async function createNewChat() {
    try {
      const data = await apiRequest(`${API}/chats`, { method: 'POST' });
      await loadChats(searchInput.value.trim() || undefined);
      currentChatId = data.chat.id;
      chatTitleDisplay.textContent = data.chat.title;
      renderMessages([]);
      highlightActiveChat(data.chat.id);
      chatInput.focus();
    } catch (e) { console.error('[ENTERTAINMENT] createNewChat failed', e); }
  }
  newChatBtn.addEventListener('click', createNewChat);

  entSuggestions?.addEventListener('click', (e) => {
    const chip = e.target.closest('.ent-suggestion-chip');
    if (!chip) return;
    chatInput.value = chip.textContent.replace(/^[^\w]+/, '').trim();
    autoResizeTextarea();
    sendMessage();
  });

  // ============================================================
  //  SENDING MESSAGES (STREAMING TEXT + TRAILING IMAGE CARDS)
  // ============================================================
  function setStreaming(streaming) {
    isStreaming = streaming;
    sendBtn.disabled = streaming;
    chatInput.disabled = streaming;
  }

  async function streamIntoBubble(response, bubbleEl, cardsWrapEl) {
    if (!response.body || !response.body.getReader) {
      const text = await response.text();
      const { display, cards } = splitCards(text);
      bubbleEl.innerHTML = renderMarkdown(display);
      if (cardsWrapEl) cardsWrapEl.innerHTML = renderCards(cards);
      return { text: display, cards };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let accumulated = '';
    const cursor = document.createElement('span');
    cursor.className = 'ent-typing-cursor';
    bubbleEl.appendChild(cursor);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
      const { display } = splitCards(accumulated);
      bubbleEl.innerHTML = renderMarkdown(display);
      bubbleEl.appendChild(cursor);
      scrollToBottom();
    }
    cursor.remove();
    const { display, cards } = splitCards(accumulated);
    bubbleEl.innerHTML = renderMarkdown(display);
    if (cardsWrapEl && cards.length) {
      cardsWrapEl.innerHTML = renderCards(cards);
      scrollToBottom();
    }
    return { text: display, cards };
  }

  function splitCards(raw) {
    const markerIdx = raw.indexOf(CARD_MARKER);
    if (markerIdx === -1) return { display: raw, cards: [] };
    const display = raw.slice(0, markerIdx).replace(/\n$/, '');
    let cards = [];
    try { cards = JSON.parse(raw.slice(markerIdx + CARD_MARKER.length)); } catch (e) { cards = []; }
    return { display, cards };
  }

  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || isStreaming) return;

    if (!currentChatId) {
      try {
        const data = await apiRequest(`${API}/chats`, { method: 'POST' });
        currentChatId = data.chat.id;
      } catch (e) { console.error('[ENTERTAINMENT] auto-create chat failed', e); return; }
    }

    chatInput.value = '';
    autoResizeTextarea();
    entWelcome.classList.add('hidden');

    const userMsg = { role: 'user', content: text, created_at: Math.floor(Date.now() / 1000) };
    messagesContainer.appendChild(buildMessageEl(userMsg, false));
    scrollToBottom();

    messagesContainer.querySelectorAll('[data-action="regenerate"]').forEach(b => b.remove());

    const aiMsgShell = { role: 'assistant', content: '', created_at: Math.floor(Date.now() / 1000) };
    const aiEl = buildMessageEl(aiMsgShell, true);
    const bubbleEl = aiEl.querySelector('.ent-msg-bubble');
    const cardsWrapEl = document.createElement('div');
    cardsWrapEl.className = 'ent-cards-wrap';
    bubbleEl.insertAdjacentElement('afterend', cardsWrapEl);

    const typing = document.createElement('div');
    typing.className = 'ent-typing-indicator';
    typing.innerHTML = '<span></span><span></span><span></span>';
    bubbleEl.appendChild(typing);

    messagesContainer.appendChild(aiEl);
    scrollToBottom();

    setStreaming(true);
    try {
      const res = await fetch(`${API}/chats/${currentChatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      typing.remove();
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        bubbleEl.innerHTML = renderMarkdown(errData.error || 'Something went wrong. Please try again.');
      } else {
        await streamIntoBubble(res, bubbleEl, cardsWrapEl);
      }
    } catch (e) {
      typing.remove();
      bubbleEl.innerHTML = renderMarkdown('⚠️ Network error. Please try again.');
    } finally {
      setStreaming(false);
      loadChats(searchInput.value.trim() || undefined);
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  chatInput.addEventListener('input', autoResizeTextarea);

  // ============================================================
  //  REGENERATE
  // ============================================================
  async function regenerateLastReply() {
    if (!currentChatId || isStreaming) return;
    const aiMessages = messagesContainer.querySelectorAll('.ent-msg-ai');
    const lastAiEl = aiMessages[aiMessages.length - 1];
    if (!lastAiEl) return;
    const bubbleEl = lastAiEl.querySelector('.ent-msg-bubble');
    let cardsWrapEl = lastAiEl.querySelector('.ent-cards-wrap');
    if (!cardsWrapEl) {
      cardsWrapEl = document.createElement('div');
      cardsWrapEl.className = 'ent-cards-wrap';
      bubbleEl.insertAdjacentElement('afterend', cardsWrapEl);
    }
    bubbleEl.innerHTML = '';
    cardsWrapEl.innerHTML = '';

    setStreaming(true);
    try {
      const res = await fetch(`${API}/chats/${currentChatId}/regenerate`, { method: 'POST' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        bubbleEl.innerHTML = renderMarkdown(errData.error || 'Something went wrong. Please try again.');
      } else {
        await streamIntoBubble(res, bubbleEl, cardsWrapEl);
      }
    } catch (e) {
      bubbleEl.innerHTML = renderMarkdown('⚠️ Network error. Please try again.');
    } finally {
      setStreaming(false);
      loadChats(searchInput.value.trim() || undefined);
    }
  }

  // ============================================================
  //  THREE-DOT DROPDOWN MENU
  // ============================================================
  function openDropdown(anchorEl, chat) {
    dropdownChatId = chat.id;
    chatDropdown.querySelector('.ent-pin-label').textContent = chat.pinned ? 'Unpin Chat' : 'Pin Chat';
    chatDropdown.querySelector('.ent-archive-label').textContent = chat.archived ? 'Restore Chat' : 'Archive Chat';
    const rect = anchorEl.getBoundingClientRect();
    chatDropdown.style.top = Math.min(rect.bottom + 6, window.innerHeight - 220) + 'px';
    chatDropdown.style.left = Math.min(rect.left, window.innerWidth - 210) + 'px';
    chatDropdown.classList.add('active');
  }
  function closeDropdown() { chatDropdown.classList.remove('active'); dropdownChatId = null; }

  document.addEventListener('click', (e) => { if (!chatDropdown.contains(e.target)) closeDropdown(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDropdown(); closeAllModals(); } });

  chatDropdown.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || !dropdownChatId) return;
    const chatId = dropdownChatId;
    const action = btn.dataset.action;
    closeDropdown();

    if (action === 'download') {
      window.location.href = `${API}/chats/${chatId}/download`;
    } else if (action === 'rename') {
      openRenameModal(chatId);
    } else if (action === 'delete') {
      openDeleteModal(chatId);
    } else if (action === 'archive') {
      const chat = chatsById[chatId] || { archived: false };
      await toggleArchive(chatId, !chat.archived);
    } else if (action === 'pin') {
      const chat = chatsById[chatId] || { pinned: false };
      await togglePin(chatId, !chat.pinned);
    }
  });

  async function togglePin(chatId, pinned) {
    try {
      await apiRequest(`${API}/chats/${chatId}/pin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }),
      });
      loadChats(searchInput.value.trim() || undefined);
    } catch (e) { console.error('[ENTERTAINMENT] togglePin failed', e); }
  }

  async function toggleArchive(chatId, archived) {
    try {
      await apiRequest(`${API}/chats/${chatId}/archive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived }),
      });
      if (archived && chatId === currentChatId) clearChatPanel();
      loadChats(searchInput.value.trim() || undefined);
      if (archiveModal.classList.contains('active')) loadArchivedChats();
    } catch (e) { console.error('[ENTERTAINMENT] toggleArchive failed', e); }
  }

  // ============================================================
  //  RENAME MODAL
  // ============================================================
  let renameTargetId = null;
  function openRenameModal(chatId) {
    renameTargetId = chatId;
    const chat = chatsById[chatId];
    renameInput.value = chat ? chat.title : '';
    renameModal.classList.add('active');
    setTimeout(() => renameInput.focus(), 50);
  }
  function closeRenameModal() { renameModal.classList.remove('active'); renameTargetId = null; }
  renameCancelBtn.addEventListener('click', closeRenameModal);
  renameSaveBtn.addEventListener('click', async () => {
    const title = renameInput.value.trim();
    if (!title || !renameTargetId) return closeRenameModal();
    try {
      await apiRequest(`${API}/chats/${renameTargetId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
      });
      if (renameTargetId === currentChatId) chatTitleDisplay.textContent = title;
      loadChats(searchInput.value.trim() || undefined);
    } catch (e) { console.error('[ENTERTAINMENT] rename failed', e); }
    finally { closeRenameModal(); }
  });
  renameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') renameSaveBtn.click(); });

  // ============================================================
  //  DELETE MODAL
  // ============================================================
  let deleteTargetId = null;
  function openDeleteModal(chatId) { deleteTargetId = chatId; deleteModal.classList.add('active'); }
  function closeDeleteModal() { deleteModal.classList.remove('active'); deleteTargetId = null; }
  deleteCancelBtn.addEventListener('click', closeDeleteModal);
  deleteConfirmBtn.addEventListener('click', async () => {
    if (!deleteTargetId) return closeDeleteModal();
    const id = deleteTargetId;
    try {
      await apiRequest(`${API}/chats/${id}`, { method: 'DELETE' });
      if (id === currentChatId) clearChatPanel();
      loadChats(searchInput.value.trim() || undefined);
      if (archiveModal.classList.contains('active')) loadArchivedChats();
    } catch (e) { console.error('[ENTERTAINMENT] delete failed', e); }
    finally { closeDeleteModal(); }
  });

  // ============================================================
  //  ARCHIVE PANEL
  // ============================================================
  async function loadArchivedChats() {
    try {
      const data = await apiRequest(`${API}/chats?archived=true`);
      const chats = data.chats || [];
      archivedList.innerHTML = '';
      chats.forEach(chat => {
        const li = document.createElement('li');
        li.className = 'ent-chat-item';
        li.innerHTML = `
          <div class="ent-chat-item-main">
            <div class="ent-chat-item-title">${escapeHtml(chat.title)}</div>
            <div class="ent-chat-item-date">${formatDateTime(chat.updated_at)}</div>
          </div>`;
        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'ent-chat-item-menu';
        restoreBtn.title = 'Restore Chat';
        restoreBtn.innerHTML = '<i class="fas fa-rotate-left"></i>';
        restoreBtn.addEventListener('click', () => toggleArchive(chat.id, false));

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'ent-chat-item-menu';
        deleteBtn.title = 'Delete Chat';
        deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
        deleteBtn.addEventListener('click', () => openDeleteModal(chat.id));

        li.appendChild(restoreBtn); li.appendChild(deleteBtn);
        archivedList.appendChild(li);
      });
      archiveEmptyState.classList.toggle('visible', chats.length === 0);
    } catch (e) { console.error('[ENTERTAINMENT] loadArchivedChats failed', e); }
  }
  archiveChatsBtn.addEventListener('click', () => { archiveModal.classList.add('active'); loadArchivedChats(); });
  archiveCloseBtn.addEventListener('click', () => archiveModal.classList.remove('active'));

  function closeAllModals() {
    renameModal.classList.remove('active');
    deleteModal.classList.remove('active');
    archiveModal.classList.remove('active');
  }
  [renameModal, deleteModal, archiveModal].forEach(overlay => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });
  });

  // ============================================================
  //  VOICE INPUT (Web Speech API)
  // ============================================================
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognitionCtor) {
    recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.addEventListener('result', (e) => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join(' ');
      chatInput.value = (chatInput.value ? chatInput.value + ' ' : '') + transcript;
      autoResizeTextarea();
    });
    recognition.addEventListener('end', () => { isListening = false; micBtn.classList.remove('listening'); });
    recognition.addEventListener('error', () => { isListening = false; micBtn.classList.remove('listening'); });

    micBtn.addEventListener('click', () => {
      if (isListening) { recognition.stop(); return; }
      isListening = true;
      micBtn.classList.add('listening');
      try { recognition.start(); } catch (e) { isListening = false; micBtn.classList.remove('listening'); }
    });
  } else {
    micBtn.disabled = true;
    micBtn.title = 'Voice input is not supported in this browser';
    micBtn.style.opacity = '0.35';
    micBtn.style.cursor = 'not-allowed';
  }

  // ============================================================
  //  INIT
  // ============================================================
  loadChats();
})();
