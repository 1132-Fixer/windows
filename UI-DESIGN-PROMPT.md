# 1132 ELIMINATOR - Combat-Themed UI Design Specification

## Application Overview
**Name:** 1132 ELIMINATOR
**Tagline:** "Total Zoom Purge Protocol"
**Purpose:** A surgical strike tool that completely eradicates Zoom's device-level ban (Error 1132) by wiping all fingerprint data, telemetry, and traces.

---

## Design Philosophy: Military Operations Center

The UI should feel like a **tactical operations terminal** - dark, precise, dangerous. Every element communicates **controlled power**. This is not a friendly cleanup utility; this is a **weapon against digital fingerprinting**.

### Visual Aesthetic Keywords:
- Tactical / Military grade
- Hacker terminal meets war room
- Dangerous but controlled
- Precise surgical elimination
- Dark ops / Covert operations
- Kill confirmed / Mission complete

---

## Color Palette

| Role | Color | Hex | Usage |
|------|-------|-----|-------|
| **Background (Deep)** | Void Black | `#0A0A0F` | Main body, deepest layer |
| **Background (Surface)** | Combat Gray | `#12141A` | Cards, panels |
| **Background (Elevated)** | Tactical Dark | `#1A1D26` | Hover states, elevated surfaces |
| **Border** | Steel Edge | `#2D3139` | Dividers, card borders |
| **Primary Action** | Kill Red | `#FF2D2D` | Main action buttons, critical alerts |
| **Primary Hover** | Blood Red | `#FF4444` | Button hover states |
| **Secondary** | Strike Orange | `#FF6B35` | Secondary actions, warnings |
| **Accent** | Tactical Cyan | `#00F0FF` | Progress bars, highlights, success |
| **Success** | Eliminated Green | `#00FF88` | Completion states, checkmarks |
| **Text Primary** | Ghost White | `#F0F0F5` | Main text |
| **Text Secondary** | Smoke Gray | `#8B9099` | Labels, descriptions |
| **Text Muted** | Shadow Gray | `#5A5F6A` | Timestamps, hints |

---

## Typography

| Element | Font | Size | Weight | Tracking |
|---------|------|------|--------|----------|
| **App Title** | Orbitron / Share Tech Mono | 24px | 700 | 3px |
| **Section Headers** | Inter / Rajdhani | 14px | 600 | 2px (uppercase) |
| **Body Text** | Inter | 14px | 400 | Normal |
| **Button Text** | Inter | 14px | 600 | 1px (uppercase) |
| **Log Output** | JetBrains Mono / Fira Code | 12px | 400 | Normal |
| **Stats Numbers** | Share Tech Mono | 32px | 600 | Normal |

---

## Layout Structure

```
+------------------------------------------------------------------+
|  [HEADER BAR]                                                     |
|  Logo + Title          Status Indicator          [Min][Max][X]   |
+------------------------------------------------------------------+
|                                                                   |
|  +---------------------------+  +------------------------------+  |
|  |    TARGET STATUS PANEL    |  |     OPERATION CONTROLS      |  |
|  |    (Threat Detection)     |  |     (Action Buttons)         |  |
|  +---------------------------+  +------------------------------+  |
|                                                                   |
|  +--------------------------------------------------------------+ |
|  |              TACTICAL OPTIONS PANEL                          | |
|  |  [ ] Uninstall Before Purge    [ ] Reinstall After Strike    | |
|  |  [ ] Auto-Launch Post-Install  [ ] Deep Fingerprint Wipe     | |
|  +--------------------------------------------------------------+ |
|                                                                   |
|  +--------------------------------------------------------------+ |
|  |              MISSION PROGRESS / COMBAT LOG                   | |
|  |  Real-time operation feed with kill confirmations            | |
|  +--------------------------------------------------------------+ |
|                                                                   |
|  [STATUS BAR - System Ready | Admin: ACTIVE | v3.0.0]            |
+------------------------------------------------------------------+
```

---

## Component Specifications

### 1. Header Bar
**Height:** 56px
**Background:** `#12141A` with bottom border `#2D3139`

**Elements:**
- **Logo:** Shield icon with crosshairs (see icon spec)
- **Title:** "1132 ELIMINATOR" in Orbitron, `#FF2D2D` (Kill Red)
- **Subtitle:** "ZOOM PURGE PROTOCOL" in uppercase, `#5A5F6A`, 10px
- **Status Indicator:** Pulsing dot (green = ready, red = in operation)
- **Window Controls:** Custom styled close/minimize/maximize

