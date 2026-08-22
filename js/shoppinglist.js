// ============================================================
// SHOPPINGLIST.JS - S.N.E.T.C.H Shopping Planner
// Fully wired to the Flask + SQLite backend (see shopinglist.py)
// ============================================================

const API_BASE = '/api/shopping';

// ---------- STATE ----------
let selectedListId = null;
let currentDropdownListId = null;
let currentView = 'default'; // default | cards | show-list | progress
let updateItemSelection = null; // item object chosen in the Update Item flow

// ---------- DOM REFS ----------
const recentContainer = document.getElementById('recentListContainer');
const pinnedContainer = document.getElementById('pinnedListContainer');
const defaultPanel = document.getElementById('defaultPanel');
const actionCards = document.getElementById('actionCards');
const searchPanel = document.getElementById('searchPanel');
const archivePanel = document.getElementById('archivePanel');
const pinnedPanel = document.getElementById('pinnedPanel');
const showListPanel = document.getElementById('showListPanel');
const progressPanel = document.getElementById('progressPanel');
const activeListBanner = document.getElementById('activeListBanner');
const activeListName = document.getElementById('activeListName');
const activeListDate = document.getElementById('activeListDate');
const threeDotDropdown = document.getElementById('threeDotDropdown');
const modalOverlay = document.getElementById('modalOverlay');
const modalContent = document.getElementById('modalContent');
const toast = document.getElementById('toast');

// ============================================================
// API HELPERS
// ============================================================
async function api(path, options = {}) {
    const opts = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options);
    const res = await fetch(API_BASE + path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
        const message = (data && data.error) ? data.error : `Request failed (${res.status})`;
        throw new Error(message);
    }
    return data;
}

function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.className = 'toast hidden'; }, 2600);
}

// ============================================================
// UTILITIES
// ============================================================
function todayISO() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDisplayDate(isoOrRaw) {
    const d = new Date(isoOrRaw);
    if (isNaN(d.getTime())) return isoOrRaw;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, s => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[s]));
}

function unitLabel(unit, qty) {
    const plural = (qty !== 1 && qty !== '1');
    const map = {
        piece: plural ? 'pcs' : 'pc',
        dozen: plural ? 'dozen' : 'dozen',
        kg: 'kg', g: 'g', l: 'L', ml: 'ml',
        packet: plural ? 'packets' : 'packet',
        box: plural ? 'boxes' : 'box',
        jar: plural ? 'jars' : 'jar',
        tube: plural ? 'tubes' : 'tube',
        roll: plural ? 'rolls' : 'roll',
        carton: plural ? 'cartons' : 'carton',
        sack: plural ? 'sacks' : 'sack',
        bag: plural ? 'bags' : 'bag',
        bucket: plural ? 'buckets' : 'bucket',
        bottle: plural ? 'bottles' : 'bottle',
        can: plural ? 'cans' : 'can',
        loaf: plural ? 'loaves' : 'loaf',
        bunch: plural ? 'bunches' : 'bunch',
        tray: plural ? 'trays' : 'tray',
    };
    return map[unit] || unit;
}

function hideAllPanels() {
    defaultPanel.classList.add('hidden');
    actionCards.classList.add('hidden');
    searchPanel.classList.add('hidden');
    archivePanel.classList.add('hidden');
    pinnedPanel.classList.add('hidden');
    showListPanel.classList.add('hidden');
    progressPanel.classList.add('hidden');
}

function setActiveNav(action) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (action) {
        const el = document.querySelector(`[data-action="${action}"]`);
        if (el) el.classList.add('active');
    }
}

// ============================================================
// SIDEBAR: LOAD & RENDER LISTS
// ============================================================
async function loadSidebarLists() {
    try {
        const data = await api('/lists');
        renderSidebar(data.lists || []);
    } catch (e) {
        showToast('Could not load shopping lists.', 'error');
    }
}

function renderSidebar(lists) {
    const pinned = lists.filter(l => l.pinned);
    const recent = lists.filter(l => !l.pinned);

    pinnedContainer.innerHTML = pinned.length
        ? pinned.map(createListItemHTML).join('')
        : '<li class="empty-archive" style="padding:8px 10px;">No pinned lists</li>';
    recentContainer.innerHTML = recent.length
        ? recent.map(createListItemHTML).join('')
        : '<li class="empty-archive" style="padding:8px 10px;">No lists yet</li>';

    document.querySelectorAll('.list-item .three-dot-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const listId = btn.dataset.listId;
            const rect = btn.getBoundingClientRect();
            showDropdown(rect.left, rect.bottom, listId, lists);
        });
    });

    document.querySelectorAll('.list-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.three-dot-btn')) return;
            selectList(item.dataset.listId);
        });
    });
}

