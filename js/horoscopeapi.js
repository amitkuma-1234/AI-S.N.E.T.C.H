// ============================================================
// HOROSCOPEAPI.JS — S.N.E.T.C.H AI Astrology Assistant
// Drives: Welcome -> 5-Step Wizard -> Verify -> Chat Consultation
// (main question -> 5 AI follow-ups -> streamed final reading ->
// free-form chat), fully synced with horoscopeapi.py via
// /api/horoscope/* endpoints.
// ============================================================

document.addEventListener('DOMContentLoaded', function () {
    'use strict';

    // ---------- STATE ----------
    let sessionId = null;
    let isStreaming = false;
    let currentWizardStep = 1;
    const TOTAL_STEPS = 5;
    const profile = { name: '', dob: '', zodiac: '', birth_place: '', birth_time: '' };

    // Mirrors the backend session status so we know whether the NEXT reply
    // should be split into "direct answer" + "first follow-up question".
    let currentSessionStatus = '';
    // Lets the Stop Response button cancel the in-flight fetch/stream.
    let abortController = null;
    // Marker the backend inserts between the direct answer and the first
    // follow-up question so one stream can become two chat bubbles.
    const HA_SPLIT_MARKER = '\u2063HA-SPLIT-MARKER\u2063';
    // Scroll behavior: only auto-scroll while the user is already near the
    // bottom; never yank them back down if they've scrolled up to read.
    let stickToBottom = true;

    // ---------- DOM REFS ----------
    const homeBtn = document.getElementById('homeBtn');

    const screenWelcome = document.getElementById('screenWelcome');
    const screenWizard = document.getElementById('screenWizard');
    const screenVerify = document.getElementById('screenVerify');
    const screenChat = document.getElementById('screenChat');
    const screens = { welcome: screenWelcome, wizard: screenWizard, verify: screenVerify, chat: screenChat };

    const startReadingBtn = document.getElementById('startReadingBtn');

    const wizardForm = document.getElementById('wizardForm');
    const progressFill = document.getElementById('progressFill');
    const progressDots = document.querySelectorAll('.ha-dot');
    const wizardError = document.getElementById('wizardError');

    const inputName = document.getElementById('inputName');
    const inputDob = document.getElementById('inputDob');
    const inputZodiac = document.getElementById('inputZodiac');
    const inputBirthPlace = document.getElementById('inputBirthPlace');
    const inputBirthTime = document.getElementById('inputBirthTime');
    const skipBirthTime = document.getElementById('skipBirthTime');
    const reviewBtn = document.getElementById('reviewBtn');

    const verifyName = document.getElementById('verifyName');
    const verifyDob = document.getElementById('verifyDob');
    const verifyZodiac = document.getElementById('verifyZodiac');
    const verifyBirthPlace = document.getElementById('verifyBirthPlace');
    const verifyBirthTime = document.getElementById('verifyBirthTime');
    const editBtn = document.getElementById('editBtn');
    const confirmBtn = document.getElementById('confirmBtn');

    const chatSubtitle = document.getElementById('chatSubtitle');
    const chatScroll = document.getElementById('chatScroll');
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    const stopBtn = document.getElementById('stopBtn');
    const micBtn = document.getElementById('micBtn');
    const voiceStatus = document.getElementById('voiceStatus');
    const newReadingBtn = document.getElementById('newReadingBtn');

    // ---------- HOME NAVIGATION ----------
    // (Handled via native <a href="/"> in HTML)

    // ---------- SPACE BACKGROUND: STARS & PARTICLES ----------
    function createStars() {
        const starsContainer = document.getElementById('stars');
        if (!starsContainer) return;
        const count = 260;
        for (let i = 0; i < count; i++) {
            const star = document.createElement('div');
            star.style.position = 'absolute';
            star.style.width = Math.random() * 2.5 + 0.5 + 'px';
            star.style.height = star.style.width;
            star.style.background = 'rgba(255, 240, 255, 0.85)';
            star.style.borderRadius = '50%';
            star.style.top = Math.random() * 100 + '%';
            star.style.left = Math.random() * 100 + '%';
            star.style.boxShadow = '0 0 6px rgba(200, 160, 255, 0.6)';
            star.style.animation = `twinkle ${2 + Math.random() * 4}s infinite alternate`;
            star.style.animationDelay = Math.random() * 3 + 's';
            starsContainer.appendChild(star);
        }
    }
    createStars();

    function createParticles() {
        const container = document.getElementById('particles');
        if (!container) return;
        const count = 32;
        for (let i = 0; i < count; i++) {
            const p = document.createElement('div');
            p.className = 'particle';
            const size = 3 + Math.random() * 6;
            p.style.width = size + 'px';
            p.style.height = size + 'px';
            p.style.top = Math.random() * 100 + '%';
            p.style.left = Math.random() * 100 + '%';
            p.style.animationDuration = 14 + Math.random() * 20 + 's';
            p.style.animationDelay = Math.random() * 12 + 's';
            p.style.background = `radial-gradient(circle, rgba(200, 170, 255, ${0.3 + Math.random() * 0.5}), rgba(120, 70, 200, 0.2))`;
            container.appendChild(p);
        }
    }
    createParticles();

    // ---------- SCREEN SWITCHING ----------
    function showScreen(name) {
        Object.entries(screens).forEach(([key, el]) => {
            el.classList.toggle('hidden', key !== name);
        });
    }

    // ---------- API HELPER ----------
    async function apiRequest(url, options = {}) {
        const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
            ...options,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Something went wrong.');
        return data;
    }

    // ============================================================
    //  WELCOME -> START READING
    // ============================================================
    startReadingBtn.addEventListener('click', async function () {
        startReadingBtn.disabled = true;
        try {
            const data = await apiRequest('/api/horoscope/sessions', { method: 'POST' });
            sessionId = data.session.id;
            resetWizard();
            showScreen('wizard');
        } catch (e) {
            console.error('[HOROSCOPE] failed to start session', e);
        } finally {
            startReadingBtn.disabled = false;
        }
    });

    // ============================================================
    //  WIZARD (STEP 1-5)
    // ============================================================
    function resetWizard() {
        currentWizardStep = 1;
        inputName.value = '';
        inputDob.value = '';
        inputZodiac.value = '';
        inputBirthPlace.value = '';
        inputBirthTime.value = '';
        skipBirthTime.checked = false;
        wizardError.textContent = '';
        renderWizardStep();
    }

    function renderWizardStep() {
        document.querySelectorAll('.ha-step').forEach(stepEl => {
            stepEl.classList.toggle('active', Number(stepEl.dataset.step) === currentWizardStep);
        });
        progressDots.forEach(dot => {
            const n = Number(dot.dataset.dot);
            dot.classList.toggle('active', n === currentWizardStep);
            dot.classList.toggle('done', n < currentWizardStep);
        });
        progressFill.style.width = (currentWizardStep / TOTAL_STEPS) * 100 + '%';
        wizardError.textContent = '';
    }

    function showWizardError(msg) {
        wizardError.textContent = msg;
    }

    document.querySelectorAll('.ha-next').forEach(btn => {
        btn.addEventListener('click', function () {
            const step = Number(btn.dataset.next);
            if (!validateStep(step)) return;
            currentWizardStep = Math.min(step + 1, TOTAL_STEPS);
            renderWizardStep();
        });
    });

    document.querySelectorAll('.ha-back').forEach(btn => {
        btn.addEventListener('click', function () {
            const step = Number(btn.dataset.back);
            currentWizardStep = Math.max(step - 1, 1);
            renderWizardStep();
        });
    });

    skipBirthTime.addEventListener('change', function () {
        inputBirthTime.disabled = skipBirthTime.checked;
        if (skipBirthTime.checked) inputBirthTime.value = '';
    });

    function validateStep(step) {
        if (step === 1) {
            if (!inputName.value.trim()) return showWizardError('Please enter your full name.'), false;
            profile.name = inputName.value.trim();
        } else if (step === 2) {
            if (!inputDob.value) return showWizardError('Please select your date of birth.'), false;
            profile.dob = inputDob.value;
        } else if (step === 3) {
            if (!inputZodiac.value) return showWizardError('Please select your zodiac sign.'), false;
            profile.zodiac = inputZodiac.value;
        } else if (step === 4) {
            if (!inputBirthPlace.value.trim()) return showWizardError('Please enter your birth place.'), false;
            profile.birth_place = inputBirthPlace.value.trim();
        }
        return true;
    }

    reviewBtn.addEventListener('click', async function () {
        profile.birth_time = skipBirthTime.checked ? '' : inputBirthTime.value;

        reviewBtn.disabled = true;
        try {
            await apiRequest(`/api/horoscope/sessions/${sessionId}/details`, {
                method: 'POST',
                body: JSON.stringify(profile),
            });
            renderVerifyScreen();
            showScreen('verify');
        } catch (e) {
            showWizardError(e.message || 'Could not save your details. Please try again.');
        } finally {
            reviewBtn.disabled = false;
        }
    });

    // ============================================================
    //  VERIFY DETAILS
    // ============================================================
    function renderVerifyScreen() {
        verifyName.textContent = profile.name || '—';
        verifyDob.textContent = formatDob(profile.dob) || '—';
        verifyZodiac.textContent = profile.zodiac || '—';
        verifyBirthPlace.textContent = profile.birth_place || '—';
        verifyBirthTime.textContent = profile.birth_time || 'Not provided';
    }

    function formatDob(dobStr) {
        if (!dobStr) return '';
        const d = new Date(dobStr + 'T00:00:00');
        if (isNaN(d.getTime())) return dobStr;
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    }

    editBtn.addEventListener('click', async function () {
        try {
            await apiRequest(`/api/horoscope/sessions/${sessionId}/edit`, { method: 'POST' });
        } catch (e) { /* non-fatal */ }
        currentWizardStep = 1;
        renderWizardStep();
        showScreen('wizard');
    });

    confirmBtn.addEventListener('click', async function () {
        confirmBtn.disabled = true;
        try {
            const data = await apiRequest(`/api/horoscope/sessions/${sessionId}/confirm`, { method: 'POST' });
            currentSessionStatus = data.session.status;
            chatSubtitle.textContent = `${profile.name} · ${profile.zodiac}`;
            renderMessages(data.session.messages || []);
            showScreen('chat');
            chatInput.focus();
        } catch (e) {
            console.error('[HOROSCOPE] confirm failed', e);
        } finally {
            confirmBtn.disabled = false;
        }
    });

    // ============================================================
    //  NEW READING (reset everything)
    // ============================================================
    newReadingBtn.addEventListener('click', async function () {
        try {
            const data = await apiRequest('/api/horoscope/sessions', { method: 'POST' });
            sessionId = data.session.id;
        } catch (e) {
            console.error('[HOROSCOPE] failed to start new session', e);
            return;
        }
        chatMessages.innerHTML = '';
        currentSessionStatus = '';
        stickToBottom = true;
        profile.name = profile.dob = profile.zodiac = profile.birth_place = profile.birth_time = '';
        resetWizard();
        showScreen('wizard');
    });

    // ============================================================
    //  MARKDOWN RENDERER (minimal — headers, bold/italic, lists)
    // ============================================================
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderMarkdown(raw) {
        if (!raw) return '';
        let text = escapeHtml(raw);
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

        const lines = text.split('\n');
        const parts = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            const headerMatch = line.match(/^(#{1,3})\s+(.*)$/);
            if (headerMatch) {
                parts.push(`<h4>${headerMatch[2]}</h4>`);
                i++;
                continue;
            }
            if (/^\s*[-*]\s+/.test(line)) {
                const items = [];
                while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
                    items.push(`<li>${lines[i].replace(/^\s*[-*]\s+/, '')}</li>`);
                    i++;
                }
                parts.push(`<ul>${items.join('')}</ul>`);
                continue;
            }
            if (/^\s*\d+\.\s+/.test(line)) {
                const items = [];
                while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                    items.push(`<li>${lines[i].replace(/^\s*\d+\.\s+/, '')}</li>`);
                    i++;
                }
                parts.push(`<ol>${items.join('')}</ol>`);
                continue;
            }
            if (line.trim() === '') { i++; continue; }
            const para = [line];
            i++;
            while (i < lines.length && lines[i].trim() !== '' &&
                   !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) &&
                   !/^#{1,3}\s+/.test(lines[i])) {
                para.push(lines[i]);
                i++;
            }
            parts.push(`<p>${para.join('<br>')}</p>`);
        }
        return parts.join('');
    }

    // ---------- PREMIUM READING CARD RENDERER ----------
    const SECTION_ICONS = {
        'summary': 'fa-scroll',
        'main prediction': 'fa-star',
        'detailed analysis': 'fa-magnifying-glass-chart',
        'positive factors': 'fa-circle-plus',
        'challenges': 'fa-triangle-exclamation',
        'suggestions': 'fa-lightbulb',
        'lucky color': 'fa-palette',
        'lucky number': 'fa-hashtag',
        'lucky day': 'fa-calendar-star',
        'recommended actions': 'fa-list-check',
    };
    const LUCKY_KEYS = ['lucky color', 'lucky number', 'lucky day'];

    function looksLikeReading(text) {
        return /##\s*Summary/i.test(text) && /##\s*Main Prediction/i.test(text);
    }

    function renderReadingCard(raw) {
        const sections = [];
        const re = /##\s*(.+?)\s*\n([\s\S]*?)(?=\n##\s|$)/g;
        let match;
        while ((match = re.exec(raw)) !== null) {
            sections.push({ title: match[1].trim(), body: match[2].trim() });
        }
        if (!sections.length) return null;

        const wrapper = document.createElement('div');
        wrapper.className = 'ha-reading';

        const luckySections = sections.filter(s => LUCKY_KEYS.includes(s.title.toLowerCase()));
        const otherSections = sections.filter(s => !LUCKY_KEYS.includes(s.title.toLowerCase()));

        otherSections.forEach(sec => {
            const card = document.createElement('div');
            card.className = 'ha-reading-card';
            const icon = SECTION_ICONS[sec.title.toLowerCase()] || 'fa-sparkles';
            card.innerHTML = `<div class="ha-reading-card-title"><i class="fas ${icon}"></i> ${escapeHtml(sec.title)}</div>
                               <div class="ha-reading-card-body">${renderMarkdown(sec.body)}</div>`;
            wrapper.appendChild(card);
        });

        if (luckySections.length) {
            const row = document.createElement('div');
            row.className = 'ha-lucky-row';
            luckySections.forEach(sec => {
                const chip = document.createElement('div');
                chip.className = 'ha-lucky-chip';
                const icon = SECTION_ICONS[sec.title.toLowerCase()] || 'fa-sparkles';
                const value = sec.body.split('\n')[0].replace(/^[-*]\s*/, '');
                chip.innerHTML = `<div class="ha-lucky-chip-label"><i class="fas ${icon}"></i> ${escapeHtml(sec.title)}</div>
                                   <div class="ha-lucky-chip-value">${escapeHtml(value)}</div>`;
                row.appendChild(chip);
            });
            wrapper.appendChild(row);
        }

        return wrapper;
    }

    // ============================================================
    //  CHAT MESSAGE RENDERING
    // ============================================================
    function formatDateTime(ts) {
        if (!ts) return '';
        const d = new Date(ts * 1000);
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return `${dateStr} · ${timeStr}`;
    }

    function buildMessageEl(msg, isLast) {
        const wrapper = document.createElement('div');
        wrapper.className = 'ha-msg ' + (msg.role === 'user' ? 'ha-msg-user' : 'ha-msg-ai');

        if (msg.role !== 'user') {
            const avatar = document.createElement('div');
            avatar.className = 'ha-msg-avatar';
            avatar.innerHTML = '<i class="fas fa-star-of-life"></i>';
            wrapper.appendChild(avatar);
        }

        const content = document.createElement('div');
        content.className = 'ha-msg-content';

        const bubble = document.createElement('div');
        bubble.className = 'ha-msg-bubble';
        if (msg.role === 'user') {
            bubble.innerHTML = `<p>${escapeHtml(msg.content)}</p>`;
        } else if (msg.kind === 'reading' && looksLikeReading(msg.content)) {
            const card = renderReadingCard(msg.content);
            bubble.appendChild(card || document.createTextNode(msg.content));
        } else if (msg.kind === 'direct_answer') {
            bubble.classList.add('ha-direct-answer');
            bubble.innerHTML = renderMarkdown(msg.content);
        } else {
            bubble.innerHTML = renderMarkdown(msg.content);
        }
        content.appendChild(bubble);

        if (msg.role !== 'user') {
            const actions = document.createElement('div');
            actions.className = 'ha-msg-actions';
            actions.innerHTML = `
                <button type="button" data-action="copy" title="Copy"><i class="fas fa-copy"></i></button>
                <button type="button" data-action="like" title="Like"><i class="fas fa-thumbs-up"></i></button>
                <button type="button" data-action="dislike" title="Dislike"><i class="fas fa-thumbs-down"></i></button>
                ${isLast ? '<button type="button" data-action="regenerate" title="Regenerate"><i class="fas fa-rotate-right"></i></button>' : ''}
            `;
            if (msg.rating === 'like') actions.querySelector('[data-action="like"]').classList.add('active');
            if (msg.rating === 'dislike') actions.querySelector('[data-action="dislike"]').classList.add('active');
            content.appendChild(actions);
            wireMessageActions(actions, bubble, msg);
        }

        const time = document.createElement('div');
        time.className = 'ha-msg-time';
        time.textContent = formatDateTime(msg.created_at);
        content.appendChild(time);

        wrapper.appendChild(content);
        return wrapper;
    }

    function wireMessageActions(actionsEl, bubbleEl, msg) {
        actionsEl.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                if (action === 'copy') {
                    const text = bubbleEl.innerText;
                    navigator.clipboard?.writeText(text).catch(() => {});
                    btn.innerHTML = '<i class="fas fa-check"></i>';
                    setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1200);
                } else if (action === 'like' || action === 'dislike') {
                    const otherAction = action === 'like' ? 'dislike' : 'like';
                    const otherBtn = actionsEl.querySelector(`[data-action="${otherAction}"]`);
                    const nowActive = !btn.classList.contains('active');
                    btn.classList.toggle('active', nowActive);
                    otherBtn.classList.remove('active');
                    sendFeedback(msg.id, nowActive ? action : '');
                } else if (action === 'regenerate') {
                    regenerateLastReply();
                }
            });
        });
    }

    async function sendFeedback(messageId, rating) {
        if (!messageId || !sessionId) return;
        try {
            await apiRequest(`/api/horoscope/sessions/${sessionId}/messages/${messageId}/feedback`, {
                method: 'POST',
                body: JSON.stringify({ rating }),
            });
        } catch (e) { /* non-fatal */ }
    }

    function renderMessages(messages) {
        chatMessages.innerHTML = '';
        const lastAiIndex = (() => {
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role !== 'user') return i;
            }
            return -1;
        })();
        messages.forEach((m, idx) => {
            chatMessages.appendChild(buildMessageEl(m, idx === lastAiIndex));
        });
        scrollToBottom(true);
    }

    // Only force-scroll when the user hasn't deliberately scrolled up. Pass
    // force=true for actions the user just triggered themselves (sending a
    // message, opening the chat) — otherwise, during streaming, we respect
    // wherever the user is currently reading.
    function scrollToBottom(force) {
        if (force) stickToBottom = true;
        if (!stickToBottom) return;
        requestAnimationFrame(() => { chatScroll.scrollTop = chatScroll.scrollHeight; });
    }

    function isScrollNearBottom() {
        return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 80;
    }

    chatScroll.addEventListener('scroll', () => {
        stickToBottom = isScrollNearBottom();
    });

    function showTypingIndicator() {
        const wrapper = document.createElement('div');
        wrapper.className = 'ha-msg ha-msg-ai';
        wrapper.id = 'haTypingIndicator';
        wrapper.innerHTML = `
            <div class="ha-msg-avatar"><i class="fas fa-star-of-life"></i></div>
            <div class="ha-msg-content">
                <div class="ha-msg-bubble"><div class="ha-typing-dots"><span></span><span></span><span></span></div></div>
            </div>`;
        chatMessages.appendChild(wrapper);
        scrollToBottom(true);
        return wrapper;
    }

    // ============================================================
    //  AUTO-RESIZE TEXTAREA
    // ============================================================
    function autoResizeTextarea() {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
    }
    chatInput.addEventListener('input', autoResizeTextarea);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // ============================================================
    //  VOICE INPUT (speech-to-text via Web Speech API)
    // ============================================================
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let isListening = false;

    if (!SpeechRecognitionCtor) {
        micBtn.disabled = true;
        micBtn.title = 'Voice input is not supported in this browser';
    } else {
        recognition = new SpeechRecognitionCtor();
        recognition.lang = 'en-US';
        recognition.continuous = false;
        recognition.interimResults = true;

        recognition.onstart = function () {
            isListening = true;
            micBtn.classList.add('listening');
            voiceStatus.textContent = 'Listening... speak your question';
        };
        recognition.onend = function () {
            isListening = false;
            micBtn.classList.remove('listening');
            voiceStatus.textContent = '';
        };
        recognition.onerror = function (e) {
            isListening = false;
            micBtn.classList.remove('listening');
            voiceStatus.textContent = e.error === 'no-speech' ? "Didn't catch that — try again." : '';
            console.error('[HOROSCOPE] speech recognition error', e);
        };
        recognition.onresult = function (event) {
            let transcript = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            chatInput.value = transcript;
            autoResizeTextarea();
            const lastResult = event.results[event.results.length - 1];
            if (lastResult.isFinal) {
                recognition.stop();
                sendMessage(); // no need to press Enter after speaking
            }
        };

        micBtn.addEventListener('click', function () {
            if (isStreaming) return;
            if (isListening) {
                recognition.stop();
                return;
            }
            chatInput.value = '';
            autoResizeTextarea();
            try { recognition.start(); } catch (e) { /* already listening */ }
        });
    }

    // ============================================================
    //  SENDING MESSAGES (STREAMING) + STOP RESPONSE
    // ============================================================
    function setStreaming(streaming) {
        isStreaming = streaming;
        chatInput.disabled = streaming;
        sendBtn.classList.toggle('hidden', streaming);
        stopBtn.classList.toggle('hidden', !streaming);
        micBtn.disabled = streaming || !recognition;
    }

    stopBtn.addEventListener('click', function () {
        if (abortController) abortController.abort();
    });

    async function streamIntoBubble(response, aiEl, kindHint) {
        const bubbleEl = aiEl.querySelector('.ha-msg-bubble');
        if (!response.body || !response.body.getReader) {
            const text = await response.text();
            bubbleEl.innerHTML = renderMarkdown(text);
            return text;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let accumulated = '';
        const cursor = document.createElement('span');
        cursor.className = 'ha-typing-cursor';
        bubbleEl.appendChild(cursor);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            accumulated += decoder.decode(value, { stream: true });
            bubbleEl.innerHTML = renderMarkdown(accumulated);
            bubbleEl.appendChild(cursor);
            scrollToBottom();
        }
        cursor.remove();

        if (kindHint === 'reading' && looksLikeReading(accumulated)) {
            bubbleEl.innerHTML = '';
            const card = renderReadingCard(accumulated);
            if (card) bubbleEl.appendChild(card);
            else bubbleEl.innerHTML = renderMarkdown(accumulated);
        } else {
            bubbleEl.innerHTML = renderMarkdown(accumulated);
        }
        scrollToBottom();
        return accumulated;
    }

    // Streams a response that contains a direct answer, an internal split
    // marker, and the first follow-up question — rendering them as two
    // separate chat bubbles as the marker is crossed.
    async function streamSplitIntoBubbles(response) {
        const directEl = buildMessageEl({ role: 'assistant', content: '', created_at: nowTs() }, false);
        chatMessages.appendChild(directEl);
        const directBubble = directEl.querySelector('.ha-msg-bubble');
        directBubble.classList.add('ha-direct-answer');
        scrollToBottom();

        if (!response.body || !response.body.getReader) {
            const text = await response.text();
            const idx = text.indexOf(HA_SPLIT_MARKER);
            const before = idx === -1 ? text : text.slice(0, idx);
            const after = idx === -1 ? '' : text.slice(idx + HA_SPLIT_MARKER.length);
            directBubble.innerHTML = renderMarkdown(before);
            appendStreamedQuestionBubble(after);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        const cursor = document.createElement('span');
        cursor.className = 'ha-typing-cursor';
        directBubble.appendChild(cursor);

        let pre = '';
        let post = '';
        let splitFound = false;
        let questionBubble = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });

            if (!splitFound) {
                pre += chunk;
                const idx = pre.indexOf(HA_SPLIT_MARKER);
                if (idx !== -1) {
                    splitFound = true;
                    post = pre.slice(idx + HA_SPLIT_MARKER.length);
                    pre = pre.slice(0, idx);
                    cursor.remove();
                    directBubble.innerHTML = renderMarkdown(pre);
                    questionBubble = appendStreamedQuestionBubble('');
                    questionBubble.appendChild(cursor);
                } else {
                    directBubble.innerHTML = renderMarkdown(pre);
                    directBubble.appendChild(cursor);
                }
            } else {
                post += chunk;
                questionBubble.innerHTML = renderMarkdown(post);
                questionBubble.appendChild(cursor);
            }
            scrollToBottom();
        }
        cursor.remove();
        if (splitFound && questionBubble) questionBubble.innerHTML = renderMarkdown(post);
    }

    function appendStreamedQuestionBubble(initialText) {
        const el = buildMessageEl({ role: 'assistant', content: '', created_at: nowTs() }, true);
        chatMessages.appendChild(el);
        scrollToBottom();
        const bubble = el.querySelector('.ha-msg-bubble');
        bubble.innerHTML = renderMarkdown(initialText);
        return bubble;
    }

    function nowTs() {
        return Math.floor(Date.now() / 1000);
    }

    function guessNextKind() {
        // Best-effort hint for how to render the incoming AI message once
        // streaming finishes (question bubble vs. premium reading cards).
        return sessionAwaitingFinalReading ? 'reading' : 'question';
    }
    let sessionAwaitingFinalReading = false;

    async function sendMessage() {
        const text = chatInput.value.trim();
        if (!text || isStreaming || !sessionId) return;

        // If the session is still waiting for the user's main question, the
        // very next reply must be split into "direct answer" + first
        // follow-up question (two bubbles, one stream).
        const expectDirectAnswer = currentSessionStatus === 'awaiting_query';

        chatInput.value = '';
        autoResizeTextarea();

        const userMsg = { role: 'user', content: text, created_at: nowTs() };
        chatMessages.appendChild(buildMessageEl(userMsg, false));
        chatMessages.querySelectorAll('[data-action="regenerate"]').forEach(b => b.remove());
        scrollToBottom(true);

        const typingEl = showTypingIndicator();

        setStreaming(true);
        abortController = new AbortController();
        try {
            const res = await fetch(`/api/horoscope/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
                signal: abortController.signal,
            });

            typingEl.remove();

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                const aiEl = buildMessageEl({ role: 'assistant', content: '', created_at: nowTs() }, true);
                chatMessages.appendChild(aiEl);
                aiEl.querySelector('.ha-msg-bubble').innerHTML = renderMarkdown(errData.error || 'Something went wrong. Please try again.');
            } else if (expectDirectAnswer) {
                await streamSplitIntoBubbles(res);
            } else {
                const aiMsgShell = { role: 'assistant', content: '', created_at: nowTs() };
                const aiEl = buildMessageEl(aiMsgShell, true);
                chatMessages.appendChild(aiEl);
                scrollToBottom();
                await streamIntoBubble(res, aiEl, guessNextKind());
            }
        } catch (e) {
            typingEl.remove();
            if (e.name !== 'AbortError') {
                const aiEl = buildMessageEl({ role: 'assistant', content: '', created_at: nowTs() }, true);
                chatMessages.appendChild(aiEl);
                aiEl.querySelector('.ha-msg-bubble').innerHTML = renderMarkdown('⚠️ Network error. Please try again.');
            }
            // AbortError (Stop Response): keep whatever partial content
            // already streamed into the bubble(s) — user can ask right away.
        } finally {
            setStreaming(false);
            abortController = null;
            await refreshSessionState();
        }
    }
    sendBtn.addEventListener('click', sendMessage);

    // Track whether the *next* AI reply should be treated as the final
    // reading (i.e. we're on the 5th follow-up answer right now), and keep
    // currentSessionStatus in sync for the direct-answer-split decision.
    async function refreshSessionState() {
        try {
            const data = await apiRequest(`/api/horoscope/sessions/${sessionId}`);
            currentSessionStatus = data.session.status;
            sessionAwaitingFinalReading = data.session.status === 'awaiting_followup' && data.session.step === 4;
            // Re-render the last AI message properly if it was a reading
            // (covers the case streamIntoBubble's kind hint guessed wrong).
            const messages = data.session.messages || [];
            const last = messages[messages.length - 1];
            if (last && last.kind === 'reading') {
                const aiEls = chatMessages.querySelectorAll('.ha-msg-ai');
                const lastAiEl = aiEls[aiEls.length - 1];
                if (lastAiEl) {
                    const bubbleEl = lastAiEl.querySelector('.ha-msg-bubble');
                    if (!bubbleEl.querySelector('.ha-reading') && looksLikeReading(last.content)) {
                        bubbleEl.innerHTML = '';
                        const card = renderReadingCard(last.content);
                        if (card) bubbleEl.appendChild(card);
                    }
                }
            }
        } catch (e) { /* non-fatal */ }
    }

    // ============================================================
    //  REGENERATE
    // ============================================================
    async function regenerateLastReply() {
        if (!sessionId || isStreaming) return;
        const aiEls = chatMessages.querySelectorAll('.ha-msg-ai');
        const lastAiEl = aiEls[aiEls.length - 1];
        if (!lastAiEl) return;
        const bubbleEl = lastAiEl.querySelector('.ha-msg-bubble');
        bubbleEl.innerHTML = '<div class="ha-typing-dots"><span></span><span></span><span></span></div>';

        setStreaming(true);
        abortController = new AbortController();
        try {
            const res = await fetch(`/api/horoscope/sessions/${sessionId}/regenerate`, {
                method: 'POST',
                signal: abortController.signal,
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                bubbleEl.innerHTML = renderMarkdown(errData.error || 'Something went wrong. Please try again.');
            } else {
                await streamIntoBubble(res, lastAiEl, guessNextKind());
            }
        } catch (e) {
            if (e.name !== 'AbortError') {
                bubbleEl.innerHTML = renderMarkdown('⚠️ Network error. Please try again.');
            }
        } finally {
            setStreaming(false);
            abortController = null;
            await refreshSessionState();
        }
    }
});