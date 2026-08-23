// ============================================================
// askanything.js · S.N.E.T.C.H Ask Anything (AI Chat)
// Fully wired to the backend REST API (/api/askanything/*)
// defined in app.py + askanything.py.
// ============================================================

(function () {
  'use strict';

  // ---------- DOM REFS ----------
  const $ = (sel) => document.querySelector(sel);

  const homeBtn = $('#homeBtn');
  const sidebar = $('#aaSidebar');
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
  const aaWelcome = $('#aaWelcome');
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

  // ---------- STATE ----------
  let currentChatId = null;
  let chatsById = {};          // cache of all known active chats, keyed by id
  let isStreaming = false;
  let dropdownChatId = null;
  let recognition = null;
  let isListening = false;
  let searchDebounceTimer = null;

  // ============================================================
  //  API HELPERS
  // ============================================================
  function authToken() { return localStorage.getItem('snetch_access_token') || ''; }

  async function apiRequest(url, options) {
    let res;
    const opts = options || {};
    opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + authToken() });
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new Error('Network error. Please check your connection.');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status}).`);
    }
    return data;
  }

  // ============================================================
  //  HOME NAVIGATION
  // ============================================================
  homeBtn.addEventListener('click', () => { window.location.href = '/'; });

  // ============================================================
  //  MOBILE SIDEBAR TOGGLE
  // ============================================================
  function openSidebar() {
    sidebar.classList.add('open');
    sidebarBackdrop.classList.add('active');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarBackdrop.classList.remove('active');
  }
  mobileMenuBtn.addEventListener('click', openSidebar);
  sidebarCloseBtn.addEventListener('click', closeSidebar);
  sidebarBackdrop.addEventListener('click', closeSidebar);

  // ============================================================
  //  HELPERS
  // ============================================================
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDateTime(unixSeconds) {
    if (!unixSeconds) return '';
    const d = new Date(unixSeconds * 1000);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return timeStr;
    const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${dateStr} · ${timeStr}`;
  }

  function autoResizeTextarea() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
  }

  // ============================================================
  //  SYNTAX HIGHLIGHTING ENGINE
  //  Lightweight, dependency-free tokenizer used to render
  //  ChatGPT-style colored code blocks for many common languages.
  // ============================================================
  const LANG_ALIASES = {
    py: 'python', python3: 'python',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    'c++': 'cpp', cxx: 'cpp',
    'c#': 'csharp', cs: 'csharp',
    sh: 'bash', shell: 'bash', zsh: 'bash',
    yml: 'yaml',
    md: 'markdown',
    html5: 'html', htm: 'html',
  };

  const LANG_LABELS = {
    python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript',
    java: 'Java', c: 'C', cpp: 'C++', csharp: 'C#', go: 'Go', rust: 'Rust',
    php: 'PHP', swift: 'Swift', kotlin: 'Kotlin', sql: 'SQL', bash: 'Bash',
    json: 'JSON', xml: 'XML', html: 'HTML', css: 'CSS', markdown: 'Markdown',
    yaml: 'YAML', text: 'Plain Text',
  };

  const LANG_ICONS = {
    python: 'fa-brands fa-python', javascript: 'fa-brands fa-js', typescript: 'fa-brands fa-js',
    java: 'fa-brands fa-java', php: 'fa-brands fa-php', swift: 'fa-brands fa-swift',
    html: 'fa-brands fa-html5', css: 'fa-brands fa-css3-alt', rust: 'fa-brands fa-rust',
    bash: 'fa-solid fa-terminal', sql: 'fa-solid fa-database', json: 'fa-solid fa-code',
    default: 'fa-solid fa-code',
  };

  const KEYWORDS = {
    python: ['def','class','if','elif','else','for','while','try','except','finally','with','as','import','from','return','yield','lambda','pass','break','continue','global','nonlocal','del','raise','assert','in','is','not','and','or','async','await'],
    javascript: ['function','var','let','const','if','else','for','while','do','switch','case','default','break','continue','return','try','catch','finally','throw','new','class','extends','super','this','import','export','from','typeof','instanceof','in','of','async','await','yield','static','get','set'],
    typescript: ['function','var','let','const','if','else','for','while','do','switch','case','default','break','continue','return','try','catch','finally','throw','new','class','extends','super','this','import','export','from','typeof','instanceof','in','of','async','await','yield','static','get','set','interface','type','implements','public','private','protected','readonly','enum','namespace','declare','as'],
    java: ['public','private','protected','class','interface','extends','implements','static','void','new','return','if','else','for','while','do','switch','case','default','break','continue','try','catch','finally','throw','throws','import','package','final','abstract','this','super','enum','synchronized'],
    c: ['int','char','float','double','void','if','else','for','while','do','switch','case','default','break','continue','return','struct','typedef','union','enum','const','static','sizeof','goto'],
    cpp: ['int','char','float','double','void','bool','if','else','for','while','do','switch','case','default','break','continue','return','class','struct','public','private','protected','virtual','override','new','delete','namespace','using','template','typename','const','static','this','friend','operator','include'],
    csharp: ['public','private','protected','class','interface','static','void','new','return','if','else','for','foreach','while','do','switch','case','default','break','continue','try','catch','finally','throw','using','namespace','struct','enum','var','readonly','const','abstract','override','virtual','this','base','get','set','async','await'],
    go: ['func','package','import','var','const','type','struct','interface','map','chan','go','defer','select','switch','case','default','if','else','for','range','return','break','continue'],
    rust: ['fn','let','mut','const','struct','enum','impl','trait','pub','use','mod','match','if','else','for','while','loop','return','break','continue','self','Self','async','await','where','move'],
    php: ['function','class','public','private','protected','static','if','else','elseif','foreach','while','for','switch','case','default','break','continue','return','echo','print','require','include','namespace','use','new','extends','implements','interface','try','catch','finally','throw','array'],
    swift: ['func','var','let','if','else','for','while','switch','case','default','class','struct','enum','protocol','extension','import','return','break','continue','guard','defer','self','Self','public','private','internal','static','try','catch','throws'],
    kotlin: ['fun','val','var','if','else','for','while','when','class','object','interface','import','package','return','break','continue','try','catch','finally','this','super','companion','data','is','in','as'],
    sql: ['select','from','where','insert','into','values','update','set','delete','create','table','alter','drop','join','left','right','inner','outer','on','group','by','order','having','as','and','or','not','null','is','in','like','limit','distinct','union','primary','key','foreign','references','default'],
    bash: ['if','then','else','elif','fi','for','while','do','done','case','esac','function','return','export','local','in','break','continue'],
  };

  const CONSTANTS = new Set(['true','false','null','none','nil','undefined','True','False','None','NULL','self','this','super','Self']);
  const BUILTINS = new Set(['print','console','len','str','int','float','list','dict','set','tuple','range','input','open','type','isinstance','super','log','error','warn','info','map','filter','reduce','Math','Object','Array','JSON','Promise','fetch']);

  function detectLanguage(code) {
    const c = code.trim();
    if (/^<\?php/.test(c)) return 'php';
    if (/^\s*(#include\s*<|std::|cout\s*<<|int\s+main\s*\()/.test(c)) return /std::|cout|class\s+\w+\s*{/.test(c) ? 'cpp' : 'c';
    if (/\bpublic\s+class\b|\bSystem\.out\.println\b/.test(c)) return 'java';
    if (/\busing\s+System\b|\bConsole\.Write(Line)?\b|\bnamespace\s+\w+/.test(c)) return 'csharp';
    if (/\bpackage\s+main\b|\bfunc\s+\w+\s*\(/.test(c)) return 'go';
    if (/\bfn\s+\w+\s*\(|\blet\s+mut\b/.test(c)) return 'rust';
    if (/^\s*(def |class .*:|import |from .* import)/m.test(c) && /:\s*$/m.test(c)) return 'python';
    if (/\bfun\s+\w+\s*\(|\bval\s+\w+\s*=/.test(c)) return 'kotlin';
    if (/\bfunc\s+\w+\s*\(.*\)\s*->|\bvar\s+\w+\s*:\s*\w+/.test(c)) return 'swift';
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE)\b/i.test(c)) return 'sql';
    if (/^#!\/bin\/(ba)?sh|\becho\s+["']|\bfi\b\s*$/m.test(c)) return 'bash';
    if (/^\s*<\?xml/.test(c)) return 'xml';
    if (/^\s*<(!DOCTYPE|html|div|span|body|head)\b/i.test(c)) return 'html';
    if (/^\s*[.#]?[\w-]+\s*{[\s\S]*:\s*[\w-]/.test(c) && /;\s*}/.test(c)) return 'css';
    if (/^\s*[{\[]/.test(c) && /^[\s\S]*[}\]]\s*$/.test(c) && !/\bfunction\b|\bconst\b|\bclass\b/.test(c)) return 'json';
    if (/=>|\bconst\s+\w+|\blet\s+\w+|\bfunction\b/.test(c)) return /:\s*(string|number|boolean|any|void)\b|\binterface\b/.test(c) ? 'typescript' : 'javascript';
    return 'text';
  }

  function normalizeLang(lang) {
    const l = (lang || '').toLowerCase().trim();
    return LANG_ALIASES[l] || l;
  }

  function tokenizeGeneric(code, lang) {
    const kwList = KEYWORDS[lang] || [];
    const kwSet = new Set(kwList);
    const commentLine = ['python', 'bash', 'sql'].includes(lang)
      ? (lang === 'sql' ? '--[^\\n]*' : '#[^\\n]*')
      : '//[^\\n]*';
    const commentBlock = ['python', 'bash', 'sql'].includes(lang) ? null : '/\\*[\\s\\S]*?\\*/';
    const stringPat = lang === 'python'
      ? '("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\')'
      : '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)';
    const numberPat = '\\b0x[0-9a-fA-F]+\\b|\\b\\d+\\.\\d+\\b|\\b\\d+\\b';
    const decoratorPat = '@[A-Za-z_]\\w*';

    const parts = [];
    if (commentBlock) parts.push(commentBlock);
    parts.push(commentLine, stringPat, numberPat, decoratorPat);
    const master = new RegExp(parts.join('|'), 'g');

    let out = '';
    let lastIndex = 0;
    let m;
    while ((m = master.exec(code)) !== null) {
      out += tokenizeWords(code.slice(lastIndex, m.index), kwSet, lang);
      const matched = m[0];
      if (matched.startsWith('/*') || matched.startsWith('#') || matched.startsWith('//') || matched.startsWith('--')) {
        out += `<span class="tok-comment">${escapeHtml(matched)}</span>`;
      } else if (matched.startsWith('@')) {
        out += `<span class="tok-decorator">${escapeHtml(matched)}</span>`;
      } else if (/^["'`]/.test(matched)) {
        out += `<span class="tok-string">${escapeHtml(matched)}</span>`;
      } else {
        out += `<span class="tok-number">${escapeHtml(matched)}</span>`;
      }
      lastIndex = master.lastIndex;
    }
    out += tokenizeWords(code.slice(lastIndex), kwSet, lang);
    return out;
  }

  function tokenizeWords(text, kwSet, lang) {
    const wordRe = /([A-Za-z_$][\w$]*)|([{}()\[\];,.:+\-*/%=<>!&|^~?]+)|(\s+)|([^\sA-Za-z_$\w{}()\[\];,.:+\-*/%=<>!&|^~?]+)/g;
    let out = '';
    let m;
    let prevEnd = 0;
    while ((m = wordRe.exec(text)) !== null) {
      const token = m[0];
      if (m[1] !== undefined) {
        const nextChar = text.slice(wordRe.lastIndex, wordRe.lastIndex + 1);
        const isCall = nextChar === '(';
        if (kwSet.has(token)) {
          out += `<span class="tok-keyword">${escapeHtml(token)}</span>`;
        } else if (CONSTANTS.has(token)) {
          out += `<span class="tok-constant">${escapeHtml(token)}</span>`;
        } else if (isCall) {
          out += `<span class="tok-function">${escapeHtml(token)}</span>`;
        } else if (BUILTINS.has(token)) {
          out += `<span class="tok-function">${escapeHtml(token)}</span>`;
        } else if (/^[A-Z]/.test(token) && token.length > 1) {
          out += `<span class="tok-class">${escapeHtml(token)}</span>`;
        } else {
          out += escapeHtml(token);
        }
      } else if (m[2] !== undefined) {
        out += `<span class="tok-operator">${escapeHtml(token)}</span>`;
      } else {
        out += escapeHtml(token);
      }
      prevEnd = wordRe.lastIndex;
    }
    return out;
  }

  function tokenizeHtml(code) {
    return escapeHtml(code)
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-comment">$1</span>')
      .replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, (m0, p1, p2) => `${p1}<span class="tok-tag">${p2}</span>`)
      .replace(/([a-zA-Z-]+)(=)(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g,
        (m0, attr, eq, val) => `<span class="tok-attr">${attr}</span>${eq}<span class="tok-string">${val}</span>`);
  }

  function tokenizeCss(code) {
    return escapeHtml(code)
      .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-comment">$1</span>')
      .replace(/([.#]?[\w-]+(?:\[[^\]]*\])?(?:::?[\w-]+)?)(\s*{)/g,
        (m0, sel, brace) => `<span class="tok-selector">${sel}</span>${brace}`)
      .replace(/([\w-]+)(\s*:\s*)([^;{}]+)(;)/g,
        (m0, prop, colon, val, semi) => `<span class="tok-property">${prop}</span>${colon}<span class="tok-value">${val}</span>${semi}`);
  }

  function tokenizeJson(code) {
    return escapeHtml(code)
      .replace(/(&quot;(?:\\.|[^&"\\])*&quot;)(\s*:)/g, '<span class="tok-key">$1</span>$2')
      .replace(/:(\s*)(&quot;(?:\\.|[^&"\\])*&quot;)/g, ':$1<span class="tok-string">$2</span>')
      .replace(/:(\s*)(true|false|null)\b/g, ':$1<span class="tok-constant">$2</span>')
      .replace(/:(\s*)(-?\d+(?:\.\d+)?)/g, ':$1<span class="tok-number">$2</span>');
  }

  function highlightCode(code, lang) {
    try {
      if (lang === 'html' || lang === 'xml') return tokenizeHtml(code);
      if (lang === 'css') return tokenizeCss(code);
      if (lang === 'json') return tokenizeJson(code);
      if (lang === 'markdown' || lang === 'text' || !KEYWORDS[lang]) return escapeHtml(code);
      return tokenizeGeneric(code, lang);
    } catch (e) {
      return escapeHtml(code);
    }
  }

  // ============================================================
  //  MINIMAL MARKDOWN RENDERER
  //  Supports: headers, bold/italic, inline code, fenced code
  //  blocks (with copy button, language badge & syntax
  //  highlighting), bullet/numbered lists, tables, blockquotes,
  //  hyperlinks, paragraphs & line breaks.
  // ============================================================
  function renderMarkdown(raw) {
    if (!raw) return '';

    const codeBlocks = [];
    // Extract fenced code blocks first so their contents are never
    // touched by the other (line-based) markdown rules below.
    let text = raw.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: (lang || 'text').trim(), code: code.replace(/\n$/, '') });
      return `\u0000CODEBLOCK${idx}\u0000`;
    });

    text = escapeHtml(text);

    // Inline code
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold / italic
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    // Hyperlinks: [label](url)
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    const lines = text.split('\n');
    const htmlParts = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Headers
      const headerMatch = line.match(/^(#{1,3})\s+(.*)$/);
      if (headerMatch) {
        const level = headerMatch[1].length + 3; // h4-h6, keeps bubble text sane-sized
        htmlParts.push(`<h${level}>${headerMatch[2]}</h${level}>`);
        i++;
        continue;
      }

      // Tables (pipe-delimited, with a --- separator row)
      if (/^\s*\|.*\|\s*$/.test(line) && lines[i + 1] && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        const headerCells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        let j = i + 2;
        const rows = [];
        while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
          rows.push(lines[j].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
          j++;
        }
        let table = '<table><thead><tr>' +
          headerCells.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
        rows.forEach(r => {
          table += '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>';
        });
        table += '</tbody></table>';
        htmlParts.push(table);
        i = j;
        continue;
      }

      // Unordered lists
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(`<li>${lines[i].replace(/^\s*[-*]\s+/, '')}</li>`);
          i++;
        }
        htmlParts.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      // Ordered lists
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${lines[i].replace(/^\s*\d+\.\s+/, '')}</li>`);
          i++;
        }
        htmlParts.push(`<ol>${items.join('')}</ol>`);
        continue;
      }

      // Code block placeholder (own line)
      const codePlaceholder = line.match(/^\u0000CODEBLOCK(\d+)\u0000$/);
      if (codePlaceholder) {
        const block = codeBlocks[Number(codePlaceholder[1])];
        const lang = normalizeLang(block.lang) && block.lang && KEYWORDS[normalizeLang(block.lang)]
          ? normalizeLang(block.lang)
          : (block.lang && ['html','xml','css','json'].includes(normalizeLang(block.lang))
              ? normalizeLang(block.lang)
              : detectLanguage(block.code));
        const label = LANG_LABELS[lang] || (block.lang ? block.lang : 'Plain Text');
        const iconClass = LANG_ICONS[lang] || LANG_ICONS.default;
        const highlighted = highlightCode(block.code, lang);
        const codeLines = highlighted.split('\n');
        const linesHtml = codeLines
          .map(l => `<li><span class="aa-code-line-content">${l || ' '}</span></li>`)
          .join('');
        htmlParts.push(
          `<div class="aa-code-block">` +
            `<div class="aa-code-block-header">` +
              `<span class="aa-code-lang"><i class="${iconClass}"></i>${escapeHtml(label)}</span>` +
              `<button type="button" class="aa-code-copy-btn" data-code="${encodeURIComponent(block.code)}">` +
              `<i class="fas fa-copy"></i><span class="aa-copy-label">Copy code</span></button>` +
            `</div>` +
            `<div class="aa-code-block-body"><ol class="aa-code-lines">${linesHtml}</ol></div>` +
          `</div>`
        );
        i++;
        continue;
      }

      // Blockquotes
      if (/^\s*&gt;\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*&gt;\s?/, ''));
          i++;
        }
        htmlParts.push(`<blockquote><p>${quoteLines.join('<br>')}</p></blockquote>`);
        continue;
      }

      // Blank line -> paragraph break
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Plain paragraph line (collect consecutive non-empty plain lines)
      const para = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^#{1,3}\s+/.test(lines[i]) &&
        !/^\u0000CODEBLOCK\d+\u0000$/.test(lines[i]) &&
        !/^\s*&gt;\s?/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      htmlParts.push(`<p>${para.join('<br>')}</p>`);
    }

    return htmlParts.join('');
  }

  // ============================================================
  //  CHAT LIST (SIDEBAR)
  // ============================================================
  function buildChatItem(chat) {
    const li = document.createElement('li');
    li.className = 'aa-chat-item' + (chat.id === currentChatId ? ' active' : '');
    li.dataset.chatId = chat.id;

    const main = document.createElement('div');
    main.className = 'aa-chat-item-main';
    const title = document.createElement('div');
    title.className = 'aa-chat-item-title';
    title.textContent = chat.title;
    const date = document.createElement('div');
    date.className = 'aa-chat-item-date';
    date.textContent = formatDateTime(chat.updated_at);
    main.appendChild(title);
    main.appendChild(date);

    if (chat.pinned) {
      const pin = document.createElement('i');
      pin.className = 'fas fa-thumbtack aa-chat-item-pin-icon';
      li.appendChild(pin);
    }

    const menuBtn = document.createElement('button');
    menuBtn.className = 'aa-chat-item-menu';
    menuBtn.title = 'More';
    menuBtn.innerHTML = '<i class="fas fa-ellipsis-vertical"></i>';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDropdown(menuBtn, chat);
    });

    li.appendChild(main);
    li.appendChild(menuBtn);
    li.addEventListener('click', () => {
      selectChat(chat.id);
      if (window.innerWidth <= 1024) closeSidebar();
    });

    return li;
  }

  function renderChatLists(chats) {
    chatsById = {};
    pinnedList.innerHTML = '';
    recentList.innerHTML = '';

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
      const url = query
        ? `/api/askanything/chats?q=${encodeURIComponent(query)}`
        : '/api/askanything/chats';
      const data = await apiRequest(url);
      renderChatLists(data.chats || []);
    } catch (e) {
      console.error('[ASKANYTHING] loadChats failed', e);
    }
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
    aaWelcome.classList.remove('hidden');
    chatTitleDisplay.textContent = 'S.N.E.T.C.H Assistant';
    currentChatId = null;
    highlightActiveChat(null);
  }

  function highlightActiveChat(chatId) {
    document.querySelectorAll('.aa-chat-item').forEach(li => {
      li.classList.toggle('active', li.dataset.chatId === chatId);
    });
  }

  function buildMessageEl(msg, isLast) {
    const wrapper = document.createElement('div');
    wrapper.className = 'aa-msg ' + (msg.role === 'user' ? 'aa-msg-user' : 'aa-msg-ai');

    if (msg.role !== 'user') {
      const avatar = document.createElement('div');
      avatar.className = 'aa-msg-avatar';
      avatar.innerHTML = '<i class="fas fa-atom"></i>';
      wrapper.appendChild(avatar);
    }

    const content = document.createElement('div');
    content.className = 'aa-msg-content';

    const bubble = document.createElement('div');
    bubble.className = 'aa-msg-bubble';
    bubble.innerHTML = msg.role === 'user' ? escapeHtml(msg.content) : renderMarkdown(msg.content);
    content.appendChild(bubble);

    if (msg.role !== 'user') {
      const actions = document.createElement('div');
      actions.className = 'aa-msg-actions';
      actions.innerHTML = `
        <button type="button" data-action="copy" title="Copy"><i class="fas fa-copy"></i></button>
        <button type="button" data-action="like" title="Like"><i class="fas fa-thumbs-up"></i></button>
        <button type="button" data-action="dislike" title="Dislike"><i class="fas fa-thumbs-down"></i></button>
        ${isLast ? '<button type="button" data-action="regenerate" title="Regenerate"><i class="fas fa-rotate-right"></i></button>' : ''}
      `;
      content.appendChild(actions);
      wireMessageActions(actions, bubble);
    }

    const time = document.createElement('div');
    time.className = 'aa-msg-time';
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
          const text = bubbleEl.innerText;
          navigator.clipboard?.writeText(text).catch(() => {});
          btn.innerHTML = '<i class="fas fa-check"></i>';
          setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1200);
        } else if (action === 'like') {
          btn.classList.toggle('active');
          const dislikeBtn = actionsEl.querySelector('[data-action="dislike"]');
          if (btn.classList.contains('active')) dislikeBtn.classList.remove('active');
        } else if (action === 'dislike') {
          btn.classList.toggle('active');
          const likeBtn = actionsEl.querySelector('[data-action="like"]');
          if (btn.classList.contains('active')) likeBtn.classList.remove('active');
        } else if (action === 'regenerate') {
          regenerateLastReply();
        }
      });
    });
  }

  function renderMessages(messages) {
    messagesContainer.innerHTML = '';
    const lastAiIndex = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'user') return i;
      }
      return -1;
    })();
    messages.forEach((m, idx) => {
      messagesContainer.appendChild(buildMessageEl(m, idx === lastAiIndex));
    });
    aaWelcome.classList.toggle('hidden', messages.length > 0);
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { chatScroll.scrollTop = chatScroll.scrollHeight; });
  }

  // True when the user is already at (or very near) the bottom of the
  // chat, so it's safe to auto-scroll as new streamed content arrives.
  // If they've deliberately scrolled up to read earlier messages while
  // a response is streaming, we leave their scroll position alone.
  function isNearBottom(threshold = 100) {
    return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < threshold;
  }

  // ============================================================
  //  CODE BLOCK — COPY BUTTON (event delegation so it works for
  //  both already-rendered messages and content streamed in live)
  // ============================================================
  chatScroll.addEventListener('click', (e) => {
    const btn = e.target.closest('.aa-code-copy-btn');
    if (!btn) return;
    const code = decodeURIComponent(btn.dataset.code || '');
    const restoreLabel = () => {
      btn.classList.remove('copied');
      btn.innerHTML = '<i class="fas fa-copy"></i><span class="aa-copy-label">Copy code</span>';
    };
    const showCopied = () => {
      btn.classList.add('copied');
      btn.innerHTML = '<i class="fas fa-check"></i><span class="aa-copy-label">Copied!</span>';
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(restoreLabel, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(showCopied).catch(() => {
        fallbackCopy(code);
        showCopied();
      });
    } else {
      fallbackCopy(code);
      showCopied();
    }
  });

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* no-op */ }
    document.body.removeChild(ta);
  }

  async function selectChat(chatId) {
    try {
      const data = await apiRequest(`/api/askanything/chats/${chatId}`);
      currentChatId = chatId;
      chatTitleDisplay.textContent = data.chat.title;
      renderMessages(data.chat.messages || []);
      highlightActiveChat(chatId);
    } catch (e) {
      console.error('[ASKANYTHING] selectChat failed', e);
    }
  }

  // ============================================================
  //  NEW CHAT
  // ============================================================
  async function createNewChat() {
    try {
      const data = await apiRequest('/api/askanything/chats', { method: 'POST' });
      await loadChats(searchInput.value.trim() || undefined);
      currentChatId = data.chat.id;
      chatTitleDisplay.textContent = data.chat.title;
      renderMessages([]);
      highlightActiveChat(data.chat.id);
      chatInput.focus();
    } catch (e) {
      console.error('[ASKANYTHING] createNewChat failed', e);
    }
  }
  newChatBtn.addEventListener('click', createNewChat);

  // ============================================================
  //  SENDING MESSAGES (STREAMING)
  // ============================================================
  let currentAbortController = null;

  function setStreaming(streaming) {
    isStreaming = streaming;
    chatInput.disabled = streaming;
    sendBtn.disabled = false; // stays clickable so it can act as the Stop button
    sendBtn.classList.toggle('stop-mode', streaming);
    sendBtn.title = streaming ? 'Stop generating' : 'Send';
    sendBtn.innerHTML = streaming
      ? '<i class="fas fa-stop"></i>'
      : '<i class="fas fa-paper-plane"></i>';
  }

  function showTypingIndicator(bubbleEl) {
    const dots = document.createElement('div');
    dots.className = 'aa-typing-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    bubbleEl.innerHTML = '';
    bubbleEl.appendChild(dots);
    return dots;
  }

  async function streamIntoBubble(response, bubbleEl, typingDots) {
    if (!response.body || !response.body.getReader) {
      // Fallback for browsers without ReadableStream support.
      const text = await response.text();
      bubbleEl.innerHTML = renderMarkdown(text);
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let accumulated = '';
    let firstChunk = true;
    const cursor = document.createElement('span');
    cursor.className = 'aa-typing-cursor';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const piece = decoder.decode(value, { stream: true });
        if (!piece) continue;
        const shouldStick = isNearBottom();
        if (firstChunk) {
          typingDots?.remove();
          bubbleEl.innerHTML = '';
          firstChunk = false;
        }
        accumulated += piece;
        bubbleEl.innerHTML = renderMarkdown(accumulated);
        bubbleEl.appendChild(cursor);
        if (shouldStick) scrollToBottom();
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        // User pressed Stop — keep whatever streamed in so far.
        cursor.remove();
        bubbleEl.innerHTML = renderMarkdown(accumulated) + '<div class="aa-stopped-note">Stopped generating</div>';
        return accumulated;
      }
      throw e;
    }
    cursor.remove();
    bubbleEl.innerHTML = renderMarkdown(accumulated) || bubbleEl.innerHTML;
    return accumulated;
  }

  async function sendMessage() {
    if (isStreaming) {
      currentAbortController?.abort();
      return;
    }
    const text = chatInput.value.trim();
    if (!text) return;

    if (!currentChatId) {
      try {
        const data = await apiRequest('/api/askanything/chats', { method: 'POST' });
        currentChatId = data.chat.id;
      } catch (e) {
        console.error('[ASKANYTHING] auto-create chat failed', e);
        return;
      }
    }

    chatInput.value = '';
    autoResizeTextarea();

    aaWelcome.classList.add('hidden');
    const userMsg = { role: 'user', content: text, created_at: Math.floor(Date.now() / 1000) };
    messagesContainer.appendChild(buildMessageEl(userMsg, false));
    scrollToBottom();

    // Remove the regenerate button from the previous last AI message
    // (only the newest reply should offer regenerate).
    messagesContainer.querySelectorAll('[data-action="regenerate"]').forEach(b => b.remove());

    const aiMsgShell = { role: 'assistant', content: '', created_at: Math.floor(Date.now() / 1000) };
    const aiEl = buildMessageEl(aiMsgShell, true);
    const bubbleEl = aiEl.querySelector('.aa-msg-bubble');
    messagesContainer.appendChild(aiEl);
    const typingDots = showTypingIndicator(bubbleEl);
    scrollToBottom();

    currentAbortController = new AbortController();
    setStreaming(true);
    try {
      const res = await fetch(`/api/askanything/chats/${currentChatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken() },
        body: JSON.stringify({ message: text }),
        signal: currentAbortController.signal,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        typingDots.remove();
        bubbleEl.innerHTML = renderMarkdown(errData.error || 'Something went wrong. Please try again.');
      } else {
        await streamIntoBubble(res, bubbleEl, typingDots);
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        bubbleEl.innerHTML = (bubbleEl.innerHTML && !bubbleEl.querySelector('.aa-typing-dots'))
          ? bubbleEl.innerHTML
          : '<div class="aa-stopped-note">Stopped generating</div>';
      } else {
        typingDots.remove();
        bubbleEl.innerHTML = renderMarkdown('⚠️ Network error. Please try again.');
      }
    } finally {
      currentAbortController = null;
      setStreaming(false);
      loadChats(searchInput.value.trim() || undefined);
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  chatInput.addEventListener('input', autoResizeTextarea);

  // ============================================================
  //  REGENERATE
  // ============================================================
  async function regenerateLastReply() {
    if (!currentChatId || isStreaming) return;
    const aiMessages = messagesContainer.querySelectorAll('.aa-msg-ai');
    const lastAiEl = aiMessages[aiMessages.length - 1];
    if (!lastAiEl) return;
    const bubbleEl = lastAiEl.querySelector('.aa-msg-bubble');
    const typingDots = showTypingIndicator(bubbleEl);

    currentAbortController = new AbortController();
    setStreaming(true);
    try {
      const res = await fetch(`/api/askanything/chats/${currentChatId}/regenerate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + authToken() },
        signal: currentAbortController.signal,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        typingDots.remove();
        bubbleEl.innerHTML = renderMarkdown(errData.error || 'Something went wrong. Please try again.');
      } else {
        await streamIntoBubble(res, bubbleEl, typingDots);
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        bubbleEl.innerHTML = (bubbleEl.innerHTML && !bubbleEl.querySelector('.aa-typing-dots'))
          ? bubbleEl.innerHTML
          : '<div class="aa-stopped-note">Stopped generating</div>';
      } else {
        typingDots.remove();
        bubbleEl.innerHTML = renderMarkdown('⚠️ Network error. Please try again.');
      }
    } finally {
      currentAbortController = null;
      setStreaming(false);
      loadChats(searchInput.value.trim() || undefined);
    }
  }

  // ============================================================
  //  THREE-DOT DROPDOWN MENU
  // ============================================================
  function openDropdown(anchorEl, chat) {
    dropdownChatId = chat.id;
    const pinLabel = chatDropdown.querySelector('.aa-pin-label');
    const archiveLabel = chatDropdown.querySelector('.aa-archive-label');
    pinLabel.textContent = chat.pinned ? 'Unpin Chat' : 'Pin Chat';
    archiveLabel.textContent = chat.archived ? 'Restore Chat' : 'Archive Chat';

    const rect = anchorEl.getBoundingClientRect();
    chatDropdown.style.top = Math.min(rect.bottom + 6, window.innerHeight - 220) + 'px';
    chatDropdown.style.left = Math.min(rect.left, window.innerWidth - 210) + 'px';
    chatDropdown.classList.add('active');
  }

  function closeDropdown() {
    chatDropdown.classList.remove('active');
    dropdownChatId = null;
  }

  document.addEventListener('click', (e) => {
    if (!chatDropdown.contains(e.target)) closeDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDropdown(); closeAllModals(); }
  });

  chatDropdown.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || !dropdownChatId) return;
    const chatId = dropdownChatId;
    const action = btn.dataset.action;
    closeDropdown();

    if (action === 'download') {
      window.location.href = `/api/askanything/chats/${chatId}/download`;
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
      await apiRequest(`/api/askanything/chats/${chatId}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      });
      loadChats(searchInput.value.trim() || undefined);
    } catch (e) {
      console.error('[ASKANYTHING] togglePin failed', e);
    }
  }

  async function toggleArchive(chatId, archived) {
    try {
      await apiRequest(`/api/askanything/chats/${chatId}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      });
      if (archived && chatId === currentChatId) clearChatPanel();
      loadChats(searchInput.value.trim() || undefined);
      if (archiveModal.classList.contains('active')) loadArchivedChats();
    } catch (e) {
      console.error('[ASKANYTHING] toggleArchive failed', e);
    }
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
  function closeRenameModal() {
    renameModal.classList.remove('active');
    renameTargetId = null;
  }
  renameCancelBtn.addEventListener('click', closeRenameModal);
  renameSaveBtn.addEventListener('click', async () => {
    const title = renameInput.value.trim();
    if (!title || !renameTargetId) return closeRenameModal();
    try {
      await apiRequest(`/api/askanything/chats/${renameTargetId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (renameTargetId === currentChatId) chatTitleDisplay.textContent = title;
      loadChats(searchInput.value.trim() || undefined);
    } catch (e) {
      console.error('[ASKANYTHING] rename failed', e);
    } finally {
      closeRenameModal();
    }
  });
  renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') renameSaveBtn.click();
  });

  // ============================================================
  //  DELETE MODAL
  // ============================================================
  let deleteTargetId = null;
  function openDeleteModal(chatId) {
    deleteTargetId = chatId;
    deleteModal.classList.add('active');
  }
  function closeDeleteModal() {
    deleteModal.classList.remove('active');
    deleteTargetId = null;
  }
  deleteCancelBtn.addEventListener('click', closeDeleteModal);
  deleteConfirmBtn.addEventListener('click', async () => {
    if (!deleteTargetId) return closeDeleteModal();
    const id = deleteTargetId;
    try {
      await apiRequest(`/api/askanything/chats/${id}`, { method: 'DELETE' });
      if (id === currentChatId) clearChatPanel();
      loadChats(searchInput.value.trim() || undefined);
      if (archiveModal.classList.contains('active')) loadArchivedChats();
    } catch (e) {
      console.error('[ASKANYTHING] delete failed', e);
    } finally {
      closeDeleteModal();
    }
  });

  // ============================================================
  //  ARCHIVE PANEL
  // ============================================================
  async function loadArchivedChats() {
    try {
      const data = await apiRequest('/api/askanything/chats?archived=true');
      const chats = data.chats || [];
      archivedList.innerHTML = '';
      chats.forEach(chat => {
        const li = document.createElement('li');
        li.className = 'aa-chat-item';
        li.innerHTML = `
          <div class="aa-chat-item-main">
            <div class="aa-chat-item-title">${escapeHtml(chat.title)}</div>
            <div class="aa-chat-item-date">${formatDateTime(chat.updated_at)}</div>
          </div>
        `;
        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'aa-chat-item-menu';
        restoreBtn.title = 'Restore Chat';
        restoreBtn.innerHTML = '<i class="fas fa-rotate-left"></i>';
        restoreBtn.addEventListener('click', () => toggleArchive(chat.id, false));

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'aa-chat-item-menu';
        deleteBtn.title = 'Delete Chat';
        deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
        deleteBtn.addEventListener('click', () => openDeleteModal(chat.id));

        li.appendChild(restoreBtn);
        li.appendChild(deleteBtn);
        archivedList.appendChild(li);
      });
      archiveEmptyState.classList.toggle('visible', chats.length === 0);
    } catch (e) {
      console.error('[ASKANYTHING] loadArchivedChats failed', e);
    }
  }
  archiveChatsBtn.addEventListener('click', () => {
    archiveModal.classList.add('active');
    loadArchivedChats();
  });
  archiveCloseBtn.addEventListener('click', () => archiveModal.classList.remove('active'));

  function closeAllModals() {
    renameModal.classList.remove('active');
    deleteModal.classList.remove('active');
    archiveModal.classList.remove('active');
  }
  [renameModal, deleteModal, archiveModal].forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('active');
    });
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
    recognition.addEventListener('end', () => {
      isListening = false;
      micBtn.classList.remove('listening');
    });
    recognition.addEventListener('error', () => {
      isListening = false;
      micBtn.classList.remove('listening');
    });

    micBtn.addEventListener('click', () => {
      if (isListening) {
        recognition.stop();
        return;
      }
      isListening = true;
      micBtn.classList.add('listening');
      try {
        recognition.start();
      } catch (e) {
        isListening = false;
        micBtn.classList.remove('listening');
      }
    });
  } else {
    micBtn.disabled = true;
    micBtn.title = 'Voice input is not supported in this browser';
    micBtn.style.opacity = '0.35';
    micBtn.style.cursor = 'not-allowed';
  }

  // ============================================================
  //  COSMIC BACKGROUND — populate stars / shooting stars / particles
  // ============================================================
  function initCosmicBackground() {
    const starField = $('#starField');
    const shootingField = $('#shootingStarField');
    const particleField = $('#particleField');
    if (!starField || !shootingField || !particleField) return;

    const isSmall = window.innerWidth <= 720;
    const starCount = isSmall ? 90 : 180;
    const shootingCount = isSmall ? 3 : 6;
    const particleCount = isSmall ? 14 : 26;

    const starsFrag = document.createDocumentFragment();
    for (let n = 0; n < starCount; n++) {
      const s = document.createElement('div');
      s.className = 'star';
      const size = (Math.random() * 1.8 + 0.6).toFixed(2);
      s.style.top = (Math.random() * 100).toFixed(2) + '%';
      s.style.left = (Math.random() * 100).toFixed(2) + '%';
      s.style.width = size + 'px';
      s.style.height = size + 'px';
      s.style.animationDuration = (Math.random() * 3 + 2).toFixed(2) + 's';
      s.style.animationDelay = (Math.random() * 5).toFixed(2) + 's';
      starsFrag.appendChild(s);
    }
    starField.appendChild(starsFrag);

    const shootFrag = document.createDocumentFragment();
    for (let n = 0; n < shootingCount; n++) {
      const s = document.createElement('div');
      s.className = 'shooting-star';
      s.style.top = (Math.random() * 60).toFixed(2) + '%';
      s.style.left = (Math.random() * 40).toFixed(2) + '%';
      s.style.animationDuration = (Math.random() * 6 + 7).toFixed(2) + 's';
      s.style.animationDelay = (Math.random() * 10).toFixed(2) + 's';
      shootFrag.appendChild(s);
    }
    shootingField.appendChild(shootFrag);

    const particleFrag = document.createDocumentFragment();
    for (let n = 0; n < particleCount; n++) {
      const p = document.createElement('div');
      p.className = 'space-particle';
      const size = (Math.random() * 2.5 + 1).toFixed(2);
      p.style.top = (Math.random() * 100).toFixed(2) + '%';
      p.style.left = (Math.random() * 100).toFixed(2) + '%';
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.animationDuration = (Math.random() * 6 + 5).toFixed(2) + 's';
      p.style.animationDelay = (Math.random() * 6).toFixed(2) + 's';
      particleFrag.appendChild(p);
    }
    particleField.appendChild(particleFrag);
  }

  // ============================================================
  //  INIT
  // ============================================================
  initCosmicBackground();
  loadChats();
})();