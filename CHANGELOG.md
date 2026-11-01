# Changelog

## 0.1.6 - 2026-11-01

- Trim persisted sessions automatically after compaction while preserving the active session and its context. Automatic trimming is enabled by default and can be disabled with `autoAfterCompaction`.
- Preserve retained entry IDs and concurrent session writes. Validate rewrites and recover missing-parent records only when the resulting context matches.
- Stop automatic trimming for the loaded session after validation fails, and report trimming after the compacted chat is rebuilt.
- Remove session backups and the restore command. Trimmed history is permanently removed; make your own backup if you need to retain it.

## 0.1.3 — 2026-08-24

- Keep the Windows CI check portable across Windows file-mode reporting.

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
