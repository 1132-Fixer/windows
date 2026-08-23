# AGENTS.md

## Design System
- The source of truth for all design decisions is the separate repository `https://github.com/1132-Fixer/design-system` (docs and tokens; nothing in it is built, imported, or shipped by this repo).
- For any design matter — colors, typography, spacing, components, icons, visual patterns — consult that repository first and follow its tokens/components.
- Do not invent new visual patterns, colors, or component styles that diverge from it.
- If it lacks guidance for a needed case, ask the user before improvising rather than guessing.
- It is **not** a git submodule of this repository. It used to be, pointing at a commit that no longer exists after the design-system history was rewritten, which broke every `git clone --recurse-submodules` — including Dependabot's, which aborted before reading a manifest and so could not open a PR for three open security advisories. Clone it separately if you need it; do not re-add it as a submodule.

## Instructions

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
