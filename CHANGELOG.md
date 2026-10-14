# Changelog

## 2.0.0 - 2026-10-14

### Added
- `npm install -g leaflet-md-opener`: installs, adds a `leaflet-md` command, registers
  `.md` files and opens the Windows app picker.
- Close button at the top-right of the toolbar.
- **Editing.** Split view (preview left, editor right) and an Editor-only view; Preview stays
  the default. Saves to the original file with Ctrl+S.
- Conflict protection: saving refuses to overwrite a file changed on disk since it was
  opened, and files changed elsewhere reload automatically.
- Line endings (CRLF/LF) and UTF-8 BOM are preserved on save.
- Opens full screen in an Edge/Chrome app window by default (`-Window` to change).
- Block-matched scroll sync, resizable split, clickable task-list checkboxes, list
  continuation, formatting bar and shortcuts, "New file" button.
- Links between Markdown files open inside Leaflet; heading anchors.
- Settings (theme, width, text size, split, sidebar) are remembered.
- HTML sanitiser and Content-Security-Policy for documents containing raw HTML.
- Per-user install/uninstall scripts and helper unit tests.

### Changed
- Runs a small localhost server instead of writing a temporary HTML file.
- Mermaid diagrams follow the theme (dark themes get dark diagrams).
- New folder layout: `src/`, `scripts/`, `tests/`, `examples/`, `docs/`.

## 1.0.0

- Read-only viewer: rendered Markdown, Mermaid, sidebar of files in the folder, four themes,
  export to PDF.
