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
| `assets/1132-fixer-logo-transparent.png` (440×440) | `assets/explore/fixer-hero.png` | `81ed40e9…` |

`fixer-hero.png` exists because `assets/1132-fixer-logo-transparent.png` is on
the `build.files` **exclude** list — referencing it directly would have shipped a
hero with no logo.

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
