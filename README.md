<p align="center">
  <img src="assets/icon.png" alt="1132 Fixer" width="180">
</p>

<h1 align="center">1132 Fixer - Windows</h1>

<p align="center">
  <strong>Fix Zoom Error 1132 device bans on Windows.</strong><br>
  1132 Fixer helps you get back into Zoom by creating a fresh local Windows user and launching Zoom Workplace as that user.
</p>

<p align="center">
  <a href="https://github.com/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/latest">Download Latest Release</a>
</p>

---

## What It Does

Zoom Error 1132 can behave like a device-level or user-profile-level restriction that persists even after uninstalling and reinstalling Zoom.

Instead of purging Zoom database files, this updated fixer uses a cleaner launch method:

- Creates a new local Windows user
- Adds that user to the local Administrators group
- Launches Zoom Workplace as that new user
- Optionally creates a Desktop quick-launch shortcut for future use

## How It Works

When you press **Fix Now**, the app will:

1. Create or reset a local Windows user:

   ```text
   Username: user1
   Password: user1
   ```

   If `user1` already exists, its password is reset to `user1` (the rest of the profile is preserved so Zoom sign-in state survives).

2. Ensure `user1` is in the local Administrators group
3. Launch Zoom Workplace as `user1` from:

   ```text
   C:\Program Files\Zoom\bin\Zoom.exe
   ```

   The launch uses PowerShell `Start-Process -Credential`, so no console password prompt appears.

4. Optionally place a quick-launch shortcut on your Desktop

## Important Notice

This fix creates a new Windows user on your computer.

Default credentials:

```text
Username: user1
Password: user1
```

The user is added to the local Administrators group so Zoom can run properly under that profile.

Windows may show permission prompts while the fix runs. You must approve those prompts for the fix to complete.

## Desktop Quick Launch

1132 Fixer can also create a Desktop shortcut named:

```text
Launch Zoom as user1
```

This shortcut lets you launch Zoom using the created Windows user in the future without reopening the fixer app.

The shortcut uses the same icon/logo as the 1132 Fixer app.

## Install

