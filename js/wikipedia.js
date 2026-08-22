


// ============================================================
// wikipedia.js · S.N.E.T.C.H Wikipedia AI Assistant
// Talks to /api/wikipedia/search (defined in app.py + wikipidea.py)
// ============================================================

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // ---------- DOM REFS ----------
  const chatMessages = $('#chatMessages');
  const chatPanel = $('#chatPanel');
  const chatInput = $('#chatInput');
  const sendBtn = $('#sendBtn');
  const voiceBtn = $('#voiceBtn');
  const voiceStatus = $('#voiceStatus');
  const voiceStatusText = $('#voiceStatusText');
  const newChatBtn = $('#newChatBtn');

  const userMsgTemplate = $('#userMsgTemplate');
  const aiMsgTemplate = $('#aiMsgTemplate');
  const typingTemplate = $('#typingTemplate');

  // ---------- STATE ----------
  let isBusy = false;
  let lastQuery = null;
  let recognition = null;
  let isListening = false;

  const EXAMPLE_PROMPTS = [
    'What is Artificial Intelligence?',
    'Tell me about India',
    'Explain Quantum Computing',
    'Who is Nikola Tesla?',
    'History of World War II',
  ];

  // ============================================================
  //  UTILITIES
  // ============================================================
  function nowTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatPanel.scrollTop = chatPanel.scrollHeight;
    });
  }

  function showToast(message) {
    let toast = $('#wikiToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'wikiToast';
      toast.className = 'toast';
      toast.innerHTML = '<i class="fas fa-triangle-exclamation"></i><span></span>';
      document.body.appendChild(toast);
    }
    toast.querySelector('span').textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 3500);
  }

  function autoResizeInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
  }

  // ============================================================
  //  WELCOME SCREEN
  // ============================================================
  function renderWelcome() {
    chatMessages.innerHTML = '';
    const welcome = document.createElement('div');
    welcome.className = 'chat-welcome';
    welcome.innerHTML = `
      <div class="welcome-icon"><i class="fas fa-atom"></i></div>
      <h2>Wikipedia AI Assistant</h2>
      <p>Ask me anything — science, history, technology, people, places — and I'll bring you a clear, well-structured answer straight from Wikipedia.</p>
      <div class="welcome-examples"></div>
    `;
    const examplesWrap = welcome.querySelector('.welcome-examples');
    EXAMPLE_PROMPTS.forEach((ex) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = ex;
      btn.addEventListener('click', () => {
        chatInput.value = ex;
        handleSend();
      });
      examplesWrap.appendChild(btn);
    });
    chatMessages.appendChild(welcome);
  }

  // ============================================================
  //  MESSAGE RENDERING
  // ============================================================
  function addUserMessage(text) {
    const node = userMsgTemplate.content.cloneNode(true);
    node.querySelector('.msg-text').textContent = text;
    node.querySelector('.timestamp').textContent = nowTime();
    chatMessages.appendChild(node);
    scrollToBottom();
  }

  function addTypingIndicator() {
    const node = typingTemplate.content.cloneNode(true);
    chatMessages.appendChild(node);
    scrollToBottom();
    return chatMessages.querySelector('.typing-msg:last-of-type');
  }

  function removeTypingIndicator(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function buildAnswerHtml(data) {
    let html = '';

    html += `<div class="ans-title"><i class="fas fa-circle-info"></i>${escapeHtml(data.title || '')}</div>`;

    if (data.thumbnail) {
      html += `<img class="ans-thumb" src="${escapeHtml(data.thumbnail)}" alt="${escapeHtml(data.title || '')}" loading="lazy">`;
    }

    if (data.summary) {
      html += `<p>${escapeHtml(data.summary)}</p>`;
    }

    if (data.detailed) {
      html += `<div class="ans-section">
        <div class="ans-section-title"><i class="fas fa-align-left"></i> Detailed Explanation</div>
        ${data.detailed.split('\n\n').map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
      </div>`;
    }

    if (Array.isArray(data.key_facts) && data.key_facts.length) {
      html += `<div class="ans-section">
        <div class="ans-section-title"><i class="fas fa-list-check"></i> Key Facts</div>
        <ul>${data.key_facts.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
      </div>`;
    }

    if (Array.isArray(data.related_topics) && data.related_topics.length) {
      html += `<div class="ans-section">
        <div class="ans-section-title"><i class="fas fa-diagram-project"></i> Related Topics</div>
        <div>${data.related_topics.map((t) =>
          `<span class="related-chip" data-topic="${escapeHtml(t)}"><i class="fas fa-arrow-right"></i>${escapeHtml(t)}</span>`
        ).join('')}</div>
      </div>`;
    }

    if (Array.isArray(data.references) && data.references.length) {
      html += `<div class="ans-section">
        <div class="ans-section-title"><i class="fas fa-book"></i> References</div>
        <div class="ans-ref">${data.references.map((r) =>
          `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.label)}</a>`
        ).join('<br>')}</div>
      </div>`;
    }

    return html;
  }

  function buildErrorHtml(data) {
    let message;
    let icon = 'fa-triangle-exclamation';
    switch (data.status) {
      case 'not_found':
        message = `I couldn't find a Wikipedia article for "${escapeHtml(data.query || '')}". Try rephrasing your question.`;
        icon = 'fa-circle-question';
        break;
      case 'empty':
        message = data.message || 'Please type or say a question first.';
        icon = 'fa-comment-slash';
        break;
      case 'error':
        message = data.message || 'Something went wrong while reaching Wikipedia. Please try again.';
        icon = 'fa-wifi';
        break;
      default:
        message = 'Something went wrong. Please try again.';
    }
    return `<div class="ans-error"><i class="fas ${icon}"></i>${message}</div>`;
  }

  function buildAmbiguousHtml(data) {
    const options = data.options || [];
    return `<div class="ans-section">
      <div class="ans-section-title"><i class="fas fa-shuffle"></i> Did you mean…</div>
      <p>Your question could refer to several different topics. Pick one to continue:</p>
      <div class="ambiguous-list">${options.map((o) =>
        `<span class="related-chip" data-topic="${escapeHtml(o)}"><i class="fas fa-arrow-right"></i>${escapeHtml(o)}</span>`
      ).join('')}</div>
    </div>`;
  }

  function attachRelatedChipHandlers(bubbleEl) {
    bubbleEl.querySelectorAll('.related-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        chatInput.value = chip.dataset.topic;
        handleSend();
      });
    });
  }

  function addAiMessage(data, sourceQuery) {
    const node = aiMsgTemplate.content.cloneNode(true);
    const wrapper = document.createElement('div');
    wrapper.appendChild(node);
    const messageEl = wrapper.firstElementChild;
    const contentEl = messageEl.querySelector('.msg-content');
    const timestampEl = messageEl.querySelector('.timestamp');

    if (data.status === 'ok') {
      contentEl.innerHTML = buildAnswerHtml(data);
    } else if (data.status === 'ambiguous') {
      contentEl.innerHTML = buildAmbiguousHtml(data);
    } else {
      contentEl.innerHTML = buildErrorHtml(data);
    }

    timestampEl.textContent = nowTime();
    attachRelatedChipHandlers(contentEl);

    // ---- message actions ----
    const copyBtn = messageEl.querySelector('.copy-btn');
    const likeBtn = messageEl.querySelector('.like-btn');
    const dislikeBtn = messageEl.querySelector('.dislike-btn');
    const regenBtn = messageEl.querySelector('.regen-btn');

    copyBtn.addEventListener('click', () => {
      const text = contentEl.innerText;
      navigator.clipboard?.writeText(text).then(() => {
        const icon = copyBtn.querySelector('i');
        icon.className = 'fas fa-check';
        setTimeout(() => { icon.className = 'fas fa-copy'; }, 1500);
      }).catch(() => showToast('Could not copy to clipboard.'));
    });

    likeBtn.addEventListener('click', () => {
      likeBtn.classList.toggle('active-like');
      dislikeBtn.classList.remove('active-dislike');
    });
    dislikeBtn.addEventListener('click', () => {
      dislikeBtn.classList.toggle('active-dislike');
      likeBtn.classList.remove('active-like');
    });

    regenBtn.addEventListener('click', () => {
      if (isBusy) return;
      regenerateAnswer(sourceQuery, messageEl);
    });

    chatMessages.appendChild(messageEl);
    scrollToBottom();
    return messageEl;
  }

  // ============================================================
  //  BACKEND CALL
  // ============================================================
  async function fetchWikipediaAnswer(query) {
    let res;
    try {
      res = await fetch('/api/wikipedia/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
    } catch (e) {
      return { status: 'error', message: 'Network error. Please check your connection.' };
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      return { status: 'error', message: 'Unexpected response from the server.' };
    }
    return data;
  }

  async function regenerateAnswer(query, messageEl) {
    if (!query) return;
    isBusy = true;
    const contentEl = messageEl.querySelector('.msg-content');
    contentEl.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    const data = await fetchWikipediaAnswer(query);
    if (data.status === 'ok') {
      contentEl.innerHTML = buildAnswerHtml(data);
    } else if (data.status === 'ambiguous') {
      contentEl.innerHTML = buildAmbiguousHtml(data);
    } else {
      contentEl.innerHTML = buildErrorHtml(data);
    }
    attachRelatedChipHandlers(contentEl);
    messageEl.querySelector('.timestamp').textContent = nowTime();
    isBusy = false;
    scrollToBottom();
  }

  // ============================================================
  //  SEND FLOW
  // ============================================================
  async function handleSend() {
    const query = chatInput.value.trim();
    if (isBusy) return;

    if (!query) {
      showToast('Please type or say a question first.');
      return;
    }

    // clear welcome screen on first message
    const welcome = chatMessages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    addUserMessage(query);
    chatInput.value = '';
    autoResizeInput();
    lastQuery = query;

    isBusy = true;
    sendBtn.disabled = true;
    const typingEl = addTypingIndicator();

    const data = await fetchWikipediaAnswer(query);

    removeTypingIndicator(typingEl);
    addAiMessage(data, query);

    isBusy = false;
    sendBtn.disabled = false;
  }

  // ============================================================
  //  NEW WIKIPEDIA CHAT
  // ============================================================
  function startNewChat() {
    if (isListening) stopListening();
    isBusy = false;
    lastQuery = null;
    chatInput.value = '';
    autoResizeInput();
    renderWelcome();
  }

  // ============================================================
  //  VOICE INPUT
  // ============================================================
  function setupVoiceRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      voiceBtn.addEventListener('click', () => {
        showToast('Voice input is not supported in this browser.');
      });
      return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isListening = true;
      voiceBtn.classList.add('listening');
      voiceStatusText.textContent = 'Listening… speak your question';
      voiceStatus.classList.add('show');
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      chatInput.value = transcript;
      autoResizeInput();
      handleSend();
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') {
        showToast('No speech detected. Please try again.');
      } else if (event.error === 'not-allowed' || event.error === 'permission-denied') {
        showToast('Microphone access was denied.');
      } else {
        showToast('Voice recognition error. Please try again.');
      }
    };

    recognition.onend = () => {
      isListening = false;
      voiceBtn.classList.remove('listening');
      voiceStatus.classList.remove('show');
    };

    voiceBtn.addEventListener('click', () => {
      if (isBusy) return;
      if (isListening) {
        stopListening();
      } else {
        try {
          recognition.start();
        } catch (e) {
          // recognition already started; ignore
        }
      }
    });
  }

  function stopListening() {
    if (recognition && isListening) {
      recognition.stop();
    }
  }

  // ============================================================
  //  EVENT WIRING
  // ============================================================
  function init() {
    renderWelcome();
    setupVoiceRecognition();

    newChatBtn.addEventListener('click', startNewChat);

    sendBtn.addEventListener('click', handleSend);

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    chatInput.addEventListener('input', autoResizeInput);
  }

  document.addEventListener('DOMContentLoaded', init);
})();



