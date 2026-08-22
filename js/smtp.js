// ============================================================
// smtp.js — S.N.E.T.C.H AI Email Center
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

  // ----- DOM refs -----
  const homeBtn = document.getElementById('homeBtn');
  const sendMailTrigger = document.getElementById('sendMailTrigger');
  const sendMailBtn = document.getElementById('sendMailBtn');
  const formContainer = document.getElementById('emailFormContainer');
  const emailForm = document.getElementById('emailForm');
  const submitBtn = document.getElementById('submitMailBtn');

  const senderInput = document.getElementById('senderEmail');
  const receiverInput = document.getElementById('receiverEmail');
  const subjectInput = document.getElementById('subject');
  const messageInput = document.getElementById('message');

  const fileInput = document.getElementById('fileInput');
  const browseFilesBtn = document.getElementById('browseFilesBtn');
  const attachmentList = document.getElementById('attachmentList');
  const attachSection = document.querySelector('.attach-section');
  const attachError = document.getElementById('attachError');
  const attachHint = document.getElementById('attachHint');

  const statusDiv = document.getElementById('statusMessage');
  const successOverlay = document.getElementById('successOverlay');

  // ----- server limits (fetched from /smtp/api/config) -----
  let LIMITS = {
    configured: true,
    max_attachment_mb: 25,
    max_total_mb: 25,
    max_attachments: 15,
    blocked_extensions: [],
  };

  fetch('/smtp/api/config')
    .then(res => res.json())
    .then(cfg => {
      if (cfg && cfg.success) {
        LIMITS = { ...LIMITS, ...cfg };
        attachHint.textContent =
          `Up to ${LIMITS.max_attachments} files, ${LIMITS.max_total_mb}MB total`;
        if (!LIMITS.configured) {
          showStatus('⚠️ Email server isn\u2019t configured yet. Sending is disabled.', true);
        }
      }
    })
    .catch(() => { /* keep client-side defaults, backend will still validate */ });

  // ----- in-memory attachment store (Gmail-style, client-side until submit) -----
  // Each entry: { id, file }
  let attachments = [];
  let idCounter = 0;

  // ----- helper: show status (success/error) -----
  function showStatus(message, isError = false) {
    statusDiv.classList.remove('hidden', 'error');
    statusDiv.innerHTML = '';
    const icon = document.createElement('i');
    icon.className = isError ? 'fas fa-times-circle' : 'fas fa-check-circle';
    statusDiv.appendChild(icon);
    statusDiv.appendChild(document.createTextNode(' ' + message));
    if (isError) statusDiv.classList.add('error');
    clearTimeout(window.statusTimeout);
    window.statusTimeout = setTimeout(() => {
      statusDiv.classList.add('hidden');
    }, 6000);
  }

  function clearStatus() {
    statusDiv.classList.add('hidden');
    clearTimeout(window.statusTimeout);
  }

  function showAttachError(message) {
    if (!message) {
      attachError.classList.add('hidden');
      attachError.textContent = '';
      return;
    }
    attachError.textContent = message;
    attachError.classList.remove('hidden');
  }

  // ----- validation helpers -----
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function validateField(input, errorMsg) {
    const group = input.closest('.input-group');
    const msgEl = group.querySelector('.validation-msg');
    let isValid = true;

    if (input.tagName === 'TEXTAREA') {
      if (!input.value.trim() || input.value.trim().length < 2) {
        isValid = false;
      }
    } else if (input.type === 'email') {
      if (!isValidEmail(input.value.trim())) {
        isValid = false;
      }
    } else {
      if (!input.value.trim()) {
        isValid = false;
      }
    }

    if (!isValid) {
      group.classList.add('error');
      if (msgEl) msgEl.textContent = errorMsg;
    } else {
      group.classList.remove('error');
      if (msgEl) msgEl.textContent = '';
    }
    return isValid;
  }

  function clearAllValidation() {
    document.querySelectorAll('.input-group').forEach(g => {
      g.classList.remove('error');
      const msg = g.querySelector('.validation-msg');
      if (msg) msg.textContent = '';
    });
  }

  function validateForm() {
    clearStatus();
    let valid = true;
    if (!validateField(senderInput, 'Invalid Sender Email Address')) valid = false;
    if (!validateField(receiverInput, 'Invalid Receiver Email Address')) valid = false;
    if (!validateField(subjectInput, 'Subject Required')) valid = false;
    if (!validateField(messageInput, 'Message Cannot Be Empty')) valid = false;
    return valid;
  }

  // ----- file helpers -----
  function humanSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  }

  function iconForFile(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      pdf: 'fa-file-pdf', doc: 'fa-file-word', docx: 'fa-file-word',
      xls: 'fa-file-excel', xlsx: 'fa-file-excel',
      ppt: 'fa-file-powerpoint', pptx: 'fa-file-powerpoint',
      txt: 'fa-file-lines', zip: 'fa-file-zipper', rar: 'fa-file-zipper', '7z': 'fa-file-zipper',
      jpg: 'fa-file-image', jpeg: 'fa-file-image', png: 'fa-file-image',
      gif: 'fa-file-image', webp: 'fa-file-image', svg: 'fa-file-image',
      mp3: 'fa-file-audio', wav: 'fa-file-audio', m4a: 'fa-file-audio',
      mp4: 'fa-file-video', mov: 'fa-file-video', mkv: 'fa-file-video', avi: 'fa-file-video',
    };
    return map[ext] || 'fa-file';
  }

  function totalSize() {
    return attachments.reduce((sum, a) => sum + a.file.size, 0);
  }

  function isBlockedExt(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return LIMITS.blocked_extensions && LIMITS.blocked_extensions.includes(ext);
  }

  function renderAttachments() {
    attachmentList.innerHTML = '';
    attachments.forEach(entry => {
      const li = document.createElement('li');
      li.className = 'attachment-item';
      li.dataset.id = entry.id;

      const icon = document.createElement('div');
      icon.className = 'attachment-icon';
      icon.innerHTML = `<i class="fas ${iconForFile(entry.file.name)}"></i>`;

      const info = document.createElement('div');
      info.className = 'attachment-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'attachment-name';
      nameEl.textContent = entry.file.name;
      const sizeEl = document.createElement('span');
      sizeEl.className = 'attachment-size';
      sizeEl.textContent = humanSize(entry.file.size);
      info.appendChild(nameEl);
      info.appendChild(sizeEl);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'attachment-remove';
      removeBtn.setAttribute('aria-label', 'Remove attachment');
      removeBtn.innerHTML = '<i class="fas fa-xmark"></i>';
      removeBtn.addEventListener('click', () => removeAttachment(entry.id));

      li.appendChild(icon);
      li.appendChild(info);
      li.appendChild(removeBtn);
      attachmentList.appendChild(li);
    });
  }

  function removeAttachment(id) {
    const li = attachmentList.querySelector(`[data-id="${id}"]`);
    if (li) {
      li.classList.add('removing');
      setTimeout(() => {
        attachments = attachments.filter(a => a.id !== id);
        renderAttachments();
      }, 220);
    } else {
      attachments = attachments.filter(a => a.id !== id);
      renderAttachments();
    }
    showAttachError('');
  }

  function addFiles(fileList) {
    showAttachError('');
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    let sizeSoFar = totalSize();

    for (const file of incoming) {
      if (attachments.length >= LIMITS.max_attachments) {
        showAttachError(`Too Many Attachments. Maximum is ${LIMITS.max_attachments}.`);
        break;
      }
      if (isBlockedExt(file.name)) {
        showAttachError(`Unsupported File Type: ${file.name}`);
        continue;
      }
      if (file.size > LIMITS.max_attachment_mb * 1024 * 1024) {
        showAttachError(`'${file.name}' Is Too Large. Max ${LIMITS.max_attachment_mb}MB Per File.`);
        continue;
      }
      if (sizeSoFar + file.size > LIMITS.max_total_mb * 1024 * 1024) {
        showAttachError(`Attachment Too Large. Total Limit Is ${LIMITS.max_total_mb}MB.`);
        break;
      }
      sizeSoFar += file.size;
      attachments.push({ id: 'f' + (idCounter++), file });
    }

    renderAttachments();
  }

  // ----- Browse Files -----
  browseFilesBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    addFiles(e.target.files);
    fileInput.value = ''; // allow re-selecting the same file later
  });

  // ----- Drag & drop onto the attach section (bonus, Gmail-like) -----
  ['dragenter', 'dragover'].forEach(evt => {
    attachSection.addEventListener(evt, (e) => {
      e.preventDefault();
      attachSection.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    attachSection.addEventListener(evt, (e) => {
      e.preventDefault();
      attachSection.classList.remove('drag-over');
    });
  });
  attachSection.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) {
      addFiles(e.dataTransfer.files);
    }
  });

  // ----- success overlay -----
  function showSuccessOverlay() {
    successOverlay.classList.remove('hidden');
    setTimeout(() => {
      successOverlay.classList.add('hidden');
    }, 2000);
  }

  // ----- handle form submit (real backend call) -----
  async function handleFormSubmit(e) {
    e.preventDefault();
    clearStatus();
    showAttachError('');

    if (!validateForm()) return;

    if (!LIMITS.configured) {
      showStatus('❌ Email Server Not Configured', true);
      return;
    }

    const sender = senderInput.value.trim();
    const receiver = receiverInput.value.trim();
    const subject = subjectInput.value.trim();
    const message = messageInput.value.trim();

    const formData = new FormData();
    formData.append('sender_email', sender);
    formData.append('receiver_email', receiver);
    formData.append('subject', subject);
    formData.append('message', message);
    attachments.forEach(entry => formData.append('attachments', entry.file, entry.file.name));

    submitBtn.disabled = true;
    submitBtn.classList.add('sending');
    submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Sending...';

    try {
      const res = await fetch('/smtp/api/send', {
        method: 'POST',
        body: formData,
      });

      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error('Network Error');
      }

      if (res.ok && data.success) {
        showStatus('✅ Email Sent Successfully', false);
        showSuccessOverlay();
        // reset form + attachments after a successful send
        emailForm.reset();
        attachments = [];
        renderAttachments();
        clearAllValidation();
      } else {
        const errMsg = (data && data.error) || 'Failed To Send Email';
        showStatus('❌ ' + errMsg, true);
        if (data && data.field) {
          const map = {
            sender_email: senderInput, receiver_email: receiverInput,
            subject: subjectInput, message: messageInput,
          };
          const el = map[data.field];
          if (el) {
            const group = el.closest('.input-group');
            if (group) {
              group.classList.add('error');
              const msgEl = group.querySelector('.validation-msg');
              if (msgEl) msgEl.textContent = errMsg;
            }
          } else if (data.field === 'attachments') {
            showAttachError(errMsg);
          }
        }
      }
    } catch (error) {
      showStatus('❌ Network Error. Please check your connection.', true);
      console.warn('Email send error:', error.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove('sending');
      submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Email';
    }
  }

  // ----- toggle form visibility (Show/Hide) -----
  function showForm() {
    formContainer.classList.remove('hidden');
    formContainer.classList.add('show');
    sendMailTrigger.style.transition = 'opacity 0.3s ease';
    sendMailTrigger.style.opacity = '0';
    setTimeout(() => {
      sendMailTrigger.style.display = 'none';
    }, 350);
    clearStatus();
    clearAllValidation();
    showAttachError('');
  }

  function hideForm() {
    formContainer.classList.remove('show');
    formContainer.classList.add('hidden');
    sendMailTrigger.style.display = 'block';
    setTimeout(() => {
      sendMailTrigger.style.opacity = '1';
    }, 20);
    clearStatus();
    clearAllValidation();
    showAttachError('');
  }

  // ----- HOME button: real navigation via href="/" -----
  homeBtn.addEventListener('click', () => {
    homeBtn.style.transform = 'scale(0.94)';
    setTimeout(() => { homeBtn.style.transform = ''; }, 150);
    // Navigation itself is handled by the anchor's href="/".
  });

  // ----- SEND MAIL button (initial) -----
  sendMailBtn.addEventListener('click', (e) => {
    createRipple(e);
    showForm();
    setTimeout(() => {
      senderInput.focus();
    }, 500);
  });

  // ----- RIPPLE effect (for buttons) -----
  function createRipple(event) {
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    button.style.position = 'relative';
    button.appendChild(ripple);
    setTimeout(() => ripple.remove(), 700);
  }

  submitBtn.addEventListener('click', createRipple);

  // ----- form submit listener -----
  emailForm.addEventListener('submit', handleFormSubmit);

  // ----- real-time validation on blur / input -----
  [senderInput, receiverInput, subjectInput, messageInput].forEach(input => {
    input.addEventListener('blur', function () {
      const group = this.closest('.input-group');
      const msgEl = group.querySelector('.validation-msg');
      let errorMsg = '';
      if (this.type === 'email') {
        if (this.value.trim() && !isValidEmail(this.value.trim())) {
          errorMsg = 'Invalid Email Address';
        }
      } else if (this.tagName === 'TEXTAREA') {
        if (this.value.trim() && this.value.trim().length < 2) {
          errorMsg = 'Message Cannot Be Empty';
        }
      } else {
        if (this.value.trim() === '') {
          errorMsg = 'This field is required';
        }
      }
      if (errorMsg) {
        group.classList.add('error');
        if (msgEl) msgEl.textContent = errorMsg;
      } else {
        group.classList.remove('error');
        if (msgEl) msgEl.textContent = '';
      }
    });

    input.addEventListener('input', function () {
      const group = this.closest('.input-group');
      group.classList.remove('error');
      const msgEl = group.querySelector('.validation-msg');
      if (msgEl) msgEl.textContent = '';
      clearStatus();
    });
  });

  // ----- Add stars & particles dynamically (background) -----
  function createStarsAndParticles() {
    const bg = document.getElementById('space-bg');
    for (let i = 0; i < 120; i++) {
      const star = document.createElement('div');
      star.className = 'star';
      const size = 1 + Math.random() * 2.5;
      star.style.width = size + 'px';
      star.style.height = size + 'px';
      star.style.top = Math.random() * 100 + '%';
      star.style.left = Math.random() * 100 + '%';
      star.style.setProperty('--duration', (2 + Math.random() * 4) + 's');
      star.style.animationDelay = (Math.random() * 5) + 's';
      bg.appendChild(star);
    }
    for (let i = 0; i < 35; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      const size = 2 + Math.random() * 5;
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.top = Math.random() * 100 + '%';
      p.style.left = Math.random() * 100 + '%';
      p.style.setProperty('--dur', (12 + Math.random() * 20) + 's');
      p.style.setProperty('--dx', (-30 + Math.random() * 60) + 'px');
      p.style.setProperty('--dy', (-30 + Math.random() * 60) + 'px');
      p.style.animationDelay = (Math.random() * 8) + 's';
      bg.appendChild(p);
    }
  }
  createStarsAndParticles();

  // ----- initial state -----
  formContainer.classList.add('hidden');
  formContainer.classList.remove('show');
  sendMailTrigger.style.display = 'block';
  sendMailTrigger.style.opacity = '1';
  statusDiv.classList.add('hidden');
  successOverlay.classList.add('hidden');
  renderAttachments();

  console.log('S.N.E.T.C.H AI Email Center ready.');
});