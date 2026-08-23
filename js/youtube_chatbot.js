// ============================================================
// youtube_chatbot.js
// S.N.E.T.C.H YouTube AI Chatbot — full production logic
// Talks to Flask API mounted at /youtube_chatbot/api/*
// ============================================================

(function () {
  'use strict';

  const API_BASE = '/youtube_chatbot/api';

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

  const loadSection = document.getElementById('loadSection');
  const loadCard = document.getElementById('loadCard');
  const chatView = document.getElementById('chatView');
  const videoUrlInput = document.getElementById('videoUrlInput');
  const loadVideoBtn = document.getElementById('loadVideoBtn');
  const progressFill = document.getElementById('progressFill');
  const statusMsg = document.getElementById('statusMessage');
  const loadProgress = document.getElementById('loadProgress');
  const loadError = document.getElementById('loadError');

  const videoCard = document.getElementById('videoCard');
  const videoThumb = document.getElementById('videoThumb');
  const videoTitle = document.getElementById('videoTitle');
  const videoChannel = document.getElementById('videoChannel');
  const videoDuration = document.getElementById('videoDuration');
  const processingStatusPill = document.getElementById('processingStatusPill');
  const processingStatusText = document.getElementById('processingStatusText');
  const transcriptStatusPill = document.getElementById('transcriptStatusPill');
  const transcriptStatusText = document.getElementById('transcriptStatusText');
  const newFromCardBtn = document.getElementById('newFromCardBtn');

  const chatPanel = document.getElementById('chatPanel');
  const messageContainer = document.getElementById('messageContainer');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const micBtn = document.getElementById('micBtn');
  const inputHint = document.getElementById('inputHint');
  const stopResponseBtn = document.getElementById('stopResponseBtn');

  const threeDotMenu = document.getElementById('threeDotMenu');
  const renameModal = document.getElementById('renameModal');
  const renameInput = document.getElementById('renameInput');
  const renameCancelBtn = document.getElementById('renameCancelBtn');
  const renameSaveBtn = document.getElementById('renameSaveBtn');
  const toastEl = document.getElementById('toast');

  // ---------- State ----------
  let currentThreadId = null;
  let currentThread = null;
  let isVideoReady = false;
  let isStreaming = false;
  let isLoadingVideo = false;
  let view = 'all';          // 'all' | 'archived'
  let showPinnedOnly = false;
  let searchQuery = '';
  let menuOpenForId = null;
  let searchDebounce = null;
  let recognition = null;
  let isListening = false;
  let activeAbortController = null;

  // ---------- Helpers ----------
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.className = 'toast hidden'; }, 2600);
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

  function authToken() { return localStorage.getItem('snetch_access_token') || ''; }

  async function api(path, opts) {
    const finalOpts = Object.assign({}, opts);
    finalOpts.headers = Object.assign({}, finalOpts.headers, { Authorization: 'Bearer ' + authToken() });
    const res = await fetch(API_BASE + path, finalOpts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || (data && data.success === false)) {
      const msg = (data && data.error) || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

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
      const icon = t.video ? 'fa-video' : 'fa-comment-dots';
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
  // NEW CHAT / VIDEO LOADING
  // ============================================================

  async function startNewChat() {
    try {
      const data = await api('/new_chat', { method: 'POST' });
      currentThreadId = data.thread_id;
      currentThread = data.thread;
      isVideoReady = false;
      stopListening();
      showLoadScreen();
      loadThreadList();
    } catch (e) {
      toast('Could not start a new chat: ' + e.message, true);
    }
  }

  function showLoadScreen() {
    loadSection.classList.remove('hidden');
    chatView.classList.add('hidden');
    chatPanel.classList.add('hidden');
    loadError.classList.add('hidden');
    loadProgress.classList.add('hidden');
    progressFill.style.width = '0%';
    videoUrlInput.value = '';
    messageContainer.innerHTML = '';
  }

  function setProgress(pct, label) {
    loadProgress.classList.remove('hidden');
    progressFill.style.width = pct + '%';
    statusMsg.textContent = label;
  }

  async function handleLoadVideo() {
    const url = videoUrlInput.value.trim();
    if (!url) {
      showLoadError('Please paste a YouTube video URL.');
      return;
    }
    if (!currentThreadId) await startNewChat();
    if (!currentThreadId) return;

    isLoadingVideo = true;
    loadVideoBtn.disabled = true;
    loadError.classList.add('hidden');
    setProgress(15, 'Validating URL...');

    try {
      setProgress(35, 'Loading video & extracting transcript...');
      const data = await api('/load_video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: currentThreadId, url }),
      });
      setProgress(80, 'Building AI knowledge base...');
      currentThread = data.thread;
      await new Promise((r) => setTimeout(r, 250));
      setProgress(100, 'Video ready — you can start chatting');
      await new Promise((r) => setTimeout(r, 300));
      loadProgress.classList.add('hidden');
      enterChatMode();
      loadThreadList();
    } catch (e) {
      loadProgress.classList.add('hidden');
      showLoadError(e.message);
    } finally {
      isLoadingVideo = false;
      loadVideoBtn.disabled = false;
    }
  }

  function showLoadError(msg) {
    loadError.textContent = msg;
    loadError.classList.remove('hidden');
  }

  // ============================================================
  // OPEN / RENDER AN EXISTING THREAD
  // ============================================================

  async function openThread(threadId) {
    try {
      const data = await api(`/thread/${threadId}`);
      currentThreadId = threadId;
      currentThread = data.thread;
      stopListening();

      if (data.thread.processing_status === 'ready') {
        enterChatMode();
        renderMessages(data.messages);
      } else {
        showLoadScreen();
      }
      document.querySelectorAll('.chat-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.threadId === threadId);
      });
    } catch (e) {
      toast('Could not open chat: ' + e.message, true);
    }
  }

  function enterChatMode() {
    loadSection.classList.add('hidden');
    chatView.classList.remove('hidden');
    chatPanel.classList.remove('hidden');
    isVideoReady = true;
    chatInput.disabled = false;
    sendBtn.disabled = false;
    micBtn.disabled = false;
    renderVideoCard();
    if (!messageContainer.children.length) {
      messageContainer.innerHTML = `
        <div class="welcome-msg">
          <i class="fas fa-sparkles"></i>
          Video ready — answers in English, built from the whole video. Ask anything: summaries, key points, quizzes, timelines, and more.
        </div>`;
    }
  }

  function renderVideoCard() {
    const video = currentThread && currentThread.video;
    if (!video) return;
    videoThumb.src = video.thumbnail || '';
    videoTitle.textContent = video.title || 'Untitled Video';
    videoChannel.innerHTML = `<i class="fas fa-user-circle"></i> ${escapeHtml(video.channel || 'Unknown channel')}`;
    videoDuration.innerHTML = `<i class="fas fa-clock"></i> ${video.duration || '—'}`;

    const pStatus = currentThread.processing_status || 'pending';
    const tStatus = currentThread.transcript_status || 'pending';
    processingStatusText.textContent = cap(pStatus);
    transcriptStatusText.textContent = cap(tStatus);
    processingStatusPill.className = 'status-pill ' + (pStatus === 'ready' ? 'ok' : pStatus === 'failed' ? 'failed' : 'pending');
    transcriptStatusPill.className = 'status-pill ' + (tStatus === 'ready' ? 'ok' : (tStatus === 'failed' || tStatus === 'disabled' || tStatus === 'unavailable') ? 'failed' : 'pending');
  }

  function renderMessages(messages) {
    messageContainer.innerHTML = '';
    if (!messages.length) {
      messageContainer.innerHTML = `
        <div class="welcome-msg">
          <i class="fas fa-sparkles"></i>
          Video ready — answers in English, built from the whole video. Ask anything: summaries, key points, quizzes, timelines, and more.
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
      if (e.name === 'AbortError') {
        finishStreamingWithError(placeholder, 'Response generation stopped by user.');
      } else {
        finishStreamingWithError(placeholder, e.message);
      }
    } finally {
      isStreaming = false;
      setInputEnabled(true);
      activeAbortController = null;
    }
  }

  // ============================================================
  // SENDING A QUESTION (SSE streaming)
  // ============================================================

  function setInputEnabled(enabled) {
    chatInput.disabled = !enabled || !isVideoReady;
    sendBtn.disabled = !enabled || !isVideoReady;
    micBtn.disabled = !enabled || !isVideoReady;
    if (stopResponseBtn) {
      if (!enabled && isStreaming) {
        stopResponseBtn.classList.remove('hidden');
        sendBtn.classList.add('hidden');
      } else {
        stopResponseBtn.classList.add('hidden');
        sendBtn.classList.remove('hidden');
      }
    }
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
    activeAbortController = new AbortController();
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken() },
      body: JSON.stringify(payload),
      signal: activeAbortController.signal
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
          const isNearBottom = messageContainer.scrollHeight - messageContainer.scrollTop - messageContainer.clientHeight < 100;
          fullText += payload.token;
          bodyEl.innerHTML = renderMarkdown(fullText) + '<span class="stream-cursor"></span>';
          if (isNearBottom) {
            scrollToBottom();
          }
        }
        if (payload.done) {
          bodyEl.innerHTML = renderMarkdown(payload.answer || fullText);
          finalizeStreamedMessage(placeholderEl, payload.answer || fullText, payload.message_id);
        }
      }
    }
    loadThreadList();
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

  async function sendMessage(text) {
    if (!isVideoReady || isStreaming || !currentThreadId) return;
    const question = (text !== undefined ? text : chatInput.value).trim();
    if (!question) return;

    addMessageEl('user', question, null, Math.floor(Date.now() / 1000));
    chatInput.value = '';
    scrollToBottom();

    isStreaming = true;
    setInputEnabled(false);
    const placeholder = createStreamingPlaceholder();

    try {
      await streamFromEndpoint('/ask', { thread_id: currentThreadId, question }, placeholder);
    } catch (e) {
      if (e.name === 'AbortError') {
        finishStreamingWithError(placeholder, 'Response generation stopped by user.');
      } else {
        finishStreamingWithError(placeholder, e.message || 'Something went wrong. Please try again.');
      }
    } finally {
      isStreaming = false;
      setInputEnabled(true);
      activeAbortController = null;
      chatInput.focus();
    }
  }

  // ============================================================
  // STOP RESPONSE
  // ============================================================

  if (stopResponseBtn) {
    stopResponseBtn.addEventListener('click', () => {
      if (activeAbortController) {
        activeAbortController.abort();
      }
    });
  }

  // ============================================================
  // VOICE CHAT (Web Speech API) — auto-listen, auto-send, no Enter needed
  // ============================================================

  function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      micBtn.style.display = 'none';
      return;
    }
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      isListening = true;
      micBtn.classList.add('listening');
      inputHint.textContent = 'Listening... speak now';
    };

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      chatInput.value = transcript;
      const last = event.results[event.results.length - 1];
      if (last.isFinal) {
        stopListening();
        if (transcript.trim()) sendMessage(transcript.trim());
      }
    };

    recognition.onerror = () => {
      stopListening();
    };

    recognition.onend = () => {
      stopListening();
    };
  }

  function stopListening() {
    isListening = false;
    micBtn.classList.remove('listening');
    inputHint.textContent = 'Enter to send · Tap the mic to speak';
    if (recognition) {
      try { recognition.stop(); } catch (e) { /* noop */ }
    }
  }

  function startListening() {
    if (!recognition || isListening || !isVideoReady || isStreaming) return;
    chatInput.value = '';
    try { recognition.start(); } catch (e) { /* already started */ }
  }

  micBtn.addEventListener('click', () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });

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
            showLoadScreen();
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

  homeBtn.addEventListener('click', () => { /* navigates via href="/" */ });

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
  // VIDEO LOAD EVENTS
  // ============================================================

  loadVideoBtn.addEventListener('click', handleLoadVideo);
  videoUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleLoadVideo();
    }
  });

  newFromCardBtn.addEventListener('click', () => startNewChat());

  // ============================================================
  // SEND (text: Enter key; voice: auto-send handled in recognition)
  // ============================================================

  sendBtn.addEventListener('click', () => sendMessage());
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  });

  // ============================================================
  // INIT
  // ============================================================

  (async function init() {
    initSpeechRecognition();
    await loadThreadList();
    currentThreadId = null;
    currentThread = null;
    showLoadScreen();
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