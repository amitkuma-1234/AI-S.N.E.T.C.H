// ══════════════════════════════════════════════════════════════════
//  Real World Information AI — Frontend Logic
// ══════════════════════════════════════════════════════════════════

// ===== DOM REFS =====
const homeBtn = document.getElementById('homeBtn');
const modeSelect = document.getElementById('modeSelect');
const typeModeBtn = document.getElementById('typeModeBtn');
const voiceModeBtn = document.getElementById('voiceModeBtn');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatInputBar = document.getElementById('chatInputBar');
const sendBtn = document.getElementById('sendBtn');
const voiceBtn = document.getElementById('voiceBtn');
const listeningIndicator = document.getElementById('listeningIndicator');
const listeningText = document.getElementById('listeningText');
const toastContainer = document.getElementById('toastContainer');

// ===== STATE =====
let isProcessing = false;
let lastQuestion = '';
let recognition = null;
let isListening = false;

// Configure marked.js for safe, clean rendering
if (window.marked) {
  marked.setOptions({ breaks: true, gfm: true });
}

// ══════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════
function init() {
  homeBtn.addEventListener('click', () => { window.location.href = '/'; });

  typeModeBtn.addEventListener('click', () => activateMode('type'));
  voiceModeBtn.addEventListener('click', () => activateMode('voice'));

  sendBtn.addEventListener('click', handleSend);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  chatInput.addEventListener('input', autoResize);

  voiceBtn.addEventListener('click', () => {
    if (isListening) {
      stopVoiceRecognition();
    } else {
      activateMode('voice');
    }
  });

  setupSpeechRecognition();
  scrollToBottom();
}

// ══════════════════════════════════════════════════════════════════
//  MODE SELECTION
// ══════════════════════════════════════════════════════════════════
function activateMode(mode) {
  typeModeBtn.classList.toggle('active', mode === 'type');
  voiceModeBtn.classList.toggle('active', mode === 'voice');

  if (mode === 'type') {
    chatInput.focus();
  } else if (mode === 'voice') {
    startVoiceRecognition();
  }
}

// ══════════════════════════════════════════════════════════════════
//  SPEECH RECOGNITION (Voice Question)
// ══════════════════════════════════════════════════════════════════
function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    return; // handled gracefully when user tries to use voice
  }
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim();
    stopVoiceRecognition();
    if (transcript) {
      chatInput.value = transcript;
      handleSend(); // auto-process, no Enter needed
    } else {
      showToast('No speech detected. Please try again.', 'error');
    }
  };

  recognition.onerror = (event) => {
    stopVoiceRecognition();
    if (event.error === 'no-speech') {
      showToast('No speech detected. Please try again.', 'error');
    } else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      showToast('Microphone access was denied. Please allow microphone permission.', 'error');
    } else {
      showToast('Speech recognition failed. Please try again.', 'error');
    }
  };

  recognition.onend = () => {
    if (isListening) stopVoiceRecognition();
  };
}

function startVoiceRecognition() {
  if (!recognition) {
    showToast('Voice input is not supported in this browser. Try Chrome or Edge.', 'error');
    voiceModeBtn.classList.remove('active');
    return;
  }
  if (isProcessing) return;

  try {
    isListening = true;
    listeningIndicator.style.display = 'flex';
    chatInputBar.classList.add('listening');
    voiceBtn.classList.add('voice-active');
    listeningText.textContent = 'Listening... speak your question';
    recognition.start();
  } catch (err) {
    stopVoiceRecognition();
    showToast('Could not start voice recognition. Please try again.', 'error');
  }
}

function stopVoiceRecognition() {
  isListening = false;
  listeningIndicator.style.display = 'none';
  chatInputBar.classList.remove('listening');
  voiceBtn.classList.remove('voice-active');
  voiceModeBtn.classList.remove('active');
  if (recognition) {
    try { recognition.stop(); } catch (e) { /* no-op */ }
  }
}

// ══════════════════════════════════════════════════════════════════
//  SEND / ASK FLOW
// ══════════════════════════════════════════════════════════════════
function handleSend() {
  const text = chatInput.value.trim();

  if (!text) {
    showToast('Please type or speak a question first.', 'error');
    return;
  }
  if (isProcessing) return;

  lastQuestion = text;
  addUserMessage(text);
  chatInput.value = '';
  autoResize();
  askBackend(text);
}

