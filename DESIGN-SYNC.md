# Design Sync — 1132 Fixer for Windows

Visual source of truth for this repository is the separate
[1132-Fixer/design-system](https://github.com/1132-Fixer/design-system) repo
(docs and tokens; nothing in it is built, imported, or shipped here). This file
records the decisions this repository owns, and the evidence behind them.

---

## Explore panel

Governing issue: [#185](https://github.com/1132-Fixer/windows/issues/185).

### Hierarchy

1132 Fixer is the subject of this panel. It is not the first cell of a grid — it
is the panel's headline, with a full-width featured surface, a centered logo and
title, the largest product name, and the single primary action. Everything below
it is the network around it, grouped by purpose.

```text
Explore
Explore apps, bots, and tools. Links open in your browser.

FEATURED
  [logo] 1132 Fixer / Project website
  [Open Source]  [Visit project]
  Independent project — not affiliated with Zoom.

Explore the network

ORGANIZATIONS & SERVICES
  Botify Network      Prime Hosting       GIF Directory
BOTS
  BotifyKickBot       BotifyModBot
CREATIVE TOOLS
  Emoji Generator     Make It GIF
```

The independence line lives **inside the hero**, not in a panel footer. As a
footer it read as a statement about every product listed, including ones this
project does not own and cannot speak for.

`Open Source` is a status badge, not a control: there is no separate
open-source destination, so it must not look like it goes somewhere.

### Destination model

One catalog in `messages.js` (`EXPLORE_VIEW`), one category list
(`EXPLORE_CATEGORIES`). Category order is render order is focus order — a single
list, so the three cannot drift apart.

Fields: `id · name · description · category · icon · accent · featured`.
The URL is deliberately **not** in this model. The renderer only ever sends an
`id`; the id→URL map lives in trusted main-process code
(`src/main/electron-security.js`), so the renderer cannot supply an arbitrary
URL — not even a different path on an approved host.

| # | id | Name | Description | Category | URL |
|--:|----|------|-------------|----------|-----|
| 1 | `fixer` | 1132 Fixer | Project website | featured | `https://1132-fixer.xyz/` |
| 2 | `botify` | Botify Network | Network home | organizations | `https://botify-network.com/` |
| 3 | `primeHosting` | Prime Hosting | Hosting and developer services | organizations | `https://primehosting.dev/` |
| 4 | `gifDirectory` | GIF Directory | Organize and discover GIFs | organizations | `https://gif.directory/` |
| 5 | `kickbot` | BotifyKickBot | Moderation bot | bots | `https://botify-network.com/apps/botifykickbot` |
| 6 | `modbot` | BotifyModBot | Community management bot | bots | `https://botify-network.com/apps/botifymodbot` |
| 7 | `emojiGenerator` | Emoji Generator | Create custom emoji | creative-tools | `https://botify-network.com/apps/emoji-generator-bot` |
| 8 | `makeItGif` | Make It GIF | Create and convert GIFs | creative-tools | `https://botify-network.com/apps/makeitgif` |

Prime Hosting is the only URL added. Every other destination is unchanged, and
`tools/electron-security-smoke.js` pins the whole table so a silent edit fails.

`primehosting.dev` is allowlisted as an **exact host** — `*.primehosting.dev` is
not reachable.

GIF Directory is an organization and discovery utility. There is no `other` or
`more` category, and no `App page` placeholder copy remains.

### Component structure

| Component | Role |
|---|---|
| `.explore-hero` | 1132 Fixer. Informational; `Visit project` is its one control. |
| `.explore-network-intro` | "Explore the network" — secondary directory heading. |
| `.explore-section` + `.explore-group` | One category, with a real `<h3>` label the section is `aria-labelledby`. |
| `.explore-choice` | One reusable destination card, variants `accent-blue` / `accent-violet` / `accent-purple`. |

Each secondary card is **one** interactive control. The trailing external-link
glyph is decorative and inside the button, so a click on it bubbles to exactly
one handler — there is no nested control to launch the browser twice.

### Semantic tokens

Component-scoped, defined on `.explore-card` and mapped onto the existing
STYLEGUIDE palette rather than re-inventing colour:

```text
--explore-surface        --explore-text            --explore-accent-blue
--explore-surface-raised --explore-text-secondary  --explore-accent-violet
--explore-border         --explore-text-muted      --explore-accent-purple
--explore-border-strong  --explore-focus
```

### Breakpoints

Content-driven, not round numbers. The Explore modal gets ~828×630 logical
pixels at 100% scaling.

| Band | Condition | Organizations | Bots / Creative Tools |
|---|---|---|---|
| Wide | `min-width: 820px` | three equal columns | two columns each |
| Standard | `720–819px` | two columns + full-width GIF Directory | two columns each |
| Compact | `max-width: 719px` | one column | one column |

820px is where an organization column stays wide enough to read. Pushing GIF
Directory onto its own row below that width is deliberate: at the default width
a fourth destination row would exceed the height budget.

`max-height: 800px` switches the hero to a **centered horizontal group** — logo
beside the name rather than above it. That is what buys the ~50px the three
destination rows need. 1132 Fixer stays the largest, boldest, centered element;
it just stops being dominant by consuming half the panel.

Grid columns are `repeat(n, minmax(0, 1fr))`. A bare `1fr` floors at
`min-content`, so one long description would widen its column and push the grid
past the modal edge instead of wrapping inside its card.

### One-screen acceptance contract

At **828×630 at 100% scaling** the whole panel is visible at once: header, hero,
directory heading, all three category rows, all eight destinations, complete
bottom padding and modal border. No vertical scroll, no horizontal scroll, no
clipping, and the last row clears the modal's bottom border by ≥14px.

Smaller windows, 125% and 150% scaling scroll the **body** rather than clipping —
the header and close control stay reachable, and no destination becomes
unreachable.

### Interaction and accessibility

- Dialog accessible name `Explore`; `role="dialog"`, `aria-modal="true"`.
- Escape closes; close control is a 40×40 target though the glyph is 13px.
- Focus is trapped while open and returns to the Explore trigger on close.
- Every destination exposes `Open <product> in your default browser`.
- Focus is an **outline**, hover is a **fill** — never the same signal, and the
  focus ring is never clipped by a card container.
- Category is carried by a labelled heading, not by accent colour alone.
- `prefers-reduced-motion` is honoured.

### Asset mapping

Sourced from the attachments on issue #185 and normalised to 256px RGBA
(transparency preserved, aspect ratio preserved, `object-fit: contain`, no mask
or `overflow: hidden` — the Make It GIF circle keeps its outer ring and the
Prime Hosting hexagon keeps its points).

| Source | Repository path | Packaged md5 |
|---|---|---|
| issue #185 attachment `ddbe632e…` (1254×1254) | `assets/explore/make-it-gif.png` | `1d962830…` |
| issue #185 attachment `c09edba9…` (512×512) | `assets/explore/gif-directory.png` | `05c42c94…` |
| issue #185 attachment `dfe552b5…` (1290×1500) | `assets/explore/prime-hosting.png` | `c7b6e8c7…` |
| managed export `assets/logo-transparent.png` | Explore featured 1132 Fixer hero | listed in `.brand-assets.tsv` |

The Explore hero uses the managed full-logo export `assets/logo-transparent.png`.
Do not introduce `assets/explore/fixer-hero.png` or any other derived copy.
`assets/1132-fixer-logo-transparent.png` remains excluded from the package;
the header product mark remains `assets/brand/app-mark.png`.

No destination falls back to the generic globe in normal operation; the fallback
is reserved for a genuinely missing or corrupt asset.

### Verification

| Command | Result |
|---|---|
| `npm test` | exit 0 — 860+ assertions, 0 failures |
| `node tools/explore-capture.js --out artifacts/explore` | exit 0 — 5 viewports, all layout assertions pass |
| `node tools/explore-capture.js --root <extracted app.asar> …` | exit 0 — packaged files render identically |
| `npx electron-builder --win dir --x64 --publish never` | exit 0 |
| `node tools/explore-package-smoke.js` | exit 0 — all 8 icons byte-identical inside `app.asar`, case-exact |

Acceptance captures: `artifacts/explore/` (worktree) and
`artifacts/explore-packaged/` (rendered from the packaged app's own files).

`01` default 828×630 · `02` wide 1280×900 · `03` standard 760×600 ·
`04` 125% scaling · `05` 150% scaling · `06`/`07` keyboard focus ·
`08`/`09` supplied-logo close-ups.

**Boundary:** captures are headless-Chromium renders of the real page files
(worktree and packaged), with only `window.electronAPI` mocked. The packaged
Electron binary is a Windows executable and cannot be launched on the Linux
build host, so running the shipped `.exe` remains Windows-only verification.

---

## Compact repair panel — token reconciliation (2026-09-04, closed 2026-09-05)

Pinned design source: `design-system` @ `133fd766b1f53f34c63de1941e9aedeefde48516`
([1132-Fixer/design-system#4](https://github.com/1132-Fixer/design-system/pull/4),
closes [#196](https://github.com/1132-Fixer/windows/issues/196)). The shipped
Windows panel (6.2.0 onward) follows the **operator acceptance spec of
2026-08-23 (§4–§9)**, whose values are the single `:root` block in
`index.html`. The design system now records those values as the Windows
platform overlay — `tokens/windows.json`, `docs/platforms/windows.md`,
`docs/02-colors.md` § "Windows shipped palette" — instead of describing a
Windows app that "ships later". Every row below is therefore a **recorded**
platform value, not a divergence; the cross-platform tokens are unchanged and
still govern macOS, the Chrome extension and the website.

| Role | design-system Windows overlay | Shipped app token | Status |
|---|---|---|---|
| App background | `background` `#0F1724` | `--bg` `#0F1724` | match |
| Surface | `surface` `#172235`, `surface-2` `#1D2A3F` | `--panel`, `--panel-2` | recorded |
| Modal surface | `surface-2` (one navy theme, no plum tier) | `--panel-3` `#1D2A3F` | recorded |
| Hover / pressed fill | `surface-hover` `#243550`, `surface-pressed` `#293D5B` | `--surface-hover`, `--surface-pressed` | recorded |
| Primary / hover / pressed | `primary` `#337FDB`, `primary-hover` `#3B8AE8`, `primary-pressed` `#286BC2` | `--accent`, `--accent-2`, `--accent-pressed` | recorded |
| Focus ring | `focus` `#71AFFF`, 2px ring on a 2px `background` gap | `--focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--focus)` | recorded |
| Success / warning / error | `#2BC66D` / `#F3B84A` / `#F05D67` | `--success` / `--warning` / `--danger` | recorded |
| Text primary / secondary / muted | `#F5F7FB` / `#A8B5C7` / `#7F8DA1` | `--text` / `--muted` / `--dim` | recorded |
| Border | `border` `#2B3D57`, `border-strong` `#3B5578` | `--border`, `--border-strong` | recorded |
| Radii | control 10 / card 14 / modal 18 / pill 999 | `--r-sm` / `--r-md` / `--r-lg` / `--r-pill` | recorded |
| Spacing | 4 8 12 16 20 24 32 40 (`20`/`40` Explore + feedback dialogs only) | `--s-1` … `--s-8` | recorded |
| Window | default 520×600, min 440×520, header 56, footer 48, content max 420 | `main.js` `compactWindowBounds`, `index.html` APP SHELL | recorded |
| Typography | Segoe UI Variable stack, 14/400 body; screen title 24/32/700 | same | match |
| Motion | 150–250 ms, reduced-motion honoured | transitions ≤ 250 ms, `prefers-reduced-motion` in `index.html` and the compact shell | match |

Rules that follow from this:

- One token authority: `index.html` has exactly one `:root` block. The compact
  shell (`src/preload/compact-shell.js`) reads `var(--…)` from it and defines
  no hex of its own.
- Status tints (`--success-bg`, `--warning-bg`, `--danger-bg`, `--accent-bg`)
  are derived from the current status colours, not from an earlier palette.
- Every focusable control shows the `--focus-ring`; `tools/packaged-acceptance.js`
  checks this on the packaged build for every visible control.

---

## Ready screen and Details view (2026-09-04)

Pinned design source: `design-system` @ `133fd766b1f53f34c63de1941e9aedeefde48516`
(`docs/platforms/windows.md`, `docs/08-components.md`, `04-spacing.md`,
`05-layout.md`, `09-accessibility.md`, `07-motion.md`). Tokens are the `:root`
block in `index.html`, recorded in the design system as the Windows overlay
(section above; #196 closed by that pin).

### Screen structure

```text
┌ header 56px ── [Back]        ( mark )              [Exit] ─┐
│                                                            │
│  main — one column, max 420px, optically centered          │
│      Ready to fix Zoom                 24/32/700           │
│      Start Zoom with a fresh setup.    14/20 text-secondary│
│      Your personal files won’t be changed.                 │
│      [ Fix now ]                       240×44 primary       │
│      [x] Create desktop shortcut       18px box, 14/20 text │
│      View details ›                    tertiary, 32px       │
│                                                            │
└ footer 48px ── v6.3.2  Independent project. …   Support Feedback About ┘
```

- Header: `grid-template-columns: 1fr auto 1fr`, the product mark absolutely
  centered against the full width, so Back (Details view only) and Exit never
  move it. Header actions are quiet text (13/600 `--muted`, 32px min height,
  hover fill, pressed `--surface-pressed`, `--focus-ring`).
- Main: `.main` flex → `.workspace` column (`max-width: 420px`,
  `justify-content: center`, `padding-bottom: --s-6` for the optical lift).
  Title → sub `--s-2`; sub → action area `--s-6`; action area gap `--s-3`.
- Primary `Fix now`: `flex: 0 1 240px`, `min-height: 44px`, `--r-sm`;
  hover `--accent-2`, pressed `--accent-pressed`, disabled 50 %, ring
  `--focus-ring` (explicit `.btn-primary:focus-visible` — the box-shadow reset
  used to beat it).
- Repair option: `inline-flex`, 18px checkbox with `accent-color: --accent`,
  label 14/20/500 `--text`; the whole label is the target; `:focus-within`
  shows the ring.
- Tertiary `View details`: `.btn-quiet.btn-disclosure` — 13/600 `--muted`,
  32px, 1px transparent border; hover fill + `--border`; pressed
  `--surface-pressed`; Lucide `chevron-right` 16px that rotates 90° while
  `aria-expanded="true"`. Never a filled button, never a bare link.
- Footer: `min-height: 48px`, `border-top: 1px solid --border`, padding
  `--s-1 --s-4`. Left group (`--s-2` gap): version 12/600 `--muted` + the exact
  independence line 12/16 `--muted` (contrast raised from `--dim`). Right group:
  Support · Feedback · About as `.footer-link` (12/600, 32px, hover fill,
  pressed, ring). The line stays on one row at 520px and may wrap to two rows
  only below 480px; it never clips.
- Spacing uses only 4/8/12/16/24/32 (`--s-1…--s-4`, `--s-6`, `--s-7`); `20`
  and `40` remain defined for the Explore and feedback surfaces.
- Motion: `wiz-in` 200ms on pane and Details entry, 150ms hover/press
  transitions, chevron rotate 150ms; all collapse under
  `prefers-reduced-motion`.

### Action map — one allowlist per screen (`screen-actions.js`)

| Screen | Visible controls (besides Exit and the footer) |
|---|---|
| Checking | — |
| Ready | Fix now · Create desktop shortcut · View details |
| Blocked / action required | Restart as administrator or the Zoom recovery card · Check again · Close · View details |
| Fixing / Cancelling | Cancel fix · View details |
| Cancelled | Try again · View details |
| Complete | Open Zoom · (Create desktop shortcut only if that step did not complete) · Done · View details |
| Unable | Try again · Support Report · Copy error details · Close · View details |
| Details overlay (any state) | Back (header) · category rows · Back to details |

Root cause of the mixed-control defect this replaces: two owners painted the
same buttons — the renderer's per-outcome `setActions()` and the compact
shell, which reparented View details beside Cancel/Done, rebuilt the footer
from moved nodes, hid Explore with `display:none !important`, and showed its
own Cancel/Done through per-state CSS. The shell now derives the state and
calls `applyScreenControls(state, document, view)`: everything not on the
screen's list is hidden; nothing is ever revealed by the gate. Header, footer
and action area are static markup. Explore is a control of the About dialog
only. `tools/screen-actions-smoke.js` pins the map; `tools/ready-screen-capture.js`
and `tools/packaged-acceptance.js` assert the rendered result.

### Details view

- Opens in place (`renderer.js` `openDetails`): `#wizardCard` and
  `.action-area` get `hidden`, `#detailsView` shows, `body[data-view="details"]`,
  Back appears in the header, focus lands on Back. The state underneath is
  untouched, so Back and Escape restore it exactly (readiness result,
  checkbox, repair outcome) and focus returns to View details.
- Layout: heading 20/26/700 (`heading`), one-sentence intro 13/18, a summary
  strip (`--panel`, `--border`, `--r-md`: tone icon + headline 14/600 + count
  12/16), then one 40px row per category (icon · name 14/600 · summary 13
  `--muted` · chevron). Rows have no borders; hover fill, pressed, ring.
  Design-system checklist rows go two-column only above the 720px minimum
  window, so at 520px the overview is a single column by that rule.
- Category view replaces the overview in the same region: `Back to details`
  (tertiary, focus lands here), category name 16/22/600, then one row per
  check (icon · plain label 14/600 · status word 13/600 · explanation 13/18
  `--muted` on the next line, only when not Ready). Rows separated by a single
  `--border` line, no nested containers.
- Status vocabulary is exactly four words, mapped in `details-view.js`:
  pending → **Checking**, ready → **Ready**, repairable and blocked → **Needs
  attention**, warning and unknown → **Unable to verify**. A key the scan did
  not report is Unable to verify, never Ready. Icons: Lucide `check-circle`
  (`--success`), `alert-circle` (`--warning`), `help-circle` (`--muted`),
  `circle` (`--dim`); the word beside the icon carries the meaning.
- Plain English: every check has a user-facing label and description
  (Administrator access, Zoom installation, Helper account, Helper profile,
  Windows sign-in service, Camera permission, Microphone permission, Windows
  profile settings, Camera service). No registry hive, account name, path,
  command or policy key can reach the surface (`isPlainEnglish` guard,
  `tools/details-view-smoke.js`).
- After a run, **Repair results** (Camera permission, Microphone permission,
  Windows profile settings, Camera service) appears as one more category
  from the orchestrator receipt.
- Nothing scrolls: the overview (headline + 5–6 rows) and every category
  (≤ 4 checks) fit 440×520 at 150 % scaling; that is asserted, not assumed.

### Verification

| Command | Result |
|---|---|
| `npm test` | exit 0 (adds `screen-actions-smoke`, `details-view-smoke`) |
| `node tools/ready-screen-capture.js --out …` | exit 0 — 6 viewports × Ready/Details/5 categories/Back/Escape/Enter, plus Checking, Fixing (+Details, Exit confirm), Complete (+Repair results), Unable (+retry to Complete), Blocked (+App category), About → Explore |
| `tools/packaged-acceptance.js` (CI, shipped binary) | per landing scale: `controls-belong-to-state`, `details-opens-in-place`, `details-focus-starts-on-back`, `details-no-foreign-controls`, `details-no-scrollbars`, `details-plain-english`, `details-categories`, `details-category-opens`, `details-back-restores-state`, `details-back-returns-focus`, `details-back-preserves-option` |

Captures: `harness render — real page code and assets, mocked electronAPI`;
the packaged `.exe` is Windows-only verification on the CI runner.