function createListItemHTML(list) {
    const pinnedIcon = list.pinned ? '<i class="fas fa-thumbtack pin-icon"></i>' : '';
    return `
        <li class="list-item" data-list-id="${list.id}">
            <span class="list-icon"><i class="fas fa-shopping-cart"></i></span>
            <span class="list-name">${escapeHtml(list.name)}</span>
            <span class="list-date">${formatDisplayDate(list.date)}</span>
            ${pinnedIcon}
            <button class="three-dot-btn" data-list-id="${list.id}"><i class="fas fa-ellipsis-v"></i></button>
        </li>
    `;
}

// ============================================================
// SIDEBAR NAVIGATION
// ============================================================
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const action = item.dataset.action;
        setActiveNav(action);
        hideAllPanels();
        selectedListId = null;
        activeListBanner.classList.add('hidden');

        if (action === 'home') {
            currentView = 'default';
            defaultPanel.classList.remove('hidden');
            loadSidebarLists();
        } else if (action === 'new-list') {
            openNewListModal();
            setActiveNav('home');
        } else if (action === 'search') {
            currentView = 'search';
            searchPanel.classList.remove('hidden');
            document.getElementById('searchInput').value = '';
            document.getElementById('searchResults').innerHTML = '';
        } else if (action === 'archive') {
            currentView = 'archive';
            renderArchivePanel();
            archivePanel.classList.remove('hidden');
        } else if (action === 'pinned') {
            currentView = 'pinned';
            renderPinnedPanel();
            pinnedPanel.classList.remove('hidden');
        }
    });
});

document.getElementById('closeActiveListBtn').addEventListener('click', () => {
    setActiveNav('home');
    hideAllPanels();
    selectedListId = null;
    activeListBanner.classList.add('hidden');
    currentView = 'default';
    defaultPanel.classList.remove('hidden');
    loadSidebarLists();
});

// ============================================================
// SELECT A LIST -> SHOW ACTION CARDS
// ============================================================
async function selectList(id) {
    try {
        const data = await api(`/lists/${id}`);
        selectedListId = id;
        currentView = 'cards';
        hideAllPanels();
        setActiveNav(null);
        activeListBanner.classList.remove('hidden');
        activeListName.textContent = data.list.name;
        activeListDate.textContent = formatDisplayDate(data.list.date);
        actionCards.classList.remove('hidden');
        loadSidebarLists();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ============================================================
// ACTION CARDS
// ============================================================
document.querySelectorAll('.card-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (!selectedListId) {
            showToast('Select or create a shopping list first.', 'error');
            return;
        }
        const action = btn.dataset.action;
        if (action === 'add-item') openAddItemModal();
        else if (action === 'update-item') openUpdateItemModal();
        else if (action === 'delete-item') openDeleteItemModal();
        else if (action === 'show-list') openShowListPanel();
        else if (action === 'progress') openProgressPanel();
    });
});

document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        hideAllPanels();
        actionCards.classList.remove('hidden');
        currentView = 'cards';
    });
});

// ============================================================
// NEW SHOPPING LIST
// ============================================================
function openNewListModal() {
    modalOverlay.classList.remove('hidden');
    modalContent.innerHTML = `
        <h3><i class="fas fa-plus-circle"></i> New Shopping List</h3>
        <label class="form-label">Shopping List Name</label>
        <input type="text" id="newListName" placeholder="e.g. Weekly Groceries" />
        <label class="form-label">Shopping Date</label>
        <input type="date" id="newListDate" value="${todayISO()}" />
        <button id="newListSaveBtn" class="modal-btn">Create Shopping List</button>
    `;
    document.getElementById('newListName').focus();
    document.getElementById('newListSaveBtn').addEventListener('click', async () => {
        const name = document.getElementById('newListName').value.trim();
        const date = document.getElementById('newListDate').value || todayISO();
        if (!name) { showToast('Please enter a shopping list name.', 'error'); return; }
        try {
            const data = await api('/lists', { method: 'POST', body: JSON.stringify({ name, date }) });
            closeModal();
            showToast('Shopping list created.');
            await loadSidebarLists();
            selectList(data.list.id);
        } catch (e) {
            showToast(e.message, 'error');
        }
    });
}

