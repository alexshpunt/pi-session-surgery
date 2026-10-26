# pi-session-surgery

A Pi extension that keeps long-running sessions small on disk.

Pi rebuilds the context it sends to the model from the newest compaction: the summary plus every
entry from that compaction's first kept entry onwards. Everything before that boundary is never
sent to the model. The moment Pi reports a successful compaction, the extension rewrites the session
file in place and drops exactly that invisible part, plus the older compaction records. The part the
model can see is copied unchanged, so what the model receives does not change.

The rewrite happens on Pi's own session file, so there is no session switch: the session keeps its
ID, its file name, its transcript and the running turn.

The manual `/session-surgery` command is more aggressive: it rewrites the whole active branch into
a plain transcript without tool history.

## Safety model

- Automatic surgery runs only after Pi has saved a successful compaction.
- It rewrites the session file the session already uses, so no turn is aborted and nothing is
  replayed or resumed.
- It copies the visible part of the session as it is, so the context sent to the model stays the same.
- It stops without changing the session when the compaction boundary cannot be found.
- Entries Pi writes while the rewrite is prepared are carried over, so nothing is lost.
- The rewrite is validated as a session before it replaces the live file.
- A prepared replacement that is not used is deleted.
- `/session-surgery` shows a preview and always asks for confirmation; that rewrite changes what the
  model sees, so it still moves the session to a new file.
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

### When it runs

The trim starts the moment Pi reports the compaction, before the turn continues. There is no waiting
for an idle moment, because nothing is aborted: Pi keeps appending to the same file afterwards.

Work is split so the live file is never rewritten under Pi's feet:

1. read the file up to the last complete line and build the replacement next to it;
2. carry over every byte Pi appended in the meantime;
3. rename the replacement onto the source and point the live session manager at that same path.

Steps 2 and 3 are synchronous, and Pi appends session entries with synchronous writes, so an append
cannot slip in between them. A newer compaction that arrives while a trim is preparing replaces the
queued request; trims never run concurrently.

### Reporting the trim

```text
Compacted session trimmed: 2367 KB → 148 KB
```

The status line carries the before and after file size. The session name, its ID and its file stay
the same, so nothing in the transcript looks like a resumed session.

If Pi cannot point the live session at a rewritten file, automatic surgery turns itself off for that
session and says so, instead of falling back to a switch.

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

Automatic surgery rewrites the live session file and shows it to Pi's session manager through
`setSessionFile()`, which is beyond the read-only type extensions get. The extension feature-detects
it and turns automatic surgery off when it is missing. Manual surgery keeps using the public
`switchSession()` lifecycle. It does not patch Pi's core or call reload as a substitute for session
switching.
Release steps are documented in [RELEASING.md](RELEASING.md).

## Development

```bash
npm install
npm run check
npm run test:integration
```

Integration tests run scripted responses through a real Pi process without paid model calls.
Set `PI_SURGERY_TEST_PI` to test another installed Pi executable.