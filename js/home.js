/**
 * ============================================
 * HOME.JS - S.N.E.T.C.H AI OS
 * Interactive features, navigation, animations
 * ============================================
 */

(function() {
    'use strict';

    // ==========================================
    // 0. AUTH GUARD — verify token with backend
    //    before showing the dashboard. Runs first.
    // ==========================================
    (function checkAuth() {
        const token = localStorage.getItem('snetch_access_token');
        if (!token) {
            window.location.replace('/login');
            return;
        }
        fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
            .then(r => {
                if (r.status === 401) {
                    return r.json().catch(() => ({})).then(body => {
                        const err = new Error('unauthenticated');
                        err.isAuthError = true;
                        err.reason = (body && body.error) || ('401 from /api/auth/me');
                        throw err;
                    });
                }
                if (!r.ok) {
                    throw new Error('server_error_' + r.status);
                }
                return r.json();
            })
            .then(d => {
                if (!d || d.status !== 'ok') throw new Error('unexpected_response');
                if (d.user) {
                    localStorage.setItem('snetch_user', JSON.stringify(d.user));
                    populateUserUI(d.user);
                }
            })
            .catch((e) => {
                console.error('[SNETCH auth check]', e);
                if (e && e.isAuthError) {
                    localStorage.removeItem('snetch_access_token');
                    localStorage.removeItem('snetch_refresh_token');
                    localStorage.removeItem('snetch_user');
                    const reason = encodeURIComponent(e.reason || e.message || 'unknown');
                    window.location.replace('/login?session_error=' + reason);
                }
                // For non-401 failures: stay on the page. The dashboard still
                // renders from localStorage/cached data; the user isn't
                // force-logged-out over a transient error.
            });
    })();

    function snetchLogout() {
        localStorage.removeItem('snetch_access_token');
        localStorage.removeItem('snetch_refresh_token');
        localStorage.removeItem('snetch_user');
        window.location.replace('/login');
    }

    // ==========================================
    // 0b. HELPERS — auth header, user initials
    // ==========================================
    function authHeaders() {
        const t = localStorage.getItem('snetch_access_token');
        return t ? { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
    }

    function getInitials(name) {
        if (!name) return '--';
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return name.substring(0, 2).toUpperCase();
    }

    // ==========================================
    // 0c. POPULATE USER UI (topbar + greeting)
    // ==========================================
    function populateUserUI(user) {
        if (!user) return;
        const name = user.username || user.email || 'User';
        const initials = getInitials(name);

        const el = id => document.getElementById(id);
        if (el('topbar-avatar')) el('topbar-avatar').textContent = initials;
        if (el('topbar-username')) el('topbar-username').textContent = name;
        if (el('dashboard-greeting')) el('dashboard-greeting').textContent = name + ' · 37 features';
    }

    // ==========================================
    // 0d. LOAD PROFILE DATA FROM API
    // ==========================================
    function loadProfile() {
        fetch('/api/user/profile', { headers: authHeaders() })
            .then(r => r.json())
            .then(d => {
                if (d.status !== 'ok' || !d.profile) return;
                const p = d.profile;
                const el = id => document.getElementById(id);
                const initials = getInitials(p.username);

                if (el('profile-avatar')) el('profile-avatar').textContent = initials;
                if (el('profile-name')) el('profile-name').textContent = p.username;
                if (el('profile-username')) el('profile-username').textContent = '@' + p.username.toLowerCase().replace(/\s+/g, '');
                if (el('profile-email')) el('profile-email').textContent = p.email;
                if (el('profile-joined')) el('profile-joined').textContent = p.joined;
                if (el('profile-features')) el('profile-features').textContent = p.features_used + ' / ' + p.total_features;
                if (el('profile-last-login')) el('profile-last-login').textContent = p.last_login;
                if (el('profile-account-type')) {
                    if (p.has_google && p.has_password) el('profile-account-type').textContent = 'Email + Google';
                    else if (p.has_google) el('profile-account-type').textContent = 'Google Account';
                    else el('profile-account-type').textContent = 'Email Account';
                }

                // Also update topbar
                populateUserUI({ username: p.username, email: p.email });
            })
            .catch(e => console.warn('[SNETCH] profile load failed:', e));
    }

    // ==========================================
    // 0e. LOAD SETTINGS FROM API
    // ==========================================
    function loadSettings() {
        // First populate account fields from localStorage
        try {
            const u = JSON.parse(localStorage.getItem('snetch_user') || '{}');
            const el = id => document.getElementById(id);
            if (el('set-username')) el('set-username').textContent = u.username || '—';
            if (el('set-email')) el('set-email').textContent = u.email || '—';
        } catch(e) {}

        fetch('/api/user/settings', { headers: authHeaders() })
            .then(r => r.json())
            .then(d => {
                if (d.status !== 'ok' || !d.settings) return;
                const s = d.settings;
                const el = id => document.getElementById(id);
                if (el('set-theme')) el('set-theme').textContent = s.theme === 'dark' ? 'On' : 'Off';
                if (el('set-theme-color')) el('set-theme-color').textContent = s.theme_color || 'Neon Purple';
                if (el('set-font-size')) el('set-font-size').textContent = s.font_size || 'Medium';
                if (el('set-language')) el('set-language').textContent = s.language || 'English';
                if (el('set-animations')) el('set-animations').textContent = s.animations ? 'Enabled' : 'Disabled';
                if (el('set-sound-effects')) el('set-sound-effects').textContent = s.sound_effects ? 'On' : 'Off';
                if (el('set-notifications')) el('set-notifications').textContent = s.notifications ? 'On' : 'Off';
                if (el('set-reminders-notify')) el('set-reminders-notify').textContent = s.reminders_notify ? 'On' : 'Off';
                if (el('set-default-home')) el('set-default-home').textContent = s.default_home || 'Dashboard';
                if (el('set-privacy')) el('set-privacy').textContent = s.privacy || 'Strict';
                if (el('set-auto-backup')) el('set-auto-backup').textContent = s.auto_backup ? 'Auto' : 'Manual';
            })
            .catch(e => console.warn('[SNETCH] settings load failed:', e));
    }

    // ==========================================
    // 1. FEATURE CARDS DATA (31 items)
    // ==========================================
    const features = [
        "Smart Alarm", "AI Assistant", "Web AI Search", "Counter & Timer", "Task Planner",
        "Document AI", "Video Downloader", "Media Downloader", "Entertainment Hub", "File Manager",
        "Recipe Assistant", "Astro Insights", "AI Image Generator", "Image Assistant", "News Hub",
        "Maps & Navigation", "Launch Apps", "Open Browser", "Password Vault","SnapLock", "Explore World",
        "Smart Reminders", "Shopping Planner", "Email Center", "Music Downloader", "Music Player",
        "World Clock", "Video Player", "WhatsApp Messenger", "Weather Center", "Wiki Search", "YouTube AI",
        "Object Tracking", "Spam Mail Checker","Face Expression", "Deepfake Detector","Barcode & QR Scanner","SNETCH Assistant"
    ];

    // Maps each feature card to its Flask route (must match the
    // @app.route(...) page routes registered in app.py).
    const routeMap = {
        "Smart Alarm": "/alarm",
        "AI Assistant": "/askanything",
        "Web AI Search": "/askbygoogle",
        "Counter & Timer": "/countingset",
        "Task Planner": "/dailytask",
        "Document AI": "/document_chatbot",
        "Video Downloader": "/downloadvideo",
        "Media Downloader": "/download_entertainment",
        "Entertainment Hub": "/Entertainment",
        "File Manager": "/filesystem",
        "Recipe Assistant": "/foodrecipe",
        "Astro Insights": "/horoscopeapi",
        "AI Image Generator": "/imagecreater",
        "Image Assistant": "/image_chatbot",
        "News Hub": "/latestnews",
        "Maps & Navigation": "/location",
        "Launch Apps": "/openanyapp",
        "Open Browser": "/openanybrowser",
        "Password Vault": "/passwordsave",
        "SnapLock": "/snaplock",
        "Explore World": "/real_world_information",
        "Smart Reminders": "/reminder",
        "Shopping Planner": "/shoppinglist",
        "Email Center": "/smtp",
        "Music Downloader": "/songdownload",
        "Music Player": "/songplay",
        "World Clock": "/time",
        "Video Player": "/videoplay",
        "WhatsApp Messenger": "/whatsappmessage",
        "Weather Center": "/wheather",
        "Wiki Search": "/wikipedia",
        "YouTube AI": "/youtube_chatbot",
        "Object Tracking": "/objecttracking",
        "Spam Mail Checker": "/spaim_mail",
        "Face Expression": "/face_expression",
        "Deepfake Detector": "/deepfake_detector",
        "Barcode & QR Scanner": "/barcode_qr_scanner",
        "SNETCH Assistant": "/snetch"
    };

    const iconMap = {
        "Smart Alarm": "fa-clock",
        "AI Assistant": "fa-robot",
        "Web AI Search": "fa-globe",
        "Counter & Timer": "fa-stopwatch",
        "Task Planner": "fa-tasks",
        "Document AI": "fa-file-alt",
        "Video Downloader": "fa-video",
        "Media Downloader": "fa-download",
        "Entertainment Hub": "fa-film",
        "File Manager": "fa-folder",
        "Recipe Assistant": "fa-utensils",
        "Astro Insights": "fa-star",
        "AI Image Generator": "fa-paint-brush",
        "Image Assistant": "fa-image",
        "News Hub": "fa-newspaper",
        "Maps & Navigation": "fa-map",
        "Launch Apps": "fa-th",
        "Open Browser": "fa-compass",
        "Password Vault": "fa-lock",
        "SnapLock": "fa-cube",
        "Explore World": "fa-earth-asia",
        "Smart Reminders": "fa-bell",
        "Shopping Planner": "fa-cart-shopping",
        "Email Center": "fa-envelope",
        "Music Downloader": "fa-music",
        "Music Player": "fa-headphones",
        "World Clock": "fa-clock",
        "Video Player": "fa-play-circle",
        "WhatsApp Messenger": "fa-whatsapp",
        "Weather Center": "fa-cloud-sun",
        "Wiki Search": "fa-wikipedia-w",
        "YouTube AI": "fa-youtube",
        "Object Tracking": "fa-crosshairs",
        "Spam Mail Checker": "fa-shield-virus",
        "Face Expression": "fa-face-smile",
        "Deepfake Detector": "fa-user-secret",
        "Barcode & QR Scanner": "fa-qrcode" ,
        "SNETCH Assistant": "fa-brain"
    };

    // ==========================================
    // 2. RENDER FEATURE CARDS
    // ==========================================
    function renderFeatureCards() {
        const grid = document.getElementById('featureGrid');
        if (!grid) return;

        // Clear existing (if any)
        grid.innerHTML = '';

        features.forEach(name => {
            const icon = iconMap[name] || 'fa-cube';
            const card = document.createElement('div');
            card.className = 'feature-card';
            card.setAttribute('data-feature', name);
            card.innerHTML = `<i class="fas ${icon}"></i><span>${name}</span>`;

            // Click handler with haptic-like feedback
            card.addEventListener('click', function(e) {
                // Ripple effect
                const ripple = document.createElement('span');
                ripple.style.cssText = `
                    position: absolute;
                    border-radius: 50%;
                    background: rgba(180, 140, 255, 0.3);
                    width: 20px;
                    height: 20px;
                    left: ${e.offsetX - 10}px;
                    top: ${e.offsetY - 10}px;
                    pointer-events: none;
                    animation: rippleAnim 0.6s ease-out forwards;
                `;
                this.style.position = 'relative';
                this.style.overflow = 'hidden';
                this.appendChild(ripple);
                setTimeout(() => ripple.remove(), 600);

                // Trigger module action
                triggerFeature(name);
            });

            grid.appendChild(card);
        });
    }

    // ==========================================
    // 3. FEATURE TRIGGER (module placeholder)
    // ==========================================
    function triggerFeature(featureName) {
        const route = routeMap[featureName];
        if (!route) {
            console.warn(`[S.N.E.T.C.H] No route mapped for: ${featureName}`);
            showNotification(`⚠️ "${featureName}" isn't wired up yet.`, 'info');
            return;
        }

        console.log(`[S.N.E.T.C.H] Launching: ${featureName} -> ${route}`);
        showNotification(`🚀 Launching ${featureName}...`, 'info');

        // Give the ripple/toast a beat to play, then open that feature's
        // own page (its own HTML, which pulls in its own CSS/JS/backend).
        setTimeout(() => {
            window.location.href = route;
        }, 220);
    }

    // ==========================================
    // 4. NOTIFICATION SYSTEM (toast)
    // ==========================================
    function showNotification(message, type = 'info') {
        // Remove existing notifications
        const existing = document.querySelector('.snetch-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'snetch-toast';
        toast.style.cssText = `
            position: fixed;
            bottom: 30px;
            right: 30px;
            background: rgba(25, 15, 50, 0.85);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(180, 140, 255, 0.2);
            border-radius: 16px;
            padding: 14px 24px;
            color: #eae6ff;
            font-weight: 500;
            font-size: 0.95rem;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
            z-index: 9999;
            display: flex;
            align-items: center;
            gap: 12px;
            animation: toastIn 0.4s ease;
            max-width: 400px;
            pointer-events: none;
        `;

        const icon = document.createElement('i');
        icon.className = `fas ${type === 'info' ? 'fa-info-circle' : 'fa-bolt'}`;
        icon.style.color = '#b68aff';
        icon.style.fontSize = '1.2rem';
        toast.appendChild(icon);

        const text = document.createElement('span');
        text.textContent = message;
        toast.appendChild(text);

        document.body.appendChild(toast);

        // Auto dismiss
        setTimeout(() => {
            toast.style.animation = 'toastOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 350);
        }, 2800);
    }

    // Inject toast animations
    const styleSheet = document.createElement('style');
    styleSheet.textContent = `
        @keyframes toastIn {
            0% { opacity: 0; transform: translateY(20px) scale(0.95); }
            100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes toastOut {
            0% { opacity: 1; transform: translateY(0) scale(1); }
            100% { opacity: 0; transform: translateY(20px) scale(0.95); }
        }
        @keyframes rippleAnim {
            0% { transform: scale(0); opacity: 0.6; }
            100% { transform: scale(8); opacity: 0; }
        }
    `;
    document.head.appendChild(styleSheet);

    // ==========================================
    // 5. NAVIGATION (sidebar routing)
    // ==========================================
    function initNavigation() {
        const navItems = document.querySelectorAll('.nav-item');
        const pages = {
            home: document.getElementById('page-home'),
            settings: document.getElementById('page-settings'),
            profile: document.getElementById('page-profile')
        };

        // Get current page from URL hash or default to home
        function getCurrentPage() {
            const hash = window.location.hash.replace('#', '');
            return ['home', 'settings', 'profile'].includes(hash) ? hash : 'home';
        }

        function switchPage(pageId) {
            // Hide all pages
            Object.keys(pages).forEach(key => {
                if (pages[key]) pages[key].classList.remove('active-page');
            });

            // Show target
            if (pages[pageId]) {
                pages[pageId].classList.add('active-page');
            }

            // Update nav active state
            navItems.forEach(item => {
                item.classList.remove('active');
                if (item.dataset.page === pageId) {
                    item.classList.add('active');
                }
            });

            // Update URL hash without scrolling
            if (history.pushState) {
                history.pushState(null, '', `#${pageId}`);
            }
        }

        // Nav item click
        navItems.forEach(item => {
            item.addEventListener('click', function(e) {
                const page = this.dataset.page;
                if (page) {
                    switchPage(page);
                    // Close mobile menu if needed (optional)
                }
            });
        });

        // Handle back/forward browser buttons
        window.addEventListener('popstate', function() {
            const page = getCurrentPage();
            switchPage(page);
        });

        // Initial load - check hash
        const initialPage = getCurrentPage();
        switchPage(initialPage);

        // Expose switchPage globally for debugging
        window.switchPage = switchPage;
    }

    // ==========================================
    // 6. SEARCH FUNCTIONALITY
    // ==========================================
    function initSearch() {
        const searchInput = document.querySelector('.search-wrap input');
        if (!searchInput) return;

        searchInput.addEventListener('input', function(e) {
            const query = this.value.trim().toLowerCase();
            if (query.length === 0) {
                // Reset: show all cards
                document.querySelectorAll('.feature-card').forEach(card => {
                    card.style.display = 'flex';
                });
                return;
            }

            // Filter feature cards
            const cards = document.querySelectorAll('.feature-card');
            let hasResults = false;
            cards.forEach(card => {
                const name = card.querySelector('span')?.textContent?.toLowerCase() || '';
                const match = name.includes(query);
                card.style.display = match ? 'flex' : 'none';
                if (match) hasResults = true;
            });

            // Optional: show "no results" message
            const existingMsg = document.querySelector('.search-no-results');
            if (!hasResults && query.length > 0) {
                if (!existingMsg) {
                    const msg = document.createElement('div');
                    msg.className = 'search-no-results';
                    msg.style.cssText = `
                        grid-column: 1 / -1;
                        text-align: center;
                        padding: 40px 20px;
                        color: #a28bdb;
                        font-size: 1rem;
                        background: rgba(25, 15, 50, 0.3);
                        border-radius: 28px;
                        backdrop-filter: blur(6px);
                        border: 1px dashed rgba(180, 140, 255, 0.15);
                    `;
                    msg.innerHTML = `<i class="fas fa-search" style="font-size: 2rem; display: block; margin-bottom: 12px; color: #7f5cff;"></i> No features found for "<strong>${query}</strong>"`;
                    document.querySelector('.card-grid').appendChild(msg);
                } else {
                    existingMsg.innerHTML = `<i class="fas fa-search" style="font-size: 2rem; display: block; margin-bottom: 12px; color: #7f5cff;"></i> No features found for "<strong>${query}</strong>"`;
                }
            } else {
                if (existingMsg) existingMsg.remove();
            }
        });

        // Clear on escape
        searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                this.value = '';
                this.dispatchEvent(new Event('input'));
                this.blur();
            }
        });

        // Focus animation: add class on focus
        searchInput.addEventListener('focus', function() {
            this.closest('.search-wrap')?.classList.add('search-focused');
        });
        searchInput.addEventListener('blur', function() {
            this.closest('.search-wrap')?.classList.remove('search-focused');
        });
    }

    // ==========================================
    // 7. USER PROFILE DROPDOWN (demo)
    // ==========================================
    function initProfileDropdown() {
        const profile = document.querySelector('.user-profile');
        if (!profile) return;

        profile.addEventListener('click', function(e) {
            e.stopPropagation();
            let dropdown = document.getElementById('user-dropdown');
            if (dropdown) {
                dropdown.remove();
                return;
            }
            dropdown = document.createElement('div');
            dropdown.id = 'user-dropdown';
            dropdown.style.cssText = `
                position: absolute;
                top: 100%;
                right: 0;
                margin-top: 10px;
                background: rgba(25, 15, 50, 0.95);
                backdrop-filter: blur(10px);
                border: 1px solid rgba(180, 140, 255, 0.2);
                border-radius: 12px;
                padding: 8px 0;
                min-width: 150px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                z-index: 1000;
                display: flex;
                flex-direction: column;
            `;
            
            const btnStyle = `
                padding: 10px 20px;
                color: #eae6ff;
                text-align: left;
                background: transparent;
                border: none;
                cursor: pointer;
                font-family: inherit;
                font-size: 0.9rem;
                display: flex;
                align-items: center;
                gap: 10px;
                transition: background 0.2s;
            `;

            const btnProfile = document.createElement('button');
            btnProfile.innerHTML = '<i class="fas fa-user"></i> Profile';
            btnProfile.style.cssText = btnStyle;
            btnProfile.onmouseover = () => btnProfile.style.background = 'rgba(180, 140, 255, 0.1)';
            btnProfile.onmouseout = () => btnProfile.style.background = 'transparent';
            btnProfile.onclick = () => {
                dropdown.remove();
                if (window.switchPage) window.switchPage('profile');
            };

            const btnLogout = document.createElement('button');
            btnLogout.innerHTML = '<i class="fas fa-sign-out-alt"></i> Logout';
            btnLogout.style.cssText = btnStyle + 'color: #ff6b6b;';
            btnLogout.onmouseover = () => btnLogout.style.background = 'rgba(255, 107, 107, 0.1)';
            btnLogout.onmouseout = () => btnLogout.style.background = 'transparent';
            btnLogout.onclick = () => {
                dropdown.remove();
                if (typeof snetchLogout === 'function') snetchLogout();
            };

            dropdown.appendChild(btnProfile);
            dropdown.appendChild(btnLogout);
            
            profile.style.position = 'relative';
            profile.appendChild(dropdown);
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', function(e) {
            const dropdown = document.getElementById('user-dropdown');
            if (dropdown && !profile.contains(e.target)) {
                dropdown.remove();
            }
        });
    }

    // ==========================================
    // 8. PREMIUM UPGRADE BUTTON
    // ==========================================
    function initPremiumButton() {
        const upgradeBtn = document.querySelector('.upgrade-btn');
        if (upgradeBtn) {
            upgradeBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                showNotification('✨ Premium upgrade portal (coming soon)', 'info');
            });
        }
    }

    // ==========================================
    // 8b. CUSTOM UI MODALS
    // ==========================================
    function showCustomModal({ title, inputType = null, inputValue = '', placeholder = '', confirmText = 'OK', cancelText = 'Cancel', isConfirm = false }) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'snetch-modal-overlay';
            overlay.style.cssText = `
                position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                background: rgba(10, 5, 25, 0.7); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
                z-index: 10000; display: flex; align-items: center; justify-content: center;
                opacity: 0; transition: opacity 0.3s ease;
            `;

            const modal = document.createElement('div');
            modal.className = 'snetch-modal';
            modal.style.cssText = `
                background: linear-gradient(145deg, #1f143c, #160c2b);
                border: 1px solid rgba(180, 140, 255, 0.3);
                border-radius: 20px; padding: 24px; width: 90%; max-width: 400px;
                box-shadow: 0 15px 40px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255,255,255,0.1);
                transform: translateY(20px) scale(0.95); transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
                color: #eae6ff; font-family: 'Inter', sans-serif;
            `;

            const titleEl = document.createElement('h3');
            titleEl.textContent = title;
            titleEl.style.cssText = `margin: 0 0 16px 0; font-size: 1.1rem; font-weight: 500; color: #d4c6ff;`;
            modal.appendChild(titleEl);

            let inputEl = null;
            if (inputType) {
                inputEl = document.createElement('input');
                inputEl.type = inputType;
                inputEl.value = inputValue;
                inputEl.placeholder = placeholder;
                inputEl.style.cssText = `
                    width: 100%; padding: 12px 16px; margin-bottom: 24px;
                    background: rgba(10, 5, 20, 0.6); border: 1px solid rgba(180, 140, 255, 0.2);
                    border-radius: 12px; color: #fff; font-size: 1rem; outline: none;
                    box-sizing: border-box; transition: border-color 0.2s;
                `;
                inputEl.onfocus = () => inputEl.style.borderColor = '#b68aff';
                inputEl.onblur = () => inputEl.style.borderColor = 'rgba(180, 140, 255, 0.2)';
                modal.appendChild(inputEl);
            } else {
                modal.style.paddingBottom = '20px';
            }

            const btnContainer = document.createElement('div');
            btnContainer.style.cssText = `display: flex; justify-content: flex-end; gap: 12px; ${inputType ? '' : 'margin-top: 24px;'}`;

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = cancelText;
            cancelBtn.style.cssText = `
                padding: 10px 20px; background: transparent; border: 1px solid rgba(180, 140, 255, 0.3);
                border-radius: 10px; color: #d4c6ff; font-size: 0.95rem; cursor: pointer;
                transition: all 0.2s; font-family: inherit; font-weight: 500;
            `;
            cancelBtn.onmouseover = () => { cancelBtn.style.background = 'rgba(180, 140, 255, 0.1)'; };
            cancelBtn.onmouseout = () => { cancelBtn.style.background = 'transparent'; };

            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = confirmText;
            confirmBtn.style.cssText = `
                padding: 10px 20px; background: linear-gradient(135deg, #8a5cff, #6431ff);
                border: none; border-radius: 10px; color: #fff; font-size: 0.95rem; cursor: pointer;
                transition: all 0.2s; font-family: inherit; font-weight: 500;
                box-shadow: 0 4px 15px rgba(100, 49, 255, 0.4);
            `;
            confirmBtn.onmouseover = () => { confirmBtn.style.transform = 'translateY(-1px)'; confirmBtn.style.boxShadow = '0 6px 20px rgba(100, 49, 255, 0.5)'; };
            confirmBtn.onmouseout = () => { confirmBtn.style.transform = 'translateY(0)'; confirmBtn.style.boxShadow = '0 4px 15px rgba(100, 49, 255, 0.4)'; };

            btnContainer.appendChild(cancelBtn);
            btnContainer.appendChild(confirmBtn);
            modal.appendChild(btnContainer);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            // Animate in
            requestAnimationFrame(() => {
                overlay.style.opacity = '1';
                modal.style.transform = 'translateY(0) scale(1)';
            });

            if (inputEl) {
                setTimeout(() => inputEl.focus(), 100);
            }

            const close = (value) => {
                overlay.style.opacity = '0';
                modal.style.transform = 'translateY(20px) scale(0.95)';
                setTimeout(() => {
                    overlay.remove();
                    resolve(value);
                }, 300);
            };

            cancelBtn.onclick = () => close(null);
            confirmBtn.onclick = () => {
                if (isConfirm) close(true);
                else close(inputEl ? inputEl.value : true);
            };

            if (inputEl) {
                inputEl.onkeydown = (e) => {
                    if (e.key === 'Enter') confirmBtn.click();
                    if (e.key === 'Escape') cancelBtn.click();
                };
            }
        });
    }

    const customPrompt = (title, defaultValue = '') => {
        return showCustomModal({ title, inputType: 'text', inputValue: defaultValue, confirmText: 'OK' });
    };

    const customPasswordPrompt = (title) => {
        return showCustomModal({ title, inputType: 'password', confirmText: 'Next' });
    };

    const customConfirm = (title) => {
        return showCustomModal({ title, isConfirm: true, confirmText: 'Yes', cancelText: 'No' });
    };

    // ==========================================
    // 9. SETTINGS & PROFILE INTERACTIONS
    // ==========================================
    function initSettingsInteractions() {
        // Settings items click - show demo
        document.querySelectorAll('.settings-item').forEach(item => {
            item.addEventListener('click', function() {
                const label = this.querySelector('span:first-child')?.textContent || 'Setting';
                showNotification(`⚙️ ${label} — settings panel (demo)`, 'info');
            });
        });

        // ── Profile action buttons (real implementations) ──

        // EDIT PROFILE
        const btnEdit = document.getElementById('btn-edit-profile');
        if (btnEdit) {
            btnEdit.addEventListener('click', async function() {
                const currentName = document.getElementById('profile-name')?.textContent || '';
                const newName = await customPrompt('Enter new display name:', currentName);
                if (!newName || newName.trim().length < 2) {
                    if (newName !== null) showNotification('⚠️ Name must be at least 2 characters.', 'info');
                    return;
                }
                fetch('/api/user/profile', {
                    method: 'PUT',
                    headers: authHeaders(),
                    body: JSON.stringify({ username: newName.trim() }),
                }).then(r => r.json()).then(d => {
                    if (d.status === 'ok') {
                        showNotification('✅ Profile updated!', 'info');
                        // Refresh stored user
                        const u = JSON.parse(localStorage.getItem('snetch_user') || '{}');
                        u.username = d.username || newName.trim();
                        localStorage.setItem('snetch_user', JSON.stringify(u));
                        populateUserUI(u);
                        loadProfile();
                        loadSettings();
                    } else {
                        showNotification('❌ ' + (d.error || 'Update failed'), 'info');
                    }
                }).catch(() => showNotification('❌ Network error', 'info'));
            });
        }

        // CHANGE PASSWORD
        const btnPwd = document.getElementById('btn-change-password');
        if (btnPwd) {
            btnPwd.addEventListener('click', async function() {
                const current = await customPasswordPrompt('Enter your CURRENT password:');
                if (!current) return;
                const newPass = await customPasswordPrompt('Enter your NEW password (min 6 chars):');
                if (!newPass || newPass.length < 6) {
                    if (newPass !== null) showNotification('⚠️ Password must be at least 6 characters.', 'info');
                    return;
                }
                fetch('/api/user/password', {
                    method: 'PUT',
                    headers: authHeaders(),
                    body: JSON.stringify({ current_password: current, new_password: newPass }),
                }).then(r => r.json()).then(d => {
                    if (d.status === 'ok') {
                        showNotification('✅ Password changed!', 'info');
                    } else {
                        showNotification('❌ ' + (d.error || 'Password change failed'), 'info');
                    }
                }).catch(() => showNotification('❌ Network error', 'info'));
            });
        }

        // EXPORT DATA
        const btnExport = document.getElementById('btn-export-data');
        if (btnExport) {
            btnExport.addEventListener('click', function() {
                showNotification('📦 Preparing your data export...', 'info');
                const token = localStorage.getItem('snetch_access_token');
                fetch('/api/user/export', { headers: { 'Authorization': 'Bearer ' + token } })
                    .then(r => {
                        if (!r.ok) throw new Error('Export failed');
                        return r.blob();
                    })
                    .then(blob => {
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'snetch_export.json';
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                        showNotification('✅ Data exported!', 'info');
                    })
                    .catch(() => showNotification('❌ Export failed', 'info'));
            });
        }

        // LOGOUT
        const btnLogout = document.getElementById('btn-logout');
        if (btnLogout) {
            btnLogout.addEventListener('click', async function() {
                const sure = await customConfirm('Are you sure you want to logout?');
                if (sure) {
                    showNotification('👋 Logging out...', 'info');
                    setTimeout(snetchLogout, 400);
                }
            });
        }
    }

    // ==========================================
    // 10. UFO ANIMATION ENHANCEMENT (extra)
    // ==========================================
    function enhanceUfoMovement() {
        // Already handled by CSS, but we can add subtle randomness
        const ufos = document.querySelectorAll('.ufo');
        ufos.forEach((ufo, index) => {
            const duration = 20 + (index * 4);
            const delay = index * 3;
            ufo.style.animationDuration = `${duration}s`;
            ufo.style.animationDelay = `${delay}s`;
        });
    }

    // ==========================================
    // 11. INITIALIZATION
    // ==========================================
    function init() {
        // Wait for DOM
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initApp);
        } else {
            initApp();
        }
    }

    function initApp() {
        // Populate UI from cached user data immediately
        try {
            const cached = JSON.parse(localStorage.getItem('snetch_user') || '{}');
            if (cached.username) populateUserUI(cached);
        } catch(e) {}

        renderFeatureCards();
        initNavigation();
        initSearch();
        initProfileDropdown();
        initPremiumButton();
        initSettingsInteractions();
        enhanceUfoMovement();

        // Load real data from API
        loadProfile();
        loadSettings();

        // Log startup
        console.log('🚀 S.N.E.T.C.H OS initialized');
        console.log(`📦 ${features.length} features loaded`);
        console.log('🌌 Space theme active');
    }

    // ==========================================
    // 12. EXPOSE API (for debugging/extension)
    // ==========================================
    window.SNETCH = {
        features: features,
        triggerFeature: triggerFeature,
        showNotification: showNotification,
        switchPage: window.switchPage || function() {},
        version: '2.4.1'
    };

    // Start the application
    init();

})();