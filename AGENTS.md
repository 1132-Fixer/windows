# AGENTS.md — 1132 Fixer (Windows/Electron)

Standing instructions for any agent working in this repo. Treat this file as
the source of truth for conventions and boundaries.

## Line-ending policy (mandatory)

Preserve `.gitattributes`: repo blobs stay LF; Windows-native scripts
(`.ps1`, `.psm1`, `.psd1`, `.cmd`, `.bat`) may check out as CRLF on disk.
Never commit whole-tree CRLF/LF churn.

Before any commit:

1. Run `git diff --check`, `git diff --stat`, and confirm the diff contains
   real content changes only.
2. If `git diff -w` is empty across many files, treat it as line-ending noise
   and stop before committing.