// ============================================================
// ADD ITEM
// ============================================================
function openAddItemModal() {
    modalOverlay.classList.remove('hidden');
    modalContent.innerHTML = `
        <h3><i class="fas fa-plus-circle"></i> Add Item(s)</h3>
        <label class="form-label">Enter item(s) — natural language, comma separated</label>
        <textarea id="addItemInput" placeholder="e.g. 1 kg rice, 2 litre milk, 12 eggs, dozen bananas"></textarea>
        <p class="form-hint">Understands formats like "4 kg rice", "rice 4kg", "2L milk", "half kg paneer", "1 dozen eggs", or just "bread".</p>
        <button id="addItemSaveBtn" class="modal-btn"><i class="fas fa-check"></i> Save</button>
    `;
    document.getElementById('addItemInput').focus();
    document.getElementById('addItemSaveBtn').addEventListener('click', async () => {
        const text = document.getElementById('addItemInput').value.trim();
        if (!text) { showToast('Please enter at least one item.', 'error'); return; }
        try {
            const data = await api(`/lists/${selectedListId}/items`, {
                method: 'POST', body: JSON.stringify({ text })
            });
            closeModal();
            const addedCount = (data.added || []).length;
            const skippedCount = (data.skipped_duplicates || []).length;
            let msg = `Added ${addedCount} item${addedCount === 1 ? '' : 's'}.`;
            if (skippedCount) msg += ` ${skippedCount} duplicate${skippedCount === 1 ? '' : 's'} skipped.`;
            showToast(msg);
            if (currentView === 'show-list') renderShowList(data.items, data.summary);
            if (currentView === 'progress') renderProgress(data.items, data.summary);
        } catch (e) {
            showToast(e.message, 'error');
        }
    });
}

