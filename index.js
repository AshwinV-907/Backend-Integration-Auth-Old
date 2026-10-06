const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 9000;
const filesDir = path.resolve(__dirname, 'files');

// Ensure storage directory exists synchronously on startup
if (!fs.existsSync(filesDir)) {
    fs.mkdirSync(filesDir, { recursive: true });
}

// Set up view engine and static asset serving
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Core Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// CORE BACKEND UTILITIES & SANITIZATION HELPERS
// ============================================================================

/**
 * Sanitizes user-provided titles to prevent illegal filesystem characters,
 * path traversal attacks, and OS reserved symbols.
 */
function sanitizeTaskTitle(rawTitle) {
    if (!rawTitle || typeof rawTitle !== 'string') return '';
    // Strip Windows/Unix forbidden characters: < > : " / \ | ? * and control chars
    let clean = rawTitle.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim();
    // Normalize spaces or multiple consecutive hyphens
    clean = clean.replace(/\s+/g, '-').replace(/-+/g, '-');
    // Strip leading or trailing dots and dashes
    clean = clean.replace(/^[.\-_]+|[.\-_]+$/g, '');
    return clean;
}

/**
 * Safely resolves a filename within filesDir, strictly preventing directory traversal.
 * Returns null if the path tries to escape filesDir or references an illegal file.
 */
function resolveSafeFilePath(filename) {
    if (!filename || typeof filename !== 'string') return null;
    
    // Extract pure basename
    const base = path.basename(filename.trim());
    if (!base || base === '.' || base === '..' || base.startsWith('.')) {
        return null;
    }

    const resolved = path.resolve(filesDir, base);
    
    // Strict directory traversal prevention check
    if (!resolved.startsWith(filesDir + path.sep)) {
        return null;
    }

    return {
        filename: base,
        filePath: resolved
    };
}

/**
 * Formats byte sizes into human-readable strings (e.g., "124 B", "1.4 KB", "2.1 MB")
 */
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Generates human-friendly relative time strings (e.g., "Just now", "5m ago", "Yesterday")
 */
function getRelativeTime(date) {
    if (!date) return 'Recently';
    const now = new Date();
    const diffSeconds = Math.floor((now - new Date(date)) / 1000);

    if (diffSeconds < 60) return 'Just now';
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
    if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
    if (diffSeconds < 172800) return 'Yesterday';
    return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Reads metadata and statistics for a given task flat-file
 */
async function getTaskMetadata(filename) {
    const safe = resolveSafeFilePath(filename);
    if (!safe) return null;

    try {
        const stat = await fs.promises.stat(safe.filePath);
        const content = await fs.promises.readFile(safe.filePath, 'utf8');
        const words = content.trim() ? content.trim().split(/\s+/).length : 0;
        const lines = content ? content.split('\n').length : 0;
        const snippet = content.replace(/\s+/g, ' ').trim().slice(0, 160);
        const title = safe.filename.replace(/\.txt$/, '');

        return {
            filename: safe.filename,
            title: title,
            size: stat.size,
            formattedSize: formatBytes(stat.size),
            modifiedTime: stat.mtimeMs,
            formattedDate: stat.mtime.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            relativeTime: getRelativeTime(stat.mtime),
            wordCount: words,
            lineCount: lines,
            readingTime: `${Math.max(1, Math.ceil(words / 200))} min read`,
            snippet: snippet
        };
    } catch (err) {
        return null;
    }
}

// ============================================================================
// APPLICATION WEB ROUTES
// ============================================================================

/**
 * 1. GET / — Display All Tasks Dashboard
 * Reads all .txt files, computes enriched metadata & global storage stats,
 * and renders views/index.ejs.
 */
app.get('/', async (req, res, next) => {
    try {
        const rawFiles = await fs.promises.readdir(filesDir);
        
        // Filter strictly valid .txt files (exclude hidden files or non-txt files)
        const validTxtFiles = rawFiles.filter(file => {
            return file.endsWith('.txt') && !file.startsWith('.') && file !== '.txt';
        });

        // Fetch task details and metadata in parallel
        const taskResults = await Promise.all(validTxtFiles.map(getTaskMetadata));
        const tasks = taskResults.filter(Boolean);

        // Sort tasks by newest modified time by default
        tasks.sort((a, b) => b.modifiedTime - a.modifiedTime);

        // Global workspace stats calculation
        const totalWords = tasks.reduce((acc, t) => acc + (t.wordCount || 0), 0);
        const totalSizeBytes = tasks.reduce((acc, t) => acc + (t.size || 0), 0);
        const latestTask = tasks[0];

        const stats = {
            totalTasks: tasks.length,
            totalWords: totalWords,
            totalSizeBytes: totalSizeBytes,
            totalSizeFormatted: formatBytes(totalSizeBytes),
            latestModifiedRelative: latestTask ? latestTask.relativeTime : 'None'
        };

        // Render dashboard (preserves `files: [...]` for backward compatibility)
        res.render('index', { 
            tasks: tasks,
            files: tasks.map(t => t.filename),
            stats: stats
        });
    } catch (err) {
        console.error('Error loading tasks dashboard:', err);
        res.render('index', { 
            tasks: [], 
            files: [], 
            stats: { totalTasks: 0, totalWords: 0, totalSizeFormatted: '0 B', latestModifiedRelative: 'None' }
        });
    }
});

/**
 * 2. POST /create — Create a New Task Flat-File
 * Accepts title and details from req.body, sanitizes title, writes <title>.txt
 * to the files directory, with duplicate prevention.
 */
app.post('/create', async (req, res, next) => {
    try {
        const rawTitle = req.body.title || '';
        let sanitized = sanitizeTaskTitle(rawTitle);

        // If title is empty after sanitization, generate a friendly timestamped title
        if (!sanitized) {
            sanitized = `task-${Date.now().toString().slice(-6)}`;
        }

        let filename = `${sanitized}.txt`;
        let targetPath = path.resolve(filesDir, filename);

        // Collision safety: If a file with that name already exists, append an incremental counter
        let counter = 1;
        while (fs.existsSync(targetPath)) {
            filename = `${sanitized}-${counter}.txt`;
            targetPath = path.resolve(filesDir, filename);
            counter++;
        }

        const details = req.body.details || req.body.description || '';

        // Write file safely
        await fs.promises.writeFile(targetPath, details, 'utf8');

        // Check if AJAX request or JSON API client
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(201).json({ success: true, filename: filename });
        }

        res.redirect(`/?created=${encodeURIComponent(filename)}`);
    } catch (err) {
        console.error('Error creating task:', err);
        res.redirect('/?error=' + encodeURIComponent('Failed to create task file.'));
    }
});

