# Security Response Plan

CleanState Sentinel Security Operations Playbook

## Vulnerability Intake

### Reporting Channels

| Channel | Use Case | Response Time |
|---------|----------|---------------|
| GitHub Security Advisories | Preferred for all reports | 48 hours |
| Email (TBD) | Sensitive disclosures | 48 hours |
| Public GitHub Issue | Non-sensitive bugs only | 72 hours |

**DO NOT** report security vulnerabilities via public GitHub issues.

### What to Include

Good vulnerability reports contain:
- Clear description of the issue
- Steps to reproduce
- Affected versions
- Potential impact assessment
- Proof of concept (if safe to share)
- Suggested fix (optional)

### Scope

**In Scope:**
- Privilege escalation vulnerabilities
- Arbitrary code execution
- Unintended data access or deletion
- Bypass of security controls
- Cryptographic weaknesses

**Out of Scope:**
- Social engineering attacks
- Physical access attacks
- Attacks requiring admin access to victim's machine
- Third-party dependency vulnerabilities (report upstream)

---

## Triage Process

### Severity Classification

| Severity | Criteria | Response SLA |
|----------|----------|--------------|
| **Critical** | RCE, privilege escalation, data destruction without consent | 24 hours |
| **High** | Significant security bypass, unintended elevated operations | 72 hours |
| **Medium** | Limited security impact, requires user interaction | 7 days |
| **Low** | Minor issues, defense in depth failures | 30 days |
| **Informational** | Best practice improvements | Next release |

### Triage Checklist

```
[ ] Acknowledge receipt to reporter
[ ] Reproduce the issue
[ ] Classify severity
[ ] Identify affected versions
[ ] Determine if public disclosure risk exists
[ ] Assign to developer
[ ] Establish fix timeline
[ ] Communicate timeline to reporter
```

---

## Patch Cadence

### Release Types

| Type | Version Bump | Trigger | Example |
|------|--------------|---------|---------|
| **Hotfix** | Patch (2.0.x) | Critical/High security | 2.0.0 → 2.0.1 |
| **Minor** | Minor (2.x.0) | Features, Medium security | 2.0.1 → 2.1.0 |
| **Major** | Major (x.0.0) | Breaking changes, architecture | 2.1.0 → 3.0.0 |

### Scheduled Releases

- **Security patches**: As needed (no delay for Critical/High)
- **Feature releases**: Quarterly or as warranted
- **Major releases**: Annual or when architecture requires

### Hotfix Process

1. Create private branch from affected release tag
2. Develop and test fix
3. Internal security review
4. Build signed release
5. Publish with security advisory
6. Notify reporter
7. Merge fix to main branch

---

## Backport Policy

### Supported Versions

| Version | Support Status | Security Updates |
|---------|----------------|------------------|
| 2.x (current) | Active | Yes |
| 1.x (legacy) | End of Life | Critical only, best effort |

### Backport Criteria

Security fixes are backported when:
- Severity is Critical or High
- Fix is technically feasible without major changes
- Significant user base remains on older version

### End of Life

When a major version reaches EOL:
1. Announce 90 days in advance
2. Final security patch if pending issues
3. Update documentation
4. Archive but don't delete release artifacts

---

## Deprecation Policy

### Feature Deprecation

1. **Announce**: Document in release notes and CHANGELOG
2. **Warn**: Add runtime deprecation warnings (1 minor version)
3. **Remove**: Remove in next major version

### API/Interface Changes

Breaking changes require:
- Major version bump
- Migration guide in release notes
- Minimum 1 release cycle warning

---

## Key Management

### Signing Key Handling

| Asset | Storage | Access | Rotation |
|-------|---------|--------|----------|
| Code signing cert | GitHub Secrets / HSM | Maintainers only | Before expiration |
| GitHub tokens | GitHub Secrets | Automated only | Annual |

### Key Rotation Schedule

- **Code signing certificate**: Before expiration (typically annual)
- **GitHub Personal Access Tokens**: Annual or on compromise
- **Secrets**: On team member departure

### Compromise Response

If a signing key is compromised:
1. Revoke certificate immediately
2. Notify users via GitHub Advisory
3. Re-sign affected releases with new certificate
4. Update all automation secrets
5. Post-mortem and process improvement

---

## Incident Communications

### Internal Notification

**Trigger**: Any security issue classified High or above

```
SECURITY INCIDENT - [SEVERITY]

Issue: [Brief description]
Affected: [Versions/components]
Status: [Investigating/Confirmed/Fixed]
Reporter: [Internal/External]
ETA: [Fix timeline]

Next steps:
- [ ] Action items
```

### External Notification

**GitHub Security Advisory** (required for all security releases):

```markdown
## Summary
[One paragraph description]

## Affected Versions
- CleanState Sentinel < X.Y.Z

## Impact
[What an attacker could do]

## Patches
Upgrade to version X.Y.Z or later.

## Workarounds
[If any exist]

## References
- [Link to fix PR/commit]

## Credit
Thanks to [reporter] for responsible disclosure.
```

### User Communication Template

For significant security releases:

```markdown
# Security Update: CleanState Sentinel vX.Y.Z

A security vulnerability was identified and fixed in CleanState Sentinel.

**Who is affected**: Users running version X.Y.Z or earlier
**Severity**: [Critical/High/Medium]
**Action required**: Update to version X.Y.Z immediately

## What happened
[Brief, non-technical explanation]

## What we did
[Fix summary without exploitation details]

## What you should do
1. Download the latest version from [releases page]
2. Verify the checksum matches
3. Install and verify the update

## Timeline
- [Date]: Issue reported
- [Date]: Fix developed
- [Date]: Release published

Questions? Open an issue or contact [channel].
```

---

## Post-Incident Review

After any Critical or High severity incident:

### Review Meeting Agenda

1. Timeline reconstruction
2. Root cause analysis
3. Detection effectiveness
4. Response effectiveness
5. Process improvements
6. Action items

### Documentation

Create `security/incidents/YYYY-MM-DD-brief-description.md`:

```markdown
# Incident Report: [Title]

**Date**: YYYY-MM-DD
**Severity**: Critical/High/Medium/Low
**Status**: Resolved

## Summary
[What happened]

## Timeline
- HH:MM - Event
- HH:MM - Event

## Root Cause
[Technical explanation]

## Impact
[What was affected]

## Resolution
[How it was fixed]

## Lessons Learned
[What we'll do differently]

## Action Items
- [ ] Item with owner and due date
```

---

## Contacts

| Role | Responsibility |
|------|----------------|
| Maintainer | Triage, fix development, release |
| Security Contact | Coordinate disclosure, external comms |

---

## Review Schedule

This document is reviewed:
- Quarterly for accuracy
- After any security incident
- When team membership changes

---

*Last updated: January 2026*
*CleanState Sentinel v2.0.0*
