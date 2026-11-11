# Vendored dependencies

These files are committed so the application runs offline with no CDN and no
package install. Nothing here is loaded from the network at runtime.

## jsPDF 4.2.1

- File: `jspdf/jspdf.umd.cjs` (upstream `dist/jspdf.umd.js`, renamed to `.cjs`
  so Node always loads it as CommonJS while browsers load it with a plain
  `<script>` tag, which is the environment the UMD wrapper detects).
- Upstream: https://github.com/parallax/jsPDF
- License: MIT, full text in `jspdf/LICENSE.txt`.
- Copyright: (c) 2010-2025 James Hall, (c) 2015-2025 yWorks GmbH and
  contributors.
- Pinned by `package-lock`-free download from the npm registry tarball
  `jspdf@4.2.1`; the exact version is also recorded in the file header.
- Used for: vector PDF export only. The application builds one jsPDF document
  from the canonical render scene and never rasterizes the drawing.

To upgrade: download the new `dist/jspdf.umd.js` from the release tarball,
replace `jspdf/jspdf.umd.cjs`, copy its `LICENSE`, update the version noted in
this file, and re-run `npm test` (the renderer tests assert on real PDF output).
