// ============================================================
// openanyapp.js - Launch Apps AI Assistant
// S.N.E.T.C.H AI Operating System
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // --- DOM refs ---
  const chatMessages   = document.getElementById('chat-messages');
  const chatInput      = document.getElementById('chatInput');
  const sendBtn        = document.getElementById('sendBtn');
  const homeBtn        = document.getElementById('homeBtn');
  const voiceBtn       = document.getElementById('voiceBtn');
  const voiceStatus    = document.getElementById('voiceStatus');
  const selectOverlay  = document.getElementById('appSelectOverlay');
  const selectList     = document.getElementById('appSelectList');
  const selectClose    = document.getElementById('appSelectClose');

  // --- state ---
  let isProcessing = false;
  let currentSpeech = null;
  let recognizer = null;
  let isListening = false;

  // --- star background (canvas) ---
  (function initStars() {
    const canvas = document.getElementById('starCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w, h;
    const stars = [];

    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width || window.innerWidth;
      canvas.height = rect.height || window.innerHeight;
      w = canvas.width;
      h = canvas.height;
    }
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < 180; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.5 + 0.3,
        a: Math.random() * 0.8 + 0.2,
        speed: Math.random() * 0.008 + 0.003,
        phase: Math.random() * Math.PI * 2
      });
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      const time = Date.now() * 0.001;
      for (const s of stars) {
        const flicker = 0.6 + 0.4 * Math.sin(time * s.speed * 3 + s.phase);
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${s.a * flicker})`;
        ctx.fill();
        if (s.r > 0.9) {
          ctx.shadowColor = 'rgba(200, 180, 255, 0.15)';
          ctx.shadowBlur = 12;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
      requestAnimationFrame(draw);
    }
    draw();
  })();

  // --- helpers ---
  function scrollToBottom() {
    setTimeout(() => { chatMessages.scrollTop = chatMessages.scrollHeight; }, 30);
  }

  function getTime() {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function iconForApp(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('chrome')) return 'fa-chrome';
    if (n.includes('edge')) return 'fa-edge';
    if (n.includes('firefox')) return 'fa-firefox-browser';
    if (n.includes('visual studio code') || n.includes('vs code') || n === 'code') return 'fa-code';
    if (n.includes('notepad')) return 'fa-file-lines';
    if (n.includes('calculator') || n.includes('calc')) return 'fa-calculator';
    if (n.includes('paint')) return 'fa-paintbrush';
    if (n.includes('spotify')) return 'fa-spotify';
    if (n.includes('telegram')) return 'fa-telegram';
    if (n.includes('whatsapp')) return 'fa-whatsapp';
    if (n.includes('discord')) return 'fa-discord';
    if (n.includes('word')) return 'fa-file-word';
    if (n.includes('excel')) return 'fa-file-excel';
    if (n.includes('powerpoint') || n.includes('ppt')) return 'fa-file-powerpoint';
    if (n.includes('file explorer') || n.includes('explorer')) return 'fa-folder-open';
    if (n.includes('command prompt') || n === 'cmd') return 'fa-terminal';
    if (n.includes('powershell')) return 'fa-terminal';
    if (n.includes('settings')) return 'fa-gear';
    if (n.includes('camera')) return 'fa-camera';
    if (n.includes('task manager')) return 'fa-gauge-high';
    if (n.includes('registry')) return 'fa-database';
    if (n.includes('control panel')) return 'fa-sliders';
    if (n.includes('system information')) return 'fa-circle-info';
    if (n.includes('snipping')) return 'fa-scissors';
    if (n.includes('github')) return 'fa-github';
    if (n.includes('docker')) return 'fa-docker';
    if (n.includes('android studio')) return 'fa-android';
    if (n.includes('blender')) return 'fa-cube';
    if (n.includes('steam')) return 'fa-steam';
    if (n.includes('zoom')) return 'fa-video';
    if (n.includes('obs')) return 'fa-clapperboard';
    return 'fa-rocket';
  }

  // --- message rendering ---
  function createTextMessage(text, type) {
    const div = document.createElement('div');
    div.className = `message ${type}-message`;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = type === 'user' ? '<i class="fas fa-user"></i>' : '<i class="fas fa-robot"></i>';
    div.appendChild(avatar);

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const content = document.createElement('div');
    content.className = 'msg-content';
    content.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    bubble.appendChild(content);

    bubble.appendChild(buildFooter(content, type, () => text));
    div.appendChild(bubble);
    return div;
  }

  function buildFooter(content, type, getRegenQuery) {
    const footer = document.createElement('div');
    footer.className = 'msg-footer';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = getTime();
    footer.appendChild(timeSpan);

    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    if (type === 'ai') {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'action-btn copy-btn';
      copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
      copyBtn.title = 'Copy';
      copyBtn.addEventListener('click', () => {
        const txt = content.innerText || content.textContent;
        navigator.clipboard?.writeText(txt).catch(() => {});
        copyBtn.style.color = '#6fcf97';
        setTimeout(() => copyBtn.style.color = '', 800);
      });
      actions.appendChild(copyBtn);

      const likeBtn = document.createElement('button');
      likeBtn.className = 'action-btn like-btn';
      likeBtn.innerHTML = '<i class="fas fa-thumbs-up"></i>';
      likeBtn.title = 'Like';
      likeBtn.addEventListener('click', () => {
        likeBtn.style.color = '#6fcf97';
        setTimeout(() => likeBtn.style.color = '', 600);
      });
      actions.appendChild(likeBtn);

      const dislikeBtn = document.createElement('button');
      dislikeBtn.className = 'action-btn dislike-btn';
      dislikeBtn.innerHTML = '<i class="fas fa-thumbs-down"></i>';
      dislikeBtn.title = 'Dislike';
      dislikeBtn.addEventListener('click', () => {
        dislikeBtn.style.color = '#f28b82';
        setTimeout(() => dislikeBtn.style.color = '', 600);
      });
      actions.appendChild(dislikeBtn);

      const ttsBtn = document.createElement('button');
      ttsBtn.className = 'action-btn tts-btn';
      ttsBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
      ttsBtn.title = 'Text to Speech';
      ttsBtn.addEventListener('click', () => {
        if (currentSpeech) {
          window.speechSynthesis?.cancel();
          currentSpeech = null;
          ttsBtn.style.color = '';
          return;
        }
        const txt = content.textContent || content.innerText;
        if (txt && 'speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance(txt);
          utterance.lang = 'en-US';
          utterance.onend = () => { currentSpeech = null; ttsBtn.style.color = ''; };
          window.speechSynthesis.speak(utterance);
          currentSpeech = utterance;
          ttsBtn.style.color = '#7ecfff';
        }
      });
      actions.appendChild(ttsBtn);
    }

    footer.appendChild(actions);
    return footer;
  }

  function addMessage(text, type = 'ai') {
    const msg = createTextMessage(text, type);
    chatMessages.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  // --- app card (shows launch progress for a single matched app) ---
  function addAppCard(appName) {
    const div = document.createElement('div');
    div.className = 'message ai-message';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = '<i class="fas fa-robot"></i>';
    div.appendChild(avatar);

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const content = document.createElement('div');
    content.className = 'msg-content';

    const card = document.createElement('div');
    card.className = 'app-card';

    const iconDiv = document.createElement('div');
    iconDiv.className = 'app-icon';
    iconDiv.innerHTML = `<i class="fas ${iconForApp(appName)}"></i>`;
    card.appendChild(iconDiv);

    const info = document.createElement('div');
    info.className = 'app-info';

    const nameSpan = document.createElement('div');
    nameSpan.className = 'app-name';
    nameSpan.textContent = appName;
    info.appendChild(nameSpan);

    const statusDiv = document.createElement('div');
    statusDiv.className = 'app-status';
    statusDiv.innerHTML = '<span class="mini-spinner"></span><span>Opening...</span>';
    info.appendChild(statusDiv);
    card.appendChild(info);

    content.appendChild(card);
    bubble.appendChild(content);
    bubble.appendChild(buildFooter(content, 'ai'));
    div.appendChild(bubble);

    chatMessages.appendChild(div);
    scrollToBottom();

    return {
      markSuccess() {
        statusDiv.innerHTML = '<span class="status-dot" style="background:#6fcf97;"></span><span>Opened Successfully</span>';
      },
      markFailure(msg) {
        statusDiv.innerHTML = `<span class="status-dot fail"></span><span>${msg || 'Could not open'}</span>`;
      }
    };
  }

  function showTyping() {
    const div = document.createElement('div');
    div.className = 'message ai-message typing-indicator';
    div.id = 'typing-indicator';
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = '<i class="fas fa-robot"></i>';
    div.appendChild(avatar);
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.style.padding = '12px 20px';
    bubble.innerHTML = '<span style="display:flex;gap:6px;"><span style="animation:blink 1.2s infinite;">●</span><span style="animation:blink 1.2s infinite 0.2s;">●</span><span style="animation:blink 1.2s infinite 0.4s;">●</span></span>';
    div.appendChild(bubble);
    chatMessages.appendChild(div);
    scrollToBottom();
    return div;
  }

  function removeTyping() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  // --- backend calls ---
  async function searchApps(query) {
    const res = await fetch('/api/openanyapp/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    return res.json();
  }

  async function launchApp(path, name) {
    const res = await fetch('/api/openanyapp/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, name })
    });
    return res.json();
  }

  async function launchAndReport(match) {
    const card = addAppCard(match.name);
    try {
      const result = await launchApp(match.path, match.name);
      if (result.success) {
        card.markSuccess();
        addMessage(`✅ **${match.name}** is now opening on your device.`);
      } else {
        card.markFailure('Could not open');
        addMessage(`⚠️ I found **${match.name}** but couldn't launch it: ${result.message || 'unknown error'}.`);
      }
    } catch (err) {
      card.markFailure('Could not open');
      addMessage(`⚠️ Something went wrong while launching **${match.name}**.`);
    }
  }

  // --- selection modal ---
  function openSelectModal(matches, onPick) {
    selectList.innerHTML = '';
    matches.forEach((m) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'app-option';

      const iconDiv = document.createElement('div');
      iconDiv.className = 'app-option-icon';
      iconDiv.innerHTML = `<i class="fas ${iconForApp(m.name)}"></i>`;
      row.appendChild(iconDiv);

      const info = document.createElement('div');
      info.className = 'app-option-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'app-option-name';
      nameDiv.textContent = m.name;
      const metaDiv = document.createElement('div');
      metaDiv.className = 'app-option-meta';
      const metaBits = [];
      if (m.publisher && m.publisher !== 'Unknown') metaBits.push(m.publisher);
      if (m.install_path) metaBits.push(m.install_path);
      metaDiv.textContent = metaBits.join(' · ') || 'Installed application';
      info.appendChild(nameDiv);
      info.appendChild(metaDiv);
      row.appendChild(info);

      const goIcon = document.createElement('i');
      goIcon.className = 'fas fa-chevron-right app-option-go';
      row.appendChild(goIcon);

      row.addEventListener('click', () => {
        closeSelectModal();
        onPick(m);
      });

      selectList.appendChild(row);
    });

    selectOverlay.hidden = false;
  }

  function closeSelectModal() {
    selectOverlay.hidden = true;
    selectList.innerHTML = '';
  }

  selectClose.addEventListener('click', closeSelectModal);
  selectOverlay.addEventListener('click', (e) => {
    if (e.target === selectOverlay) closeSelectModal();
  });

  // --- handle user query (real backend search + launch) ---
  async function handleUserQuery(query) {
    if (isProcessing) return;
    if (!query.trim()) return;

    addMessage(query, 'user');
    chatInput.value = '';
    chatInput.style.height = 'auto';
    isProcessing = true;

    const typingEl = showTyping();

    try {
      const result = await searchApps(query);
      removeTyping();

      if (result.status === 'single') {
        await launchAndReport(result.match);
      } else if (result.status === 'multiple') {
        addMessage(`I found **${result.matches.length}** apps that could match "${query}". Please choose one below.`);
        openSelectModal(result.matches, (chosen) => launchAndReport(chosen));
      } else {
        addMessage(`❌ **Application Not Found**\n\n${result.message || "I couldn't recognize that app. Try something like \"Chrome\" or \"Task Manager\"."}`);
      }
    } catch (err) {
      removeTyping();
      addMessage('⚠️ I couldn\'t reach the app launcher service. Please try again.');
    } finally {
      isProcessing = false;
    }
  }

  // --- event listeners ---
  function sendMessage() {
    const text = chatInput.value.trim();
    if (text) handleUserQuery(text);
  }

  sendBtn.addEventListener('click', sendMessage);

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });

  // home button — back to Home Dashboard
  homeBtn.addEventListener('click', () => {
    window.location.href = '/';
  });

  // --- voice command: listens, transcribes, and auto-launches (no Enter needed) ---
  function setListening(state) {
    isListening = state;
    voiceBtn.classList.toggle('listening', state);
    if (voiceStatus) {
      voiceStatus.classList.toggle('active', state);
      voiceStatus.textContent = state ? 'Listening... speak an app name' : '';
    }
  }

  voiceBtn.addEventListener('click', () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      addMessage('🎤 Voice input is not supported in this browser. Try Chrome or Edge.');
      return;
    }

    if (isListening && recognizer) {
      recognizer.stop();
      return;
    }

    recognizer = new SR();
    recognizer.lang = 'en-US';
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;

    recognizer.onstart = () => setListening(true);
    recognizer.onerror = () => setListening(false);
    recognizer.onend = () => setListening(false);

    recognizer.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      chatInput.value = transcript;
      chatInput.dispatchEvent(new Event('input'));
      // Voice commands launch immediately — no Enter press required.
      sendMessage();
    };

    recognizer.start();
  });

  // --- initial greeting already in HTML ---
  scrollToBottom();

});
