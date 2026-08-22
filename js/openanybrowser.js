// ============================================
// openanybrowser.js
// S.N.E.T.C.H · Open Browser
// Chat logic, backend integration, voice commands
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  // ---------- DOM refs ----------
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const voiceBtn = document.getElementById('voiceBtn');
  const voiceStatus = document.getElementById('voiceStatus');
  const homeBtn = document.getElementById('homeBtn');
  const selectionOverlay = document.getElementById('selectionOverlay');
  const selectionList = document.getElementById('selectionList');
  const selectionClose = document.getElementById('selectionClose');

  // ---------- State ----------
  let isProcessing = false;

  // ---------- Icon helpers ----------
  const BROWSER_ICONS = {
    'google chrome': 'fa-chrome',
    'microsoft edge': 'fa-edge',
    'mozilla firefox': 'fa-firefox',
    'brave': 'fa-brave',
    'opera': 'fa-opera',
    'opera gx': 'fa-opera',
    'safari': 'fa-safari',
    'chromium': 'fa-chromium',
    'tor browser': 'fa-fort-awesome',
    'vivaldi': 'fa-vivaldi',
    'arc browser': 'fa-compass',
    'internet explorer': 'fa-internet-explorer',
  };
  const FALLBACK_ICON = 'fa-globe';

  function iconFor(item) {
    if (item.type === 'browser') {
      return BROWSER_ICONS[item.name.toLowerCase()] || 'fa-window-maximize';
    }
    return FALLBACK_ICON;
  }

  // ---------- Helper: Timestamp ----------
  function getTimestamp() {
    const now = new Date();
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ---------- Helper: Scroll to bottom ----------
  function scrollToBottom() {
    setTimeout(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 50);
  }

  // ---------- Add plain message to chat ----------
  function addMessage(type, html) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${type}`;

    const textDiv = document.createElement('div');
    textDiv.innerHTML = html;
    msgDiv.appendChild(textDiv);

    const timeSpan = document.createElement('div');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = getTimestamp();
    msgDiv.appendChild(timeSpan);

    chatMessages.appendChild(msgDiv);
    scrollToBottom();
    return msgDiv;
  }

  // ---------- Add a result card (browser/website open status) ----------
  function addResultCard({ icon, title, statusText, statusClass }) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ai';

    const card = document.createElement('div');
    card.className = 'browser-card';

    const iconDiv = document.createElement('div');
    iconDiv.className = 'b-icon';
    iconDiv.innerHTML = `<i class="fab ${icon}"></i>`;
    card.appendChild(iconDiv);

    const info = document.createElement('div');
    info.className = 'b-info';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'b-name';
    nameDiv.textContent = title;
    info.appendChild(nameDiv);

    const statusDiv = document.createElement('div');
    statusDiv.className = 'b-status';
    const dot = document.createElement('span');
    dot.className = `dot ${statusClass || ''}`;
    statusDiv.appendChild(dot);
    const statusSpan = document.createElement('span');
    statusSpan.textContent = statusText;
    statusDiv.appendChild(statusSpan);
    info.appendChild(statusDiv);

    card.appendChild(info);
    msgDiv.appendChild(card);

    const timeSpan = document.createElement('div');
    timeSpan.className = 'timestamp';
    timeSpan.textContent = getTimestamp();
    msgDiv.appendChild(timeSpan);

    chatMessages.appendChild(msgDiv);
    scrollToBottom();
    return msgDiv;
  }

  // ---------- Show typing / loading indicator ----------
  function showTyping() {
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message ai typing-message';
    typingDiv.id = 'typingIndicator';
    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.innerHTML = '<span></span><span></span><span></span>';
    typingDiv.appendChild(indicator);
    chatMessages.appendChild(typingDiv);
    scrollToBottom();
  }

  function removeTyping() {
    const typing = document.getElementById('typingIndicator');
    if (typing) typing.remove();
  }

  // ---------- Backend calls ----------
  async function searchTarget(query) {
    const res = await fetch('/api/openanybrowser/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    return res.json();
  }

  async function launchTarget(match) {
    const res = await fetch('/api/openanybrowser/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(match),
    });
    return res.json();
  }

  // ---------- Selection dialog (multiple matches) ----------
  function showSelectionDialog(matches) {
    selectionList.innerHTML = '';
    matches.forEach((item) => {
      const optDiv = document.createElement('div');
      optDiv.className = 'selection-item';

      const iconDiv = document.createElement('div');
      iconDiv.className = 'selection-icon';
      iconDiv.innerHTML = `<i class="fab ${iconFor(item)}"></i>`;
      optDiv.appendChild(iconDiv);

      const infoDiv = document.createElement('div');
      infoDiv.className = 'selection-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'selection-name';
      nameDiv.textContent = item.name;
      infoDiv.appendChild(nameDiv);
      if (item.url) {
        const urlDiv = document.createElement('div');
        urlDiv.className = 'selection-url';
        urlDiv.textContent = item.url;
        infoDiv.appendChild(urlDiv);
      } else {
        const typeDiv = document.createElement('div');
        typeDiv.className = 'selection-url';
        typeDiv.textContent = 'Desktop browser';
        infoDiv.appendChild(typeDiv);
      }
      optDiv.appendChild(infoDiv);

      const chooseIcon = document.createElement('i');
      chooseIcon.className = 'fas fa-chevron-right selection-arrow';
      optDiv.appendChild(chooseIcon);

      optDiv.addEventListener('click', () => {
        hideSelectionDialog();
        performLaunch(item);
      });

      selectionList.appendChild(optDiv);
    });
    selectionOverlay.classList.add('active');
  }

  function hideSelectionDialog() {
    selectionOverlay.classList.remove('active');
  }

  selectionClose.addEventListener('click', () => {
    hideSelectionDialog();
    isProcessing = false;
  });

  // ---------- Perform the actual launch + render result ----------
  async function performLaunch(item) {
    showTyping();
    try {
      const result = await launchTarget({
        type: item.type,
        name: item.name,
        target: item.target,
      });
      removeTyping();

      if (result.success) {
        addResultCard({
          icon: iconFor(item),
          title: item.name,
          statusText: item.type === 'browser' ? 'Browser Opened Successfully' : 'Website Opened Successfully',
          statusClass: '',
        });
        addMessage('ai', `✅ <strong>${item.name}</strong> ${item.type === 'browser' ? 'has been launched' : 'has been opened'}.`);
      } else {
        addResultCard({
          icon: iconFor(item),
          title: item.name,
          statusText: 'Could Not Open',
          statusClass: 'error',
        });
        addMessage('ai', `⚠️ ${result.message || 'Something went wrong while opening that.'}`);
      }
    } catch (err) {
      removeTyping();
      addMessage('ai', '⚠️ Could not reach the server. Please try again.');
    } finally {
      isProcessing = false;
    }
  }

  // ---------- Process user command ----------
  async function handleUserCommand(input) {
    if (isProcessing) return;
    if (!input || input.trim() === '') return;

    addMessage('user', escapeHtml(input));
    chatInput.value = '';
    chatInput.style.height = 'auto';
    isProcessing = true;

    showTyping();

    try {
      const result = await searchTarget(input);
      removeTyping();

      if (result.status === 'single') {
        await performLaunch(result.match);
      } else if (result.status === 'multiple') {
        addMessage('ai', `I found <strong>${result.matches.length}</strong> possible matches. Please choose one:`);
        showSelectionDialog(result.matches);
        // isProcessing is released once a choice is made or dialog closed
      } else {
        addResultCard({
          icon: FALLBACK_ICON,
          title: 'Not Found',
          statusText: 'No Match Found',
          statusClass: 'error',
        });
        addMessage('ai', `⚠️ ${result.message || 'No matching browser or website was found. Please try another name.'}`);
        isProcessing = false;
      }
    } catch (err) {
      removeTyping();
      addMessage('ai', '⚠️ Could not reach the server. Please try again.');
      isProcessing = false;
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Send message ----------
  function sendMessage() {
    const text = chatInput.value.trim();
    if (text === '' || isProcessing) return;
    handleUserCommand(text);
  }

  // ---------- Event listeners ----------
  sendBtn.addEventListener('click', sendMessage);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-expand textarea
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });

  // ---------- Voice input — auto-send, no Enter needed ----------
  voiceBtn.addEventListener('click', () => {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      addMessage('ai', '⚠️ Voice input is not supported in this browser.');
      return;
    }
    if (isProcessing) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    voiceBtn.classList.add('listening');
    voiceStatus.textContent = 'Listening...';
    recognition.start();

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      voiceBtn.classList.remove('listening');
      voiceStatus.textContent = '';
      chatInput.value = transcript;
      // Auto-send immediately — no Enter press required.
      handleUserCommand(transcript);
    };

    recognition.onerror = () => {
      voiceBtn.classList.remove('listening');
      voiceStatus.textContent = '';
    };

    recognition.onend = () => {
      voiceBtn.classList.remove('listening');
      voiceStatus.textContent = '';
    };
  });

  // ---------- Home button ----------
  homeBtn.addEventListener('click', () => {
    window.location.href = '/';
  });

  // ---------- Welcome message (on load) ----------
  function showWelcome() {
    addResultCard({
      icon: FALLBACK_ICON,
      title: 'Open Browser',
      statusText: 'Ready — type or speak a browser/website name',
      statusClass: '',
    });
    addMessage('ai', '👋 Hi! I can open any browser or website for you. Try: <strong>"Chrome"</strong>, <strong>"YouTube"</strong>, or tap the mic and just say it.');
  }

  showWelcome();

  // ---------- Keyboard shortcut for focus ----------
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const active = document.activeElement;
      if (active && active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA') {
        e.preventDefault();
        chatInput.focus();
      }
    }
  });
});
