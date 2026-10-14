// Leaflet app: wires the sidebar, views, editor, preview and saving together.

/* global mermaid */
import { api } from './api.js';
import { createRenderer, toggleTaskInSource } from './render.js';
import { attachEditor, applyFormat } from './editor.js';
import { createScrollSync } from './scroll-sync.js';
import { $, toast, showBanner, hideBanner, downloadText, countWords } from './ui.js';

const DARK_THEMES = new Set(['slate', 'midnight']);
const VIEWS = ['preview', 'split', 'editor'];
const POLL_MS = 4000;
const DEFAULTS = { theme: null, width: 72, font: 17, split: 50, sidebarCollapsed: false, syncScroll: true };

const editor = $('editor');
const preview = $('preview');
const previewPane = $('previewPane');
const work = $('work');

const state = {
  folderName: '',
  files: [],          // [{ name, mtime }] as last reported by the server
  docs: new Map(),    // name -> { text, saved, mtime, scroll, sel, diskMtime }
  current: null,
  view: 'preview',
  settings: { ...DEFAULTS },
  offline: false,
};

const currentDoc = () => state.docs.get(state.current);
const isDirty = (doc) => !!doc && doc.text !== doc.saved;
// decodeURIComponent throws on a stray '%' (e.g. a link to "100%.md").
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// ------------------------------------------------------------------ rendering

const renderer = createRenderer({
  root: preview,
  onTaskToggle(fromLine, toLine, index, checked) {
    const doc = currentDoc();
    const next = doc.readOnly ? null : toggleTaskInSource(doc.text, fromLine, toLine, index, checked);
    if (next === null) return false;
    doc.text = next;
    editor.value = next;
    afterEdit({ immediate: true });
    return true;
  },
});

const sync = createScrollSync({
  editor, previewPane, preview,
  isActive: () => state.view === 'split' && state.settings.syncScroll,
});

let renderTimer = 0;
function renderNow() {
  clearTimeout(renderTimer);
  renderTimer = 0;
  renderer.render(currentDoc()?.text ?? '');
  sync.invalidate();
}
function scheduleRender() {
  clearTimeout(renderTimer);
  // Longer documents get a longer pause so typing never stutters.
  const delay = Math.min(450, 80 + (editor.value.length / 400));
  renderTimer = setTimeout(renderNow, delay);
}

// ------------------------------------------------------------------ status

function updateStatus() {
  const doc = currentDoc();
  const dirty = isDirty(doc);
  const stateEl = $('saveState');
  if (!stateEl.classList.contains('busy')) {
    stateEl.textContent = dirty ? 'Unsaved changes' : 'Saved';
    stateEl.className = 'save-state' + (dirty ? ' dirty' : '');
  }
  $('saveBtn').disabled = !dirty || !!doc?.readOnly;
  document.title = `${dirty ? '● ' : ''}${state.current || ''} — Leaflet`;

  document.querySelectorAll('.file-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.name === state.current);
    b.classList.toggle('dirty', isDirty(state.docs.get(b.dataset.name)));
  });

  const words = countWords(doc?.text || '');
  $('statWords').textContent = `${words.toLocaleString()} words`;
  $('statRead').textContent = `${Math.max(1, Math.round(words / 230))} min read`;
  updateCursor();
}

function updateCursor() {
  if (state.view === 'preview') { $('statCursor').textContent = ''; return; }
  const before = editor.value.slice(0, editor.selectionStart);
  const line = before.split('\n').length;
  const col = before.length - before.lastIndexOf('\n');
  $('statCursor').textContent = `Ln ${line}, Col ${col}`;
}

function setBusy(text) {
  const el = $('saveState');
  el.textContent = text;
  el.className = 'save-state busy';
}
function clearBusy(errorText) {
  const el = $('saveState');
  el.className = 'save-state' + (errorText ? ' error' : '');
  if (errorText) el.textContent = errorText;
  else updateStatus();
}

// ------------------------------------------------------------------ files