/**
 * 3. GET /file/:filename — Read Task Details
 * Reads the task content and renders views/show.ejs with complete metadata.
 */
app.get('/file/:filename', async (req, res) => {
    const safe = resolveSafeFilePath(req.params.filename);
    if (!safe) {
        return res.status(400).render('404');
    }

    try {
        const content = await fs.promises.readFile(safe.filePath, 'utf8');
        const metadata = await getTaskMetadata(safe.filename);

        res.render('show', {
            filename: safe.filename,
            filedata: content,
            stats: metadata
        });
    } catch (err) {
        if (err.code === 'ENOENT') {
            return res.status(404).render('404');
        }
        res.status(500).send('Internal Server Error reading task file');
    }
});

/**
 * 4. GET /edit/:filename — Edit Task & Content Page
 * Loads views/edit.ejs with both current filename AND current content.
 */
app.get('/edit/:filename', async (req, res) => {
    const safe = resolveSafeFilePath(req.params.filename);
    if (!safe) {
        return res.status(400).render('404');
    }

    try {
        const content = await fs.promises.readFile(safe.filePath, 'utf8');
        const metadata = await getTaskMetadata(safe.filename);

        res.render('edit', {
            filename: safe.filename,
            filedata: content,
            stats: metadata
        });
    } catch (err) {
        if (err.code === 'ENOENT') {
            return res.status(404).render('404');
        }
        res.status(500).send('Error loading task for editing');
    }
});

/**
 * 5. POST /edit — Update Task Title and Task Content
 * Renames file if title changed, writes updated details to the file.
 */
app.post('/edit', async (req, res) => {
    try {
        const previousName = req.body.previous;
        const safeOld = resolveSafeFilePath(previousName);
        if (!safeOld || !fs.existsSync(safeOld.filePath)) {
            return res.redirect('/?error=' + encodeURIComponent('Source file not found.'));
        }

        // Handle title / filename renaming
        const rawNewTitle = req.body.new || '';
        let sanitizedNew = sanitizeTaskTitle(rawNewTitle);
        if (!sanitizedNew) {
            sanitizedNew = safeOld.filename.replace(/\.txt$/, '');
        }
        const newFilename = `${sanitizedNew}.txt`;

        let activeFilePath = safeOld.filePath;
        let finalFilename = safeOld.filename;

        // If the filename actually changed, rename it safely
        if (newFilename !== safeOld.filename) {
            const safeNew = resolveSafeFilePath(newFilename);
            if (!safeNew) {
                return res.redirect('/?error=' + encodeURIComponent('Invalid new filename provided.'));
            }

            // Prevent overwriting a different existing file
            if (fs.existsSync(safeNew.filePath) && safeNew.filePath.toLowerCase() !== safeOld.filePath.toLowerCase()) {
                return res.redirect(`/edit/${encodeURIComponent(previousName)}?error=${encodeURIComponent('A task with that title already exists.')}`);
            }

            await fs.promises.rename(safeOld.filePath, safeNew.filePath);
            activeFilePath = safeNew.filePath;
            finalFilename = safeNew.filename;
        }

        // Update task details/content if provided in request
        if (req.body.details !== undefined) {
            await fs.promises.writeFile(activeFilePath, req.body.details, 'utf8');
        }

        res.redirect(`/file/${encodeURIComponent(finalFilename)}?updated=true`);
    } catch (err) {
        console.error('Error updating task:', err);
        res.redirect('/?error=' + encodeURIComponent('Failed to update task.'));
    }
});

