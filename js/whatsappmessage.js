// ===== WHATSAPP MESSENGER — S.N.E.T.C.H =====
// ===== JavaScript (production ready, modular) =====

(function () {
  'use strict';

  // ============================================================
  // DOM REFERENCES
  // ============================================================
  const phoneInput = document.getElementById('phoneInput');
  const countrySelectBtn = document.getElementById('countrySelectBtn');
  const countryFlag = document.getElementById('countryFlag');
  const countryDial = document.getElementById('countryDial');
  const countryDropdown = document.getElementById('countryDropdown');
  const countrySearch = document.getElementById('countrySearch');
  const countryList = document.getElementById('countryList');
  const messageInput = document.getElementById('messageInput');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const attachmentsList = document.getElementById('attachmentsList');
  const sendBtn = document.getElementById('sendBtn');
  const phoneError = document.getElementById('phoneError');
  const messageError = document.getElementById('messageError');
  const fileError = document.getElementById('fileError');
  const sendStatus = document.getElementById('sendStatus');
  const successOverlay = document.getElementById('successOverlay');
  const successDetail = document.getElementById('successDetail');
  const successCloseBtn = document.getElementById('successCloseBtn');

  // ============================================================
  // CONFIG
  // ============================================================
  const MAX_FILES = 10;
  const MAX_FILE_SIZE = 64 * 1024 * 1024;   // 64 MB — must match backend
  const MAX_TOTAL_SIZE = 200 * 1024 * 1024; // 200 MB — must match backend
  const ALLOWED_EXTENSIONS = [
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf',
    'zip', 'rar', '7z',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
    'mp3', 'wav', 'ogg', 'm4a', 'aac',
    'mp4', 'mov', 'avi', 'mkv', 'webm',
  ];
  const POLL_INTERVAL_MS = 1500;
  const POLL_MAX_ATTEMPTS = 60; // ~90 seconds of polling before giving up
  const DEFAULT_COUNTRY_ISO2 = 'IN'; // India — default selection

  // ============================================================
  // COUNTRY DIAL CODES (name, ISO 3166-1 alpha-2, calling code)
  // Flags are rendered from the ISO2 code via Unicode regional
  // indicator symbols — no image assets needed.
  // ============================================================
  const COUNTRIES = [
    { name: 'Afghanistan', iso2: 'AF', dial: '93' },
    { name: 'Albania', iso2: 'AL', dial: '355' },
    { name: 'Algeria', iso2: 'DZ', dial: '213' },
    { name: 'American Samoa', iso2: 'AS', dial: '1684' },
    { name: 'Andorra', iso2: 'AD', dial: '376' },
    { name: 'Angola', iso2: 'AO', dial: '244' },
    { name: 'Anguilla', iso2: 'AI', dial: '1264' },
    { name: 'Antigua and Barbuda', iso2: 'AG', dial: '1268' },
    { name: 'Argentina', iso2: 'AR', dial: '54' },
    { name: 'Armenia', iso2: 'AM', dial: '374' },
    { name: 'Aruba', iso2: 'AW', dial: '297' },
    { name: 'Australia', iso2: 'AU', dial: '61' },
    { name: 'Austria', iso2: 'AT', dial: '43' },
    { name: 'Azerbaijan', iso2: 'AZ', dial: '994' },
    { name: 'Bahamas', iso2: 'BS', dial: '1242' },
    { name: 'Bahrain', iso2: 'BH', dial: '973' },
    { name: 'Bangladesh', iso2: 'BD', dial: '880' },
    { name: 'Barbados', iso2: 'BB', dial: '1246' },
    { name: 'Belarus', iso2: 'BY', dial: '375' },
    { name: 'Belgium', iso2: 'BE', dial: '32' },
    { name: 'Belize', iso2: 'BZ', dial: '501' },
    { name: 'Benin', iso2: 'BJ', dial: '229' },
    { name: 'Bermuda', iso2: 'BM', dial: '1441' },
    { name: 'Bhutan', iso2: 'BT', dial: '975' },
    { name: 'Bolivia', iso2: 'BO', dial: '591' },
    { name: 'Bosnia and Herzegovina', iso2: 'BA', dial: '387' },
    { name: 'Botswana', iso2: 'BW', dial: '267' },
    { name: 'Brazil', iso2: 'BR', dial: '55' },
    { name: 'British Virgin Islands', iso2: 'VG', dial: '1284' },
    { name: 'Brunei', iso2: 'BN', dial: '673' },
    { name: 'Bulgaria', iso2: 'BG', dial: '359' },
    { name: 'Burkina Faso', iso2: 'BF', dial: '226' },
    { name: 'Burundi', iso2: 'BI', dial: '257' },
    { name: 'Cambodia', iso2: 'KH', dial: '855' },
    { name: 'Cameroon', iso2: 'CM', dial: '237' },
    { name: 'Canada', iso2: 'CA', dial: '1' },
    { name: 'Cape Verde', iso2: 'CV', dial: '238' },
    { name: 'Cayman Islands', iso2: 'KY', dial: '1345' },
    { name: 'Central African Republic', iso2: 'CF', dial: '236' },
    { name: 'Chad', iso2: 'TD', dial: '235' },
    { name: 'Chile', iso2: 'CL', dial: '56' },
    { name: 'China', iso2: 'CN', dial: '86' },
    { name: 'Colombia', iso2: 'CO', dial: '57' },
    { name: 'Comoros', iso2: 'KM', dial: '269' },
    { name: 'Congo (DRC)', iso2: 'CD', dial: '243' },
    { name: 'Congo (Republic)', iso2: 'CG', dial: '242' },
    { name: 'Cook Islands', iso2: 'CK', dial: '682' },
    { name: 'Costa Rica', iso2: 'CR', dial: '506' },
    { name: "Côte d'Ivoire", iso2: 'CI', dial: '225' },
    { name: 'Croatia', iso2: 'HR', dial: '385' },
    { name: 'Cuba', iso2: 'CU', dial: '53' },
    { name: 'Curaçao', iso2: 'CW', dial: '599' },
    { name: 'Cyprus', iso2: 'CY', dial: '357' },
    { name: 'Czech Republic', iso2: 'CZ', dial: '420' },
    { name: 'Denmark', iso2: 'DK', dial: '45' },
    { name: 'Djibouti', iso2: 'DJ', dial: '253' },
    { name: 'Dominica', iso2: 'DM', dial: '1767' },
    { name: 'Dominican Republic', iso2: 'DO', dial: '1809' },
    { name: 'Ecuador', iso2: 'EC', dial: '593' },
    { name: 'Egypt', iso2: 'EG', dial: '20' },
    { name: 'El Salvador', iso2: 'SV', dial: '503' },
    { name: 'Equatorial Guinea', iso2: 'GQ', dial: '240' },
    { name: 'Eritrea', iso2: 'ER', dial: '291' },
    { name: 'Estonia', iso2: 'EE', dial: '372' },
    { name: 'Eswatini', iso2: 'SZ', dial: '268' },
    { name: 'Ethiopia', iso2: 'ET', dial: '251' },
    { name: 'Fiji', iso2: 'FJ', dial: '679' },
    { name: 'Finland', iso2: 'FI', dial: '358' },
    { name: 'France', iso2: 'FR', dial: '33' },
    { name: 'French Polynesia', iso2: 'PF', dial: '689' },
    { name: 'Gabon', iso2: 'GA', dial: '241' },
    { name: 'Gambia', iso2: 'GM', dial: '220' },
    { name: 'Georgia', iso2: 'GE', dial: '995' },
    { name: 'Germany', iso2: 'DE', dial: '49' },
    { name: 'Ghana', iso2: 'GH', dial: '233' },
    { name: 'Gibraltar', iso2: 'GI', dial: '350' },
    { name: 'Greece', iso2: 'GR', dial: '30' },
    { name: 'Greenland', iso2: 'GL', dial: '299' },
    { name: 'Grenada', iso2: 'GD', dial: '1473' },
    { name: 'Guam', iso2: 'GU', dial: '1671' },
    { name: 'Guatemala', iso2: 'GT', dial: '502' },
    { name: 'Guernsey', iso2: 'GG', dial: '44' },
    { name: 'Guinea', iso2: 'GN', dial: '224' },
    { name: 'Guinea-Bissau', iso2: 'GW', dial: '245' },
    { name: 'Guyana', iso2: 'GY', dial: '592' },
    { name: 'Haiti', iso2: 'HT', dial: '509' },
    { name: 'Honduras', iso2: 'HN', dial: '504' },
    { name: 'Hong Kong', iso2: 'HK', dial: '852' },
    { name: 'Hungary', iso2: 'HU', dial: '36' },
    { name: 'Iceland', iso2: 'IS', dial: '354' },
    { name: 'India', iso2: 'IN', dial: '91' },
    { name: 'Indonesia', iso2: 'ID', dial: '62' },
    { name: 'Iran', iso2: 'IR', dial: '98' },
    { name: 'Iraq', iso2: 'IQ', dial: '964' },
    { name: 'Ireland', iso2: 'IE', dial: '353' },
    { name: 'Isle of Man', iso2: 'IM', dial: '44' },
    { name: 'Israel', iso2: 'IL', dial: '972' },
    { name: 'Italy', iso2: 'IT', dial: '39' },
    { name: 'Jamaica', iso2: 'JM', dial: '1876' },
    { name: 'Japan', iso2: 'JP', dial: '81' },
    { name: 'Jersey', iso2: 'JE', dial: '44' },
    { name: 'Jordan', iso2: 'JO', dial: '962' },
    { name: 'Kazakhstan', iso2: 'KZ', dial: '7' },
    { name: 'Kenya', iso2: 'KE', dial: '254' },
    { name: 'Kiribati', iso2: 'KI', dial: '686' },
    { name: 'Kosovo', iso2: 'XK', dial: '383' },
    { name: 'Kuwait', iso2: 'KW', dial: '965' },
    { name: 'Kyrgyzstan', iso2: 'KG', dial: '996' },
    { name: 'Laos', iso2: 'LA', dial: '856' },
    { name: 'Latvia', iso2: 'LV', dial: '371' },
    { name: 'Lebanon', iso2: 'LB', dial: '961' },
    { name: 'Lesotho', iso2: 'LS', dial: '266' },
    { name: 'Liberia', iso2: 'LR', dial: '231' },
    { name: 'Libya', iso2: 'LY', dial: '218' },
    { name: 'Liechtenstein', iso2: 'LI', dial: '423' },
    { name: 'Lithuania', iso2: 'LT', dial: '370' },
    { name: 'Luxembourg', iso2: 'LU', dial: '352' },
    { name: 'Macau', iso2: 'MO', dial: '853' },
    { name: 'Madagascar', iso2: 'MG', dial: '261' },
    { name: 'Malawi', iso2: 'MW', dial: '265' },
    { name: 'Malaysia', iso2: 'MY', dial: '60' },
    { name: 'Maldives', iso2: 'MV', dial: '960' },
    { name: 'Mali', iso2: 'ML', dial: '223' },
    { name: 'Malta', iso2: 'MT', dial: '356' },
    { name: 'Marshall Islands', iso2: 'MH', dial: '692' },
    { name: 'Mauritania', iso2: 'MR', dial: '222' },
    { name: 'Mauritius', iso2: 'MU', dial: '230' },
    { name: 'Mexico', iso2: 'MX', dial: '52' },
    { name: 'Micronesia', iso2: 'FM', dial: '691' },
    { name: 'Moldova', iso2: 'MD', dial: '373' },
    { name: 'Monaco', iso2: 'MC', dial: '377' },
    { name: 'Mongolia', iso2: 'MN', dial: '976' },
    { name: 'Montenegro', iso2: 'ME', dial: '382' },
    { name: 'Montserrat', iso2: 'MS', dial: '1664' },
    { name: 'Morocco', iso2: 'MA', dial: '212' },
    { name: 'Mozambique', iso2: 'MZ', dial: '258' },
    { name: 'Myanmar', iso2: 'MM', dial: '95' },
    { name: 'Namibia', iso2: 'NA', dial: '264' },
    { name: 'Nauru', iso2: 'NR', dial: '674' },
    { name: 'Nepal', iso2: 'NP', dial: '977' },
    { name: 'Netherlands', iso2: 'NL', dial: '31' },
    { name: 'New Caledonia', iso2: 'NC', dial: '687' },
    { name: 'New Zealand', iso2: 'NZ', dial: '64' },
    { name: 'Nicaragua', iso2: 'NI', dial: '505' },
    { name: 'Niger', iso2: 'NE', dial: '227' },
    { name: 'Nigeria', iso2: 'NG', dial: '234' },
    { name: 'Niue', iso2: 'NU', dial: '683' },
    { name: 'North Korea', iso2: 'KP', dial: '850' },
    { name: 'North Macedonia', iso2: 'MK', dial: '389' },
    { name: 'Norway', iso2: 'NO', dial: '47' },
    { name: 'Oman', iso2: 'OM', dial: '968' },
    { name: 'Pakistan', iso2: 'PK', dial: '92' },
    { name: 'Palau', iso2: 'PW', dial: '680' },
    { name: 'Palestine', iso2: 'PS', dial: '970' },
    { name: 'Panama', iso2: 'PA', dial: '507' },
    { name: 'Papua New Guinea', iso2: 'PG', dial: '675' },
    { name: 'Paraguay', iso2: 'PY', dial: '595' },
    { name: 'Peru', iso2: 'PE', dial: '51' },
    { name: 'Philippines', iso2: 'PH', dial: '63' },
    { name: 'Poland', iso2: 'PL', dial: '48' },
    { name: 'Portugal', iso2: 'PT', dial: '351' },
    { name: 'Puerto Rico', iso2: 'PR', dial: '1787' },
    { name: 'Qatar', iso2: 'QA', dial: '974' },
    { name: 'Romania', iso2: 'RO', dial: '40' },
    { name: 'Russia', iso2: 'RU', dial: '7' },
    { name: 'Rwanda', iso2: 'RW', dial: '250' },
    { name: 'Saint Kitts and Nevis', iso2: 'KN', dial: '1869' },
    { name: 'Saint Lucia', iso2: 'LC', dial: '1758' },
    { name: 'Saint Vincent and the Grenadines', iso2: 'VC', dial: '1784' },
    { name: 'Samoa', iso2: 'WS', dial: '685' },
    { name: 'San Marino', iso2: 'SM', dial: '378' },
    { name: 'Sao Tome and Principe', iso2: 'ST', dial: '239' },
    { name: 'Saudi Arabia', iso2: 'SA', dial: '966' },
    { name: 'Senegal', iso2: 'SN', dial: '221' },
    { name: 'Serbia', iso2: 'RS', dial: '381' },
    { name: 'Seychelles', iso2: 'SC', dial: '248' },
    { name: 'Sierra Leone', iso2: 'SL', dial: '232' },
    { name: 'Singapore', iso2: 'SG', dial: '65' },
    { name: 'Slovakia', iso2: 'SK', dial: '421' },
    { name: 'Slovenia', iso2: 'SI', dial: '386' },
    { name: 'Solomon Islands', iso2: 'SB', dial: '677' },
    { name: 'Somalia', iso2: 'SO', dial: '252' },
    { name: 'South Africa', iso2: 'ZA', dial: '27' },
    { name: 'South Korea', iso2: 'KR', dial: '82' },
    { name: 'South Sudan', iso2: 'SS', dial: '211' },
    { name: 'Spain', iso2: 'ES', dial: '34' },
    { name: 'Sri Lanka', iso2: 'LK', dial: '94' },
    { name: 'Sudan', iso2: 'SD', dial: '249' },
    { name: 'Suriname', iso2: 'SR', dial: '597' },
    { name: 'Sweden', iso2: 'SE', dial: '46' },
    { name: 'Switzerland', iso2: 'CH', dial: '41' },
    { name: 'Syria', iso2: 'SY', dial: '963' },
    { name: 'Taiwan', iso2: 'TW', dial: '886' },
    { name: 'Tajikistan', iso2: 'TJ', dial: '992' },
    { name: 'Tanzania', iso2: 'TZ', dial: '255' },
    { name: 'Thailand', iso2: 'TH', dial: '66' },
    { name: 'Timor-Leste', iso2: 'TL', dial: '670' },
    { name: 'Togo', iso2: 'TG', dial: '228' },
    { name: 'Tonga', iso2: 'TO', dial: '676' },
    { name: 'Trinidad and Tobago', iso2: 'TT', dial: '1868' },
    { name: 'Tunisia', iso2: 'TN', dial: '216' },
    { name: 'Turkey', iso2: 'TR', dial: '90' },
    { name: 'Turkmenistan', iso2: 'TM', dial: '993' },
    { name: 'Turks and Caicos Islands', iso2: 'TC', dial: '1649' },
    { name: 'Tuvalu', iso2: 'TV', dial: '688' },
    { name: 'Uganda', iso2: 'UG', dial: '256' },
    { name: 'Ukraine', iso2: 'UA', dial: '380' },
    { name: 'United Arab Emirates', iso2: 'AE', dial: '971' },
    { name: 'United Kingdom', iso2: 'GB', dial: '44' },
    { name: 'United States', iso2: 'US', dial: '1' },
    { name: 'Uruguay', iso2: 'UY', dial: '598' },
    { name: 'Uzbekistan', iso2: 'UZ', dial: '998' },
    { name: 'Vanuatu', iso2: 'VU', dial: '678' },
    { name: 'Vatican City', iso2: 'VA', dial: '379' },
    { name: 'Venezuela', iso2: 'VE', dial: '58' },
    { name: 'Vietnam', iso2: 'VN', dial: '84' },
    { name: 'Yemen', iso2: 'YE', dial: '967' },
    { name: 'Zambia', iso2: 'ZM', dial: '260' },
    { name: 'Zimbabwe', iso2: 'ZW', dial: '263' },
  ];

  function flagEmoji(iso2) {
    if (!iso2 || iso2.length !== 2) return '🏳️';
    const codePoints = [...iso2.toUpperCase()].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
    return String.fromCodePoint(...codePoints);
  }

  let selectedCountry = COUNTRIES.find((c) => c.iso2 === DEFAULT_COUNTRY_ISO2) || COUNTRIES[0];

  // Selected files, keyed by a locally generated id.
  let selectedFiles = []; // [{ id, file }]
  let pollTimer = null;

  // ============================================================
  // HELPERS
  // ============================================================

  function getExtension(filename) {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  function iconForExtension(ext) {
    const map = {
      pdf: 'fa-file-pdf', doc: 'fa-file-word', docx: 'fa-file-word',
      xls: 'fa-file-excel', xlsx: 'fa-file-excel',
      ppt: 'fa-file-powerpoint', pptx: 'fa-file-powerpoint',
      txt: 'fa-file-lines', csv: 'fa-file-csv', rtf: 'fa-file-lines',
      zip: 'fa-file-zipper', rar: 'fa-file-zipper', '7z': 'fa-file-zipper',
      png: 'fa-file-image', jpg: 'fa-file-image', jpeg: 'fa-file-image',
      gif: 'fa-file-image', webp: 'fa-file-image', bmp: 'fa-file-image',
      mp3: 'fa-file-audio', wav: 'fa-file-audio', ogg: 'fa-file-audio',
      m4a: 'fa-file-audio', aac: 'fa-file-audio',
      mp4: 'fa-file-video', mov: 'fa-file-video', avi: 'fa-file-video',
      mkv: 'fa-file-video', webm: 'fa-file-video',
    };
    return map[ext] || 'fa-file';
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function setValidationMessage(element, message, type = 'error') {
    element.textContent = message;
    element.className = 'validation-msg ' + type;
    void element.offsetWidth;
  }

  function clearValidationMessages() {
    setValidationMessage(phoneError, '', '');
    setValidationMessage(messageError, '', '');
    setValidationMessage(fileError, '', '');
    setValidationMessage(sendStatus, '', '');
  }

  function totalSelectedSize() {
    return selectedFiles.reduce((sum, entry) => sum + entry.file.size, 0);
  }

  // ============================================================
  // VALIDATION
  // ============================================================

  function isValidWhatsAppNumber(value) {
    if (!value || value.trim() === '') return false;
    const digitsOnly = value.replace(/\D/g, '');
    return digitsOnly.length >= 6 && digitsOnly.length <= 12;
  }

  function getFullE164Number() {
    const localDigits = phoneInput.value.replace(/\D/g, '');
    return `+${selectedCountry.dial}${localDigits}`;
  }

  // ============================================================
  // ATTACHMENTS: RENDER / ADD / REMOVE
  // ============================================================

  function statusBadge(entry) {
    if (entry.status === 'success') {
      return '<span class="file-chip-status success"><i class="fas fa-circle-check"></i> Uploaded</span>';
    }
    if (entry.status === 'error') {
      return `<span class="file-chip-status error"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(entry.errorMessage || 'Upload failed')}</span>`;
    }
    return '<span class="file-chip-status uploading"><i class="fas fa-spinner fa-spin"></i> Uploading…</span>';
  }

  function renderAttachments() {
    attachmentsList.innerHTML = '';
    selectedFiles.forEach((entry) => {
      const ext = getExtension(entry.file.name);
      const chip = document.createElement('div');
      chip.className = 'file-chip' + (entry.status === 'error' ? ' file-chip-error' : '');
      chip.dataset.id = entry.id;
      chip.innerHTML = `
        <div class="file-chip-icon"><i class="fas ${iconForExtension(ext)}"></i></div>
        <div class="file-chip-info">
          <div class="file-chip-name">${escapeHtml(entry.file.name)}</div>
          <div class="file-chip-size">${formatSize(entry.file.size)}</div>
          <div class="file-chip-progress"><div class="file-chip-progress-bar" data-role="progress" style="width:${entry.status === 'uploading' ? '2' : '100'}%"></div></div>
          ${statusBadge(entry)}
        </div>
        <button type="button" class="file-chip-remove" aria-label="Remove ${escapeHtml(entry.file.name)}">
          <i class="fas fa-xmark"></i>
        </button>
      `;
      chip.querySelector('.file-chip-remove').addEventListener('click', () => removeFile(entry.id));
      attachmentsList.appendChild(chip);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // currentUploadId ties every /api/whatsapp/upload call together so
  // files picked across multiple Browse clicks land in the same
  // backend staging folder, ready for a single Send.
  let currentUploadId = null;

  function addFiles(fileList) {
    setValidationMessage(fileError, '', '');
    const incoming = Array.from(fileList);
    const batch = [];

    for (const file of incoming) {
      if (selectedFiles.length + batch.length >= MAX_FILES) {
        setValidationMessage(fileError, `You can attach a maximum of ${MAX_FILES} files.`, 'error');
        break;
      }
      const ext = getExtension(file.name);
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        setValidationMessage(fileError, `"${file.name}" is an unsupported file type.`, 'error');
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        setValidationMessage(fileError, `"${file.name}" is too large (max ${formatSize(MAX_FILE_SIZE)}).`, 'error');
        continue;
      }
      if (totalSelectedSize() + batch.reduce((s, e) => s + e.file.size, 0) + file.size > MAX_TOTAL_SIZE) {
        setValidationMessage(fileError, `Total attachment size can't exceed ${formatSize(MAX_TOTAL_SIZE)}.`, 'error');
        continue;
      }
      batch.push({
        id: 'f' + Date.now() + Math.random().toString(36).slice(2),
        file,
        status: 'uploading', // 'uploading' | 'success' | 'error'
        fileId: null,
        errorMessage: '',
      });
    }

    if (batch.length === 0) return;

    selectedFiles = selectedFiles.concat(batch);
    renderAttachments();
    uploadBatch(batch);
  }

  // ============================================================
  // IMMEDIATE ATTACHMENT UPLOAD (fires as soon as files are picked)
  // ============================================================

  function uploadBatch(batch) {
    const formData = new FormData();
    if (currentUploadId) formData.append('upload_id', currentUploadId);
    batch.forEach((entry) => {
      formData.append('files', entry.file);
      formData.append('client_ids', entry.id);
    });

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/whatsapp/upload', true);

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const pct = Math.max(2, Math.round((event.loaded / event.total) * 100));
      batch.forEach((entry) => setChipProgress(entry.id, pct));
    });

    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch (_) {
        data = {};
      }

      if (xhr.status < 200 || xhr.status >= 300 || !data.results) {
        const message = data.error || 'Upload failed. Please try again.';
        batch.forEach((entry) => markUploadResult(entry.id, { success: false, error: message }));
        setValidationMessage(fileError, message, 'error');
        return;
      }

      currentUploadId = data.upload_id || currentUploadId;

      data.results.forEach((result) => markUploadResult(result.client_id, result));

      const failed = data.results.filter((r) => !r.success);
      if (failed.length) {
        setValidationMessage(fileError, failed[0].error || 'Some files failed to upload.', 'error');
      }
    };

    xhr.onerror = () => {
      batch.forEach((entry) =>
        markUploadResult(entry.id, { success: false, error: 'Network error while uploading. Please try again.' })
      );
      setValidationMessage(fileError, 'Network error while uploading. Please try again.', 'error');
    };

    xhr.send(formData);
  }

  function markUploadResult(localId, result) {
    const entry = selectedFiles.find((e) => e.id === localId);
    if (!entry) {
      // The user removed the chip before the upload response came
      // back — clean up the now-orphaned backend file immediately.
      if (result && result.success && currentUploadId && result.file_id) {
        deleteUploadedFile(currentUploadId, result.file_id);
      }
      return;
    }
    if (result && result.success) {
      entry.status = 'success';
      entry.fileId = result.file_id;
      entry.errorMessage = '';
    } else {
      entry.status = 'error';
      entry.errorMessage = (result && result.error) || 'Upload failed.';
    }
    renderAttachments();
  }

  function setChipProgress(localId, pct) {
    const bar = attachmentsList.querySelector(`[data-id="${localId}"] [data-role="progress"]`);
    if (bar) bar.style.width = pct + '%';
  }

  function deleteUploadedFile(uploadId, fileId) {
    return fetch(`/api/whatsapp/upload/${uploadId}/${fileId}`, { method: 'DELETE' }).catch(() => {
      // Best-effort: if this fails, the server's retention cleanup
      // will eventually reclaim the orphaned file.
    });
  }

  function removeFile(id) {
    const entry = selectedFiles.find((e) => e.id === id);
    const chip = attachmentsList.querySelector(`[data-id="${id}"]`);

    const doRemove = () => {
      selectedFiles = selectedFiles.filter((e) => e.id !== id);
      renderAttachments();
    };

    if (chip) {
      chip.classList.add('removing');
      setTimeout(doRemove, 220);
    } else {
      doRemove();
    }

    // Tell the backend too, so the temporary file is actually deleted
    // and isn't sent later.
    if (entry && entry.status === 'success' && entry.fileId && currentUploadId) {
      deleteUploadedFile(currentUploadId, entry.fileId);
    }
  }

  // ============================================================
  // COUNTRY DIAL-CODE DROPDOWN
  // ============================================================

  function renderCountryList(filterText) {
    const query = (filterText || '').trim().toLowerCase();
    const filtered = !query
      ? COUNTRIES
      : COUNTRIES.filter((c) =>
          c.name.toLowerCase().includes(query) || c.dial.includes(query.replace(/[^\d]/g, ''))
        );

    countryList.innerHTML = '';

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'country-empty-msg';
      empty.textContent = 'No matching country found.';
      countryList.appendChild(empty);
      return;
    }

    filtered.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'country-option';
      row.setAttribute('role', 'option');
      row.dataset.iso2 = c.iso2;
      row.innerHTML = `
        <span class="country-flag">${flagEmoji(c.iso2)}</span>
        <span class="country-name">${escapeHtml(c.name)}</span>
        <span class="country-dial-code">+${c.dial}</span>
      `;
      row.addEventListener('click', () => selectCountry(c));
      countryList.appendChild(row);
    });
  }

  function selectCountry(country) {
    selectedCountry = country;
    countryFlag.textContent = flagEmoji(country.iso2);
    countryDial.textContent = `+${country.dial}`;
    closeCountryDropdown();
    phoneInput.focus();
  }

  function openCountryDropdown() {
    countryDropdown.classList.add('open');
    countrySelectBtn.classList.add('open');
    countrySelectBtn.setAttribute('aria-expanded', 'true');
    countrySearch.value = '';
    renderCountryList('');
    setTimeout(() => countrySearch.focus(), 0);
  }

  function closeCountryDropdown() {
    countryDropdown.classList.remove('open');
    countrySelectBtn.classList.remove('open');
    countrySelectBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleCountryDropdown() {
    if (countryDropdown.classList.contains('open')) {
      closeCountryDropdown();
    } else {
      openCountryDropdown();
    }
  }

  // ============================================================
  // RIPPLE EFFECT (send button)
  // ============================================================

  function createRipple(event) {
    const btn = event.currentTarget;
    const ripple = document.createElement('span');
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;

    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    ripple.classList.add('ripple');
    btn.appendChild(ripple);

    setTimeout(() => {
      if (ripple.parentNode) ripple.remove();
    }, 700);
  }

  // ============================================================
  // BACKEND INTEGRATION
  // ============================================================

  function setSendingState(isSending) {
    sendBtn.classList.toggle('is-sending', isSending);
    sendBtn.disabled = isSending;
  }

  function pollJobStatus(jobId, attempt = 0) {
    fetch(`/api/whatsapp/status/${jobId}`)
      .then((res) => {
        if (!res.ok) throw new Error('Status check failed.');
        return res.json();
      })
      .then((job) => {
        if (job.status === 'success') {
          onSendSuccess(job.message);
        } else if (job.status === 'error') {
          onSendFailure(job.message || 'Sending failed. Please try again.');
        } else if (attempt < POLL_MAX_ATTEMPTS) {
          setValidationMessage(sendStatus, `⏳ ${job.message || 'Sending...'}`, 'success');
          pollTimer = setTimeout(() => pollJobStatus(jobId, attempt + 1), POLL_INTERVAL_MS);
        } else {
          onSendFailure('This is taking longer than expected. Please check WhatsApp Desktop and try again.');
        }
      })
      .catch(() => {
        onSendFailure('Network error while checking message status.');
      });
  }

  function onSendSuccess(detailMessage) {
    setSendingState(false);
    setValidationMessage(sendStatus, '✅ Message Sent Successfully', 'success');
    successDetail.textContent = detailMessage || 'Your WhatsApp message is on its way.';
    successOverlay.classList.add('visible');
  }

  function onSendFailure(errorMessage) {
    setSendingState(false);
    setValidationMessage(sendStatus, `❌ ${errorMessage}`, 'error');
  }

  async function sendWhatsAppMessage(phone, message) {
    const formData = new FormData();
    formData.append('number', phone);
    formData.append('message', message);

    // Attachments were already uploaded to the backend the moment
    // they were selected — we only send references to them here,
    // never the raw files again.
    if (currentUploadId) {
      formData.append('upload_id', currentUploadId);
      selectedFiles
        .filter((entry) => entry.status === 'success' && entry.fileId)
        .forEach((entry) => formData.append('file_ids', entry.fileId));
    }

    const response = await fetch('/api/whatsapp/send', {
      method: 'POST',
      body: formData,
    });

    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      // ignore parse errors, handled below
    }

    if (!response.ok) {
      throw new Error(data.error || 'Sending failed. Please try again.');
    }
    return data; // { job_id, status }
  }

  // ============================================================
  // MAIN HANDLER: Send Message
  // ============================================================

  async function handleSendMessage() {
    clearValidationMessages();

    const localNumber = phoneInput.value.trim();
    const phone = getFullE164Number();
    const message = messageInput.value;

    let hasError = false;

    if (!isValidWhatsAppNumber(localNumber)) {
      setValidationMessage(
        phoneError,
        '❌ Enter a valid WhatsApp number for the selected country.',
        'error'
      );
      hasError = true;
    }

    if (!message.trim() && selectedFiles.length === 0) {
      setValidationMessage(messageError, '❌ Type a message or attach a file.', 'error');
      hasError = true;
    }

    const stillUploading = selectedFiles.some((entry) => entry.status === 'uploading');
    const hasFailedUploads = selectedFiles.some((entry) => entry.status === 'error');

    if (stillUploading) {
      setValidationMessage(fileError, '⏳ Please wait for attachments to finish uploading.', 'error');
      hasError = true;
    } else if (hasFailedUploads) {
      setValidationMessage(fileError, '❌ Remove or fix the failed attachment(s) before sending.', 'error');
      hasError = true;
    }

    if (hasError) {
      setValidationMessage(sendStatus, '⚠️ Please fix the errors above.', 'error');
      return;
    }

    setSendingState(true);
    setValidationMessage(sendStatus, '⏳ Sending...', 'success');

    try {
      const result = await sendWhatsAppMessage(phone, message);
      if (result.job_id) {
        pollJobStatus(result.job_id);
      } else {
        onSendFailure('Unexpected response from the server.');
      }
    } catch (error) {
      onSendFailure(error.message || 'Failed to send message.');
    }
  }

  function resetFormAfterSuccess() {
    phoneInput.value = '';
    messageInput.value = '';
    selectedFiles = [];
    currentUploadId = null;
    renderAttachments();
    clearValidationMessages();
    successOverlay.classList.remove('visible');
  }

  // ============================================================
  // INPUT CLEANUP (auto-format phone)
  // ============================================================

  function formatPhoneInput() {
    let val = phoneInput.value.trim();
    val = val.replace(/[^\d\s]/g, '');
    phoneInput.value = val;
  }

  // ============================================================
  // EVENT BINDING
  // ============================================================

  sendBtn.addEventListener('click', function (event) {
    if (sendBtn.disabled) return;
    createRipple(event);
    setTimeout(() => handleSendMessage(), 150);
  });

  browseBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (event) => {
    addFiles(event.target.files);
    fileInput.value = ''; // allow re-selecting the same file later
  });

  // Drag & drop onto the browse button area
  browseBtn.addEventListener('dragover', (event) => {
    event.preventDefault();
    browseBtn.style.borderColor = '#a855f7';
  });
  browseBtn.addEventListener('dragleave', () => {
    browseBtn.style.borderColor = '';
  });
  browseBtn.addEventListener('drop', (event) => {
    event.preventDefault();
    browseBtn.style.borderColor = '';
    if (event.dataTransfer && event.dataTransfer.files) {
      addFiles(event.dataTransfer.files);
    }
  });

  countrySelectBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleCountryDropdown();
  });

  countrySearch.addEventListener('input', () => {
    renderCountryList(countrySearch.value);
  });

  countrySearch.addEventListener('click', (event) => event.stopPropagation());

  document.addEventListener('click', (event) => {
    if (!countryDropdown.contains(event.target) && !countrySelectBtn.contains(event.target)) {
      closeCountryDropdown();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && countryDropdown.classList.contains('open')) {
      closeCountryDropdown();
    }
  });

  // Initialize the country button to reflect the default selection.
  countryFlag.textContent = flagEmoji(selectedCountry.iso2);
  countryDial.textContent = `+${selectedCountry.dial}`;

  phoneInput.addEventListener('blur', formatPhoneInput);

  phoneInput.addEventListener('input', () => {
    if (phoneError.textContent) setValidationMessage(phoneError, '', '');
    if (sendStatus.textContent) setValidationMessage(sendStatus, '', '');
  });

  messageInput.addEventListener('input', () => {
    if (messageError.textContent) setValidationMessage(messageError, '', '');
    if (sendStatus.textContent) setValidationMessage(sendStatus, '', '');
  });

  messageInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      sendBtn.click();
    }
  });

  successCloseBtn.addEventListener('click', resetFormAfterSuccess);

  window.addEventListener('beforeunload', () => {
    if (pollTimer) clearTimeout(pollTimer);
  });

  console.log('S.N.E.T.C.H · AI WhatsApp Messenger ready ✅');

})();