function renderFileList() {
  const list = $('fileList');
  list.replaceChildren(...state.files.map(({ name }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'file-item';
    b.dataset.name = name;
    b.setAttribute('role', 'listitem');
    b.title = name;
    b.innerHTML = '<span class="fname"></span><span class="dot" aria-hidden="true"></span>';
    b.querySelector('.fname').textContent = name;
    b.addEventListener('click', () => openFile(name));
    return b;
  }));
  updateStatus();
}

async function loadDoc(name) {
  const data = await api.readFile(name);
  const doc = {
    text: data.text, saved: data.text, mtime: data.mtime, diskMtime: data.mtime,
    readOnly: !!data.readOnly, scroll: 0, sel: 0,
  };
  state.docs.set(name, doc);
  return doc;
}

function showReadOnlyNotice(name) {
  showBanner(`${name} isn't saved as UTF-8 text, so it's open read-only - saving could damage characters in it.`, [{ label: 'OK' }], 'readonly');
}

async function openFile(name, hash = '') {
  if (name !== state.current) {
    const prev = currentDoc();
    if (prev) { prev.scroll = state.view === 'preview' ? previewPane.scrollTop : editor.scrollTop; prev.sel = editor.selectionStart; }
    let doc = state.docs.get(name);
    try {
      if (!doc) doc = await loadDoc(name);
    } catch (err) {
      toast(err.status === 404 ? `${name} no longer exists` : `Could not open ${name}`);
      return;
    }
    state.current = name;
    editor.value = doc.text;
    editor.readOnly = doc.readOnly;
    editor.setSelectionRange(doc.sel, doc.sel);
    $('docName').textContent = name;
    history.replaceState(null, '', '#' + encodeURIComponent(name));
    hideBanner();
    if (doc.readOnly) showReadOnlyNotice(name);
    renderNow();
    previewPane.scrollTop = doc.scroll;
    editor.scrollTop = doc.scroll;
    updateStatus();
  }
  if (hash) document.getElementById(hash)?.scrollIntoView({ block: 'start' });
}

function afterEdit({ immediate = false } = {}) {
  if (immediate) renderNow(); else scheduleRender();
  updateStatus();
}

// ------------------------------------------------------------------ saving

let saving = null;       // the in-flight save, so two saves never race
let saveAgain = false;   // Ctrl+S pressed again while a save was running

async function save({ force = false } = {}) {
  if (saving) { saveAgain = true; return saving; }
  saving = runSave(force);
  try { await saving; } finally { saving = null; }
  if (saveAgain) { saveAgain = false; await save(); }
}

async function runSave(force) {
  const name = state.current;
  const doc = currentDoc();
  if (!doc || doc.readOnly || (!isDirty(doc) && !force)) return;
  const snapshot = doc.text;
  setBusy('Saving…');
  try {
    const res = await api.saveFile(name, snapshot, doc.mtime, force);
    doc.saved = snapshot;
    doc.mtime = res.mtime;
    doc.diskMtime = res.mtime;
    state.offline = false;
    hideBanner();
    clearBusy();
    toast(`Saved ${name}`, 1500);
  } catch (err) {
    clearBusy('Not saved');
    handleSaveError(err, name, snapshot);
  }
}

function handleSaveError(err, name, text) {
  if (err.status === 409) {
    showBanner(`${name} was changed by another program since you opened it.`, [
      { label: 'Overwrite with my version', kind: 'primary', run: () => save({ force: true }) },
      { label: 'Load the version on disk', kind: 'danger', run: () => reloadFromDisk(name) },
      { label: 'Cancel' },
    ], 'conflict');
  } else if (err.status === 404) {
    showBanner(`${name} was moved or deleted on disk.`, [
      { label: 'Save it again here', kind: 'primary', run: () => recreate(name, text) },
      { label: 'Download a copy', run: () => downloadText(name, text) },
    ], 'missing');
  } else if (err.status === 0) {
    showOfflineBanner();
  } else {
    showBanner(`Could not save ${name}: ${err.message}`, [
      { label: 'Download a copy', kind: 'primary', run: () => downloadText(name, text) },
      { label: 'Dismiss' },
    ], 'save-error');
  }
}