// ============================================================
// UPDATE ITEM (select ONE, then edit)
// ============================================================
async function openUpdateItemModal() {
    modalOverlay.classList.remove('hidden');
    modalContent.innerHTML = `<div class="spinner"></div>`;
    try {
        const data = await api(`/lists/${selectedListId}/items`);
        const items = data.items || [];
        if (!items.length) {
            modalContent.innerHTML = `<h3><i class="fas fa-edit"></i> Update Item</h3><p class="form-hint">This shopping list has no items yet.</p>`;
            return;
        }
        modalContent.innerHTML = `
            <h3><i class="fas fa-edit"></i> Update Item</h3>
            <label class="form-label">Select ONE item to edit</label>
            <div class="select-item-list" id="updateSelectList">
                ${items.map(it => `
                    <label class="select-item-row" data-id="${it.id}">
                        <input type="radio" name="updateItemRadio" value="${it.id}" />
                        <span class="select-item-label">${escapeHtml(it.name)} — ${it.qty} ${unitLabel(it.unit, it.qty)}</span>
                    </label>
                `).join('')}
            </div>
            <button id="updateNextBtn" class="modal-btn">Next</button>
        `;
        modalContent.querySelectorAll('.select-item-row').forEach(row => {
            row.addEventListener('click', () => {
                modalContent.querySelectorAll('.select-item-row').forEach(r => r.classList.remove('checked'));
                row.classList.add('checked');
                row.querySelector('input').checked = true;
            });
        });
        document.getElementById('updateNextBtn').addEventListener('click', () => {
            const checked = modalContent.querySelector('input[name="updateItemRadio"]:checked');
            if (!checked) { showToast('Please select an item.', 'error'); return; }
            const item = items.find(i => i.id === checked.value);
            renderUpdateItemForm(item);
        });
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function renderUpdateItemForm(item) {
    modalContent.innerHTML = `
        <h3><i class="fas fa-edit"></i> Update "${escapeHtml(item.name)}"</h3>
        <label class="form-label">Item Name</label>
        <input type="text" id="editItemName" value="${escapeHtml(item.name)}" />
        <div class="modal-row">
            <div>
                <label class="form-label">Quantity</label>
                <input type="number" id="editItemQty" value="${item.qty}" min="0" step="any" />
            </div>
            <div>
                <label class="form-label">Unit</label>
                <select id="editItemUnit">
                    ${['piece','kg','g','l','ml','dozen','packet','box','jar','tube','roll','carton','sack','bag','bucket','bottle','can','loaf','bunch','tray']
                        .map(u => `<option value="${u}" ${u === item.unit ? 'selected' : ''}>${unitLabel(u, 2)}</option>`).join('')}
                </select>
            </div>
        </div>
        <div class="modal-actions">
            <button id="updateBackBtn" class="modal-btn secondary">Back</button>
            <button id="updateSaveBtn" class="modal-btn">Save</button>
        </div>
    `;
    document.getElementById('updateBackBtn').addEventListener('click', openUpdateItemModal);
    document.getElementById('updateSaveBtn').addEventListener('click', async () => {
        const name = document.getElementById('editItemName').value.trim();
        const qty = parseFloat(document.getElementById('editItemQty').value);
        const unit = document.getElementById('editItemUnit').value;
        if (!name) { showToast('Item name cannot be empty.', 'error'); return; }
        if (isNaN(qty) || qty <= 0) { showToast('Please enter a valid quantity.', 'error'); return; }
        try {
            const data = await api(`/items/${item.id}`, {
                method: 'PUT', body: JSON.stringify({ name, qty, unit })
            });
            closeModal();
            showToast('Item updated.');
            if (currentView === 'show-list') renderShowList(data.items, data.summary);
            if (currentView === 'progress') renderProgress(data.items, data.summary);
        } catch (e) {
            showToast(e.message, 'error');
        }
    });
}

// ============================================================
// DELETE ITEM (one / multiple / select all)
// ============================================================
async function openDeleteItemModal() {
    modalOverlay.classList.remove('hidden');
    modalContent.innerHTML = `<div class="spinner"></div>`;
    try {
        const data = await api(`/lists/${selectedListId}/items`);
        const items = data.items || [];
        if (!items.length) {
            modalContent.innerHTML = `<h3><i class="fas fa-trash-alt"></i> Delete Item</h3><p class="form-hint">This shopping list has no items yet.</p>`;
            return;
        }
        modalContent.innerHTML = `
            <h3><i class="fas fa-trash-alt"></i> Delete Item(s)</h3>
            <div class="select-all-row">
                <input type="checkbox" id="deleteSelectAll" /> <span>Select All</span>
            </div>
            <div class="select-item-list" id="deleteSelectList">
                ${items.map(it => `
                    <label class="select-item-row" data-id="${it.id}">
                        <input type="checkbox" class="deleteItemCheckbox" value="${it.id}" />
                        <span class="select-item-label">${escapeHtml(it.name)} — ${it.qty} ${unitLabel(it.unit, it.qty)}</span>
                    </label>
                `).join('')}
            </div>
            <button id="deleteConfirmBtn" class="modal-btn danger"><i class="fas fa-trash"></i> Delete Selected</button>
        `;
        const syncRowState = (checkbox) => {
            const row = checkbox.closest('.select-item-row');
            row.classList.toggle('checked', checkbox.checked);
        };
        modalContent.querySelectorAll('.select-item-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.tagName.toLowerCase() === 'input') return;
                const cb = row.querySelector('input');
                cb.checked = !cb.checked;
                syncRowState(cb);
            });
        });
        modalContent.querySelectorAll('.deleteItemCheckbox').forEach(cb => {
            cb.addEventListener('change', () => syncRowState(cb));
        });
        document.getElementById('deleteSelectAll').addEventListener('change', (e) => {
            modalContent.querySelectorAll('.deleteItemCheckbox').forEach(cb => {
                cb.checked = e.target.checked;
                syncRowState(cb);
            });
        });
        document.getElementById('deleteConfirmBtn').addEventListener('click', async () => {
            const ids = Array.from(modalContent.querySelectorAll('.deleteItemCheckbox:checked')).map(cb => cb.value);
            if (!ids.length) { showToast('Select at least one item to delete.', 'error'); return; }
            try {
                const result = await api('/items/delete', { method: 'POST', body: JSON.stringify({ ids }) });
                closeModal();
                showToast(`Deleted ${ids.length} item${ids.length === 1 ? '' : 's'}.`);
                const refreshed = await api(`/lists/${selectedListId}/items`);
                if (currentView === 'show-list') renderShowList(refreshed.items, refreshed.summary);
                if (currentView === 'progress') renderProgress(refreshed.items, refreshed.summary);
            } catch (e) {
                showToast(e.message, 'error');
            }
        });
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ============================================================
// SHOW SHOPPING LIST
// ============================================================
async function openShowListPanel() {
    hideAllPanels();
    showListPanel.classList.remove('hidden');
    currentView = 'show-list';
    document.getElementById('showListBody').innerHTML = `<div class="spinner"></div>`;
    try {
        const data = await api(`/lists/${selectedListId}/items`);
        renderShowList(data.items, data.summary);
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function renderShowList(items, summary) {
    const body = document.getElementById('showListBody');
    if (!items.length) {
        body.innerHTML = `<div class="empty-items"><i class="fas fa-shopping-basket"></i>This shopping list has no items yet.</div>`;
    } else {
        body.innerHTML = `
            <div class="table-scroll">
            <table class="item-table">
                <thead>
                    <tr><th>Item</th><th>Qty</th><th>Unit</th><th>Status</th><th>Price</th></tr>
                </thead>
                <tbody>
                    ${items.map(it => `
                        <tr class="item-row ${it.purchased ? 'purchased-row' : ''}">
                            <td class="item-name">${escapeHtml(it.name)}</td>
                            <td>${it.qty}</td>
                            <td>${unitLabel(it.unit, it.qty)}</td>
                            <td>
                                ${it.purchased
                                    ? '<span class="status-pill purchased"><i class="fas fa-check"></i> Purchased</span><span class="check-badge"><i class="fas fa-check-circle"></i></span>'
                                    : '<span class="status-pill pending"><i class="fas fa-clock"></i> Pending</span>'}
                            </td>
                            <td>${it.purchased ? ('Rs. ' + Number(it.price).toFixed(2)) : '—'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            </div>
        `;
    }
    renderTotals('showListTotals', summary);
}

function renderTotals(containerId, summary) {
    document.getElementById(containerId).innerHTML = `
        <div class="totals-chip">
            <div class="totals-value">${summary.purchased_items}</div>
            <div class="totals-label">Purchased</div>
        </div>
        <div class="totals-chip">
            <div class="totals-value">${summary.remaining_items}</div>
            <div class="totals-label">Remaining</div>
        </div>
        <div class="totals-chip cost">
            <div class="totals-value">Rs. ${Number(summary.total_cost).toFixed(2)}</div>
            <div class="totals-label">Total Shopping Cost</div>
        </div>
    `;
}

// ============================================================
// SHOPPING PROGRESS
// ============================================================
async function openProgressPanel() {
    hideAllPanels();
    progressPanel.classList.remove('hidden');
    currentView = 'progress';
    document.getElementById('progressBody').innerHTML = `<div class="spinner"></div>`;
    try {
        const data = await api(`/lists/${selectedListId}/items`);
        renderProgress(data.items, data.summary);
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function renderProgress(items, summary) {
    const body = document.getElementById('progressBody');
    if (!items.length) {
        body.innerHTML = `<div class="empty-items"><i class="fas fa-check-circle"></i>Nothing to track yet — add some items first.</div>`;
    } else {
        body.innerHTML = items.map(it => `
            <div class="progress-item ${it.purchased ? 'is-purchased' : ''}" data-id="${it.id}">
                <div class="progress-item-info">
                    <div class="progress-item-name">${escapeHtml(it.name)} ${it.purchased ? '<span class="check-badge"><i class="fas fa-check-circle"></i></span>' : ''}</div>
                    <div class="progress-item-meta">${it.qty} ${unitLabel(it.unit, it.qty)}</div>
                </div>
                ${it.purchased ? `<span class="progress-price">Rs. ${Number(it.price).toFixed(2)}</span>` : ''}
                <button class="mark-purchased-btn ${it.purchased ? 'purchased-btn' : ''}" data-id="${it.id}" data-purchased="${it.purchased}">
                    ${it.purchased ? '<i class="fas fa-undo"></i> Undo' : '<i class="fas fa-check"></i> Mark as Purchased'}
                </button>
            </div>
        `).join('');

        body.querySelectorAll('.mark-purchased-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const isPurchased = btn.dataset.purchased === 'true';
                if (isPurchased) {
                    unpurchaseItem(id);
                } else {
                    openPurchasePriceModal(id);
                }
            });
        });
    }
    renderTotals('progressTotals', summary);
}

function openPurchasePriceModal(itemId) {
    modalOverlay.classList.remove('hidden');
    modalContent.innerHTML = `
        <h3><i class="fas fa-tag"></i> Enter Purchase Price</h3>
        <label class="form-label">Price Paid</label>
        <input type="number" id="purchasePriceInput" min="0" step="any" placeholder="e.g. 120" />
        <button id="purchaseSaveBtn" class="modal-btn"><i class="fas fa-check"></i> Confirm Purchase</button>
    `;
    document.getElementById('purchasePriceInput').focus();
    document.getElementById('purchaseSaveBtn').addEventListener('click', async () => {
        const price = parseFloat(document.getElementById('purchasePriceInput').value);
        if (isNaN(price) || price < 0) { showToast('Please enter a valid price.', 'error'); return; }
        try {
            const data = await api(`/items/${itemId}/purchase`, {
                method: 'POST', body: JSON.stringify({ price })
            });
            closeModal();
            showToast('Item marked as purchased.');
            renderProgress(data.items, data.summary);
        } catch (e) {
            showToast(e.message, 'error');
        }
    });
}

async function unpurchaseItem(itemId) {
    try {
        const data = await api(`/items/${itemId}/unpurchase`, { method: 'POST' });
        renderProgress(data.items, data.summary);
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ============================================================
// THREE-DOT DROPDOWN
// ============================================================
function showDropdown(x, y, listId, lists) {
    currentDropdownListId = listId;
    threeDotDropdown.classList.remove('hidden');
    threeDotDropdown.style.left = x + 'px';
    threeDotDropdown.style.top = y + 'px';

    const list = (lists || []).find(l => l.id === listId);
    const pinOpt = threeDotDropdown.querySelector('[data-opt="pin"]');
    if (list) {
        pinOpt.innerHTML = list.pinned
            ? '<i class="fas fa-thumbtack"></i> Unpin Shopping List'
            : '<i class="fas fa-thumbtack"></i> Pin Shopping List';
    }
}

document.addEventListener('click', (e) => {
    if (!threeDotDropdown.contains(e.target) && !e.target.closest('.three-dot-btn')) {
        threeDotDropdown.classList.add('hidden');
    }
});

threeDotDropdown.querySelectorAll('li').forEach(opt => {
    opt.addEventListener('click', async () => {
        const action = opt.dataset.opt;
        const listId = currentDropdownListId;
        threeDotDropdown.classList.add('hidden');
        if (!listId) return;

        try {
            if (action === 'rename') {
                const data = await api(`/lists/${listId}`);
                showRenameModal(data.list);
            } else if (action === 'delete') {
                if (await customConfirm('Delete this shopping list permanently?')) {
                    await api(`/lists/${listId}`, { method: 'DELETE' });
                    if (selectedListId === listId) {
                        selectedListId = null;
                        hideAllPanels();
                        activeListBanner.classList.add('hidden');
                        defaultPanel.classList.remove('hidden');
                        setActiveNav('home');
                    }
                    showToast('Shopping list deleted.');
                    loadSidebarLists();
                    if (currentView === 'archive') renderArchivePanel();
                }
            } else if (action === 'pin') {
                const data = await api(`/lists/${listId}`);
                await api(`/lists/${listId}`, { method: 'PATCH', body: JSON.stringify({ pinned: !data.list.pinned }) });
                showToast(data.list.pinned ? 'Shopping list unpinned.' : 'Shopping list pinned.');
                loadSidebarLists();
                if (currentView === 'pinned') renderPinnedPanel();
            } else if (action === 'download') {
                window.open(`${API_BASE}/lists/${listId}/download`, '_blank');
            } else if (action === 'archive') {
                await api(`/lists/${listId}`, { method: 'PATCH', body: JSON.stringify({ archived: true, pinned: false }) });
                if (selectedListId === listId) {
                    selectedListId = null;
                    hideAllPanels();
                    activeListBanner.classList.add('hidden');
                    defaultPanel.classList.remove('hidden');
                    setActiveNav('home');
                }
                showToast('Shopping list archived.');
                loadSidebarLists();
            }
        } catch (e) {
            showToast(e.message, 'error');
        }
    });
});

function showRenameModal(list) {
    modalOverlay.classList.remove('hidden');
    modalContent.innerHTML = `
        <h3><i class="fas fa-pen"></i> Rename Shopping List</h3>
        <label class="form-label">Shopping List Name</label>
        <input type="text" id="renameInput" value="${escapeHtml(list.name)}" />
        <button id="renameSaveBtn" class="modal-btn">Save</button>
    `;
    document.getElementById('renameInput').focus();
    document.getElementById('renameSaveBtn').addEventListener('click', async () => {
        const newName = document.getElementById('renameInput').value.trim();
        if (!newName) { showToast('Name cannot be empty.', 'error'); return; }
        try {
            await api(`/lists/${list.id}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
            closeModal();
            showToast('Shopping list renamed.');
            loadSidebarLists();
            if (selectedListId === list.id) activeListName.textContent = newName;
        } catch (e) {
            showToast(e.message, 'error');
        }
    });
}

// ============================================================
// MODAL HELPERS
// ============================================================
function closeModal() {
    modalOverlay.classList.add('hidden');
    modalContent.innerHTML = '';
}
modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
});
document.addEventListener('click', (e) => {
    if (e.target.closest('.modal-close')) closeModal();
});

