# pi-session-surgery

A destructive Pi extension that rebuilds a session without persisted tool history.

This is not context pruning. It rewrites the session JSONL file into a smaller replacement session, then switches Pi to that session.

## Safety model

- `/session-surgery` shows the preview and always asks for confirmation.
- The original JSONL is copied to `~/.pi/agent/session-backups/<session-id>/` first.
- The replacement is validated before Pi switches to it.
- The backup is never overwritten by restore.
- The old visible session file is removed only after the switch succeeds.

The replacement keeps user messages, assistant text and thinking, model and thinking-level changes, session info, compaction records, and its surgery metadata. It removes tool calls, tool results, bash execution records, and other extension entries.

Each slim session stores a non-context link to the backup of its immediate parent. This lets restore find the right manifest without a path.

## Commands

```text
/session-surgery
/session-surgery restore
/session-surgery restore ~/.pi/agent/session-backups/<session-id>/<backup>/manifest.json
```

`restore` without a path restores the immediate parent backup linked to the current session. Both forms show the backup details and ask for confirmation.

The package uses Pi's `switchSession()` lifecycle. It does not patch Pi's core or call reload as a substitute for session switching.

## Development

```bash
npm install
npm run check
```