function showOfflineBanner() {
  state.offline = true;
  const doc = currentDoc();
  showBanner(
    "Leaflet's background helper has stopped, so changes cannot be saved. Your text is still here - download it, then reopen the file.",
    [{ label: 'Download a copy', kind: 'primary', run: () => downloadText(state.current, doc?.text || '') }],
    'offline',
  );
}

async function recreate(name, text) {
  try {
    const res = await api.createFile(name, text);
    const doc = state.docs.get(name);
    Object.assign(doc, { saved: text, mtime: res.mtime, diskMtime: res.mtime });
    await refreshFiles();
    updateStatus();
    toast(`Saved ${name}`);
  } catch {
    toast('Could not save the file');
  }
}

/**
 * Replaces the in-memory copy with the file on disk. With onlyIfClean, gives up
 * if the user typed anything while the file was being fetched.
 */
async function reloadFromDisk(name, { onlyIfClean = false } = {}) {
  try {
    const old = state.docs.get(name);
    const data = await api.readFile(name);
    if (onlyIfClean && isDirty(state.docs.get(name))) return false;
    const doc = {
      text: data.text, saved: data.text, mtime: data.mtime, diskMtime: data.mtime,
      readOnly: !!data.readOnly, scroll: old?.scroll || 0, sel: Math.min(old?.sel || 0, data.text.length),
    };
    state.docs.set(name, doc);
    if (name === state.current) {
      const top = editor.scrollTop;
      editor.value = doc.text;
      editor.readOnly = doc.readOnly;
      editor.scrollTop = top;
      renderNow();
    }
    updateStatus();
    return true;
  } catch {
    toast(`Could not reload ${name}`);
    return false;
  }
}

// ------------------------------------------------------------------ watching the folder

async function refreshFiles() {
  const files = await api.files();
  const changedList = files.map((f) => f.name).join('\n') !== state.files.map((f) => f.name).join('\n');
  state.files = files;
  if (changedList) renderFileList();

  // Our own save changes the file's time; don't mistake it for someone else's.
  if (saving) return;
  for (const f of files) {
    const doc = state.docs.get(f.name);
    if (!doc || f.mtime === doc.diskMtime) continue;
    doc.diskMtime = f.mtime;
    if (!isDirty(doc)) {
      const reloaded = await reloadFromDisk(f.name, { onlyIfClean: true });
      if (reloaded && f.name === state.current) toast(`Reloaded ${f.name} - it changed on disk`);
    } else if (f.name === state.current) {
      showBanner(`${f.name} changed on disk while you were editing it.`, [
        { label: 'Keep my version' },
        { label: 'Load the version on disk', kind: 'danger', run: () => reloadFromDisk(f.name) },
      ], 'external');
    }
  }
}

async function poll() {
  try {
    await refreshFiles();
    if (state.offline) { state.offline = false; hideBanner('offline'); }
  } catch {
    if (!state.offline) showOfflineBanner();
  }
}

async function newFile() {
  let name = prompt('New markdown file name:', 'untitled.md');
  if (name === null) return;
  name = name.trim();
  if (!name) return;
  if (!/\.(md|markdown)$/i.test(name)) name += '.md';
  const title = name.replace(/\.(md|markdown)$/i, '');
  try {
    await api.createFile(name, `# ${title}\n\n`);
    await refreshFiles();
    renderFileList();
    await openFile(name);
    if (state.view === 'preview') setView('split');
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  } catch (err) {
    toast(err.message || 'Could not create the file');
  }
}

// ------------------------------------------------------------------ views & settings

function setView(view) {
  if (!VIEWS.includes(view)) return;
  const wasPreview = state.view === 'preview';
  state.view = view;
  work.dataset.view = view;
  document.querySelectorAll('#viewSeg [data-view]').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.view === view));
  });
  if (view !== 'preview') {
    if (wasPreview) editor.focus({ preventScroll: true });
    if (view === 'split') requestAnimationFrame(() => sync.syncNow());
  }
  updateCursor();
}

let saveSettingsTimer = 0;
function persistSettings() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => api.saveSettings(state.settings), 400);
}