// close dropdown on scroll or resize
window.addEventListener('scroll', () => threeDotDropdown.classList.add('hidden'));
window.addEventListener('resize', () => threeDotDropdown.classList.add('hidden'));

// ============================================================
// SEARCH
// ============================================================
let searchDebounce = null;
document.getElementById('searchInput').addEventListener('input', function () {
    const query = this.value.trim();
    const results = document.getElementById('searchResults');
    clearTimeout(searchDebounce);
    if (!query) { results.innerHTML = ''; return; }
    searchDebounce = setTimeout(async () => {
        try {
            const data = await api(`/search?q=${encodeURIComponent(query)}`);
            const matched = data.lists || [];
            if (!matched.length) {
                results.innerHTML = '<p class="no-results">No matching lists found.</p>';
                return;
            }
            results.innerHTML = matched.map(list => `
                <div class="search-result-item" data-id="${list.id}">
                    <i class="fas fa-shopping-cart"></i> ${escapeHtml(list.name)}
                    <span class="result-date">${formatDisplayDate(list.date)}</span>
                    ${list.archived ? '<span class="archived-badge">(archived)</span>' : ''}
                </div>
            `).join('');
            results.querySelectorAll('.search-result-item').forEach(el => {
                el.addEventListener('click', () => {
                    const list = matched.find(l => l.id === el.dataset.id);
                    if (list && list.archived) {
                        showToast('This list is archived. Restore it from Archive first.', 'error');
                    } else {
                        selectList(el.dataset.id);
                    }
                });
            });
        } catch (e) {
            results.innerHTML = '<p class="no-results">Search failed. Please try again.</p>';
        }
    }, 250);
});

