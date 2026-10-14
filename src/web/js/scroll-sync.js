// Keeps the editor and preview scrolled to the same part of the document.
//
// Proportional sync drifts badly when a short source line becomes a tall
// diagram, so instead each preview block (data-line) is paired with the pixel
// position of that same line in the editor, and scrolling interpolates between
// the nearest pair. Editor line positions are measured with a hidden "mirror"
// element because a wrapped textarea cannot report where a line starts.

const MIRRORED_STYLES = [
  'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
  'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak', 'textIndent',
];

function measureLineTops(textarea, lineNumbers) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement('div');
  MIRRORED_STYLES.forEach((p) => { mirror.style[p] = style[p]; });
  mirror.style.width = textarea.clientWidth + 'px';
  mirror.style.boxSizing = 'border-box';
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-99999px', height: 'auto' });

  const lines = textarea.value.split('\n');
  const wanted = new Set(lineNumbers);
  const markers = new Map();
  let buffer = '';
  lines.forEach((line, i) => {
    if (wanted.has(i)) {
      if (buffer) mirror.appendChild(document.createTextNode(buffer));
      buffer = '';
      const marker = document.createElement('span');
      mirror.appendChild(marker);
      markers.set(i, marker);
    }
    buffer += line + '\n';
  });
  if (buffer) mirror.appendChild(document.createTextNode(buffer));

  document.body.appendChild(mirror);
  const tops = new Map([...markers].map(([i, m]) => [i, m.offsetTop]));
  mirror.remove();
  return tops;
}

function interpolate(points, fromKey, toKey, value) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (value >= a[fromKey] && value <= b[fromKey]) {
      const span = b[fromKey] - a[fromKey];
      const t = span > 0 ? (value - a[fromKey]) / span : 0;
      return a[toKey] + t * (b[toKey] - a[toKey]);
    }
  }
  return points.length ? points[points.length - 1][toKey] : 0;
}

export function createScrollSync({ editor, previewPane, preview, isActive }) {
  let points = [];
  let stale = true;
  let leader = null;
  let leaderTimer = 0;

  function rebuild() {
    const blocks = [...preview.querySelectorAll(':scope > .blk')];
    const lines = blocks.map((b) => Number(b.dataset.line));
    const tops = measureLineTops(editor, lines);
    const paneTop = previewPane.getBoundingClientRect().top - previewPane.scrollTop;

    points = [{ e: 0, p: 0 }];
    blocks.forEach((b, i) => {
      const e = tops.get(lines[i]);
      const p = b.getBoundingClientRect().top - paneTop;
      const last = points[points.length - 1];
      if (e === undefined || e < last.e || p < last.p) return; // keep it monotonic
      points.push({ e, p });
    });
    const endE = editor.scrollHeight - editor.clientHeight;
    const endP = previewPane.scrollHeight - previewPane.clientHeight;
    const last = points[points.length - 1];
    if (endE > last.e && endP > last.p) points.push({ e: endE, p: endP });
    stale = false;
  }

  function follow(source) {
    if (!isActive()) return;
    // Ignore the scroll event our own assignment causes on the other pane.
    if (leader && leader !== source) return;
    leader = source;
    clearTimeout(leaderTimer);
    leaderTimer = setTimeout(() => { leader = null; }, 120);

    if (stale) rebuild();
    if (source === editor) {
      previewPane.scrollTop = interpolate(points, 'e', 'p', editor.scrollTop);
    } else {
      editor.scrollTop = interpolate(points, 'p', 'e', previewPane.scrollTop);
    }
  }

  editor.addEventListener('scroll', () => follow(editor), { passive: true });
  previewPane.addEventListener('scroll', () => follow(previewPane), { passive: true });
  // Width changes rewrap the editor; images and diagrams grow the preview
  // after they load. Either one moves every pair.
  const observer = new ResizeObserver(() => { stale = true; });
  observer.observe(editor);
  observer.observe(preview);

  return {
    invalidate() { stale = true; },
    /** Re-align the preview to wherever the editor currently is. */
    syncNow() { stale = true; leader = null; follow(editor); },
  };
}
