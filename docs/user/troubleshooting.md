# Troubleshooting

| Problem | Try this |
| --- | --- |
| The app says permission is missing | Close it, then run 1132 Fixer and approve the Windows prompt. |
| Zoom is not found | Install Zoom Workplace with the **machine-wide** installer, not a per-user copy. |
| **Fix now** stays unavailable | Open **View details** and fix the item that needs attention. |
| The Windows tool check fails or takes too long | Press **Try again**. If it repeats, use **Support Report**. A failed check does not prove that Windows tools are missing. |
| Version 6.4.0 lists several missing Windows tools after **Fix now**, in Setup or Portable | That version can turn one failed check into several missing-tool messages. Use **Support Report** and include the version and build type. Those messages do not prove that PATH is damaged. |
| The app could not find a required tool in the Windows system folder | Use **Support Report** for the checked paths. Do not download replacement Windows tools from an unofficial site. |
| Security software blocks the fix | Review the reported block with your Windows administrator. Do not disable protections or add a broad exception to force the repair. |
| Camera or microphone is missing in Zoom | Check Windows privacy settings **as user1**, the hardware shutter, the camera driver, and any antivirus webcam shield. |
| The app says the helper profile is temporary | Do not use that setup. Run **Check again** and use **Support Report** before another reset. Completed changes from the earlier attempt may remain. |
| Start menu, desktop icons, administrator launches or Snipping Tool fail after using 6.4.0 | Save work and record the time and app version. Avoid another **Fix now** reset. A reboot may restore the session but does not prove the cause is fixed. Include Windows service, Explorer and profile events in the investigation; see issue [#252](https://github.com/1132-Fixer/windows/issues/252). |
| Setup says 1132 Fixer is still running | Let any repair finish, close the app, then run Setup again. Setup refuses to force-close a repair. A same-name instance in another account can also block it. |
| You are signed in as `user1` | Sign out of that account first. 1132 Fixer cannot run while the helper account is the active Windows session. |
| SmartScreen warns | Current releases are unsigned. See [code signing](../security/code-signing.md). |
| Windows says Smart App Control blocked the app | Smart App Control only opens apps with a trusted publisher signature. Current releases are unsigned, so it blocks 1132 Fixer, and it does not offer a per-app exception. Do not turn Smart App Control off for this. Use a PC where it is off or in evaluation mode, or wait for a signed release. Details: [code signing](../security/code-signing.md#11-smart-app-control). |
| **Unable to complete** at startup | The message names the step that stopped and says whether it timed out or could not run. Press **Try again**. **View details** keeps the results of the steps that did finish; only the affected checks read "could not be verified". The startup check only reads settings and changes nothing. If it repeats, copy the text from **Support** into a report: it includes the step and its code. On 6.4.0 this screen always said "did not finish in time" and listed all nine checks, whatever the cause; install 6.5.0 or later. |
| Updates keep appearing or installing | Open **About** and turn **Automatic app updates** off. See [installation](installation.md#turn-automatic-updates-off-or-on-650-and-later). |
| **The update could not be completed** | Press **Retry update**. If it fails again, press **View diagnostic details** and include the text in a support report, or install the newest version from the [Releases page](https://github.com/1132-Fixer/windows/releases/latest) by hand. Your settings are kept. **Continue with current version** keeps using the version you have. |
| 1132 Fixer closed during an update and did not reopen | Open it from the Start Menu or desktop shortcut. It reports whether the update was installed. Versions 6.3.1 to 6.3.3 have a known defect that closes the app without installing; install the newest release once from the Releases page. |
| After an update the old version opens | Open 1132 Fixer once; it detects that the previous version is still running and offers **Retry update**. If it keeps happening, uninstall from Windows Settings and install the newest release from the Releases page. |
| Windows Settings cannot uninstall 6.3.1, 6.3.2 or 6.3.3 (*Installer integrity check has failed*), or an update stops at *Failed to uninstall old application files ... : 2* | The uninstaller shipped with those three versions is damaged. Install the newest release from the Releases page: its installer skips that uninstaller and replaces the app in place. After that, uninstall works normally. |

| 1132 Fixer closed by itself | After 30 seconds without use it shows **Closing soon** with a 30-second countdown; after that it closes to free the computer. Move the mouse, press a key, or press **Keep open** to keep it. It never closes while a repair or an update is running. |

## Where updates are recorded

The update log is `%APPDATA%\1132-fixer\logs\updater.log`. It survives an
update and an uninstall. It contains version numbers, install paths and
update stages; it never contains passwords, tokens or your user name.

## Camera and microphone as user1

Open Windows as `user1`, then:

```text
Settings → Privacy & security → Camera
```

Turn on **Camera access** and **Let desktop apps access your camera**. Check
the matching microphone page too.

If those controls are already on, check the laptop camera shutter, a camera
function key, antivirus webcam protection, Device Manager, and any
organization policy.

## Support reports

Use **Support** or **Feedback** in the app. Review the redacted report before
you send it. Do not paste unredacted SIDs, passwords, or profile dumps into a
public issue.

For a Windows tool-check problem, include whether you used Setup or Portable,
the app version, and whether the message appeared before or after **Fix now**.
The check result and checked system-folder paths help identify the failure.
You do not need to edit PATH or turn off Windows security based only on a
failed check.

Security problems go to private vulnerability reporting, not a public issue.
See [SECURITY.md](../../SECURITY.md).
