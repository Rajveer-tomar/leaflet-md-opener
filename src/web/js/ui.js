// Small UI primitives: toast, banner, download.

const $ = (id) => document.getElementById(id);

let toastTimer = 0;
export function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/**
 * Shows a banner under the toolbar. `actions` is a list of
 * { label, kind?: 'primary'|'danger'|'ghost', run } - clicking any closes it.
 */
export function showBanner(message, actions = [], key = '') {
  const banner = $('banner');
  banner.dataset.key = key;
  $('bannerText').textContent = message;
  const box = $('bannerActions');
  box.replaceChildren(...actions.map(({ label, kind = 'ghost', run }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${kind}`;
    b.textContent = label;
    b.addEventListener('click', () => { hideBanner(); run?.(); });
    return b;
  }));
  banner.hidden = false;
}

export function hideBanner(key) {
  const banner = $('banner');
  if (key === undefined || banner.dataset.key === key) banner.hidden = true;
}

export function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function countWords(text) {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
}

export { $ };
