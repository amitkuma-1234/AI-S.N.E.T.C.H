// ============================================================
// S.N.E.T.C.H · Latest News AI — main application
// ============================================================
// This is a from-scratch rewrite of the frontend logic. The previous
// version never called any backend endpoint — it only rendered fake
// demo chats client-side. This version talks to GET /api/latestnews
// and renders the real, live results as premium news cards.

(function () {
    'use strict';

    // ---- STATE ----
    let responses = [];          // [{ id, query, timestamp, status, data }]
    let nextId = 1;
    let isBusy = false;          // true while a request is in flight
    let recognizing = false;

    // ---- DOM REFS ----
    const placeholderEl = document.getElementById('chat-placeholder');
    const messagesEl = document.getElementById('chat-messages');
    const inputBarEl = document.getElementById('input-bar');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const voiceBtn = document.getElementById('voice-btn');
    const voiceIndicator = document.getElementById('voice-indicator');
    const newChatBtn = document.getElementById('new-chat-btn');
    const newChatNav = document.getElementById('new-chat-nav');

    // ---- HELPERS ----
    function generateId() { return nextId++; }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }

    function formatTime(date) {
        const d = new Date(date);
        return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function scrollToBottom(smooth = true) {
        if (!messagesEl) return;
        messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    }

    // ---- RESET / NEW CHAT ----
    function resetConversation() {
        // stop any in-flight recognition
        stopVoiceRecognition();
        responses = [];
        isBusy = false;
        chatInput.value = '';

        placeholderEl.style.display = 'none';
        messagesEl.style.display = 'flex';
        messagesEl.innerHTML = '';
        inputBarEl.style.display = 'block';
        chatInput.focus();
    }

    // ---- RENDER ----
    function renderAll() {
        if (responses.length === 0) {
            messagesEl.innerHTML = '';
            return;
        }
        messagesEl.innerHTML = responses.map(renderResponseBlock).join('');
        attachActionListeners();
        scrollToBottom(false);
    }

    function renderResponseBlock(entry) {
        const userMsg = `
            <div class="message user">
                <div>${escapeHtml(entry.query)}</div>
                <div class="msg-time">${formatTime(entry.timestamp)}</div>
            </div>`;

        let body;
        if (entry.status === 'loading') {
            body = `
                <div class="news-loading" data-id="${entry.id}">
                    <div class="loading-dots"><span></span><span></span><span></span></div>
                    <span>Fetching the latest news for "${escapeHtml(entry.query)}"…</span>
                </div>`;
            return userMsg + body;
        }

        if (entry.status === 'error') {
            body = `
                <div class="error-card" data-id="${entry.id}">
                    <i class="fas fa-triangle-exclamation"></i>
                    <span>${escapeHtml(entry.message)}</span>
                </div>`;
            return userMsg + body;
        }

        // success
        const data = entry.data;
        const cards = data.articles.map(a => renderNewsCard(a)).join('');
        body = `
            <div class="news-response" data-id="${entry.id}">
                <div class="news-response-label"><i class="fas fa-satellite-dish"></i> ${escapeHtml(data.label)} · ${data.articles.length} results</div>
                <div class="news-grid">${cards}</div>
                <div class="response-actions">
                    <button data-action="copy" data-id="${entry.id}" title="Copy"><i class="fas fa-copy"></i></button>
                    <button data-action="like" data-id="${entry.id}" title="Like" class="${entry.liked ? 'active-like' : ''}"><i class="fa${entry.liked ? 's' : 'r'} fa-thumbs-up"></i></button>
                    <button data-action="dislike" data-id="${entry.id}" title="Dislike" class="${entry.disliked ? 'active-dislike' : ''}"><i class="fa${entry.disliked ? 's' : 'r'} fa-thumbs-down"></i></button>
                    <button data-action="regenerate" data-id="${entry.id}" title="Regenerate"><i class="fas fa-rotate"></i></button>
                    <button data-action="tts" data-id="${entry.id}" title="Read aloud"><i class="fas fa-volume-up"></i></button>
                    <span class="response-timestamp">${formatTime(entry.timestamp)}</span>
                </div>
            </div>`;
        return userMsg + body;
    }

    function renderNewsCard(article) {
        const highlights = (article.highlights || []).map(h => `<li>${escapeHtml(h)}</li>`).join('');
        const topics = (article.related_topics || []).map(t => `<span class="news-topic-chip">${escapeHtml(t)}</span>`).join('');
        const link = article.link ? escapeHtml(article.link) : '';
        return `
            <div class="news-card">
                <div class="news-card-top">
                    <span class="news-category">${escapeHtml(article.category || 'General')}</span>
                    <span class="news-datetime"><i class="far fa-clock"></i> ${escapeHtml(article.published_display || 'Unknown date')}</span>
                </div>
                <div class="news-headline">${escapeHtml(article.headline)}</div>
                <div class="news-source"><i class="fas fa-signature"></i> ${escapeHtml(article.source || 'Unknown Source')}</div>
                <div class="news-summary">${escapeHtml(article.summary)}</div>
                ${highlights ? `<ul class="news-highlights">${highlights}</ul>` : ''}
                ${topics ? `<div class="news-topics">${topics}</div>` : ''}
                <div class="news-card-footer">
                    ${link ? `<button class="read-more-btn" data-link="${link}"><i class="fas fa-arrow-up-right-from-square"></i> Read More</button>` : ''}
                </div>
            </div>`;
    }

    function attachActionListeners() {
        messagesEl.querySelectorAll('.read-more-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.getAttribute('data-link');
                if (url) window.open(url, '_blank', 'noopener,noreferrer');
            });
        });

        messagesEl.querySelectorAll('.response-actions button').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                const id = parseInt(btn.dataset.id, 10);
                const entry = responses.find(r => r.id === id);
                if (!entry) return;

                if (action === 'copy') {
                    const text = buildPlainTextSummary(entry);
                    navigator.clipboard?.writeText(text).catch(() => {});
                    flashButton(btn, 'fa-check');
                } else if (action === 'like') {
                    entry.liked = !entry.liked;
                    entry.disliked = false;
                    renderAll();
                } else if (action === 'dislike') {
                    entry.disliked = !entry.disliked;
                    entry.liked = false;
                    renderAll();
                } else if (action === 'regenerate') {
                    regenerate(entry);
                } else if (action === 'tts') {
                    speak(entry);
                }
            });
        });
    }

    function flashButton(btn, iconClass) {
        const icon = btn.querySelector('i');
        if (!icon) return;
        const original = icon.className;
        icon.className = `fas ${iconClass}`;
        setTimeout(() => { icon.className = original; }, 1200);
    }

    function buildPlainTextSummary(entry) {
        if (entry.status !== 'success') return entry.query;
        const lines = [entry.data.label];
        entry.data.articles.forEach((a, i) => {
            lines.push(`${i + 1}. ${a.headline} — ${a.source} (${a.published_display})`);
            lines.push(`   ${a.summary}`);
            lines.push(`   ${a.link}`);
        });
        return lines.join('\n');
    }

    function speak(entry) {
        if (!('speechSynthesis' in window)) {
            alert('Text-to-speech is not supported in this browser.');
            return;
        }
        speechSynthesis.cancel();
        const text = entry.status === 'success'
            ? `${entry.data.label}. ` + entry.data.articles.map(a => `${a.headline}. ${a.summary}`).join(' ')
            : (entry.message || entry.query);
        const utterance = new SpeechSynthesisUtterance(text);
        speechSynthesis.speak(utterance);
    }

    // ---- SEARCH / FETCH ----
    async function runSearch(rawQuery) {
        const query = (rawQuery || '').trim();
        if (!query) return; // guard against empty query — no request sent

        const entry = { id: generateId(), query, timestamp: new Date().toISOString(), status: 'loading' };
        responses.push(entry);
        isBusy = true;
        renderAll();
        scrollToBottom();

        try {
            const res = await fetch(`/api/latestnews?q=${encodeURIComponent(query)}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
            });

            let payload;
            try {
                payload = await res.json();
            } catch (parseErr) {
                throw new Error('server_bad_response');
            }

            if (!res.ok || payload.status !== 'ok') {
                entry.status = 'error';
                entry.message = friendlyErrorMessage(payload);
            } else {
                entry.status = 'success';
                entry.data = payload;
            }
        } catch (err) {
            entry.status = 'error';
            entry.message = 'Network error — please check your internet connection and try again.';
        } finally {
            isBusy = false;
            renderAll();
            scrollToBottom();
        }
    }

    function friendlyErrorMessage(payload) {
        if (!payload) return 'Something went wrong while fetching the news. Please try again.';
        switch (payload.error_type) {
            case 'empty_query':
                return 'Please type or speak a news topic to search.';
            case 'invalid_query':
                return payload.message || 'That doesn\'t look like a valid search. Try a topic, place, or category.';
            case 'no_news':
                return payload.message || 'No news found for that search. Try a different topic or spelling.';
            case 'network_error':
                return payload.message || 'Couldn\'t reach the news service. Please try again shortly.';
            default:
                return payload.message || 'Something went wrong while fetching the news. Please try again.';
        }
    }

    function regenerate(entry) {
        entry.status = 'loading';
        renderAll();
        scrollToBottom();

        fetch(`/api/latestnews?q=${encodeURIComponent(entry.query)}`, { headers: { 'Accept': 'application/json' } })
            .then(res => res.json().then(payload => ({ ok: res.ok, payload })))
            .then(({ ok, payload }) => {
                if (!ok || payload.status !== 'ok') {
                    entry.status = 'error';
                    entry.message = friendlyErrorMessage(payload);
                } else {
                    entry.status = 'success';
                    entry.data = payload;
                }
            })
            .catch(() => {
                entry.status = 'error';
                entry.message = 'Network error — please check your internet connection and try again.';
            })
            .finally(() => {
                renderAll();
                scrollToBottom();
            });
    }

    // ---- SEND (Enter / button) ----
    function handleSend() {
        if (isBusy) return;
        const text = chatInput.value.trim();
        if (!text) return; // empty query — do nothing, no request
        chatInput.value = '';
        runSearch(text);
    }

    sendBtn.addEventListener('click', handleSend);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });

    // ---- VOICE INPUT (auto-search after speech, no Enter needed) ----
    let recognition = null;
    function getRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return null;
        if (recognition) return recognition;
        recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onstart = () => {
            recognizing = true;
            voiceBtn.classList.add('listening');
            voiceIndicator.style.display = 'flex';
        };
        recognition.onerror = () => {
            recognizing = false;
            voiceBtn.classList.remove('listening');
            voiceIndicator.style.display = 'none';
        };
        recognition.onend = () => {
            recognizing = false;
            voiceBtn.classList.remove('listening');
            voiceIndicator.style.display = 'none';
        };
        recognition.onresult = (e) => {
            const transcript = e.results[0][0].transcript;
            chatInput.value = transcript;
            // Voice input must auto-search — no Enter required.
            runSearch(transcript);
        };
        return recognition;
    }

    function stopVoiceRecognition() {
        if (recognition && recognizing) {
            try { recognition.stop(); } catch (e) { /* ignore */ }
        }
    }

    voiceBtn.addEventListener('click', () => {
        const rec = getRecognition();
        if (!rec) {
            alert('Voice input is not supported in this browser. Please type your request instead.');
            return;
        }
        if (recognizing) {
            rec.stop();
            return;
        }
        try {
            rec.start();
        } catch (e) {
            // start() throws if already started; ignore
        }
    });

    // ---- NEW CHAT ----
    function createNewChat() {
        resetConversation();
    }
    newChatBtn.addEventListener('click', createNewChat);
    newChatNav.addEventListener('click', (e) => {
        e.preventDefault();
        createNewChat();
    });

    // ---- INIT ----
    function init() {
        placeholderEl.style.display = 'flex';
        messagesEl.style.display = 'none';
        inputBarEl.style.display = 'none';
    }
    init();

    // ---- SHOOTING STARS & PARTICLES (pure css animated, but add dynamic) ----
    function createStars() {
        const container = document.getElementById('stars');
        for (let i = 0; i < 120; i++) {
            const star = document.createElement('div');
            star.className = 'star';
            star.style.width = (1 + Math.random() * 2.5) + 'px';
            star.style.height = star.style.width;
            star.style.left = Math.random() * 100 + '%';
            star.style.top = Math.random() * 100 + '%';
            star.style.animationDelay = Math.random() * 5 + 's';
            star.style.animationDuration = (1.5 + Math.random() * 3) + 's';
            container.appendChild(star);
        }
    }
    function createShootingStars() {
        const container = document.getElementById('shooting-stars');
        for (let i = 0; i < 4; i++) {
            const ss = document.createElement('div');
            ss.className = 'shooting-star';
            ss.style.left = (10 + Math.random() * 70) + '%';
            ss.style.top = (5 + Math.random() * 20) + '%';
            ss.style.animationDelay = (2 + i * 5 + Math.random() * 6) + 's';
            ss.style.animationDuration = (3 + Math.random() * 4) + 's';
            container.appendChild(ss);
        }
    }
    function createParticles() {
        const container = document.getElementById('particles');
        for (let i = 0; i < 30; i++) {
            const p = document.createElement('div');
            p.className = 'particle';
            p.style.width = (2 + Math.random() * 6) + 'px';
            p.style.height = p.style.width;
            p.style.left = Math.random() * 100 + '%';
            p.style.top = Math.random() * 100 + '%';
            p.style.animationDelay = Math.random() * 15 + 's';
            p.style.animationDuration = (15 + Math.random() * 20) + 's';
            container.appendChild(p);
        }
    }
    createStars();
    createShootingStars();
    createParticles();
})();