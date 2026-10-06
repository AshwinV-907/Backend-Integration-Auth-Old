/**
 * TaskFlow Interactive Frontend Engine
 * Handles live search, dynamic sorting, layout toggling, markdown rendering,
 * modal dialogs, clipboard actions, keyboard shortcuts, and toast notifications.
 */

// Simple lightweight markdown parser (Zero external dependencies)
function parseMarkdown(text) {
    if (!text) return '';
    
    // Escape HTML first to prevent XSS
    let escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Code blocks ```code```
    escaped = escaped.replace(/```([\s\S]*?)```/g, function(match, code) {
        return '<pre><code>' + code.trim() + '</code></pre>';
    });

    // Inline code `code`
    escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    escaped = escaped.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    escaped = escaped.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    escaped = escaped.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Blockquotes
    escaped = escaped.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

    // Bold & Italics
    escaped = escaped.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
    escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Task list / Checkboxes
    escaped = escaped.replace(/^- \[x\] (.*$)/gim, '<li style="list-style:none;">✅ <del>$1</del></li>');
    escaped = escaped.replace(/^- \[ \] (.*$)/gim, '<li style="list-style:none;">⬜ $1</li>');

    // Unordered lists
    escaped = escaped.replace(/^- (.*$)/gim, '<li>$1</li>');
    escaped = escaped.replace(/(<li>.*<\/li>)/gim, '<ul>$1</ul>');

    // Clean up adjacent <ul> tags
    escaped = escaped.replace(/<\/ul>\s*<ul>/g, '');

    // Paragraphs / Linebreaks
    const lines = escaped.split('\n');
    let inPre = false;
    const processedLines = lines.map(line => {
        if (line.includes('<pre>')) inPre = true;
        if (line.includes('</pre>')) { inPre = false; return line; }
        if (inPre) return line;
        if (line.trim().startsWith('<h') || line.trim().startsWith('<ul') || line.trim().startsWith('<li') || line.trim().startsWith('<blockquote')) {
            return line;
        }
        if (line.trim() === '') return '<br>';
        return `<p>${line}</p>`;
    });

    return processedLines.join('\n');
}

// Toast Notification System
const Toast = {
    container: null,
    init() {
        this.container = document.getElementById('toastContainer');
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.id = 'toastContainer';
            this.container.className = 'toast-container';
            document.body.appendChild(this.container);
        }
    },
    show(message, type = 'info', duration = 3500) {
        if (!this.container) this.init();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        let iconSvg = '';
        if (type === 'success') {
            iconSvg = `<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;
        } else if (type === 'error') {
            iconSvg = `<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`;
        } else {
            iconSvg = `<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
        }

        toast.innerHTML = `
            <div style="flex-shrink:0;">${iconSvg}</div>
            <div style="flex:1;">${message}</div>
        `;

        this.container.appendChild(toast);

        // Animate in
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 350);
        }, duration);
    }
};

// Copy content to clipboard
async function copyToClipboard(text, successMessage = 'Copied to clipboard!') {
    try {
        await navigator.clipboard.writeText(text);
        Toast.show(successMessage, 'success');
    } catch (err) {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        Toast.show(successMessage, 'success');
    }
}

// Quick Preview Modal Handler
const QuickPreview = {
    modal: null,
    titleEl: null,
    bodyEl: null,
    renderedTab: null,
    rawTab: null,
    fullLinkEl: null,
    editLinkEl: null,
    currentRawContent: '',

    init() {
        this.modal = document.getElementById('previewModal');
        this.titleEl = document.getElementById('modalTaskTitle');
        this.bodyEl = document.getElementById('modalContentBody');
        this.fullLinkEl = document.getElementById('modalFullLink');
        this.editLinkEl = document.getElementById('modalEditLink');
        this.renderedTab = document.getElementById('modalTabRendered');
        this.rawTab = document.getElementById('modalTabRaw');

        if (this.modal) {
            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal) this.close();
            });
        }
    },

    async open(filename) {
        if (!this.modal) this.init();
        
        this.titleEl.textContent = filename;
        this.bodyEl.innerHTML = `
            <div style="text-align:center; padding: 2.5rem; color: var(--text-muted);">
                <div class="pulse-dot" style="margin: 0 auto 1rem auto; width: 12px; height: 12px;"></div>
                Loading task content...
            </div>
        `;
        
        if (this.fullLinkEl) this.fullLinkEl.href = '/file/' + encodeURIComponent(filename);
        if (this.editLinkEl) this.editLinkEl.href = '/edit/' + encodeURIComponent(filename);

        this.modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        try {
            const res = await fetch('/api/file/' + encodeURIComponent(filename));
            if (!res.ok) throw new Error('File not found');
            const data = await res.json();
            this.currentRawContent = data.content || '';
            this.showRendered();
        } catch (err) {
            this.bodyEl.innerHTML = `
                <div style="text-align:center; padding: 2.5rem; color: var(--accent-rose);">
                    <p style="font-weight:600; margin-bottom: 0.5rem;">Failed to load task</p>
                    <p style="font-size:0.85rem; color: var(--text-muted);">${err.message}</p>
                </div>
            `;
        }
    },

    showRendered() {
        if (this.renderedTab) this.renderedTab.classList.add('active');
        if (this.rawTab) this.rawTab.classList.remove('active');
        
        if (!this.currentRawContent.trim()) {
            this.bodyEl.innerHTML = '<p style="color:var(--text-muted); font-style:italic;">(This task has no content yet)</p>';
            return;
        }
        this.bodyEl.className = 'modal-body markdown-rendered';
        this.bodyEl.innerHTML = parseMarkdown(this.currentRawContent);
    },

    showRaw() {
        if (this.rawTab) this.rawTab.classList.add('active');
        if (this.renderedTab) this.renderedTab.classList.remove('active');
        
        this.bodyEl.className = 'modal-body raw-content';
        this.bodyEl.textContent = this.currentRawContent || '(Empty file)';
    },

    close() {
        if (!this.modal) return;
        this.modal.classList.remove('active');
        document.body.style.overflow = '';
    },

    copyCurrent() {
        copyToClipboard(this.currentRawContent, 'Task content copied!');
    }
};