function applyTheme(theme) {
  const dark = DARK_THEMES.has(theme);
  document.documentElement.dataset.theme = theme;
  $('hljsTheme').href = `__leaflet__/vendor/highlight-github${dark ? '-dark' : ''}.min.css`;
  document.querySelectorAll('#themeSeg .swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral' });
  renderer.reset();
  if (state.current) renderNow();
}

function applySettings() {
  const s = state.settings;
  const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(['paper', 'sepia', 'slate', 'midnight'].includes(s.theme) ? s.theme : (systemDark ? 'slate' : 'paper'));
  document.documentElement.style.setProperty('--content-width', s.width + 'ch');
  document.documentElement.style.setProperty('--text-size', s.font + 'px');
  work.style.setProperty('--split', s.split + '%');
  $('sidebar').classList.toggle('collapsed', !!s.sidebarCollapsed);
  $('widthRange').value = s.width;
  $('widthValue').textContent = s.width + 'ch';
  $('fontRange').value = s.font;
  $('fontValue').textContent = s.font + 'px';
  $('syncScroll').checked = !!s.syncScroll;
}

function sanitizeSettings(raw) {
  const s = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (typeof raw.theme === 'string') s.theme = raw.theme;
    const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
    s.width = clamp(raw.width, 40, 140, DEFAULTS.width);
    s.font = clamp(raw.font, 13, 26, DEFAULTS.font);
    s.split = clamp(raw.split, 20, 80, DEFAULTS.split);
    s.sidebarCollapsed = !!raw.sidebarCollapsed;
    s.syncScroll = raw.syncScroll !== false;
  }
  return s;
}

// ------------------------------------------------------------------ wiring

function wireToolbar() {
  document.querySelectorAll('#viewSeg [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('saveBtn').addEventListener('click', () => save());
  $('exportBtn').addEventListener('click', () => { renderNow(); window.print(); });
  $('newFileBtn').addEventListener('click', newFile);
  $('closeBtn').addEventListener('click', closeLeaflet);
  $('collapseBtn').addEventListener('click', toggleSidebar);
  $('fullscreenBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => toast('Press F11 for full screen'));
  });

  const panel = $('displayPanel');
  const displayBtn = $('displayBtn');
  const closePanel = () => { panel.hidden = true; displayBtn.setAttribute('aria-expanded', 'false'); };
  displayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    displayBtn.setAttribute('aria-expanded', String(!panel.hidden));
  });
  document.addEventListener('click', (e) => { if (!panel.hidden && !panel.contains(e.target)) closePanel(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

  document.querySelectorAll('#themeSeg .swatch').forEach((b) => b.addEventListener('click', () => {
    state.settings.theme = b.dataset.theme;
    applyTheme(b.dataset.theme);
    persistSettings();
  }));
  $('widthRange').addEventListener('input', (e) => {
    state.settings.width = +e.target.value;
    applySettingsLight();
  });
  $('fontRange').addEventListener('input', (e) => {
    state.settings.font = +e.target.value;
    applySettingsLight();
  });
  $('syncScroll').addEventListener('change', (e) => {
    state.settings.syncScroll = e.target.checked;
    persistSettings();
  });
  document.querySelectorAll('#formatBar [data-fmt]').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor selection
    b.addEventListener('click', () => applyFormat(editor, b.dataset.fmt));
  });
}

function applySettingsLight() {
  const s = state.settings;
  document.documentElement.style.setProperty('--content-width', s.width + 'ch');
  document.documentElement.style.setProperty('--text-size', s.font + 'px');
  $('widthValue').textContent = s.width + 'ch';
  $('fontValue').textContent = s.font + 'px';
  sync.invalidate();
  persistSettings();
}

