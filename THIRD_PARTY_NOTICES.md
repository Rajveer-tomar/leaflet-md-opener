# Third-party notices

Leaflet bundles these libraries, unmodified, in `src/web/vendor/` so that it works fully
offline. Each keeps its own license; their copyright headers remain in the files.

| Library | Version | License | Source |
| --- | --- | --- | --- |
| marked | 18.0.13 | MIT | https://github.com/markedjs/marked |
| highlight.js (+ GitHub themes) | 11.9.0 | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| Mermaid | 12.0.0 | MIT | https://github.com/mermaid-js/mermaid |

To update one, replace its file in `src/web/vendor/` with the browser/UMD build of the new
version and update the table above.