// ============================================================
// ARCHIVE PANEL
// ============================================================
async function renderArchivePanel() {
    const container = document.getElementById('archiveListContainer');
    container.innerHTML = `<div class="spinner"></div>`;
    try {
        const data = await api('/lists/archived');
        const archivedLists = data.lists || [];
        if (!archivedLists.length) {
            container.innerHTML = '<p class="empty-archive">No archived lists.</p>';
            return;
        }
        container.innerHTML = archivedLists.map(list => `
            <div class="archive-item">
                <span><i class="fas fa-shopping-cart"></i> ${escapeHtml(list.name)}</span>
                <span>${formatDisplayDate(list.date)}</span>
                <div>
                    <button class="archive-restore" data-id="${list.id}"><i class="fas fa-undo"></i> Restore</button>
                    <button class="archive-delete" data-id="${list.id}"><i class="fas fa-trash"></i> Delete</button>
                </div>
            </div>
        `).join('');
        container.querySelectorAll('.archive-restore').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await api(`/lists/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ archived: false }) });
                    showToast('Shopping list restored.');
                    renderArchivePanel();
                    loadSidebarLists();
                } catch (e) {
                    showToast(e.message, 'error');
                }
            });
        });
        container.querySelectorAll('.archive-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!(await customConfirm('Delete this archived list permanently?'))) return;
                try {
                    await api(`/lists/${btn.dataset.id}`, { method: 'DELETE' });
                    showToast('Shopping list deleted.');
                    renderArchivePanel();
                } catch (e) {
                    showToast(e.message, 'error');
                }
            });
        });
    } catch (e) {
        container.innerHTML = '<p class="empty-archive">Could not load archived lists.</p>';
    }
}

// ============================================================
// PINNED PANEL
// ============================================================
async function renderPinnedPanel() {
    const container = document.getElementById('pinnedPanelContainer');
    container.innerHTML = `<div class="spinner"></div>`;
    try {
        const data = await api('/lists');
        const pinned = (data.lists || []).filter(l => l.pinned);
        if (!pinned.length) {
            container.innerHTML = '<p class="empty-pinned">No pinned lists.</p>';
            return;
        }
        container.innerHTML = pinned.map(list => `
            <div class="pinned-item">
                <span><i class="fas fa-thumbtack"></i> ${escapeHtml(list.name)}</span>
                <span>${formatDisplayDate(list.date)}</span>
                <button class="unpin-btn" data-id="${list.id}"><i class="fas fa-thumbtack"></i> Unpin</button>
            </div>
        `).join('');
        container.querySelectorAll('.unpin-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await api(`/lists/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: false }) });
                    showToast('Shopping list unpinned.');
                    renderPinnedPanel();
                    loadSidebarLists();
                } catch (e) {
                    showToast(e.message, 'error');
                }
            });
        });
    } catch (e) {
        container.innerHTML = '<p class="empty-pinned">Could not load pinned lists.</p>';
    }
}

