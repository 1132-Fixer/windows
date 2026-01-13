# 1132 REMOVER — Premium UI Dashboard Design Brief

> **Authored by a principal product designer specializing in system utilities, privacy tools, and enterprise-grade Windows applications.**

---

## PROJECT CONTEXT

**Product:** 1132 Remover — A Windows desktop application that performs complete Zoom data forensic wipe and fresh reinstallation. Built with Electron, targeting power users and privacy-conscious professionals.

**Core Function:** Device fingerprint reset utility. When Zoom bans a device (Error 1132), this tool removes all identifiable traces—registry keys, telemetry databases, service identifiers—enabling a clean slate reinstall.

**Target Users:**
- IT administrators managing fleet devices
- Privacy-focused professionals
- Users recovering from false-positive bans
- Enterprise compliance officers

**Platform:** Windows 10/11 desktop (Electron)

---

## DESIGN REQUIREMENTS

### Visual Identity

**Aesthetic Direction:** Industrial Precision meets Digital Security

Think: Stripe's dashboard clarity + Discord's dark mode sophistication + 1Password's trust signals

**Color System:**
```
Primary Background:    #0D1117 (GitHub Dark)
Secondary Background:  #161B22 (Elevated surfaces)
Accent Primary:        #00D4AA (Teal/Cyan - represents "clean/reset")
Accent Warning:        #F59E0B (Amber - caution states)
Accent Danger:         #EF4444 (Red - destructive actions)
Accent Success:        #10B981 (Green - completion)
Text Primary:          #F0F6FC
Text Secondary:        #8B949E
Border/Divider:        #30363D
```

**Typography:**
- Headings: Inter Bold or SF Pro Display (system font fallback)
- Body: Inter Regular 14px
- Monospace (logs): JetBrains Mono or Cascadia Code
- Critical numbers: Tabular numerals for alignment

**Iconography:**
- Line icons, 1.5px stroke weight
- Consistent 20x20 or 24x24 grid
- Custom icons for: Shield (security), Fingerprint (identity), Trash (delete), Refresh (reset)

---

## DASHBOARD LAYOUT SPECIFICATION

### Window Dimensions
- **Default:** 900px × 650px
- **Minimum:** 800px × 600px
- **Resizable:** Yes, with responsive breakpoints

### Layout Structure