### 2. Target Status Panel (Left)
**Purpose:** Shows current Zoom infection status
**Size:** 280px width, auto height
**Style:** Card with `#12141A` background, `#2D3139` border, 8px radius

**Header:** "TARGET ANALYSIS" with radar/scan icon

**Content (Grid Layout):**
```
ZOOM INSTALLED      [YES] / [NO]     (red/green badge)
PROCESSES ACTIVE    [3] detected     (count with warning if > 0)
DATA LOCATIONS      [47] identified  (folder count)
REGISTRY ENTRIES    [156] found      (key count)
FINGERPRINT DATA    [DETECTED]       (red alert if found)
THREAT LEVEL        [CRITICAL]       (color-coded badge)
```

**Threat Level Badges:**
- CLEAR = Green `#00FF88`
- LOW = Yellow `#FFD93D`
- MODERATE = Orange `#FF6B35`
- HIGH = Red `#FF2D2D`
- CRITICAL = Pulsing Red with glow

### 3. Operation Controls Panel (Right)
**Purpose:** Main action buttons
**Size:** Flexible, fills remaining width

**Primary Button: "EXECUTE FULL PURGE"**
- Size: Full width of panel, 64px height
- Background: Gradient `#FF2D2D` to `#CC0000`
- Text: "EXECUTE FULL PURGE" + explosion icon
- Hover: Scale 1.02, glow effect (`box-shadow: 0 0 30px rgba(255,45,45,0.5)`)
- Active: Brief flash effect
- Font: 18px, bold, uppercase, 2px letter-spacing

**Secondary Button Row:**
```
[TERMINATE PROCESSES]  [PURGE DATA]  [WIPE FINGERPRINT]
```
- Size: Equal width, 48px height
- Style: Outlined, `#2D3139` border, `#FF6B35` text
- Hover: Fill with `#FF6B35` at 10% opacity

**Utility Button Row:**
```
[STOP ZOOM]  [LAUNCH ZOOM]  [OPEN LOGS]
```
- Size: Smaller, icon + text
- Style: Ghost buttons, text only with hover underline

### 4. Tactical Options Panel
**Purpose:** Configuration toggles
**Style:** Horizontal card, icon + toggle + label format

**Options with Military-Style Labels:**
```
[ ] DEMOLITION MODE      - Uninstall Zoom before purge
[ ] REBUILD PROTOCOL     - Reinstall fresh Zoom after
[ ] AUTO-DEPLOY          - Launch Zoom when complete
[ ] DEEP STERILIZATION   - Extended fingerprint wipe
```

**Toggle Switch Style:**
- Track: 48px x 24px, rounded pill
- Off: `#2D3139` background
- On: `#FF2D2D` background with glow
- Knob: White, slides with momentum animation

### 5. Mission Progress Panel
**Purpose:** Real-time operation feedback
**Height:** Flexible, fills remaining space (min 200px)

**During Operation - Progress Mode:**
```
+--------------------------------------------------------------+
|  OPERATION IN PROGRESS                            [ABORT]    |
|  ============================================== 67%          |
|  Current Target: Registry Elimination                        |
|  Elapsed: 00:00:47                                          |
+--------------------------------------------------------------+
```

**Progress Bar Style:**
- Background: `#1A1D26`
- Fill: Animated gradient `#FF2D2D` -> `#FF6B35` -> `#00F0FF`
- Height: 8px with subtle glow
- Animation: Shimmer effect moving left to right

**Combat Log (Below Progress):**
```
[21:45:03] [INIT]  Operation started - Full Purge Protocol
[21:45:04] [KILL]  Terminating Zoom.exe... ELIMINATED
[21:45:04] [KILL]  Terminating ZoomWebHost.exe... ELIMINATED
[21:45:05] [KILL]  Process sweep complete - 5 targets neutralized
[21:45:06] [DEL]   Purging C:\Users\...\Zoom... DESTROYED
[21:45:07] [REG]   Erasing HKCU\Software\Zoom... WIPED
[21:45:08] [FP]    Wiping device fingerprint... STERILIZED
```

**Log Entry Colors:**
- `[INIT]` = Cyan `#00F0FF`
- `[KILL]` = Red `#FF2D2D`
- `[DEL]` = Orange `#FF6B35`
- `[REG]` = Yellow `#FFD93D`
- `[FP]` = Purple `#B366FF`
- `[OK]` = Green `#00FF88`
- `[ERR]` = Bright Red with background highlight

### 6. Mission Complete State
**Replaces progress panel on success:**

