# BOLT AI PROMPT: 1132 ELIMINATOR - Total Overhaul Build

---

## BRIEF FROM: High-End Market & Design Specialist

I'm providing specifications for a complete UI rebuild of a critical system utility. This is a **premium-tier tactical application** that requires precision execution. The deliverable must reflect elite-level design standards—no compromises on aesthetics, no shortcuts on functionality.

---

## PROJECT: 1132 ELIMINATOR

**Classification:** Tactical System Utility
**Platform:** Electron Desktop Application (Windows)
**Purpose:** Complete elimination of Zoom's device-level ban (Error 1132) through systematic fingerprint wipe, data purge, and clean reinstallation.

This is not a cleanup tool. This is a **surgical weapon** against digital fingerprinting. The UI must communicate controlled power, precision, and finality.

---

## DESIGN MANDATE: Combat Operations Theme

The interface must feel like a **military tactical operations terminal**. Dark. Precise. Dangerous. Every pixel communicates purpose. Every interaction confirms decisive action.

**Core Aesthetic:**
- Military war room meets hacker terminal
- Surgical precision, not friendly cleanup wizard
- Dark ops / covert operations energy
- Kill confirmed / Mission complete feedback loops
- Controlled aggression, not chaos

---

## COLOR SYSTEM

Execute this palette exactly:

```
BACKGROUNDS
-----------
Void Black       #0A0A0F   (Primary body)
Combat Gray      #12141A   (Surface panels)
Tactical Dark    #1A1D26   (Elevated states)

BORDERS
-------
Steel Edge       #2D3139   (All borders, dividers)

PRIMARY ACTIONS
---------------
Kill Red         #FF2D2D   (Main CTAs, critical states)
Blood Red        #FF4444   (Hover intensification)
Strike Orange    #FF6B35   (Secondary actions, warnings)

ACCENTS
-------
Tactical Cyan    #00F0FF   (Progress, highlights, crosshairs)
Eliminated Green #00FF88   (Success confirmations)

TEXT HIERARCHY
--------------
Ghost White      #F0F0F5   (Primary text)
Smoke Gray       #8B9099   (Secondary labels)
Shadow Gray      #5A5F6A   (Muted, timestamps)
```

---

## TYPOGRAPHY SPEC

```
APP TITLE         Orbitron or Share Tech Mono | 24px | 700 | 3px tracking
SECTION HEADERS   Inter or Rajdhani | 14px | 600 | 2px tracking | UPPERCASE
BODY TEXT         Inter | 14px | 400
BUTTON TEXT       Inter | 14px | 600 | 1px tracking | UPPERCASE
LOG OUTPUT        JetBrains Mono or Fira Code | 12px | 400 | monospace
STAT NUMBERS      Share Tech Mono | 32px | 600
```

---

## LAYOUT ARCHITECTURE

Build this structure:

```
+================================================================+
|  HEADER BAR (56px)                                              |
|  [Shield Logo] 1132 ELIMINATOR    [Status]    [−][□][×]        |
+================================================================+
|                                                                 |
|  ┌─────────────────────────┐  ┌──────────────────────────────┐ |
|  │  TARGET ANALYSIS        │  │  OPERATION CONTROLS          │ |
|  │  (Real-time threat      │  │  (Primary action buttons)    │ |
|  │   detection panel)      │  │                              │ |
|  └─────────────────────────┘  └──────────────────────────────┘ |
|                                                                 |
|  ┌────────────────────────────────────────────────────────────┐|
|  │  TACTICAL OPTIONS (toggle switches)                        │|
|  │  [ ] Demolition Mode  [ ] Rebuild Protocol  [ ] Auto-Deploy│|
|  └────────────────────────────────────────────────────────────┘|
|                                                                 |
|  ┌────────────────────────────────────────────────────────────┐|
|  │  MISSION PROGRESS / COMBAT LOG                             │|
|  │  (Real-time operation feed with kill confirmations)        │|
|  └────────────────────────────────────────────────────────────┘|
|                                                                 |
+================================================================+
|  STATUS BAR: System Ready | Admin: ACTIVE | v3.0.0             |
+================================================================+
```

---

## COMPONENT BUILD SPECS

### 1. HEADER BAR

**Structure:**
- Fixed 56px height
- Background: `#12141A`
- Bottom border: 1px `#2D3139`

**Left Zone:**
- Shield/crosshair icon (SVG, 32px)
- "1132 ELIMINATOR" in `#FF2D2D`, Orbitron font
- Subtitle: "ZOOM PURGE PROTOCOL" | 10px | `#5A5F6A` | uppercase

**Right Zone:**
- Status indicator (pulsing dot)
- Custom window controls styled to theme

---

### 2. TARGET ANALYSIS PANEL

**Function:** Real-time scan of Zoom infection status
**Position:** Left column, 280px fixed width

**Build this data display:**
```
┌─────────────────────────────────────┐
│  [RADAR ICON] TARGET ANALYSIS       │
├─────────────────────────────────────┤
│  ZOOM INSTALLED       [YES]  ← red  │
│  PROCESSES ACTIVE     [3]           │
│  DATA LOCATIONS       [47]          │
│  REGISTRY ENTRIES     [156]         │
│  FINGERPRINT DATA     [DETECTED]    │
├─────────────────────────────────────┤
│  THREAT LEVEL:  ████ CRITICAL ████  │
└─────────────────────────────────────┘
```

**Threat Level System:**
- CLEAR = `#00FF88` green badge
- LOW = `#FFD93D` yellow badge
- MODERATE = `#FF6B35` orange badge
- HIGH = `#FF2D2D` red badge
- CRITICAL = Pulsing red with glow animation

---

### 3. OPERATION CONTROLS PANEL

