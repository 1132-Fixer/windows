# Configuration reference

This page lists every setting that the app, the build and the release
workflows read. It gives names and effects only. It never gives a secret value.

The app has no settings file and holds no credential. Every value that enters
the packaged app is public.

## App settings

| Name | Read by | When | Default | Effect |
| --- | --- | --- | --- | --- |
| `FEEDBACK_PROXY_URL` | `scripts/inject-config.js`, `src/main/config.js` | Build time. Run time only in development (see below). | Not set | Public HTTPS address of the support service. When it is not set or not valid, in-app submissions are off and the app says so. |
| `PRODUCTS_URL` | `src/main/config.js` | Run time | `https://botify-network.com/` | Page that **Explore Our Products** opens. The address must pass the external-URL allowlist in `src/main/electron-security.js`. An address that is not on the list hides the section. |

### How the support address enters a build

1. Each build script (`npm run build`, `build:installer`, `build:all`) first
   runs `scripts/inject-config.js`.
2. That script reads `FEEDBACK_PROXY_URL` from the environment. The address
   must use HTTPS and must have no user name, password, query or fragment.
   The path must be `/` or `/v1/feedback`. The script stops the build when the
   address is not valid, and it does not print the rejected text.
3. The script writes `src/main/config.generated.js` with the normalized
   address and `FEEDBACK_CONFIG_REVISION`, a SHA-256 value of that address.
   Git ignores this file. Do not commit it.
4. At run time, `src/main/config.js` loads the generated file and computes the
   revision again. If the two values differ, or the file does not load, the
   address is treated as not set. The app fails closed.

A packaged app reads the address from the generated file only. An environment
variable on the user's computer cannot change it.

### Local development

`npm start` reads `FEEDBACK_PROXY_URL` from the environment only while
`src/main/config.generated.js` does not exist:

```powershell
$env:FEEDBACK_PROXY_URL = 'https://support.example.test'
npm start
```

After any build script has run, the generated file exists and it wins. Delete
`src/main/config.generated.js` to use the environment again. With no address,
the app starts normally and the feedback form reports that submissions are not
available.

## Repository variables and secrets (GitHub Actions)

Names only. Set them in the repository settings, never in a file.

| Name | Kind | Used by | Purpose |
| --- | --- | --- | --- |
| `FEEDBACK_PROXY_URL` | variable | `ci.yml` (build), `release.yml` (publish) | Support address for candidate and release builds. The release also checks that the service answers; see [Release process](release-process.md). |
| `NATIVE_ACCEPTANCE_ARTIFACT_ID` | variable | `release.yml` (preflight) | Identifier of the native acceptance evidence for the release candidate. |
| `SUPPORT_CLEARANCE_ARTIFACT_ID` | variable | `release.yml` (preflight) | Identifier of the support clearance evidence for the release candidate. |
| `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT`, `ARTIFACT_SIGNING_PROFILE`, `ARTIFACT_SIGNING_PUBLISHER` | variables | `ci.yml` through `scripts/signing-config.mjs` | Microsoft Artifact Signing. Signing is off unless all seven signing values are present. A partial set fails the build. See [Code signing](../security/code-signing.md). |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | secrets | `ci.yml` through `scripts/signing-config.mjs` | The identity for Microsoft Artifact Signing. Pull request builds never receive them. |
| `DESIGN_SYSTEM_DEPLOY_KEY`, `DESIGN_SYSTEM_TOKEN` | secrets | `ci.yml`, `brand.yml` through `.github/scripts/fetch-design-system.js` | Read access to fetch the pinned `design-system` submodule. |
| `GITHUB_TOKEN` | built in | all workflows | Supplied by GitHub Actions for each run. |
| `RELEASE_SETTINGS_READ_TOKEN` | secret | `release.yml` through `scripts/release-preflight.mjs` and `scripts/publish-release.mjs` | Reads only the immutable-release setting. GitHub shows that setting only with the Administration read permission, which `GITHUB_TOKEN` cannot have (GitHub answers 403). Use a fine-grained token for this repository with Administration: read and nothing else; record its owner and expiry date when you set it. Optional: without it, CI skips only that read and the release actor makes the local pre-tag readback in `docs/development/release-process.md`. |

## Settings for manual tools

| Name | Read by | Purpose |
| --- | --- | --- |
| `RELEASES_OWNER`, `RELEASES_REPO` | `scripts/validate-release-assets.mjs` | Repository to audit. Defaults: `1132-Fixer`, `windows`. |
| `RELEASES_PAT` or `GITHUB_TOKEN` | `scripts/validate-release-assets.mjs` | Token to read release metadata. Public releases also work without a token, with a lower rate limit. |
| `RELEASE_TAG` | `scripts/validate-release-assets.mjs` | Tag to audit when no argument is given. |
| `CSC_LINK`, `WIN_CSC_LINK`, `ARTIFACT_SIGNING_CONFIGURED` | `scripts/check-signature-state.mjs` | Tell the signature check whether a signed result is expected. |

The release scripts also read values that the workflows set for themselves
(`RELEASE_REF_BEFORE`, `RELEASE_REF_AFTER`, `RELEASE_TAG_PUSHER`,
`RELEASE_VERSION`, `RELEASE_RECEIPT_KIND`, `RELEASE_RECEIPT_BASE64`). Do not
set them by hand. [Release process](release-process.md) describes each step.

## Windows values the app reads

Windows or the package sets these. They are not settings.

| Name | Use |
| --- | --- |
| `PORTABLE_EXECUTABLE_DIR` | Present only in the portable build. The app uses it to tell the portable build from the installed build. |
| `APPDATA` | To find a per-user Zoom installation. |
| `PUBLIC`, `OneDrive`, `OneDriveConsumer`, `OneDriveCommercial` | To find the Desktop folders that can hold the helper shortcut. |
| `PROCESSOR_ARCHITECTURE`, `PROCESSOR_ARCHITEW6432` | To compare the Zoom build with the operating system. |
