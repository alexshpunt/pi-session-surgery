# Changelog

## Unreleased

- Recover missing-parent records hidden by a complete compaction checkpoint only when Pi builds identical context before and after trimming.
- Wait for automatic trimming before compaction continuation, preserve branch navigation and session changes, and reject non-append source rewrites.
- Disable automatic trimming for the loaded session after a validation failure, with one short explanation instead of repeated errors.
- Show trim notifications after Pi rebuilds the compacted chat, and cancel deferred notices when the loaded session changes.
- Preserve retained entry IDs during automatic trimming so entries appended while the rewrite is prepared keep valid parents; validate carried-over entries before replacing the live file.
- Automatic surgery now forks at the compaction boundary: everything before Pi's first kept entry and every older compaction record is dropped, while the visible part is copied unchanged so the context sent to the model stays identical.
- Remove session backups, the restore command, and the restore machinery. A rewrite no longer copies the old session; removed tool history is gone for good.
- Trim the persisted session automatically after successful compaction while keeping Pi's post-compaction context unchanged.
- Add the `autoAfterCompaction` setting, enabled by default, with global and trusted-project overrides.
- Rewrite the live session file in place right after a compaction instead of switching to a replacement session: no resumed session, no aborted turn, no waiting for an idle moment, and the session keeps its ID, its file and its transcript.
- Carry over entries Pi writes while the rewrite is prepared, and skip the rewrite when the compaction kept all history.
- Turn automatic surgery off with a warning when Pi cannot point the live session at a rewritten file.
- Report the trim after the switch resolves, so Pi's generic `Resumed session` status no longer hides what happened, and include the before and after session file size.
- Wait for queued Pi messages before trimming so Worktrunk moves are not interrupted by a session replacement.
- Rebuild retained assistant messages as plain transcript content so stale provider replay metadata cannot break tool use in the replacement session.
- Replace the previous rewrite suffix in session file names so repeated automatic surgery cannot hit the file name length limit.
- Switch only while Pi is idle with nothing queued and the source file unchanged since the copy, so a trim can no longer abort a turn that started while the replacement was being written.
- Retry a deferred trim after the next settle instead of dropping it silently.
- Treat a session replacement during a trim as a retry instead of reporting a stale-context failure.
- Delete the prepared replacement when the switch is cancelled or never starts.

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