**Function:** Primary action interface
**Position:** Right of Target Analysis, flexible width

**PRIMARY CTA: "EXECUTE FULL PURGE"**
```css
.btn-execute {
  width: 100%;
  height: 64px;
  background: linear-gradient(135deg, #FF2D2D, #CC0000);
  border: none;
  border-radius: 8px;
  font: 700 18px/1 Inter, sans-serif;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: #F0F0F5;
  box-shadow: 0 4px 20px rgba(255, 45, 45, 0.3);
  transition: all 0.2s ease;
}

.btn-execute:hover {
  transform: scale(1.02);
  box-shadow: 0 8px 30px rgba(255, 45, 45, 0.5);
}

.btn-execute:active {
  transform: scale(0.98);
}
```

**Secondary Actions Row:**
```
[ TERMINATE PROCESSES ]  [ PURGE DATA ]  [ WIPE FINGERPRINT ]
```
- Outlined style: `#2D3139` border, `#FF6B35` text
- Hover: 10% fill with accent color

**Utility Row:**
```
[ STOP ZOOM ]  [ LAUNCH ZOOM ]  [ VIEW LOGS ]
```
- Ghost buttons, text only

---

### 4. TACTICAL OPTIONS PANEL

**Function:** Operation configuration
**Style:** Horizontal strip with toggle switches

**Options:**
```
[ ] DEMOLITION MODE     → Uninstall Zoom before purge
[ ] REBUILD PROTOCOL    → Reinstall fresh after completion
[ ] AUTO-DEPLOY         → Launch Zoom when finished
[ ] DEEP STERILIZATION  → Extended fingerprint wipe
```

**Toggle Switch Spec:**
```css
.toggle {
  width: 48px;
  height: 24px;
  border-radius: 12px;
  background: #2D3139;
  transition: background 0.2s;
}

.toggle.active {
  background: #FF2D2D;
  box-shadow: 0 0 12px rgba(255, 45, 45, 0.4);
}

.toggle-knob {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #F0F0F5;
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.toggle.active .toggle-knob {
  transform: translateX(24px);
}
```

---

### 5. MISSION PROGRESS / COMBAT LOG

**Function:** Real-time operation feedback
**Height:** Flexible, minimum 200px

**During Operation - Progress Mode:**
```
┌──────────────────────────────────────────────────────────┐
│  OPERATION IN PROGRESS                        [ABORT]   │
│  ════════════════════════════════════════ 67%           │
│  Current Target: Registry Elimination                   │
│  Elapsed: 00:00:47                                      │
├──────────────────────────────────────────────────────────┤
│  [21:45:03] [INIT] Operation started                    │
│  [21:45:04] [KILL] Terminating Zoom.exe... ELIMINATED   │
│  [21:45:05] [DEL]  Purging AppData\Zoom... DESTROYED    │
│  [21:45:06] [REG]  Erasing registry... WIPED            │
│  [21:45:07] [FP]   Wiping fingerprint... STERILIZED     │
└──────────────────────────────────────────────────────────┘
```

**Progress Bar Spec:**
```css
.progress-bar {
  height: 8px;
  border-radius: 4px;
  background: #1A1D26;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #FF2D2D, #FF6B35, #00F0FF);
  background-size: 200% 100%;
  animation: shimmer 2s infinite linear;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

**Log Entry Color Coding:**
```
[INIT]  → #00F0FF (Cyan)
[KILL]  → #FF2D2D (Red)
[DEL]   → #FF6B35 (Orange)
[REG]   → #FFD93D (Yellow)
[FP]    → #B366FF (Purple)
[OK]    → #00FF88 (Green)
[ERR]   → #FF2D2D with background highlight
```

---

### 6. MISSION COMPLETE STATE

**Replace progress panel with success display:**

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                 ✓ MISSION ACCOMPLISHED                  │
│                                                          │
│   "Zoom has been completely eliminated from this device" │
│                                                          │
│     ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│     │    47    │  │   156    │  │    5     │           │
│     │ FOLDERS  │  │ REGISTRY │  │PROCESSES │           │
│     │DESTROYED │  │  WIPED   │  │  KILLED  │           │
│     └──────────┘  └──────────┘  └──────────┘           │
│                                                          │
│            [DEPLOY ZOOM]     [VIEW REPORT]              │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Stats Cards:**
- Background: `#1A1D26`
- Number: `#00FF88` large display
- Label: `#8B9099` uppercase small
- Subtle green glow on each card

---

### 7. STATUS BAR

**Height:** 32px
**Background:** `#0A0A0F`

**Left:** Status indicator + text
**Center:** Current operation (if running)
**Right:** Admin status badge + version

---

## ANIMATIONS

### Button Hover
```css
.btn:hover {
  transform: scale(1.02);
  box-shadow: 0 0 30px rgba(255, 45, 45, 0.4);
}
```

### Threat Pulse
```css
@keyframes threat-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 10px rgba(255, 45, 45, 0.5); }
  50% { opacity: 0.8; box-shadow: 0 0 25px rgba(255, 45, 45, 0.8); }
}
```

### Log Entry Slide
```css
@keyframes slide-in {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: translateX(0); }
}
```

---

## WINDOW DIMENSIONS

- Minimum: 800 x 600
- Optimal: 1000 x 700
- Resizable with responsive adjustments

---

## FINAL DIRECTIVE

Build this with zero compromises. Every element must feel dangerous, precise, and premium. This is a tactical weapon disguised as software. The user should feel like they're launching a precision strike against invasive surveillance technology.

**This is 1132 ELIMINATION.**
**Total. Complete. Surgical.**

Execute with excellence.

---

*Prompt prepared by high-end market & design specialist. Build to spec.*
