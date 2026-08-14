# NOTICE

1132 Fixer for Windows
Copyright (c) 2024-2026 1132 Fixer

This product is licensed under the MIT License. See [LICENSE](LICENSE) for the
full licence text. This NOTICE file records attribution requests, third-party
acknowledgements, and notices for bundled components. It does not add
conditions to the MIT licence.

---

## Attribution

The MIT licence does not require attribution beyond preserving the copyright and
permission notice. As a courtesy — not a licence condition — forks and copies
are asked to credit the canonical repository:

`https://github.com/1132-Fixer/windows`

The **1132 Fixer name, logo, and icons are trademarks and are not covered by the
MIT licence.** See [TRADEMARKS.md](TRADEMARKS.md).

---

## Third-party components

The distributed application bundles the following third-party software. Each is
used under its own licence; the full licence texts ship inside the respective
package directories under `node_modules/` and in the packaged application
resources.

| Component | Version at time of writing | Licence | Role |
| --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 43.2.0 | MIT | Application runtime |
| [Chromium](https://www.chromium.org/) | bundled by Electron | BSD-3-Clause and others | Rendering engine (via Electron) |
| [Node.js](https://nodejs.org/) | bundled by Electron | MIT | JavaScript runtime (via Electron) |
| [electron-updater](https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater) | 6.8.9 | MIT | Auto-update client |
| [electron-builder](https://github.com/electron-userland/electron-builder) | 24.13.3 | MIT | Build/packaging tool (build-time only, not shipped) |

Additional transitive dependencies are declared in [`package.json`](package.json)
and pinned in `package-lock.json`; their licences are available in each package's
directory under `node_modules/`.

---

## Bundled binary components

1132 Fixer aims to be buildable from source. The tree does not carry opaque,
unbuildable native binaries as part of the application. Image and icon assets
under `assets/` (`.png`, `.ico`) are project brand assets — see
[TRADEMARKS.md](TRADEMARKS.md).

### Historical: `assets/dpapi_hook.dll` (removed)

A compiled native library, `assets/dpapi_hook.dll` (17920 bytes,
SHA-256 `7c76641818c3287dec7493e236b436de7d0735de9778b34875c8f8b7a56f71cc`),
was present in the tree until this change. It is documented here for
transparency rather than left undocumented.

- **What it was:** a DPAPI hook library introduced in v5.0.19
  (commit `a02b245`, 2026-03-19) as part of a device-fingerprint feature that
  loaded the DLL via a `dpapi-launcher` module.
- **Current status:** dead code. The loader module (`src/main/operations/dpapi-launcher.js`)
  was removed in v5.1.0 (commit `576af26`, "clean up dead code"); the binary was
  left behind. In the current tree no source, build step, packaging rule, or
  runtime code references it. It was matched only by a broad `**/*` packaging
  glob, so it was being copied into the installer while never being loaded.
- **Provenance:** no source and no separate licence were ever committed with the
  binary, so it could not be rebuilt from this repository and its licence status
  in isolation was undetermined.
- **Resolution:** the orphaned binary was removed so the published tree is
  buildable from source and carries no opaque native executable. The historical
  copy remains in git history (no history rewrite was performed).