Download the latest **Setup .exe** from [Releases](https://github.com/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/latest).

Requires:

- Windows 10 or Windows 11
- Administrator privileges
- Zoom Workplace installed at the default location

## Usage

1. Run **1132 Fixer**
2. Read the notice explaining that a new Windows user will be created
3. Press **Fix Now**
4. Approve any Windows permission prompts
5. Zoom Workplace launches as the new user
6. Optionally create the Desktop quick-launch shortcut

## Troubleshooting

If the fix fails, check that:

- You are running the app as Administrator
- Zoom Workplace is installed
- Zoom exists at:

  ```text
  C:\Program Files\Zoom\bin\Zoom.exe
  ```

- Your Windows account has permission to create local users
- Security software is not blocking user creation or `runas`

### Camera or microphone does not work as `user1`

As of **v5.3.6**, the fixer grants Windows camera + microphone consent
to desktop apps for the newly created `user1` automatically. If camera
or mic still does not work in Zoom under `user1`, the cause is almost
always one of these — none of which a Zoom-error fixer can override:

| Cause | What to do |
|---|---|
| **Windows organization / MDM policy blocks camera or microphone** | The Fix Receipt panel will show `BLOCKED BY WINDOWS POLICY`. Ask your Windows administrator. Or use a non-managed personal device. |
| **Hardware privacy shutter is closed** | Lenovo ThinkShutter, Dell webcam slider, function-key camera disable (F-key with camera icon). Slide it open / toggle the key. |
| **Third-party antivirus webcam shield** | Bitdefender, Kaspersky, ESET, Norton, and similar AV suites gate camera access separately from Windows. Open the AV app and allow Zoom (or temporarily disable the webcam shield to confirm). |
| **Camera driver failure** | Open Device Manager → Cameras. If the camera shows a warning icon, reinstall the driver from the laptop vendor (not Windows Update). |
| **FrameServer service Disabled** | The fixer auto-bumps this from Disabled to Manual. If the Fix Receipt shows `Frame Server: DISABLED and could not be re-enabled`, run `Set-Service FrameServer -StartupType Manual` from an admin PowerShell. |
| **Hive race on first run only** | If the Fix Receipt shows `HKU hive: per-user write skipped`, double-click the **Apply Zoom Settings** shortcut on the user1 desktop. The first-run script reasserts consent from inside `user1`'s own session and will fix it. |

To verify Windows itself is letting `user1` use the camera, sign into
Windows as `user1` and open:

```text
Settings → Privacy & security → Camera
```

Both the top **Camera access** toggle and **Let desktop apps access
your camera** must be on. If they are on and Zoom still cannot see a
camera, the cause is hardware, driver, or third-party AV — not Windows
consent.

## Release & CI Setup

### Cutting a release

Releases are built and published by CI, not from a laptop. The whole flow is:

```bash
node scripts/bump-version.js patch   # 5.3.11 -> 5.3.12 (or minor/major)
npm install --package-lock-only      # keep package-lock in sync — `npm ci` fails otherwise
# commit + merge to master, then:
git tag -a v5.3.12 -m "v5.3.12 — ..."
git push origin v5.3.12
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds **both**
targets, refuses to publish unless *both* `*Setup*.exe` and `*Portable*.exe` exist,
generates checksums, and creates the release on
`PrimeUpYourLife/1132-Fixer-Windows-Releases` using the `RELEASES_PAT` secret.

> Keep `package.json` and `package-lock.json` in sync. `release.yml` runs `npm ci`,
> which hard-fails on a mismatch — this is why v5.3.10 never ran the pipeline and
> was hand-published with only the Portable exe.

### Build vs. publish

`build`, `build:installer`, and `build:all` all pass `--publish never`: they only ever
produce artifacts in `dist/`. Only `npm run release` (`--publish always`) publishes.

This matters because **electron-builder auto-detects CI and will try to publish on its
own** if a `publish` block exists in `package.json` — which made every `master` CI run
fail with `GitHub Personal Access Token is not set ... "GH_TOKEN"`. The explicit
`--publish never` on the build scripts is what keeps CI green without needing a token.

### Secrets

| Variable | Where | Purpose |
|---|---|---|
| `RELEASES_PAT` | Actions secret on `1132-Fixer-Windows` | Lets `release.yml` create the release + upload assets on the Releases repo. **Required.** |
| `GH_ISSUES_TOKEN` | Actions secret on `1132-Fixer-Windows` | Optional. Baked into the build by `scripts/inject-config.js` to enable in-app feedback. Without it the build still succeeds and feedback reports "Feedback service not configured". |
| `GH_TOKEN` | local shell only | Only needed if you run `npm run release` by hand instead of tagging. |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Actions secrets | Optional code signing. |

**Never hardcode a token in `src/main/config.js`.** It resolves `GH_ISSUES_TOKEN` from
the environment or from a gitignored, build-time-generated `config.generated.js`.

This repo is private, so the danger is *not* git history — it's that `config.js` is
bundled into the packaged app, and the app ships as a **public installer**. Anything
hardcoded here lands in `app.asar` inside every published `.exe`, where asar stores
file contents uncompressed. Pulling it back out takes about a minute:

```bash
7za x 1132-Fixer-Portable-5.3.10.exe -oext
grep -a "GH_ISSUES_TOKEN" ext/resources/app.asar
```

That is how the token hardcoded up to v5.3.10 leaked.

> **Injecting at build time keeps the secret out of source control, but does not make
> it secret.** It is still in the shipped `.exe` and extractable with the command
> above. That is tolerable only because the token is scoped to Issues:write on one
> repo — worst case is issue spam, and you rotate. If it must be genuinely secret,
> route feedback through a server-side proxy instead of embedding a credential in a
> desktop app.

## License

MIT - PЯIMΞ
