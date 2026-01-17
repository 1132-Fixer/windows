# CleanState Sentinel Roadmap

Strategic direction and planned enhancements. This roadmap prioritizes stability and user value over feature volume.

## Philosophy

- **Conservative scope**: Each release should be boring to ship
- **Value-driven**: Every feature must solve a real user problem
- **No architecture changes**: v2.x builds on v2.0 foundation
- **Quality over speed**: Better to delay than ship regressions

---

## v2.1 (Next Release)

**Theme**: Polish and Performance

Target: Q2 2026

### Confirmed Features

#### Performance Improvements

| Item | Description | Benefit |
|------|-------------|---------|
| Parallel discovery | Run file/registry/service scans concurrently | 40-60% faster audit |
| Lazy loading | Load scan results incrementally | Lower memory footprint |
| Smart caching | Cache unchanged scan results between sessions | Instant re-scans |

#### UX Polish

| Item | Description | Benefit |
|------|-------------|---------|
| Progress granularity | Per-item progress instead of per-phase | Better user feedback |
| One-click quick scan | Preset for common use case | Faster time-to-value |
| Keyboard shortcuts | Ctrl+R scan, Ctrl+E execute, etc. | Power user efficiency |
| Tray minimization | Minimize to system tray during long operations | Less intrusive |

#### Report Enhancements

| Item | Description | Benefit |
|------|-------------|---------|
| Diff view | Compare two reports side-by-side | Track changes over time |
| Export formats | Add CSV and HTML export options | Integration flexibility |
| Redaction presets | Common redaction patterns (usernames, paths) | Easier sharing |

### Stretch Goals (If Time Permits)

- Dark mode UI theme
- Command-line interface for scripted runs
- Localization infrastructure (i18n)

### Explicitly Not in v2.1

- New target software support (Zoom-only in v2.x)
- Cloud features of any kind
- Auto-update mechanism
- Kernel-level operations

---

## v2.2 (Future)

**Theme**: Power User Features

Target: Q4 2026

### Candidates (Not Committed)

| Item | Description | Consideration |
|------|-------------|---------------|
| Custom scan profiles | Save/load scan configurations | Requested by IT admins |
| Scheduled scans | Run scans on a schedule | Compliance use case |
| Filter expressions | Regex-based artifact filtering | Advanced users only |
| Batch operations | Process multiple machines (local) | Enterprise need |

### Dependencies

- v2.1 must ship stable
- Community feedback incorporated
- No v2.1 regressions

---

## v3.0 (Long-term Vision)

**Theme**: Platform Expansion

Target: 2027+

### Potential Directions

These are exploratory and not committed:

| Direction | Description | Trade-offs |
|-----------|-------------|------------|
| Multi-target support | Beyond Zoom (Teams, Slack, etc.) | Scope explosion risk |
| Plugin architecture | User-defined scan modules | Maintenance burden |
| Headless mode | Full CLI operation | Different user base |
| Enterprise features | Central management, policies | Business model change |

### Gate Criteria for v3.0

v3.0 planning begins only when:
- v2.x has proven stable for 6+ months
- Clear user demand exists for new capabilities
- Architecture can support changes without rewrite

---

## Non-Goals (Things We Won't Do)

These are intentional exclusions to maintain project focus:

| Non-Goal | Reason |
|----------|--------|
| Cloud sync | Privacy commitment |
| Telemetry | Privacy commitment |
| Auto-update without consent | User control principle |
| Network scanning | Out of scope |
| Antivirus features | Not our domain |
| Ban evasion features | Ethical boundary |
| Kernel/driver operations | Risk too high |

---

## How Features Are Prioritized

### Acceptance Criteria

For any feature to be considered:

1. **Solves a real problem** - User request or clear pain point
2. **Fits the architecture** - No major refactoring required
3. **Maintainable** - One person can understand and fix it
4. **Testable** - Can be verified without manual QA
5. **Documented** - User-facing docs before merge

### Priority Matrix

| | High Impact | Low Impact |
|---|-------------|------------|
| **Low Effort** | Do first | Do if time |
| **High Effort** | Plan carefully | Probably skip |

---

## Contributing Ideas

Feature requests are welcome via GitHub Issues.

**Good feature requests include:**
- Problem description (what's painful today)
- Proposed solution (how you'd want it to work)
- Use case (who benefits and when)
- Alternatives considered

**We will close requests that:**
- Conflict with non-goals
- Require architectural changes in v2.x
- Lack clear user benefit
- Duplicate existing functionality

---

## Version Support

| Version | Status | Support |
|---------|--------|---------|
| v2.1+ | Active | Full |
| v2.0 | Active | Security only after v2.1 ships |
| v1.x | EOL | None |

---

## Changelog Location

See [CHANGELOG.md](CHANGELOG.md) for detailed release history.

---

*Last updated: January 2026*
*This roadmap is a living document and subject to change based on user feedback and project priorities.*
