// Markdown -> preview DOM.
//
// The document is rendered one top-level block at a time. Each block is
// wrapped in <div class="blk" data-line="N"> (N = its first source line), which
// is what lets Split view keep the editor and preview scrolled to the same
// place. Blocks whose source did not change are reused as-is between
// keystrokes, so diagrams, images and highlighted code do not flicker or
// re-render while you type elsewhere.

/* global marked, mermaid, hljs */
import { sanitizeToFragment } from './sanitize.js';

const COPY_ICON = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';
const TASK_MARKER = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;
const FENCE = /^\s*(?:>\s*)*(```|~~~)/;

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const countLines = (s) => (s.match(/\n/g) || []).length;

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
      if (language === 'mermaid') return `<div class="mermaid">${escapeHtml(text)}</div>`;
      const cls = language ? ` class="language-${escapeHtml(language)}"` : '';
      return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`;
    },
  },
});

function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

export function createRenderer({ root, onTaskToggle }) {
  let mermaidCache = new Map();
  let mermaidSeq = 0;
  let pool = new Map(); // block key -> [nodes] from the previous render

  function enhanceCode(blk) {
    blk.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      const lang = (code?.className.match(/language-(\S+)/) || [])[1];
      if (code && lang && window.hljs?.getLanguage(lang)) hljs.highlightElement(code);

      const wrap = document.createElement('div');
      wrap.className = 'code-block';
      pre.replaceWith(wrap);
      wrap.appendChild(pre);
      if (lang) {
        const label = document.createElement('span');
        label.className = 'lang';
        label.textContent = lang;
        wrap.appendChild(label);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.title = 'Copy code';
      btn.innerHTML = COPY_ICON;
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText((code || pre).innerText).then(() => {
          btn.innerHTML = CHECK_ICON;
          setTimeout(() => { btn.innerHTML = COPY_ICON; }, 1400);
        });
      });
      wrap.appendChild(btn);
    });
  }

  async function renderDiagram(el) {
    const source = el.textContent;
    const cached = mermaidCache.get(source);
    if (cached) { el.innerHTML = cached; return; }
    try {
      // parse() first: a failed render() can leave stray error SVGs in <body>.
      await mermaid.parse(source);
      const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, source);
      mermaidCache.set(source, svg);
      if (el.isConnected) el.innerHTML = svg;
    } catch (err) {
      el.classList.add('error');
      el.textContent = 'Diagram error: ' + (err?.message || err);
    }
  }

  function enhance(blk) {
    enhanceCode(blk);
    blk.querySelectorAll('.mermaid').forEach(renderDiagram);
    blk.querySelectorAll('table').forEach((table) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });
    // In a "loose" list marked puts the checkbox inside a <p>, so match any depth.
    blk.querySelectorAll('li input[type=checkbox]').forEach((box, index) => {
      box.closest('li').classList.add('task');
      box.disabled = false;
      box.dataset.taskIndex = String(index);
    });
  }

  function buildBlock(token, links) {
    const tokens = [token];
    tokens.links = links;
    const blk = document.createElement('div');
    blk.className = 'blk';
    blk.appendChild(sanitizeToFragment(marked.parser(tokens)));
    enhance(blk);
    return blk;
  }

  function assignHeadingIds() {
    const seen = new Map();
    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
      const base = slugify(h.textContent.replace(/#$/, '')) || 'section';
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      h.id = n ? `${base}-${n}` : base;
      let anchor = h.querySelector(':scope > .anchor');
      if (!anchor) {
        anchor = document.createElement('a');
        anchor.className = 'anchor';
        anchor.setAttribute('aria-hidden', 'true');
        anchor.textContent = '#';
        h.appendChild(anchor);
      }
      anchor.setAttribute('href', '#' + h.id);
    });
  }

  root.addEventListener('change', (e) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || box.dataset.taskIndex === undefined) return;
    const blk = box.closest('.blk');
    const next = blk.nextElementSibling;
    const endLine = next?.dataset.line !== undefined ? Number(next.dataset.line) : Infinity;
    const applied = onTaskToggle(Number(blk.dataset.line), endLine, Number(box.dataset.taskIndex), box.checked);
    // Nothing in the source to flip (or the file is read-only): undo the click.
    if (!applied) box.checked = !box.checked;
  });

  return {
    render(text) {
      if (!text.trim()) {
        root.innerHTML = '<p class="empty">This file is empty. Switch to Split or Editor to start writing.</p>';
        pool = new Map();
        return;
      }
      const tokens = marked.lexer(text);
      const linksKey = JSON.stringify(tokens.links || {});
      const next = new Map();
      const nodes = [];
      let line = 0;

      for (const token of tokens) {
        const startLine = line;
        line += countLines(token.raw || '');
        if (token.type === 'space' || token.type === 'def') continue;

        const key = token.raw + '\u0000' + linksKey;
        const reusable = pool.get(key);
        const blk = reusable?.length ? reusable.shift() : buildBlock(token, tokens.links);
        blk.dataset.line = String(startLine);
        nodes.push(blk);
        if (!next.has(key)) next.set(key, []);
        next.get(key).push(blk);
      }
      root.replaceChildren(...nodes);
      // Keep only what is on screen now; the next render can reuse these.
      pool = next;
      assignHeadingIds();
    },

    /** Forget cached output, e.g. after a theme change recolours diagrams. */
    reset() {
      mermaidCache = new Map();
      pool = new Map();
    },
  };
}

/**
 * Flips the index-th task checkbox between source lines [fromLine, toLine).
 * Returns the new text, or null when the checkbox has no matching "- [ ]"
 * marker (e.g. a raw <input> in HTML) - the caller then just re-renders.
 */
export function toggleTaskInSource(text, fromLine, toLine, index, checked) {
  const lines = text.split('\n');
  const end = Math.min(toLine, lines.length);
  let seen = 0;
  let inFence = false;
  for (let i = fromLine; i < end; i++) {
    if (FENCE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence || !TASK_MARKER.test(lines[i])) continue;
    if (seen++ === index) {
      lines[i] = lines[i].replace(TASK_MARKER, `$1${checked ? 'x' : ' '}$3`);
      return lines.join('\n');
    }
  }
  return null;
}
