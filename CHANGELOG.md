# Changelog

## Unreleased

- Trim the persisted session automatically after successful compaction while keeping Pi's post-compaction context unchanged.
- Add the `autoAfterCompaction` setting, enabled by default, with global and trusted-project overrides.
- Wait for queued Pi messages before trimming so Worktrunk moves are not interrupted by a session replacement.
- Rebuild retained assistant messages as plain transcript content so stale provider replay metadata cannot break tool use in the replacement session.

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