// Custom Delete Confirmation Modal
const DeleteConfirm = {
    modal: null,
    targetFileEl: null,
    formEl: null,

    init() {
        this.modal = document.getElementById('deleteConfirmModal');
        this.targetFileEl = document.getElementById('deleteModalTargetFile');
        this.formEl = document.getElementById('deleteModalForm');

        if (this.modal) {
            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal) this.close();
            });
        }
    },

    open(filename) {
        if (!this.modal) this.init();
        if (this.targetFileEl) this.targetFileEl.textContent = filename;
        if (this.formEl) this.formEl.action = '/delete/' + encodeURIComponent(filename);
        this.modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    },

    close() {
        if (!this.modal) return;
        this.modal.classList.remove('active');
        document.body.style.overflow = '';
    }
};

// Search, Filter & Layout Engine
const DashboardEngine = {
    searchInput: null,
    clearBtn: null,
    sortSelect: null,
    viewGridBtn: null,
    viewListBtn: null,
    tasksContainer: null,
    countBadge: null,

    init() {
        this.searchInput = document.getElementById('taskSearchInput');
        this.clearBtn = document.getElementById('searchClearBtn');
        this.sortSelect = document.getElementById('taskSortSelect');
        this.viewGridBtn = document.getElementById('viewGridBtn');
        this.viewListBtn = document.getElementById('viewListBtn');
        this.tasksContainer = document.getElementById('tasksContainer');
        this.countBadge = document.getElementById('tasksCountBadge');

        if (!this.tasksContainer) return;

        // Restore view preference
        const savedView = localStorage.getItem('taskflow_view') || 'grid';
        this.setView(savedView);

        // Bind Search
        if (this.searchInput) {
            this.searchInput.addEventListener('input', () => this.filterAndSort());
        }

        if (this.clearBtn) {
            this.clearBtn.addEventListener('click', () => {
                this.searchInput.value = '';
                this.clearBtn.style.display = 'none';
                this.filterAndSort();
                this.searchInput.focus();
            });
        }

        // Bind Sort
        if (this.sortSelect) {
            this.sortSelect.addEventListener('change', () => this.filterAndSort());
        }

        // Bind Views
        if (this.viewGridBtn) {
            this.viewGridBtn.addEventListener('click', () => this.setView('grid'));
        }
        if (this.viewListBtn) {
            this.viewListBtn.addEventListener('click', () => this.setView('list'));
        }
    },

    setView(viewType) {
        if (!this.tasksContainer) return;
        if (viewType === 'list') {
            this.tasksContainer.className = 'tasks-list';
            if (this.viewListBtn) this.viewListBtn.classList.add('active');
            if (this.viewGridBtn) this.viewGridBtn.classList.remove('active');
        } else {
            this.tasksContainer.className = 'tasks-grid';
            if (this.viewGridBtn) this.viewGridBtn.classList.add('active');
            if (this.viewListBtn) this.viewListBtn.classList.remove('active');
        }
        localStorage.setItem('taskflow_view', viewType);
    },

    filterAndSort() {
        const query = (this.searchInput ? this.searchInput.value : '').toLowerCase().trim();
        const sortMode = this.sortSelect ? this.sortSelect.value : 'modified-desc';
        
        if (this.clearBtn) {
            this.clearBtn.style.display = query ? 'block' : 'none';
        }

        const cards = Array.from(this.tasksContainer.querySelectorAll('.task-card'));
        let visibleCount = 0;

        // Filter
        cards.forEach(card => {
            const title = (card.dataset.title || '').toLowerCase();
            const snippet = (card.dataset.snippet || '').toLowerCase();
            const matches = !query || title.includes(query) || snippet.includes(query);

            if (matches) {
                card.style.display = '';
                visibleCount++;
            } else {
                card.style.display = 'none';
            }
        });

        // Sort visible cards
        cards.sort((a, b) => {
            if (sortMode === 'name-asc') {
                return (a.dataset.title || '').localeCompare(b.dataset.title || '');
            } else if (sortMode === 'name-desc') {
                return (b.dataset.title || '').localeCompare(a.dataset.title || '');
            } else if (sortMode === 'size-desc') {
                return (parseInt(b.dataset.size) || 0) - (parseInt(a.dataset.size) || 0);
            } else if (sortMode === 'size-asc') {
                return (parseInt(a.dataset.size) || 0) - (parseInt(b.dataset.size) || 0);
            } else if (sortMode === 'modified-asc') {
                return (parseInt(a.dataset.time) || 0) - (parseInt(b.dataset.time) || 0);
            } else { // modified-desc default
                return (parseInt(b.dataset.time) || 0) - (parseInt(a.dataset.time) || 0);
            }
        });

        cards.forEach(card => this.tasksContainer.appendChild(card));

        // Update count badge
        if (this.countBadge) {
            this.countBadge.textContent = `${visibleCount} ${visibleCount === 1 ? 'task' : 'tasks'}`;
        }

        // Show/hide empty search state
        let noMatchEl = document.getElementById('noMatchState');
        if (visibleCount === 0 && cards.length > 0) {
            if (!noMatchEl) {
                noMatchEl = document.createElement('div');
                noMatchEl.id = 'noMatchState';
                noMatchEl.className = 'empty-state';
                noMatchEl.innerHTML = `
                    <div class="empty-icon">🔍</div>
                    <h3 class="empty-title">No matching tasks</h3>
                    <p class="empty-desc">No tasks match your search query "${query}". Try different keywords.</p>
                    <button class="btn btn-secondary btn-sm" onclick="DashboardEngine.clearSearch()">Clear Search</button>
                `;
                this.tasksContainer.appendChild(noMatchEl);
            }
            noMatchEl.style.display = 'flex';
        } else if (noMatchEl) {
            noMatchEl.style.display = 'none';
        }
    },

    clearSearch() {
        if (this.searchInput) {
            this.searchInput.value = '';
            this.filterAndSort();
            this.searchInput.focus();
        }
    }
};

