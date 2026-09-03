# pi-session-surgery

A Pi extension that keeps long-running sessions small on disk.

After Pi compacts context successfully, the extension creates a replacement session from that compaction checkpoint. It drops entries that Pi's summary has replaced and keeps the summary, the recent retained tail, and anything written after compaction. The context sent to the model stays the same.

The manual `/session-surgery` command remains more aggressive: it removes persisted tool history throughout the active branch.

## Safety model

- Automatic surgery runs only after Pi has saved a successful compaction.
- It keeps Pi's exact post-compaction context, including recent tool calls and results.
- It stops without changing the session if the retained compaction tail cannot be found.
- `/session-surgery` shows a preview and always asks for confirmation.
- Every rewrite first copies the original JSONL to `~/.pi/agent/session-backups/<session-id>/`.
- The replacement is validated before Pi switches to it.
- Restore never overwrites the backup.
- The old visible session file is removed only after the switch succeeds.

## Manual surgery behavior

The manual replacement keeps user messages, assistant text and thinking, model and thinking-level changes, session info, compaction records, and its surgery metadata. Retained assistant content is rebuilt as plain transcript content: provider replay IDs and signatures are discarded, and each retained assistant message gets a normal completed stop reason. This prevents removed tool exchanges from leaving invalid provider state behind.

Manual surgery removes tool calls, tool results, bash execution records, and other extension entries.

Each slim session stores a non-context link to the backup of its immediate parent. This lets restore find the right manifest without a path.

## Configuration

Automatic surgery is on by default. Set `autoAfterCompaction` to `false` to turn it off:

```json
{
  "autoAfterCompaction": false
}
```

Put the file at either location:

- `~/.pi/agent/extensions/session-surgery.json` for all projects;
- `<project>/.pi/session-surgery.json` for one trusted project.

The project value overrides the global value. An invalid setting disables automatic surgery for that session instead of running with a guessed value.

## Commands

```text
/session-surgery
/session-surgery restore
/session-surgery restore ~/.pi/agent/session-backups/<session-id>/<backup>/manifest.json
```

`restore` without a path restores the immediate parent backup linked to the current session. Both forms show the backup details and ask for confirmation.

The package uses Pi's `switchSession()` lifecycle. It does not patch Pi's core or call reload as a substitute for session switching.
Release steps are documented in [RELEASING.md](RELEASING.md).


## Development

```bash
npm install
npm run check
```
