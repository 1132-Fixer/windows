# Helper-shortcut artwork slot — AWAITING OPERATOR ARTWORK

This file is a placeholder record, not artwork. The helper-shortcut rebrand
(operator order 2026-08-07) is complete in code and blocked only on the
artwork handoff.

## What lands here

`assets/1132-helper-shortcut.png` — the operator's transparent PNG master
(`1132-helper-shortcut-transparent-filled.png`), placed under this permanent
filename. It is already referenced by:

- `index.html` — the **Create Zoom Helper Shortcut** button's decorative 24 px
  image (`.btn-icon`, `alt=""`, `aria-hidden="true"`; the button text supplies
  the accessible name).

Until the PNG exists the button renders its text label with a broken-image
slot suppressed by `alt=""` — the control stays fully usable, and no
substitute or regenerated approximation is shipped.

## What gets generated from it

`assets/1132-helper-shortcut.ico` — real multi-frame icon at
**16, 20, 24, 32, 40, 48, 64, 128, 256**, produced by the same verified
pipeline used for the application icon (sharp lanczos ladder → png-to-ico →
ICONDIR frame-count assertion). The `.lnk` created by `create-shortcut` points
at the installed path via a `getHelperIconPath()` resolver twinned with the
existing `getIconPath()` (packaged `resources/…` vs dev `assets/…`) — never a
worktree or temp path.

## Verification owed once the artwork lands

Real transparency (RGBA alpha present, corners transparent — no black, white,
or green rectangle) · icon inspected at 16 / 24 / 32 / 48 / 256 · button
displays the artwork · created shortcut shows the icon on desktop **and**
taskbar · launching still runs the same `user1` helper flow (code path
unchanged by this work).