function closeLeaflet() {
  const unsaved = [...state.docs.entries()].filter(([, doc]) => isDirty(doc)).map(([name]) => name);
  if (unsaved.length && !confirm(`Close without saving ${unsaved.join(', ')}?`)) return;
  // Already confirmed - don't ask a second time from beforeunload.
  window.removeEventListener('beforeunload', warnBeforeUnload);
  api.bye();
  window.close();
  // Browsers only let a page close a window it opened itself, or an app window.
  // In an ordinary tab nothing happens, so say what to do instead.
  setTimeout(() => {
    window.addEventListener('beforeunload', warnBeforeUnload);
    poll(); // any request cancels the shutdown the "bye" just scheduled
    toast('Close this browser tab to exit Leaflet (Ctrl+W)');
  }, 300);
}

function warnBeforeUnload(e) {
  if ([...state.docs.values()].some(isDirty)) { e.preventDefault(); e.returnValue = ''; }
}

function toggleSidebar() {
  state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
  $('sidebar').classList.toggle('collapsed', state.settings.sidebarCollapsed);
  persistSettings();
}

function wireDivider() {
  const divider = $('divider');
  const setSplit = (pct) => {
    state.settings.split = Math.min(80, Math.max(20, Math.round(pct * 10) / 10));
    work.style.setProperty('--split', state.settings.split + '%');
    sync.invalidate();
  };
  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('dragging');
    work.classList.add('resizing');
  });
  divider.addEventListener('pointermove', (e) => {
    if (!divider.hasPointerCapture(e.pointerId)) return;
    const box = work.getBoundingClientRect();
    setSplit(((e.clientX - box.left) / box.width) * 100);
  });
  divider.addEventListener('pointerup', (e) => {
    divider.releasePointerCapture(e.pointerId);
    divider.classList.remove('dragging');
    work.classList.remove('resizing');
    persistSettings();
  });
  divider.addEventListener('dblclick', () => { setSplit(50); persistSettings(); });
  divider.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -2, ArrowRight: 2 }[e.key];
    if (step) { e.preventDefault(); setSplit(state.settings.split + step); persistSettings(); }
  });
}

function wirePreviewLinks() {
  preview.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      e.preventDefault();
      document.getElementById(safeDecode(href.slice(1)))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return; // external: opens in a new tab
    // A link to another markdown file in this folder opens inside Leaflet.
    // Never let a relative link navigate the app window itself.
    e.preventDefault();
    const [path, hash = ''] = href.split('#');
    const name = safeDecode(path.replace(/^\.\//, ''));
    if (state.files.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      const match = state.files.find((f) => f.name.toLowerCase() === name.toLowerCase()).name;
      openFile(match, safeDecode(hash));
    } else {
      window.open(a.href, '_blank', 'noopener');
    }
  });
}

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (mod && e.key === '\\') { e.preventDefault(); toggleSidebar(); return; }
    if (e.altKey && !mod && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); setView(VIEWS[+e.key - 1]); }
  });
  editor.addEventListener('input', () => {
    const doc = currentDoc();
    if (!doc) return;
    doc.text = editor.value;
    afterEdit();
  });
  ['keyup', 'click', 'select'].forEach((t) => editor.addEventListener(t, updateCursor));
  attachEditor(editor);

  window.addEventListener('beforeunload', warnBeforeUnload);
  window.addEventListener('pagehide', () => api.bye());
  window.addEventListener('beforeprint', renderNow);
  window.addEventListener('focus', poll);
}

async function start() {
  wireToolbar();
  wireDivider();
  wirePreviewLinks();
  wireKeyboard();
  setView('preview');

  const [session, settings] = await Promise.all([api.session(), api.loadSettings()]);
  state.settings = sanitizeSettings(settings);
  applySettings();

  state.folderName = session.folderName;
  $('folderName').textContent = session.folderName;
  $('folderName').title = session.folderPath;
  state.files = session.files;
  renderFileList();

  const fromHash = safeDecode(location.hash.slice(1));
  const first = [fromHash, session.initialFile].find((n) => n && state.files.some((f) => f.name === n))
    || session.initialFile || state.files[0]?.name;
  if (first) await openFile(first);

  setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  // Hidden windows still check in occasionally so the helper knows we are alive.
  setInterval(() => { if (document.hidden) poll(); }, 60000);
}

start().catch(() => {
  preview.innerHTML = '<p class="empty">Leaflet could not reach its background helper. Close this window and open the file again.</p>';
});