/**
 * 6. POST /delete/:filename — Delete Task Flat-File
 * Removes the target .txt file from the files directory.
 */
app.post('/delete/:filename', async (req, res) => {
    const safe = resolveSafeFilePath(req.params.filename);
    if (!safe) {
        return res.redirect('/?error=' + encodeURIComponent('Invalid file target.'));
    }

    try {
        if (fs.existsSync(safe.filePath)) {
            await fs.promises.unlink(safe.filePath);
        }
        res.redirect(`/?deleted=${encodeURIComponent(safe.filename)}`);
    } catch (err) {
        console.error('Error deleting file:', err);
        res.redirect('/?error=' + encodeURIComponent('Could not delete file.'));
    }
});

/**
 * 7. GET /download/:filename — Download Task as .txt Attachment
 */
app.get('/download/:filename', (req, res) => {
    const safe = resolveSafeFilePath(req.params.filename);
    if (!safe || !fs.existsSync(safe.filePath)) {
        return res.status(404).render('404');
    }
    res.download(safe.filePath, safe.filename);
});

/**
 * 8. GET /raw/:filename — View Raw Plain Text
 */
app.get('/raw/:filename', async (req, res) => {
    const safe = resolveSafeFilePath(req.params.filename);
    if (!safe || !fs.existsSync(safe.filePath)) {
        return res.status(404).render('404');
    }
    res.type('text/plain; charset=utf-8');
    res.sendFile(safe.filePath);
});

// ============================================================================
// REST API ENDPOINTS (AJAX & Dynamic Preview Support)
// ============================================================================

/**
 * GET /api/tasks — Returns JSON list of all tasks with metadata
 */
app.get('/api/tasks', async (req, res) => {
    try {
        const rawFiles = await fs.promises.readdir(filesDir);
        const validTxtFiles = rawFiles.filter(file => file.endsWith('.txt') && !file.startsWith('.') && file !== '.txt');
        const tasks = (await Promise.all(validTxtFiles.map(getTaskMetadata))).filter(Boolean);
        tasks.sort((a, b) => b.modifiedTime - a.modifiedTime);
        res.json({ success: true, count: tasks.length, tasks: tasks });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/file/:filename — Fetch single file content dynamically
 */
app.get('/api/file/:filename', async (req, res) => {
    const safe = resolveSafeFilePath(req.params.filename);
    if (!safe) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    try {
        const content = await fs.promises.readFile(safe.filePath, 'utf8');
        const metadata = await getTaskMetadata(safe.filename);
        res.json({ 
            success: true, 
            filename: safe.filename, 
            content: content,
            metadata: metadata 
        });
    } catch (err) {
        res.status(404).json({ error: 'File not found' });
    }
});

/**
 * GET /api/stats — Workspace storage & count statistics
 */
app.get('/api/stats', async (req, res) => {
    try {
        const rawFiles = await fs.promises.readdir(filesDir);
        const validTxtFiles = rawFiles.filter(file => file.endsWith('.txt') && !file.startsWith('.') && file !== '.txt');
        const tasks = (await Promise.all(validTxtFiles.map(getTaskMetadata))).filter(Boolean);
        const totalWords = tasks.reduce((acc, t) => acc + (t.wordCount || 0), 0);
        const totalSizeBytes = tasks.reduce((acc, t) => acc + (t.size || 0), 0);

        res.json({
            success: true,
            totalTasks: tasks.length,
            totalWords: totalWords,
            totalSizeBytes: totalSizeBytes,
            totalSizeFormatted: formatBytes(totalSizeBytes)
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================================
// 404 & CENTRALIZED ERROR HANDLER
// ============================================================================

app.use((req, res) => {
    res.status(404).render('404');
});

app.use((err, req, res, next) => {
    console.error('Unhandled Application Error:', err);
    res.status(500).send('Internal Server Error');
});

// Start Server
app.listen(PORT, () => {
    console.log(`TaskFlow Server running at http://localhost:${PORT}`);
});