function askBackend(question) {
  isProcessing = true;
  sendBtn.disabled = true;
  const loadingId = addLoadingMessage();

  fetch('/api/real_world_information/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  })
    .then((res) => {
      if (!res.ok) throw new Error('server_error');
      return res.json();
    })
    .then((data) => {
      removeLoadingMessage(loadingId);
      if (data && data.success) {
        addAIMessage(data.answer_markdown, data.timestamp);
      } else {
        const errMsg = (data && data.error) || 'No response available for this question.';
        addErrorMessage(errMsg);
      }
    })
    .catch(() => {
      removeLoadingMessage(loadingId);
      addErrorMessage('Network error — please check your connection and try again.');
    })
    .finally(() => {
      isProcessing = false;
      sendBtn.disabled = false;
    });
}

function regenerateLast() {
  if (!lastQuestion || isProcessing) return;
  askBackend(lastQuestion);
}

// ══════════════════════════════════════════════════════════════════
//  MESSAGE RENDERING
// ══════════════════════════════════════════════════════════════════
function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function addUserMessage(text) {
  const div = document.createElement('div');
  div.className = 'message user-message';
  div.innerHTML = `
    <div class="msg-icon"><i class="fas fa-user"></i></div>
    <div class="msg-bubble">
      <div class="msg-content"><p>${escapeHtml(text)}</p></div>
      <span class="msg-time">${nowLabel()}</span>
    </div>
  `;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function addLoadingMessage() {
  const id = 'loading-' + Date.now();
  const div = document.createElement('div');
  div.className = 'message ai-message';
  div.id = id;
  div.innerHTML = `
    <div class="msg-icon"><i class="fas fa-robot"></i></div>
    <div class="msg-bubble">
      <div class="typing-dots"><span></span><span></span><span></span></div>
    </div>
  `;
  chatMessages.appendChild(div);
  scrollToBottom();
  return id;
}

function removeLoadingMessage(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function addAIMessage(markdown, timestamp) {
  const div = document.createElement('div');
  div.className = 'message ai-message';
  const html = window.marked ? marked.parse(markdown) : `<p>${escapeHtml(markdown)}</p>`;
  const timeLabel = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : nowLabel();

  div.innerHTML = `
    <div class="msg-icon"><i class="fas fa-robot"></i></div>
    <div class="msg-bubble">
      <div class="msg-content">${html}</div>
      <div class="msg-actions">
        <button class="msg-action-btn" data-action="copy" title="Copy response"><i class="fas fa-copy"></i> Copy</button>
        <button class="msg-action-btn" data-action="regenerate" title="Regenerate response"><i class="fas fa-redo"></i> Regenerate</button>
        <button class="msg-action-btn" data-action="like" title="Like"><i class="fas fa-thumbs-up"></i></button>
        <button class="msg-action-btn" data-action="dislike" title="Dislike"><i class="fas fa-thumbs-down"></i></button>
      </div>
      <span class="msg-time">${timeLabel}</span>
    </div>
  `;

  const rawMarkdown = markdown;
  div.querySelector('[data-action="copy"]').addEventListener('click', (e) => {
    copyToClipboard(rawMarkdown, e.currentTarget);
  });
  div.querySelector('[data-action="regenerate"]').addEventListener('click', () => {
    regenerateLast();
  });
  div.querySelector('[data-action="like"]').addEventListener('click', (e) => {
    toggleReaction(e.currentTarget, 'active-like');
  });
  div.querySelector('[data-action="dislike"]').addEventListener('click', (e) => {
    toggleReaction(e.currentTarget, 'active-dislike');
  });

  chatMessages.appendChild(div);
  scrollToBottom();
}

function addErrorMessage(message) {
  const div = document.createElement('div');
  div.className = 'message ai-message';
  div.innerHTML = `
    <div class="msg-icon"><i class="fas fa-robot"></i></div>
    <div class="msg-bubble">
      <div class="msg-content"><p><i class="fas fa-triangle-exclamation" style="color:#f87171;margin-right:6px;"></i>${escapeHtml(message)}</p></div>
      <span class="msg-time">${nowLabel()}</span>
    </div>
  `;
  chatMessages.appendChild(div);
  showToast(message, 'error');
  scrollToBottom();
}

function toggleReaction(btn, activeClass) {
  const otherClass = activeClass === 'active-like' ? 'active-dislike' : 'active-like';
  btn.parentElement.querySelectorAll('.msg-action-btn').forEach((b) => b.classList.remove(otherClass));
  btn.classList.toggle(activeClass);
}

function copyToClipboard(text, btn) {
  const plain = text.replace(/[#*`_>|-]/g, '').replace(/\n{2,}/g, '\n');
  const finish = () => {
    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-check"></i> Copied';
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(plain).then(finish).catch(() => showToast('Could not copy to clipboard.', 'error'));
  } else {
    try {
      const ta = document.createElement('textarea');
      ta.value = plain;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      finish();
    } catch (e) {
      showToast('Could not copy to clipboard.', 'error');
    }
  }
}

// ══════════════════════════════════════════════════════════════════
//  TOASTS
// ══════════════════════════════════════════════════════════════════
function showToast(message, type) {
  const toast = document.createElement('div');
  toast.className = 'toast' + (type === 'info' ? ' toast-info' : '');
  toast.innerHTML = `<i class="fas ${type === 'info' ? 'fa-circle-info' : 'fa-triangle-exclamation'}"></i><span>${escapeHtml(message)}</span>`;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(30px)';
    toast.style.transition = '0.25s ease';
    setTimeout(() => toast.remove(), 260);
  }, 3800);
}

// ══════════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════════
function autoResize() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

// ===== START =====
document.addEventListener('DOMContentLoaded', init);