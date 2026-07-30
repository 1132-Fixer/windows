# 1132 Fixer Design System

> **Version:** 1.0\
> **Platform:** Windows Desktop\
> **Framework:** WinUI 3 / Windows App SDK\
> **Theme:** Dark (Fluent Design)

------------------------------------------------------------------------

# Overview

1132 Fixer is a professional Windows desktop utility designed to
diagnose and repair Zoom-related issues. The interface should feel like
a first-party Microsoft application with a clean, modern, and
trustworthy appearance.

Inspired by:

-   Windows Settings
-   Microsoft PowerToys
-   Dev Home
-   Windows Terminal
-   Microsoft Defender
-   Visual Studio Installer

Avoid visual styles inspired by gaming software, crypto dashboards, RGB
utilities, or mobile applications.

------------------------------------------------------------------------

# Design Principles

-   Function before decoration
-   Clear information hierarchy
-   Spacious layouts
-   Consistent spacing
-   Minimal visual noise
-   Native Windows look and feel
-   Accessibility first

------------------------------------------------------------------------

# Color Palette

## Window Background

-   `#18233A`

Gradient:

-   `#17243A → #203857`

## Surface

-   `#1E2B46`

## Elevated Surface

-   `#243453`

## Border

Default:

`rgba(255,255,255,0.08)`

Highlighted:

`rgba(58,130,247,0.40)`

## Accent

Use the Windows system accent color whenever available.

Fallback:

-   `#3A82F7`

## Status Colors

Success

-   `#39D353`

Warning

-   `#F2C94C`

Error

-   `#F85149`

Disabled Text

-   `#7E8597`

------------------------------------------------------------------------

# Typography

Primary font:

-   Segoe UI Variable

Monospace:

-   Cascadia Mono

  Style       Size Weight
  --------- ------ ----------
  Display       32 Bold
  Title         24 Semibold
  Section       18 Semibold
  Body          14 Regular
  Caption       12 Medium

------------------------------------------------------------------------

# Corner Radius

  Component     Radius
  ----------- --------
  Window          12px
  Cards           12px
  Buttons          8px
  Inputs           8px
  Badges         999px

------------------------------------------------------------------------

# Spacing

Base spacing unit:

`8px`

Scale:

`4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48`

Card padding:

`24px`

------------------------------------------------------------------------

# Layout

-   Maximum content width: 1240px
-   Outer padding: 28px
-   Section spacing: 24px
-   Consistent card alignment
-   Large primary actions

------------------------------------------------------------------------

# Components

## Cards

-   Rounded corners
-   Subtle border
-   Flat appearance
-   No heavy shadows

## Buttons

### Primary

-   Filled accent color
-   White text
-   Large click target

### Secondary

-   Dark surface
-   Subtle border

### Toolbar

-   Icon + label
-   Compact
-   Consistent width

------------------------------------------------------------------------

# Inputs

-   Dark background
-   8px radius
-   Blue focus outline
-   12px internal padding

------------------------------------------------------------------------

# Status Indicators

Always pair color with an icon.

-   Green = Success
-   Yellow = Warning
-   Red = Error

------------------------------------------------------------------------

# Chips

Used for supported platforms, architectures, and features.

-   Pill shape
-   Small padding
-   Muted colors

------------------------------------------------------------------------

# Activity Log

-   Cascadia Mono
-   Individual rounded log rows
-   Auto-scroll
-   Copy/Clear actions always visible

------------------------------------------------------------------------

# Icons

Preferred:

-   Fluent UI System Icons

Fallback:

-   Segoe Fluent Icons
-   Lucide

Use outline icons between 18--22px.

------------------------------------------------------------------------

# Motion

Use subtle Fluent animations.

Allowed:

-   Fade
-   Scale
-   Crossfade

Duration:

`120–180ms`

Avoid bounce, elastic, or flashy transitions.

------------------------------------------------------------------------

# Accessibility

-   WCAG AA contrast
-   Keyboard accessible
-   Visible focus states
-   Minimum target size: 44×44px

------------------------------------------------------------------------

# Overall Experience

The application should feel like a polished Windows 11 system utility.
Every interface element should communicate reliability, clarity, and
confidence while remaining visually restrained. Decorative effects
should be minimal, with the focus on diagnostics, system status, and
user actions rather than visual embellishment.
