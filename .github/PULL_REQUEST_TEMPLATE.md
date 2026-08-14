<!--
  Thank you for contributing to 1132 Fixer for Windows.
  Keep the change focused — one concern per PR. See CONTRIBUTING.md.
-->

## What changed

<!-- A short, concrete summary of the change. -->

## Why

<!-- The problem this solves, or the issue it closes (e.g. "Closes #123"). -->

## User-visible impact

<!-- What a user of the app would notice, if anything. Write "None" if internal only. -->

## How I tested it

<!-- The exact commands you ran and what you observed. Be specific. -->

## Safety impact

This app creates and resets a local Windows account, uses elevation, and handles
a DPAPI-sealed credential. Tick every area this PR touches:

- [ ] Changes **local account** behaviour (create/reset/delete `user1`)
- [ ] Changes **privilege or elevation** behaviour
- [ ] Changes **credential handling** (DPAPI, stored secrets, the launcher)
- [ ] Changes **updater or release** behaviour
- [ ] **None of the above** — no safety-sensitive surface is affected

## Verification

- [ ] `npm test` passes locally
- [ ] I launched the app locally (`npm start`) and it starts
- [ ] I exercised the relevant Windows flow (or explained why it could not be tested)
- [ ] Documentation is updated (README / CONTRIBUTING / docs), or no docs change is needed

<!--
  Do not commit secrets, certificates, .env files, or unpacked release binaries.
  Do not open a PR that rewrites git history.
-->
