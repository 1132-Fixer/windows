# Helper-shortcut artwork — BOUND

The helper-shortcut rebrand (operator order 2026-08-07) is complete, artwork
included. This file records provenance and the rules that keep it correct.

## The master

`assets/1132-helper-shortcut.png` — the operator's transparent PNG master,
byte-identical to the supplied file (sha256
`a2df0f7429e94b25714a0657a9c0322bd685605565b8c90b53595cf4d4934958`,
1024×1024, 8-bit RGBA, 1,497,101 bytes). Artwork: a two-user handoff mark
(blue and silver figures, orange transfer arrow) on a metallic-framed plate
with the 1132 gear badge — deliberately distinct from the application icon,
because a shortcut that launches Zoom as the helper account is not the app.

It is referenced by:

- `index.html` — the **Create Zoom Helper Shortcut** button's decorative 24 px
  image (`.btn-icon`, `alt=""`, `aria-hidden="true"`; the button text supplies
  the accessible name).

## Generated from it

`assets/1132-helper-shortcut.ico` — real multi-frame icon, **9 frames**
verified present at 16, 20, 24, 32, 40, 48, 64, 128, 256, produced by the same
pipeline as the application icon (sharp lanczos ladder → png-to-ico → ICONDIR
frame-count and per-frame-size assertions). The `.lnk` created by
`create-shortcut` points at it through `getHelperIconPath()`, twinned with
`getIconPath()` (packaged `resources/…` vs dev `assets/…`) — never a worktree
or temp path — and the `.ico` ships via `build.extraResources`.

Regenerate with `scratchpad/asset-build/helper-ico.js`-equivalent steps if the
master ever changes; the assertions are the contract, not the file size.

## Verified

- Transparency survives conversion: corner alpha 0 on the 256 frame, 8.03% of
  pixels fully transparent — no black, white, or green rectangle.
- Frame count asserted 9; every frame's dimensions asserted exactly.
- Small sizes inspected: the two-figure silhouette and orange arrow read
  clearly at 24 and 48 px; the 1132 badge merges into the plate below ~24 px,
  which is expected for a badge that small and does not cost identity.
- Suite: 11 PASS / 0 FAIL.

## Still owed (needs a physical display)

Taskbar and desktop appearance of the created shortcut, and a live launch
through the helper account. Those need a real displayed Windows session and
are reported as validation pending rather than claimed here.
