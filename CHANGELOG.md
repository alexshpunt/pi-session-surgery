# Changelog

## 0.1.0 — 2026-08-24

- Add `/session-surgery` to rebuild a Pi session without persisted tool history.
- Keep conversation text, thinking, control records, and compaction state.
- Store an immutable backup before switching to the slim session.
- Add automatic parent-backup discovery for `/session-surgery restore`.
- Add explicit manifest restore for manual recovery.
