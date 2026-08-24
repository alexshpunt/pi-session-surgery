# Changelog

## 0.1.2 — 2026-08-24

- Fix atomic session writes on Windows paths.
- Run the package test suite on Windows in CI.

## 0.1.1 — 2026-08-24

- Add automated CI, secret scanning, and provenance-backed npm publishing.
- Document the public release and Trusted Publishing setup.

## 0.1.0 — 2026-08-24

- Add `/session-surgery` to rebuild a Pi session without persisted tool history.
- Keep conversation text, thinking, control records, and compaction state.
- Store an immutable backup before switching to the slim session.
- Add automatic parent-backup discovery for `/session-surgery restore`.
- Add explicit manifest restore for manual recovery.