```
+--------------------------------------------------------------+
|                                                               |
|                    ✓ MISSION ACCOMPLISHED                    |
|                                                               |
|     "Zoom has been completely eliminated from this device"    |
|                                                               |
|     +------------+  +------------+  +------------+            |
|     |     47     |  |    156     |  |     5      |            |
|     |  FOLDERS   |  |  REGISTRY  |  | PROCESSES  |            |
|     |  DESTROYED |  |   WIPED    |  |   KILLED   |            |
|     +------------+  +------------+  +------------+            |
|                                                               |
|              [DEPLOY ZOOM]     [VIEW REPORT]                 |
|                                                               |
+--------------------------------------------------------------+
```

**Stats Cards:**
- Background: `#1A1D26`
- Number: Large `#00FF88` (success green)
- Label: Small uppercase `#8B9099`
- Subtle green glow on each card

### 7. Status Bar (Footer)
**Height:** 32px
**Background:** `#0A0A0F`

**Left:** Status text with indicator dot
- "SYSTEM READY" (green dot)
- "OPERATION IN PROGRESS" (pulsing red dot)
- "MISSION COMPLETE" (green dot)

**Center:** Current operation label (if running)

**Right:** "Admin: ACTIVE" badge + version number

---

## Animations & Micro-interactions

### Button Hover Effects
```css
.btn-primary:hover {
  transform: scale(1.02);
  box-shadow: 0 0 30px rgba(255, 45, 45, 0.4);
  transition: all 0.2s ease;
}
```

### Progress Bar Shimmer
```css
.progress-fill {
  background: linear-gradient(
    90deg,
    #FF2D2D 0%,
    #FF6B35 50%,
    #00F0FF 100%
  );
  background-size: 200% 100%;
  animation: shimmer 2s infinite linear;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

### Threat Level Pulse
```css
.threat-critical {
  animation: pulse-glow 1s infinite;
}

@keyframes pulse-glow {
  0%, 100% {
    box-shadow: 0 0 10px rgba(255, 45, 45, 0.5);
    opacity: 1;
  }
  50% {
    box-shadow: 0 0 25px rgba(255, 45, 45, 0.8);
    opacity: 0.8;
  }
}
```

### Log Entry Fade-in
```css
.log-entry {
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateX(-10px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
```

---

## Sound Design (Optional)

If implementing audio feedback:
- **Button Click:** Short tactical "blip"
- **Process Kill:** Muted impact sound
- **Progress Complete:** Subtle success chime
- **Error:** Warning alarm tone
- **Mission Complete:** Achievement unlock sound

---

## Responsive Considerations

**Minimum Window Size:** 800x600
**Optimal Size:** 1000x700

At smaller sizes:
- Stack panels vertically
- Collapse secondary buttons into dropdown
- Reduce log panel height
- Hide stats labels (show on hover)

---

## Empty States

**No Zoom Detected:**
```
         ┌──────────────────────────────┐
         │                              │
         │      🎯 NO TARGET FOUND      │
         │                              │
         │   Zoom is not installed on   │
         │   this device. Install Zoom  │
         │   to enable purge protocol.  │
         │                              │
         │      [INSTALL ZOOM]          │
         │                              │
         └──────────────────────────────┘
```

---

## Error States

**Operation Failed:**
- Red border on progress panel
- Error message with full details
- "RETRY" and "VIEW LOG" buttons
- Log panel auto-scrolls to error

**Admin Required:**
- Yellow warning banner at top
- "Some operations require administrator privileges"
- "Restart as Admin" button

---

## Implementation Notes

### IPC API Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `fullReset(options)` | Execute complete purge | `{ success, steps, verification }` |
| `killZoom()` | Terminate all Zoom processes | `{ killed, failed }` |
| `launchZoom()` | Start Zoom application | `{ success, error }` |
| `checkZoom()` | Check if Zoom installed | `{ installed, path }` |
| `audit()` | Scan for Zoom artifacts | `{ processes, folders, registry }` |

### Progress Events

```javascript
window.electronAPI.onProgress((data) => {
  // data: { step, percent, message }
  updateProgressBar(data.percent);
  updateStatusText(data.step);
  addLogEntry(data.message);
});
```

---

## Final Notes

This UI should feel **powerful and dangerous**, like you're about to launch a missile at Zoom's surveillance infrastructure. Every click should feel decisive. The combat theme reinforces that this is a serious tool for a real problem - Zoom's invasive device fingerprinting that persists across reinstalls.

The user should feel like a tactical operator executing a precision strike, not someone clicking through a boring settings panel.

**REMEMBER:** This is 1132 ELIMINATION. Total. Complete. Surgical.
