// Markdown-aware behaviour for the plain <textarea> editor.
//
// Every edit goes through insertText(), which uses execCommand so the
// browser's own undo/redo (Ctrl+Z / Ctrl+Y) keeps working.

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;
const INDENT = '  ';

function insertText(el, text) {
  el.focus();
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function lineBounds(value, start, end) {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
  if (lineEnd === -1) lineEnd = value.length;
  return [lineStart, lineEnd];
}

/** Replaces the whole lines touched by the selection with fn(lines). */
function editLines(el, fn) {
  const [from, to] = lineBounds(el.value, el.selectionStart, el.selectionEnd);
  const replaced = fn(el.value.slice(from, to).split('\n')).join('\n');
  el.setSelectionRange(from, to);
  insertText(el, replaced);
  el.setSelectionRange(from, from + replaced.length);
}

function wrapSelection(el, before, after = before, placeholder = 'text') {
  const { selectionStart: s, selectionEnd: e, value } = el;
  const selected = value.slice(s, e);
  // Toggle off when the selection is already wrapped.
  if (value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after) {
    el.setSelectionRange(s - before.length, e + after.length);
    insertText(el, selected);
    el.setSelectionRange(s - before.length, e - before.length);
    return;
  }
  const inner = selected || placeholder;
  insertText(el, before + inner + after);
  el.setSelectionRange(s + before.length, s + before.length + inner.length);
}

function togglePrefix(el, prefix, pattern) {
  editLines(el, (lines) => {
    const all = lines.filter((l) => l.trim()).every((l) => pattern.test(l));
    return lines.map((l) => {
      if (!l.trim()) return l;
      return all ? l.replace(pattern, '') : prefix + l.replace(pattern, '');
    });
  });
}

const FORMATS = {
  bold: (el) => wrapSelection(el, '**'),
  italic: (el) => wrapSelection(el, '_'),
  strike: (el) => wrapSelection(el, '~~'),
  code: (el) => wrapSelection(el, '`', '`', 'code'),
  h2: (el) => togglePrefix(el, '## ', /^#{1,6}\s+/),
  quote: (el) => togglePrefix(el, '> ', /^>\s?/),
  ul: (el) => togglePrefix(el, '- ', /^\s*[-*+]\s+(\[[ xX]\]\s+)?/),
  task: (el) => togglePrefix(el, '- [ ] ', /^\s*[-*+]\s+(\[[ xX]\]\s+)?/),
  link(el) {
    const { selectionStart: s, selectionEnd: e, value } = el;
    const label = value.slice(s, e) || 'link text';
    insertText(el, `[${label}](https://)`);
    const urlStart = s + label.length + 3;
    el.setSelectionRange(urlStart, urlStart + 8);
  },
  table(el) {
    const atLineStart = el.selectionStart === 0 || el.value[el.selectionStart - 1] === '\n';
    insertText(el, (atLineStart ? '' : '\n\n') +
      '| Column | Column |\n| ------ | ------ |\n| Cell   | Cell   |\n');
  },
};

export function applyFormat(el, name) {
  FORMATS[name]?.(el);
}

function continueList(el) {
  const { selectionStart: s, selectionEnd: e, value } = el;
  if (s !== e) return false;
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  const line = value.slice(lineStart, s);
  const m = line.match(LIST_ITEM);
  if (!m) return false;

  // Enter on an empty item ends the list, like every word processor.
  if (line.slice(m[0].length).trim() === '') {
    el.setSelectionRange(lineStart, s);
    insertText(el, '');
    return true;
  }
  const [, indent, marker, gap, task] = m;
  const nextMarker = /\d/.test(marker) ? `${parseInt(marker, 10) + 1}${marker.slice(-1)}` : marker;
  insertText(el, `\n${indent}${nextMarker}${gap}${task ? '[ ] ' : ''}`);
  return true;
}

function indentLines(el, outdent) {
  const { selectionStart: s, selectionEnd: e } = el;
  if (!outdent && s === e) { insertText(el, INDENT); return; }
  editLines(el, (lines) => lines.map((l) => (outdent ? l.replace(/^( {1,2}|\t)/, '') : INDENT + l)));
}

/** Wires keyboard shortcuts. Returns nothing; edits fire normal input events. */
export function attachEditor(el) {
  el.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey) {
      const key = e.key.toLowerCase();
      const fmt = { b: 'bold', i: 'italic', k: 'link', e: 'code' }[key];
      if (fmt) { e.preventDefault(); applyFormat(el, fmt); return; }
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      indentLines(el, e.shiftKey);
      return;
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
      if (continueList(el)) e.preventDefault();
    }
  });
}
