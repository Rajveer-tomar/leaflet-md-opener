// Allow-list HTML sanitiser for rendered markdown.
//
// Markdown may contain raw HTML, and this page can save files, so a README you
// downloaded must not be able to run script here. The HTML is parsed into an
// inert document, unknown elements/attributes are removed in place, and the
// resulting nodes are moved into the page directly - never re-serialised to a
// string, which is where most sanitiser bypasses ("mutation XSS") come from.
// The server's Content-Security-Policy is a second wall behind this one.

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li',
  'mark', 'ol', 'p', 'picture', 'pre', 'q', 's', 'samp', 'small', 'source', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul', 'var', 'video', 'audio', 'wbr',
]);

// Removed together with everything inside them.
const DROP_WITH_CONTENT = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript', 'textarea', 'select', 'svg', 'math', 'form']);

const GLOBAL_ATTRS = new Set(['id', 'class', 'title', 'lang', 'dir', 'align', 'aria-label', 'aria-hidden', 'role']);
const TAG_ATTRS = {
  a: ['href', 'name'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  source: ['src', 'srcset', 'type', 'media'],
  video: ['src', 'controls', 'width', 'height', 'poster', 'loop', 'muted'],
  audio: ['src', 'controls', 'loop'],
  input: ['type', 'checked', 'disabled'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  col: ['span'],
  colgroup: ['span'],
  details: ['open'],
  q: ['cite'],
  blockquote: ['cite'],
};
const URL_ATTRS = new Set(['href', 'src', 'poster', 'cite']);
const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\.{0,2}\/|[^:/?#]*(?:[/?#]|$))/i;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|avif|bmp);base64,/i;

function isSafeUrl(value, tag) {
  const v = value.trim().replace(/[\u0000-\u001F\u007F\s]+/g, '');
  if (SAFE_DATA_IMAGE.test(v)) return tag === 'img' || tag === 'source';
  return SAFE_URL.test(v);
}

function cleanAttributes(el, tag) {
  const allowed = TAG_ATTRS[tag] || [];
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    const ok = GLOBAL_ATTRS.has(name) || allowed.includes(name);
    if (!ok || (URL_ATTRS.has(name) && !isSafeUrl(attr.value, tag))) {
      el.removeAttribute(attr.name);
    } else if (name === 'srcset' && /javascript:|data:/i.test(attr.value)) {
      el.removeAttribute(attr.name);
    }
  }
  if (tag === 'input' && el.getAttribute('type') !== 'checkbox') el.remove();
  if (tag === 'a' && /^https?:/i.test(el.getAttribute('href') || '')) {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
}

function cleanTree(root) {
  // Walk a static snapshot so removals do not disturb iteration.
  for (const el of [...root.querySelectorAll('*')]) {
    if (!el.isConnected && el !== root) continue;
    const tag = el.localName;
    if (DROP_WITH_CONTENT.has(tag)) { el.remove(); continue; }
    if (!ALLOWED_TAGS.has(tag)) { el.replaceWith(...el.childNodes); continue; }
    cleanAttributes(el, tag);
  }
  // Comments can hide conditional markup in some engines; drop them.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.remove());
}

/** Parses untrusted HTML and returns a DocumentFragment that is safe to insert. */
export function sanitizeToFragment(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  cleanTree(doc.body);
  const fragment = document.createDocumentFragment();
  while (doc.body.firstChild) fragment.appendChild(document.adoptNode(doc.body.firstChild));
  return fragment;
}
