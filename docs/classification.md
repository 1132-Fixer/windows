# How the classification works (conservative)

The script produces an inventory and assigns each item one of:
- Required
- CandidateRemove
- Unknown

Rules used:
1) Required
   - Inside FinalRoot
   - Inside any StartingPaths
   - Any .lnk shortcut target it discovers

2) CandidateRemove
   - Obvious temp/cache/log files (Temp/Cache/Log heuristics)
   - Duplicate hashes outside FinalRoot (keeps newest, quarantines older copies)

3) Unknown
   - Everything else (never removed automatically)

You can tune this safely by adjusting:
- Keywords / Extensions in config.json
- The Classify() function in src/1132-Remover.ps1

Recommended workflow:
Audit → Review summary → Consolidate → Verify → Cleanup (quarantine) → Delete (optional)