// ============================================================
// INIT
// ============================================================
loadSidebarLists();
defaultPanel.classList.remove('hidden');
actionCards.classList.add('hidden');

// ==========================================
// CUSTOM UI MODALS
// ==========================================
function showCustomModal({ title, isConfirm = false, onConfirm = null }) {
  const overlay = document.createElement('div');
  overlay.className = 'custom-modal-overlay';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    background: 'rgba(10, 10, 26, 0.7)', backdropFilter: 'blur(10px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: '10000', opacity: '0', transition: 'opacity 0.3s ease'
  });

  const modal = document.createElement('div');
  modal.className = 'custom-modal';
  Object.assign(modal.style, {
    background: 'linear-gradient(145deg, rgba(30,30,50,0.9), rgba(20,20,40,0.95))',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px',
    padding: '30px', width: '90%', maxWidth: '400px',
    boxShadow: '0 15px 35px rgba(0,0,0,0.5), 0 0 20px rgba(138, 43, 226, 0.2)',
    color: '#fff', fontFamily: "'Inter', sans-serif",
    transform: 'translateY(-20px) scale(0.95)', transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)'
  });

  const titleEl = document.createElement('h3');
  titleEl.textContent = title;
  Object.assign(titleEl.style, { margin: '0 0 20px 0', fontSize: '1.2rem', fontWeight: '600', lineHeight: '1.4' });
  modal.appendChild(titleEl);

  const btnContainer = document.createElement('div');
  Object.assign(btnContainer.style, { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' });

  const btnCancel = document.createElement('button');
  btnCancel.textContent = 'Cancel';
  Object.assign(btnCancel.style, {
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
    color: '#fff', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer',
    fontWeight: '500', transition: 'all 0.2s'
  });
  btnCancel.onmouseover = () => { btnCancel.style.background = 'rgba(255,255,255,0.1)'; };
  btnCancel.onmouseout = () => { btnCancel.style.background = 'rgba(255,255,255,0.05)'; };
  
  const btnConfirm = document.createElement('button');
  btnConfirm.textContent = 'OK';
  Object.assign(btnConfirm.style, {
    background: 'linear-gradient(135deg, #8a2be2, #4b0082)', border: 'none',
    color: '#fff', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer',
    fontWeight: '500', boxShadow: '0 4px 15px rgba(138,43,226,0.3)', transition: 'all 0.2s'
  });
  btnConfirm.onmouseover = () => { btnConfirm.style.transform = 'translateY(-2px)'; btnConfirm.style.boxShadow = '0 6px 20px rgba(138,43,226,0.4)'; };
  btnConfirm.onmouseout = () => { btnConfirm.style.transform = 'translateY(0)'; btnConfirm.style.boxShadow = '0 4px 15px rgba(138,43,226,0.3)'; };

  const close = (result) => {
    overlay.style.opacity = '0';
    modal.style.transform = 'translateY(20px) scale(0.95)';
    setTimeout(() => { document.body.removeChild(overlay); if (onConfirm) onConfirm(result); }, 300);
  };

  btnCancel.onclick = () => close(false);
  btnConfirm.onclick = () => { close(true); };

  btnContainer.appendChild(btnCancel);
  btnContainer.appendChild(btnConfirm);
  modal.appendChild(btnContainer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  void overlay.offsetWidth;
  overlay.style.opacity = '1';
  modal.style.transform = 'translateY(0) scale(1)';
}

function customConfirm(message) {
  return new Promise(resolve => {
    showCustomModal({ title: message, isConfirm: true, onConfirm: resolve });
  });
}