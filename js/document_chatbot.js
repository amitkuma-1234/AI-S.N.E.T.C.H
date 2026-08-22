// ============================================================
// document_chatbot.js
// S.N.E.T.C.H Document Chatbot — full production logic
// Talks to Flask API mounted at /document_chatbot/api/*
// ============================================================

(function () {
  'use strict';

  const API_BASE = '/document_chatbot/api';

  // ---------- DOM refs ----------
  const sidebar = document.getElementById('sidebar');
  const mobileToggle = document.getElementById('mobileSidebarToggle');
  const homeBtn = document.getElementById('homeBtn');
  const newChatBtn = document.getElementById('newChatBtn');
  const searchInput = document.getElementById('searchChat');
  const pinnedBtn = document.getElementById('pinnedBtn');
  const archiveBtn = document.getElementById('archiveBtn');
  const chatListEl = document.getElementById('chatList');
  const historyLabel = document.getElementById('historyLabel');
  const emptyState = document.getElementById('emptyState');

  const uploadSection = document.getElementById('uploadSection');
  const uploadCard = document.getElementById('uploadCard');
  const chatView = document.getElementById('chatView');
  const browseBtn = document.getElementById('browseBtn');
  const fileInput = document.getElementById('fileInput');
  const progressFill = document.getElementById('progressFill');
  const statusMsg = document.getElementById('statusMessage');
  const uploadProgress = document.getElementById('uploadProgress');
  const uploadError = document.getElementById('uploadError');

  const docCard = document.getElementById('docCard');
  const docName = document.getElementById('docName');
  const docType = document.getElementById('docType');
  const docSize = document.getElementById('docSize');
  const docUploadTime = document.getElementById('docUploadTime');
  const docTypeIcon = document.getElementById('docTypeIcon');
  const uploadStatusPill = document.getElementById('uploadStatusPill');
  const uploadStatusText = document.getElementById('uploadStatusText');
  const processingStatusPill = document.getElementById('processingStatusPill');
  const processingStatusText = document.getElementById('processingStatusText');
  const replaceDocBtn = document.getElementById('replaceDocBtn');

  const chatPanel = document.getElementById('chatPanel');
  const messageContainer = document.getElementById('messageContainer');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const micBtn = document.getElementById('micBtn');
  const stopBtn = document.getElementById('stopBtn');

  const threeDotMenu = document.getElementById('threeDotMenu');
  const renameModal = document.getElementById('renameModal');
  const renameInput = document.getElementById('renameInput');
  const renameCancelBtn = document.getElementById('renameCancelBtn');
  const renameSaveBtn = document.getElementById('renameSaveBtn');
  const toastEl = document.getElementById('toast');

  // ---------- State ----------
  let currentThreadId = null;
  let currentThread = null;
  let isDocReady = false;
  let isStreaming = false;
  let view = 'all';          // 'all' | 'archived'
  let showPinnedOnly = false;
  let searchQuery = '';
  let menuOpenForId = null;
  let searchDebounce = null;
  let abortController = null;

  // ---------- Helpers ----------
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.className = 'toast hidden'; }, 2600);
  }

  function fmtBytes(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `Today, ${time}`;
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return `Yesterday, ${time}`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + `, ${time}`;
  }

  function iconForType(type) {
    const t = (type || '').toLowerCase();
    if (t === 'pdf') return 'fa-file-pdf';
    if (t === 'docx' || t === 'doc') return 'fa-file-word';
    if (t === 'pptx' || t === 'ppt') return 'fa-file-powerpoint';
    if (t === 'md' || t === 'markdown') return 'fa-file-lines';
    return 'fa-file-alt';
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function renderMarkdown(text) {
    try {
      if (window.marked) {
        window.marked.setOptions({ breaks: true, gfm: true });
        return window.marked.parse(text || '');
      }
    } catch (e) { /* fall through */ }
    return `<p>${escapeHtml(text || '').replace(/\n/g, '<br>')}</p>`;
  }

  async function api(path, opts) {
    const res = await fetch(API_BASE + path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || (data && data.success === false)) {
      const msg = (data && data.error) || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  // ============================================================
  // SIDEBAR: chat list (recent / pinned / archived / search)
  // ============================================================

  async function loadThreadList() {
    try {
      const params = new URLSearchParams();
      if (searchQuery) params.set('search', searchQuery);
      params.set('scope', view);
      const data = await api(`/threads?${params.toString()}`);
      let threads = [...data.pinned, ...data.recent];
      if (showPinnedOnly) threads = data.pinned;

      historyLabel.textContent = view === 'archived'
        ? 'Archived Chats'
        : (showPinnedOnly ? 'Pinned Chats' : 'Recent Chats');

      renderChatList(threads);
    } catch (e) {
      toast('Could not load chats: ' + e.message, true);
    }
  }

  function renderChatList(threads) {
    chatListEl.innerHTML = '';
    emptyState.classList.toggle('hidden', threads.length > 0);
    threads.forEach((t) => {
      const li = document.createElement('li');
      li.className = 'chat-item' + (t.thread_id === currentThreadId ? ' active' : '');
      li.dataset.threadId = t.thread_id;
      const icon = t.document ? iconForType(t.document.type) : 'fa-comment-dots';
      li.innerHTML = `
        <div class="chat-info">
          <i class="fas ${icon}"></i>
          <div class="chat-meta">
            <span class="chat-title">${t.is_pinned ? '<i class="fas fa-thumbtack pin-icon"></i>' : ''}${escapeHtml(t.title)}</span>
            <span class="chat-date">${fmtDate(t.updated_at)}</span>
          </div>
        </div>
        <button class="dot-btn" data-threadid="${t.thread_id}"><i class="fas fa-ellipsis-v"></i></button>
      `;
      li.addEventListener('click', (e) => {
        if (e.target.closest('.dot-btn')) return;
        openThread(t.thread_id);
        if (window.innerWidth <= 820) closeSidebar();
      });
      const dotBtn = li.querySelector('.dot-btn');
      dotBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = dotBtn.getBoundingClientRect();
        openMenu(t, rect.left, rect.bottom);
      });
      chatListEl.appendChild(li);
    });
  }

  // ============================================================
  // NEW CHAT / UPLOAD
  // ============================================================

  async function startNewChat() {
    try {
      const data = await api('/new_chat', { method: 'POST' });
      currentThreadId = data.thread_id;
      currentThread = data.thread;
      isDocReady = false;
      showUploadScreen();
      loadThreadList();
    } catch (e) {
      toast('Could not start a new chat: ' + e.message, true);
    }
  }

  function showUploadScreen() {
    uploadSection.classList.remove('hidden');
    chatView.classList.add('hidden');
    chatPanel.classList.add('hidden');
    uploadError.classList.add('hidden');
    uploadProgress.classList.add('hidden');
    progressFill.style.width = '0%';
    messageContainer.innerHTML = '';
  }

  function setProgress(pct, label) {
    uploadProgress.classList.remove('hidden');
    progressFill.style.width = pct + '%';
    statusMsg.textContent = label;
  }

  async function handleFile(file) {
    if (!file || !currentThreadId) {
      if (!currentThreadId) await startNewChat();
      if (!currentThreadId) return;
    }
    const ext = file.name.split('.').pop().toLowerCase();
    const supported = ['pdf', 'docx', 'doc', 'txt', 'text', 'md', 'markdown', 'pptx', 'ppt'];
    if (!supported.includes(ext)) {
      showUploadError('Unsupported format. Please use PDF, DOCX, TXT, Markdown, or PPTX.');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      showUploadError('File exceeds the 50MB limit.');
      return;
    }

    uploadError.classList.add('hidden');
    setProgress(15, 'Uploading document...');

    const formData = new FormData();
    formData.append('thread_id', currentThreadId);
    formData.append('file', file);

    try {
      setProgress(45, 'Processing document...');
      const data = await api('/upload', { method: 'POST', body: formData });
      setProgress(85, 'Indexing for question answering...');
      currentThread = data.thread;
      await new Promise((r) => setTimeout(r, 250));
      setProgress(100, 'Ready to chat');
      await new Promise((r) => setTimeout(r, 300));
      uploadProgress.classList.add('hidden');
      enterChatMode();
      loadThreadList();
    } catch (e) {
      uploadProgress.classList.add('hidden');
      showUploadError(e.message);
    }
  }

  function showUploadError(msg) {
    uploadError.textContent = msg;
    uploadError.classList.remove('hidden');
  }

  // ============================================================
  // OPEN / RENDER AN EXISTING THREAD
  // ============================================================

  async function openThread(threadId) {
    try {
      const data = await api(`/thread/${threadId}`);
      currentThreadId = threadId;
      currentThread = data.thread;

      if (data.thread.processing_status === 'ready') {
        enterChatMode();
        renderMessages(data.messages);
      } else {
        showUploadScreen();
      }
      // refresh sidebar highlight
      document.querySelectorAll('.chat-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.threadId === threadId);
      });
    } catch (e) {
      toast('Could not open chat: ' + e.message, true);
    }
  }

  function enterChatMode() {
    uploadSection.classList.add('hidden');
    chatView.classList.remove('hidden');
    chatPanel.classList.remove('hidden');
    isDocReady = true;
    chatInput.disabled = false;
    sendBtn.disabled = false;
    renderDocCard();
    if (!messageContainer.children.length) {
      messageContainer.innerHTML = `
        <div class="welcome-msg">
          <i class="fas fa-sparkles"></i>
          Document ready. Ask anything — summaries, key points, quizzes, page lookups, and more.
        </div>`;
    }
  }

  function renderDocCard() {
    const doc = currentThread && currentThread.document;
    if (!doc) return;
    docName.textContent = doc.name;
    docType.textContent = (doc.type || '').toUpperCase();
    docSize.textContent = fmtBytes(doc.size);
    docUploadTime.textContent = fmtDate(doc.upload_time);
    docTypeIcon.className = 'fas ' + iconForType(doc.type);

    const uStatus = currentThread.upload_status || 'pending';
    const pStatus = currentThread.processing_status || 'pending';
    uploadStatusText.textContent = cap(uStatus);
    processingStatusText.textContent = cap(pStatus);
    uploadStatusPill.className = 'status-pill ' + (uStatus === 'success' ? 'ok' : uStatus === 'failed' ? 'failed' : 'pending');
    processingStatusPill.className = 'status-pill ' + (pStatus === 'ready' ? 'ok' : pStatus === 'failed' ? 'failed' : 'pending');
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function renderMessages(messages) {
    messageContainer.innerHTML = '';
    if (!messages.length) {
      messageContainer.innerHTML = `
        <div class="welcome-msg">
          <i class="fas fa-sparkles"></i>
          Document ready. Ask anything — summaries, key points, quizzes, page lookups, and more.
        </div>`;
      return;
    }
    messages.forEach((m) => addMessageEl(m.role, m.content, m.id, m.created_at, m.liked, m.disliked));
    scrollToBottom();
  }

  function scrollToBottom() {
    messageContainer.scrollTop = messageContainer.scrollHeight;
  }

  // ============================================================
  // MESSAGE RENDERING
  // ============================================================

  function addMessageEl(role, content, messageId, createdAt, liked, disliked) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    if (messageId) div.dataset.messageId = messageId;

    const body = document.createElement('div');
    body.className = 'msg-body';
    if (role === 'assistant') {
      body.innerHTML = renderMarkdown(content);
    } else {
      body.textContent = content;
    }
    div.appendChild(body);

    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = createdAt ? new Date(createdAt * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'Just now';
    div.appendChild(time);

    if (role === 'assistant') {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      actions.innerHTML = `
        <span data-action="copy" title="Copy"><i class="fas fa-copy"></i></span>
        <span data-action="like" title="Like" class="${liked ? 'active-like' : ''}"><i class="fas fa-thumbs-up"></i></span>
        <span data-action="dislike" title="Dislike" class="${disliked ? 'active-dislike' : ''}"><i class="fas fa-thumbs-down"></i></span>
        <span data-action="regenerate" title="Regenerate"><i class="fas fa-redo"></i></span>
      `;
      div.appendChild(actions);
      actions.querySelectorAll('[data-action]').forEach((el) => {
        el.addEventListener('click', () => handleMessageAction(el, div, content));
      });
    }

    messageContainer.appendChild(div);
    return div;
  }

  function handleMessageAction(el, msgEl, content) {
    const action = el.dataset.action;
    const messageId = msgEl.dataset.messageId;

    if (action === 'copy') {
      navigator.clipboard?.writeText(msgEl.querySelector('.msg-body').innerText).then(() => toast('Copied to clipboard'));
    } else if (action === 'like' || action === 'dislike') {
      const actions = msgEl.querySelector('.msg-actions');
      const likeEl = actions.querySelector('[data-action="like"]');
      const dislikeEl = actions.querySelector('[data-action="dislike"]');
      const isActive = el.classList.contains(action === 'like' ? 'active-like' : 'active-dislike');
      const type = isActive ? 'none' : action;
      likeEl.classList.remove('active-like');
      dislikeEl.classList.remove('active-dislike');
      if (type === 'like') likeEl.classList.add('active-like');
      if (type === 'dislike') dislikeEl.classList.add('active-dislike');
      if (messageId) {
        api(`/message/${messageId}/feedback`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type }),
        }).catch(() => {});
      }
    } else if (action === 'regenerate') {
      regenerateLast(msgEl);
    }
  }

  async function regenerateLast(msgEl) {
    if (isStreaming || !currentThreadId) return;
    const isLast = msgEl === messageContainer.lastElementChild;
    if (!isLast) { toast('Only the last response can be regenerated', true); return; }

    msgEl.remove();
    const placeholder = createStreamingPlaceholder();
    isStreaming = true;
    setInputEnabled(false);

    try {
      await streamFromEndpoint('/regenerate', { thread_id: currentThreadId }, placeholder);
    } catch (e) {
      finishStreamingWithError(placeholder, e.message);
    } finally {
      isStreaming = false;
      setInputEnabled(true);
    }
  }

  // ============================================================
  // SENDING A QUESTION (SSE streaming)
  // ============================================================

  function setInputEnabled(enabled) {
    chatInput.disabled = !enabled || !isDocReady;
    sendBtn.disabled = !enabled || !isDocReady;
  }

  function createStreamingPlaceholder() {
    const welcome = messageContainer.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML = `<div class="msg-body"><span class="typing-dots"><span></span><span></span><span></span></span></div>`;
    messageContainer.appendChild(div);
    scrollToBottom();
    return div;
  }

  async function streamFromEndpoint(path, payload, placeholderEl) {
    abortController = new AbortController();
    stopBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
    try {
      const res = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abortController.signal
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let firstToken = true;
      const bodyEl = placeholderEl.querySelector('.msg-body');

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          let payload;
          try { payload = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }

          if (payload.error) {
            throw new Error(payload.error);
          }
          if (payload.token) {
            if (firstToken) { bodyEl.innerHTML = ''; firstToken = false; }
            fullText += payload.token;
            bodyEl.innerHTML = renderMarkdown(fullText) + '<span class="stream-cursor"></span>';
            scrollToBottom();
          }
          if (payload.done) {
            bodyEl.innerHTML = renderMarkdown(payload.answer || fullText);
            finalizeStreamedMessage(placeholderEl, payload.answer || fullText, payload.message_id);
          }
        }
      }
      loadThreadList();
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error('Response stopped.');
      }
      throw e;
    } finally {
      abortController = null;
      stopBtn.classList.add('hidden');
      sendBtn.classList.remove('hidden');
    }
  }

  function finalizeStreamedMessage(div, content, messageId) {
    if (messageId) div.dataset.messageId = messageId;
    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    div.appendChild(time);

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `
      <span data-action="copy" title="Copy"><i class="fas fa-copy"></i></span>
      <span data-action="like" title="Like"><i class="fas fa-thumbs-up"></i></span>
      <span data-action="dislike" title="Dislike"><i class="fas fa-thumbs-down"></i></span>
      <span data-action="regenerate" title="Regenerate"><i class="fas fa-redo"></i></span>
    `;
    div.appendChild(actions);
    actions.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', () => handleMessageAction(el, div, content));
    });
  }

  function finishStreamingWithError(div, message) {
    const bodyEl = div.querySelector('.msg-body');
    bodyEl.innerHTML = `<p style="color:#ff8a8a">${escapeHtml(message)}</p>`;
  }

  async function sendMessage() {
    if (!isDocReady || isStreaming || !currentThreadId) return;
    const text = chatInput.value.trim();
    if (!text) return;

    addMessageEl('user', text, null, Math.floor(Date.now() / 1000));
    chatInput.value = '';
    scrollToBottom();

    isStreaming = true;
    setInputEnabled(false);
    const placeholder = createStreamingPlaceholder();

    try {
      await streamFromEndpoint('/ask', { thread_id: currentThreadId, question: text }, placeholder);
    } catch (e) {
      finishStreamingWithError(placeholder, e.message || 'Something went wrong. Please try again.');
    } finally {
      isStreaming = false;
      setInputEnabled(true);
      chatInput.focus();
    }
  }

  // ============================================================
  // THREE-DOT MENU: download / rename / delete / archive / pin
  // ============================================================

  function openMenu(thread, x, y) {
    menuOpenForId = thread.thread_id;
    threeDotMenu.style.display = 'block';
    const menuWidth = 190;
    let left = x - menuWidth + 30;
    if (left < 8) left = 8;
    threeDotMenu.style.left = left + 'px';
    threeDotMenu.style.top = (y + 6) + 'px';
    threeDotMenu.dataset.threadId = thread.thread_id;

    const pinItem = threeDotMenu.querySelector('[data-action="pin"]');
    pinItem.innerHTML = thread.is_pinned
      ? '<i class="fas fa-thumbtack"></i> Unpin Chat' : '<i class="fas fa-thumbtack"></i> Pin Chat';

    const archiveItem = threeDotMenu.querySelector('[data-action="archive"]');
    archiveItem.innerHTML = thread.is_archived
      ? '<i class="fas fa-box-open"></i> Restore Chat' : '<i class="fas fa-archive"></i> Archive Chat';
  }

  function closeMenu() {
    threeDotMenu.style.display = 'none';
    menuOpenForId = null;
  }

  threeDotMenu.addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    const action = item.dataset.action;
    const threadId = threeDotMenu.dataset.threadId;
    closeMenu();
    if (!threadId) return;

    try {
      if (action === 'download') {
        window.open(`${API_BASE}/thread/${threadId}/download`, '_blank');
      } else if (action === 'rename') {
        openRenameModal(threadId);
      } else if (action === 'delete') {
        if (await customConfirm('Delete this chat permanently? This cannot be undone.')) {
          await api(`/thread/${threadId}`, { method: 'DELETE' });
          if (threadId === currentThreadId) {
            currentThreadId = null;
            currentThread = null;
            showUploadScreen();
          }
          toast('Chat deleted');
          loadThreadList();
        }
      } else if (action === 'archive') {
        await api(`/thread/${threadId}/archive`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        toast('Chat updated');
        loadThreadList();
      } else if (action === 'pin') {
        await api(`/thread/${threadId}/pin`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        loadThreadList();
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.addEventListener('click', (e) => {
    if (!threeDotMenu.contains(e.target) && !e.target.closest('.dot-btn')) closeMenu();
  });

  // ---------- Rename modal ----------
  function openRenameModal(threadId) {
    renameModal.dataset.threadId = threadId;
    const li = chatListEl.querySelector(`[data-thread-id="${threadId}"] .chat-title`);
    renameInput.value = li ? li.textContent.replace(/^\s*/, '').trim() : '';
    renameModal.classList.remove('hidden');
    renameInput.focus();
    renameInput.select();
  }
  function closeRenameModal() {
    renameModal.classList.add('hidden');
    renameModal.dataset.threadId = '';
  }
  renameCancelBtn.addEventListener('click', closeRenameModal);
  renameModal.addEventListener('click', (e) => { if (e.target === renameModal) closeRenameModal(); });
  renameSaveBtn.addEventListener('click', async () => {
    const threadId = renameModal.dataset.threadId;
    const title = renameInput.value.trim();
    if (!threadId || !title) return;
    try {
      await api(`/thread/${threadId}/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      closeRenameModal();
      loadThreadList();
      toast('Chat renamed');
    } catch (e) {
      toast(e.message, true);
    }
  });
  renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') renameSaveBtn.click();
    if (e.key === 'Escape') closeRenameModal();
  });

  // ============================================================
  // SIDEBAR CONTROLS
  // ============================================================

  homeBtn.addEventListener('click', (e) => {
    // Home link points to /home for full navigation; nothing else to do here.
  });

  newChatBtn.addEventListener('click', (e) => {
    e.preventDefault();
    startNewChat();
  });

  pinnedBtn.addEventListener('click', (e) => {
    e.preventDefault();
    showPinnedOnly = !showPinnedOnly;
    view = 'all';
    pinnedBtn.classList.toggle('active', showPinnedOnly);
    archiveBtn.classList.remove('active');
    loadThreadList();
  });

  archiveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    view = view === 'archived' ? 'all' : 'archived';
    showPinnedOnly = false;
    archiveBtn.classList.toggle('active', view === 'archived');
    pinnedBtn.classList.remove('active');
    loadThreadList();
  });

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = e.target.value.trim();
      loadThreadList();
    }, 250);
  });

  // ---------- Mobile sidebar ----------
  function closeSidebar() { sidebar.classList.remove('open'); }
  mobileToggle.addEventListener('click', () => sidebar.classList.toggle('open'));

  // ============================================================
  // UPLOAD EVENTS
  // ============================================================

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
    fileInput.value = '';
  });

  uploadCard.addEventListener('dragenter', (e) => { e.preventDefault(); uploadCard.classList.add('drag-over'); });
  uploadCard.addEventListener('dragover', (e) => { e.preventDefault(); uploadCard.classList.add('drag-over'); });
  uploadCard.addEventListener('dragleave', () => uploadCard.classList.remove('drag-over'));
  uploadCard.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadCard.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });

  replaceDocBtn.addEventListener('click', () => startNewChat());

  // ============================================================
  // SEND
  // ============================================================

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ============================================================
  // VOICE & STOP
  // ============================================================
  
  stopBtn.addEventListener('click', () => {
    if (abortController) {
      abortController.abort();
    }
  });

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      chatInput.value += (chatInput.value ? ' ' : '') + transcript;
      micBtn.classList.remove('recording');
      chatInput.focus();
    };
    recognition.onerror = () => micBtn.classList.remove('recording');
    recognition.onend = () => micBtn.classList.remove('recording');
  } else {
    micBtn.style.display = 'none';
  }

  micBtn.addEventListener('click', () => {
    if (!recognition || !isDocReady) return;
    if (micBtn.classList.contains('recording')) {
      recognition.stop();
    } else {
      recognition.start();
      micBtn.classList.add('recording');
    }
  });

  // ============================================================
  // INIT
  // ============================================================

  (async function init() {
    await loadThreadList();
    currentThreadId = null;
    currentThread = null;
    showUploadScreen();
  })();

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