```
┌─────────────────────────────────────────────────────────────┐
│ TITLE BAR (Custom, frameless)                               │
│ ┌─────────────────────────────────────┬───────────────────┐ │
│ │ ◉ 1132 REMOVER                      │ ─ □ ✕            │ │
│ │ v3.0.0                              │                   │ │
│ └─────────────────────────────────────┴───────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│ NAVIGATION TABS                                             │
│ ┌────────┬────────┬────────┬────────┐                       │
│ │ Reset  │ Audit  │ Logs   │ Settings│                      │
│ └────────┴────────┴────────┴────────┘                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  MAIN CONTENT AREA                                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                      │   │
│  │   [Dynamic content based on selected tab]            │   │
│  │                                                      │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ STATUS BAR                                                  │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ● System Ready          │ Admin: ✓  │ Last Run: Never  │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## TAB 1: RESET (Primary View)

### Hero Section
Large, commanding call-to-action with clear hierarchy:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│     ┌─────────────────────────────────────────────┐         │
│     │                                             │         │
│     │            [ FINGERPRINT ICON ]             │         │
│     │                  64x64                      │         │
│     │                                             │         │
│     │        COMPLETE ZOOM RESET                  │         │
│     │                                             │         │
│     │   Removes all device identifiers,           │         │
│     │   reinstalls with fresh configuration       │         │
│     │                                             │         │
│     └─────────────────────────────────────────────┘         │
│                                                             │
│     ┌─────────────────────────────────────────────┐         │
│     │                                             │         │
│     │         🔘 FULL RESET & REINSTALL           │         │
│     │              [PRIMARY BUTTON]               │         │
│     │                                             │         │
│     └─────────────────────────────────────────────┘         │
│                                                             │
│     Options:                                                │
│     ┌─────────────────────────────────────────────┐         │
│     │  ☑ Uninstall existing Zoom                  │         │
│     │  ☑ Download fresh installer                 │         │
│     │  ☑ Reinstall Zoom after cleanup             │         │
│     │  ☐ Launch Zoom when complete                │         │
│     └─────────────────────────────────────────────┘         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Progress State (During Operation)

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│     RESETTING DEVICE IDENTITY                               │
│     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━░░░░░░░░░░  67%         │
│                                                             │
│     ┌─────────────────────────────────────────────┐         │
│     │  ✓ Stopping Zoom processes          2.1s   │         │
│     │  ✓ Uninstalling Zoom                8.4s   │         │
│     │  ✓ Removing services                1.2s   │         │
│     │  ✓ Cleaning registry                4.7s   │         │
│     │  ● Wiping device fingerprint        ...    │  ← Active│
│     │  ○ Deleting data folders                   │         │
│     │  ○ Downloading fresh Zoom                  │         │
│     │  ○ Installing Zoom                         │         │
│     │  ○ Verification                            │         │
│     └─────────────────────────────────────────────┘         │
│                                                             │
│     Current: Removing CptService identifiers...             │
│                                                             │
│     [ CANCEL ]                                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Success State

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│           ┌───────────────────────┐                         │
│           │                       │                         │
│           │    ✓ CHECKMARK        │                         │
│           │    (Animated)         │                         │
│           │                       │                         │
│           └───────────────────────┘                         │
│                                                             │
│              RESET COMPLETE                                 │
│                                                             │
│     ┌─────────────────────────────────────────────┐         │
│     │  Processes stopped:        47               │         │
│     │  Registry keys removed:    23               │         │
│     │  Data folders deleted:     18               │         │
│     │  Fingerprint wiped:        ✓                │         │
│     │  Zoom reinstalled:         ✓                │         │
│     │  Verification:             PASSED           │         │
│     └─────────────────────────────────────────────┘         │
│                                                             │
│     [ LAUNCH ZOOM ]        [ VIEW LOG ]                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## TAB 2: AUDIT (Pre-Scan View)

Shows what will be affected before any changes:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  SYSTEM AUDIT                              [ SCAN NOW ]     │
│  Analyze Zoom footprint without making changes              │
│                                                             │
│  ┌───────────────┬───────────────┬───────────────┐         │
│  │   PROCESSES   │   REGISTRY    │    FILES      │         │
│  │      12       │      23       │     847       │         │
│  │   running     │    keys       │    items      │         │
│  └───────────────┴───────────────┴───────────────┘         │
│                                                             │
│  DETECTED LOCATIONS                                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ▼ AppData\Roaming\Zoom                   245 MB    │   │
│  │   ├── data\                              198 MB    │   │
│  │   │   └── telemetrydata.db ⚠️            12 MB     │   │
│  │   ├── logs\                               43 MB    │   │
│  │   └── cache\                               4 MB    │   │
│  │ ▼ AppData\Local\Zoom                      67 MB    │   │
│  │ ▼ ProgramData\CptService ⚠️               1.2 MB   │   │
│  │ ▶ Registry: HKCU\Software\Zoom           23 keys   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ⚠️ = Contains device identifiers                          │
│                                                             │
│  [ EXPORT REPORT ]                                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## TAB 3: LOGS (Operation History)

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  OPERATION LOGS                        [ CLEAR ] [ EXPORT ] │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 2026-01-12 20:45:23  ●────────────────────────────  │   │
│  │                                                      │   │
│  │ [INFO]  Starting full reset                          │   │
│  │ [INFO]  Killing process: Zoom.exe                    │   │
│  │ [OK]    Zoom.exe terminated                          │   │
│  │ [INFO]  Killing process: CptHost.exe                 │   │
│  │ [OK]    CptHost.exe terminated                       │   │
│  │ [INFO]  Uninstalling Zoom via WMI                    │   │
│  │ [OK]    Zoom uninstalled successfully                │   │
│  │ [INFO]  Deleting registry: HKCU\Software\Zoom        │   │
│  │ [OK]    Registry key deleted                         │   │
│  │ [WARN]  Permission denied: HKLM\...\CptService       │   │
│  │ [INFO]  Escalating to TrustedInstaller               │   │
│  │ [OK]    Registry key deleted (escalated)             │   │
│  │ [INFO]  Wiping telemetrydata.db                      │   │
│  │ [OK]    Device fingerprint cleared                   │   │
│  │ [INFO]  Downloading ZoomInstallerFull.msi            │   │
│  │ [OK]    Download complete (68.4 MB)                  │   │
│  │ [INFO]  Installing Zoom (silent)                     │   │
│  │ [OK]    Installation complete                        │   │
│  │ [OK]    ═══ RESET COMPLETE ═══                       │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## TAB 4: SETTINGS

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  SETTINGS                                                   │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  BEHAVIOR                                                   │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Launch Zoom after reset              [ TOGGLE ○ ]  │   │
│  │  Close app after successful reset     [ TOGGLE ● ]  │   │
│  │  Show confirmation dialogs            [ TOGGLE ● ]  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  CLEANUP SCOPE                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Clean all user profiles              [ TOGGLE ● ]  │   │
│  │  Remove firewall rules                [ TOGGLE ● ]  │   │
│  │  Flush DNS cache                      [ TOGGLE ● ]  │   │
│  │  Clear Windows prefetch               [ TOGGLE ○ ]  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  ADVANCED                                                   │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  Log retention:          [ 30 days      ▼ ]                │
│  Zoom installer URL:     [ Official     ▼ ]                │
│                                                             │
│  [ RESET TO DEFAULTS ]                                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## COMPONENT SPECIFICATIONS

### Primary Button (CTA)
```css
.btn-primary {
  background: linear-gradient(135deg, #00D4AA 0%, #00B894 100%);
  border: none;
  border-radius: 8px;
  padding: 16px 32px;
  font-weight: 600;
  font-size: 16px;
  color: #0D1117;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 4px 14px rgba(0, 212, 170, 0.4);
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(0, 212, 170, 0.5);
}

.btn-primary:active {
  transform: translateY(0);
}

.btn-primary:disabled {
  background: #30363D;
  color: #8B949E;
  box-shadow: none;
  cursor: not-allowed;
}
```

### Progress Bar
```css
.progress-bar {
  height: 8px;
  background: #30363D;
  border-radius: 4px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #00D4AA, #00E5C0);
  border-radius: 4px;
  transition: width 0.3s ease;
}
```

### Toggle Switch
```css
.toggle {
  width: 44px;
  height: 24px;
  background: #30363D;
  border-radius: 12px;
  position: relative;
  cursor: pointer;
  transition: background 0.2s ease;
}

.toggle.active {
  background: #00D4AA;
}

.toggle::after {
  content: '';
  width: 20px;
  height: 20px;
  background: #F0F6FC;
  border-radius: 50%;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.2s ease;
}

.toggle.active::after {
  transform: translateX(20px);
}
```

### Step Indicator
```css
.step {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 6px;
}

.step.completed {
  color: #10B981;
}

.step.active {
  background: rgba(0, 212, 170, 0.1);
  color: #00D4AA;
}

.step.pending {
  color: #8B949E;
}

.step-icon {
  width: 20px;
  height: 20px;
}

.step-icon.completed::before {
  content: '✓';
}

.step-icon.active::before {
  content: '●';
  animation: pulse 1s infinite;
}

.step-icon.pending::before {
  content: '○';
}
```

---

## MICROINTERACTIONS & ANIMATIONS

### Button Press
- Scale down to 0.98 on press
- Return to 1.0 with spring easing

### Progress Updates
- Smooth width transition (300ms ease-out)
- Subtle pulse on active step indicator

### Success Checkmark
- Draw-in animation (SVG stroke-dashoffset)
- Duration: 600ms
- Followed by confetti burst (optional, subtle)

### Tab Switching
- Crossfade content (200ms)
- Underline indicator slides (300ms ease-out)

### Log Entries
- Fade in from left (200ms)
- Auto-scroll to bottom with smooth behavior

---

## ERROR STATES

### Permission Denied
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ⚠️ ELEVATED PERMISSIONS REQUIRED                           │
│                                                             │
│  Some operations require administrator access.              │
│  Please restart the application as administrator.           │
│                                                             │
│  [ RESTART AS ADMIN ]     [ CONTINUE LIMITED ]              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Operation Failed
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ✕ OPERATION FAILED                                         │
│                                                             │
│  Failed to delete registry key:                             │
│  HKLM\SYSTEM\CurrentControlSet\Services\CptService          │
│                                                             │
│  Error: Access denied                                       │
│                                                             │
│  [ RETRY ]     [ SKIP ]     [ VIEW LOG ]                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## RESPONSIVE BEHAVIOR

### Compact Mode (< 850px width)
- Hide sidebar navigation
- Use bottom tab bar
- Stack settings in single column

### Expanded Mode (> 1100px width)
- Show sidebar navigation
- Two-column settings layout
- Larger log view

---

## ACCESSIBILITY

- All interactive elements keyboard-navigable
- Focus rings visible (2px solid #00D4AA)
- Minimum touch targets: 44x44px
- Color contrast ratio: minimum 4.5:1
- Screen reader labels on all icons
- Reduce motion preference respected

---

## IMPLEMENTATION NOTES

### Tech Stack Recommendation
- **Framework:** React 18 or Svelte (Electron-compatible)
- **Styling:** Tailwind CSS (utility-first, matches component specs)
- **Icons:** Lucide React or Heroicons
- **Animations:** Framer Motion
- **State:** Zustand (lightweight, Electron-friendly)

### File Structure
```
src/
├── renderer/
│   ├── components/
│   │   ├── Button/
│   │   ├── ProgressBar/
│   │   ├── Toggle/
│   │   ├── StepList/
│   │   └── LogViewer/
│   ├── views/
│   │   ├── Reset/
│   │   ├── Audit/
│   │   ├── Logs/
│   │   └── Settings/
│   ├── styles/
│   │   ├── globals.css
│   │   └── tokens.css
│   └── App.jsx
```

---

## DELIVERABLES EXPECTED

1. **Figma/Design File** with all states and components
2. **Interactive Prototype** demonstrating key flows
3. **Component Library** with documented props
4. **Animation Specifications** with timing curves
5. **Asset Export** (icons, logos in SVG/PNG)

---

*This brief represents the complete design specification for a production-grade system utility. The visual language balances trust, professionalism, and technical precision—essential for a tool that performs irreversible system modifications.*
