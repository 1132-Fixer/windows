<!-- This notice supplements the repository's MIT licence as declared in package.json ("license": "MIT") and reproduced in the root LICENSE file, and as shipped with builds in build/license.txt. It modifies none of them. The MIT declaration is the source-license statement this notice qualifies, prospectively from this notice forward. -->

# Asset license notice — brand and mark boundary

Added 2026-08-09. **This notice applies prospectively from the date it is added to the
repository. It does not state, and must not be read to imply, that any rights previously
granted are cancelled or retracted.**

## What the MIT declaration covers

The MIT declaration in [`package.json`](package.json) (`"license": "MIT"`), whose full
text is the root [`LICENSE`](LICENSE), covers the code, the documentation, and the
eligible design tokens in this repository. That
includes, without limitation:

- the application source (`main.js`, `renderer.js`, `preload.js`, `messages.js`,
  `zoom-detect.js`, `run-verdict.js`, `helper-credential.js`, `index.html`, and the code
  under `src/`, `scripts/`, and `tools/`)
- the CSS custom properties and design-token vocabulary used by the app styles
- all written documentation (`README.md`, `CHANGELOG.md`, `docs/`, and asset README
  files such as `assets/1132-helper-shortcut.README.md`)

Distributed installers and portable builds ship [`build/license.txt`](build/license.txt).
That file is the same MIT text as the root [`LICENSE`](LICENSE), plus a canonical-source
line — it is not a separate end-user agreement. This notice does not modify it.

## What is not licensed under MIT — prospectively from this notice forward

The product names, logos, icons, and brand artwork identified below are **not** licensed
under the MIT declaration, prospectively from this notice forward.

**Names and marks**

- the product name **"1132 Fixer"**
- the **1132 Fixer gear logo** (the blue gear device with orange "1132" and silver
  "Fixer" lettering, in all raster and vector renditions)
- the **helper-shortcut artwork** (the two-user handoff mark with transfer arrow and
  gear badge described in `assets/1132-helper-shortcut.README.md`)

**Files (exact list)**

- `assets/icon.ico`
- `assets/icon.png`
- `assets/1132-fixer-logo-transparent.png`
- `assets/logo-transparent.png`
- `assets/1132-helper-shortcut.ico`
- `assets/1132-helper-shortcut.png`
- `assets/brand/logo-mark.svg` (a vector wrapper that embeds
  `1132-fixer-logo-transparent.png`; the wrapper markup itself is trivial — the embedded
  artwork is what this notice covers)
- `assets/brand/tray.svg`
- `assets/brand/status-error.svg`
- `assets/brand/status-running.svg`
- `assets/brand/status-success.svg`
- `assets/brand/status-warning.svg`
- `assets/social-preview.png`
- `social-preview.png` (repository root)

## Scope of the reservation — honesty clause

Rights in the names and files above are reserved **only to the extent actually controlled
by the project**. This notice claims no exclusive ownership of any asset whose provenance
has not been established. For every asset marked "under review" in the table below:
**provenance under review — status will be corrected when established.**

## Provenance records

Status legend:

- **controlled** — created in this repository with its source of authorship in the repo
  history (hand-authored vector source in-repo); no external provenance identified.
- **under review (CR-10)** — provenance under review — status will be corrected when
  established. The current artwork traces to the 2026-08-07 brand-refresh directives,
  whose asset provenance is being verified under review item CR-10.
- **under review (legacy raster)** — provenance under review — status will be corrected
  when established. A legacy raster asset with no in-repo source attestation.

| File | What it depicts | First appeared (commit) | Current artwork since (commit) | Provenance status |
|---|---|---|---|---|
| `assets/icon.ico` | gear mark on dimensional card (app icon, multi-res) | `a208b88` (2026-02-19) | `afc4207` (2026-08-07, PR #116) | under review (CR-10) |
| `assets/icon.png` | gear mark on dimensional card (app icon) | `a208b88` (2026-02-19) | `afc4207` (2026-08-07, PR #116) | under review (CR-10) |
| `assets/1132-fixer-logo-transparent.png` | blue gear with orange "1132" and silver "Fixer" lettering, transparent background | `3365f05` (2026-08-07, PR #114) | `3365f05` (2026-08-07, PR #114) | under review (CR-10) |
| `assets/logo-transparent.png` | transparent gear logo (footer rendition) | `3365f05` (2026-08-07, PR #114) | `3365f05` (2026-08-07, PR #114) | under review (CR-10) |
| `assets/1132-helper-shortcut.ico` | two-user handoff mark with transfer arrow and gear badge (helper shortcut icon) | `ba4f32b` (2026-08-07, PR #118) | `ba4f32b` (2026-08-07, PR #118) | under review (CR-10) |
| `assets/1132-helper-shortcut.png` | two-user handoff mark, 1024 px transparent master | `ba4f32b` (2026-08-07, PR #118) | `ba4f32b` (2026-08-07, PR #118) | under review (CR-10) |
| `assets/brand/logo-mark.svg` | vector wrapper embedding `1132-fixer-logo-transparent.png` | `8e8c570` (2026-05-29, PR #35) | `3365f05` (2026-08-07, PR #114) | under review (CR-10) |
| `assets/brand/tray.svg` | simplified gear silhouette for the tray icon (hand-authored SVG) | `8e8c570` (2026-05-29, PR #35) | `8e8c570` (2026-05-29, PR #35) | controlled |
| `assets/brand/status-error.svg` | status indicator glyph: error | `8e8c570` (2026-05-29, PR #35) | `8e8c570` (2026-05-29, PR #35) | controlled |
| `assets/brand/status-running.svg` | status indicator glyph: running | `8e8c570` (2026-05-29, PR #35) | `8e8c570` (2026-05-29, PR #35) | controlled |
| `assets/brand/status-success.svg` | status indicator glyph: success (check) | `8e8c570` (2026-05-29, PR #35) | `8e8c570` (2026-05-29, PR #35) | controlled |
| `assets/brand/status-warning.svg` | status indicator glyph: warning | `8e8c570` (2026-05-29, PR #35) | `8e8c570` (2026-05-29, PR #35) | controlled |
| `assets/social-preview.png` | social/preview banner with gear mark and wordmark | `3365f05` (2026-08-07, PR #114) | `afc4207` (2026-08-07, PR #116) | under review (CR-10) |
| `social-preview.png` (root) | earlier social/preview banner with prior branding | `2fdd945` (2026-02-28) | `2fdd945` (2026-02-28) | under review (legacy raster) |

Commits are cited from this repository's history (`git log --follow`).