// Form Textarea Helpers (Formatting toolbar & word counter)
function insertFormat(textareaId, prefix, suffix = '') {
    const textarea = document.getElementById(textareaId);
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);
    const replacement = prefix + (selected || 'text') + suffix;

    textarea.value = textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
    textarea.focus();
    textarea.setSelectionRange(start + prefix.length, start + prefix.length + (selected ? selected.length : 4));
    
    // Trigger input event to update counters
    textarea.dispatchEvent(new Event('input'));
}

function updateTextareaStats(textareaId, wordCountId, charCountId) {
    const textarea = document.getElementById(textareaId);
    if (!textarea) return;

    const text = textarea.value;
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;

    const wordEl = document.getElementById(wordCountId);
    const charEl = document.getElementById(charCountId);

    if (wordEl) wordEl.textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
    if (charEl) charEl.textContent = `${chars} ${chars === 1 ? 'char' : 'chars'}`;
}

// Global Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
    // Esc: close any open modal
    if (e.key === 'Escape') {
        QuickPreview.close();
        DeleteConfirm.close();
    }

    // Ctrl + / or /: focus search input if not in form input
    if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        const searchInput = document.getElementById('taskSearchInput');
        if (searchInput) searchInput.focus();
    }

    // Ctrl + Enter or Cmd + Enter: submit current active form
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const form = document.querySelector('form:focus-within');
        if (form) {
            e.preventDefault();
            form.submit();
        }
    }
});

// Check URL query parameters for feedback notifications
document.addEventListener('DOMContentLoaded', () => {
    Toast.init();
    QuickPreview.init();
    DeleteConfirm.init();
    DashboardEngine.init();

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('created')) {
        Toast.show(`Task "${urlParams.get('created')}" created successfully!`, 'success');
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
    } else if (urlParams.has('updated')) {
        Toast.show('Task updated successfully!', 'success');
        window.history.replaceState({}, document.title, window.location.pathname);
    } else if (urlParams.has('deleted')) {
        Toast.show(`Task "${urlParams.get('deleted')}" deleted.`, 'info');
        window.history.replaceState({}, document.title, window.location.pathname);
    } else if (urlParams.has('error')) {
        Toast.show(urlParams.get('error'), 'error');
        window.history.replaceState({}, document.title, window.location.pathname);
    }
});
