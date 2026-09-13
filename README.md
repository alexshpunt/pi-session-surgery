# pi-session-surgery

A Pi extension that keeps long-running sessions small on disk.

Pi rebuilds the context it sends to the model from the newest compaction: the summary plus every
entry from that compaction's first kept entry onwards. Everything before that boundary is never
sent to the model. After a successful compaction the extension forks the session and drops exactly
that invisible part, plus the older compaction records. The part the model can see is copied
unchanged, so what the model receives does not change.

The manual `/session-surgery` command is more aggressive: it rewrites the whole active branch into
a plain transcript without tool history.

## Safety model

- Automatic surgery runs only after Pi has saved a successful compaction.
- It copies the visible part of the session as it is, so the context sent to the model stays the same.
- It stops without changing the session when the compaction boundary cannot be found.
- `/session-surgery` shows a preview and always asks for confirmation.
- The replacement is validated before Pi switches to it.
- The switch happens only while Pi is idle with nothing queued and the source file unchanged since
  the copy, because activating a session aborts the active turn.
- A prepared replacement that is not used is deleted, so a cancelled switch leaves no extra file.
- The old session file is removed only after the switch succeeds.
- There are no backups. Tool history removed by a rewrite is gone for good.

## Automatic surgery behavior

The new session file keeps:

- the newest compaction record;
- the latest model, thinking-level, and session-info records;
- every entry from the newest compaction's first kept entry onwards, unchanged.

It removes everything before that boundary, including older compaction records.

Measured on real sessions: 2367 KB -> 420 KB with seven compaction records, 36460 KB -> 10338 KB
with five. Pi reports the same context before and after the rewrite.

On a session whose newest compaction kept almost the whole history, there is nothing invisible left
to drop, and the file keeps its size. That is expected: the remaining bytes are the context the
model is using right now.

### Waiting for a quiet moment

Pi activates a session by aborting the active turn and dropping queued messages. The replacement is
copied from the session file, so anything that arrives after that copy would be lost together with
the removed source file. The extension switches only while Pi is idle, nothing is queued, and the
source file has not changed since the copy.

When that check fails, the prepared file is deleted and the trim stays pending: the next settle
tries again. A session replacement during a trim is handled the same way, so the request moves to
the replacement session instead of failing with a stale-context error. `/session-surgery` reports
the same condition and asks for a retry, because a manual rewrite is never deferred silently.

## Manual surgery behavior

The manual replacement keeps user messages, assistant text and thinking, model and thinking-level
changes, session info, and the newest compaction record. It removes tool calls, tool results, bash
execution records, and other extension entries.

Retained assistant content is rebuilt as plain transcript content: provider replay IDs and
signatures are discarded, and each retained assistant message gets a normal completed stop reason.
This prevents removed tool exchanges from leaving invalid provider state behind.

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

The project value overrides the global value. An invalid setting disables automatic surgery for that
session instead of running with a guessed value.

## Commands

```text
/session-surgery
```

The package uses Pi's `switchSession()` lifecycle. It does not patch Pi's core or call reload as a
substitute for session switching.
Release steps are documented in [RELEASING.md](RELEASING.md).

## Development

```bash
npm install
npm run check
```
