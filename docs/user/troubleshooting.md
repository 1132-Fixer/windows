# Troubleshooting

| Problem | Try this |
| --- | --- |
| The app says permission is missing | Close it, then run 1132 Fixer and approve the Windows prompt. |
| Zoom is not found | Install Zoom Workplace with the **machine-wide** installer, not a per-user copy. |
| **Fix now** stays unavailable | Open **View details** and fix the item that needs attention. |
| Security software blocks the fix | Allow the app to create the local helper account and start Zoom. |
| Camera or microphone is missing in Zoom | Check Windows privacy settings **as user1**, the hardware shutter, the camera driver, and any antivirus webcam shield. |
| The app says the helper profile is temporary | Run **Fix now** again. Do not use Zoom from a TEMP profile. |
| You are signed in as `user1` | Sign out of that account first. 1132 Fixer cannot run while the helper account is the active Windows session. |
| SmartScreen warns | Current releases are unsigned. See [code signing](../security/code-signing.md). |
| Windows says Smart App Control blocked the app | Smart App Control only opens apps with a trusted publisher signature. Current releases are unsigned, so it blocks 1132 Fixer, and it does not offer a per-app exception. Do not turn Smart App Control off for this. Use a PC where it is off or in evaluation mode, or wait for a signed release. Details: [code signing](../security/code-signing.md#11-smart-app-control). |

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

Security problems go to private vulnerability reporting, not a public issue.
See [SECURITY.md](../../SECURITY.md).
