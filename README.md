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

- Automatic surgery runs after Pi saves a successful compaction. Pi waits for the trim before
  continuation messages or the next turn can append.
- The session keeps its file and ID. No turn is aborted, replayed or resumed.
- Before replacement, Pi must build identical context from the original and rewritten files,
  including the system checkpoint, tool declarations and retained tool exchanges.
- The source bytes must still match the snapshot. Navigating to another leaf or switching sessions
  cancels the prepared rewrite.
- Entries appended during preparation keep their original IDs and parents. A reference to discarded
  history prevents replacement.
- An old missing-parent record can be removed only when the latest complete checkpoint hides it
  from the model. Visible broken history is kept; missing parents are never guessed.
- Invalid retained history or a missing compaction boundary turns automatic surgery off for the
  loaded session after one notification.
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

Pi waits for the compaction event handler to finish trimming before the turn continues. File
preparation is asynchronous; the final validation, replacement and manager reload are synchronous.

1. Read a complete-line snapshot and prepare the replacement beside the source.
2. Check that the session, live leaf and source prefix still match; carry over any appended entries.
3. Validate the tree and compare both contexts with Pi, then rename the replacement onto the source
   and reload the live manager at the same path.

A newer compaction replaces the waiting request; trims never run concurrently. Session shutdown or
replacement cancels obsolete work.

These checks coordinate writes within one Pi process. Do not open the same session file for writing
in multiple processes: another process does not participate in the commit.

### Reporting the trim

```text
Compacted session trimmed: 2367 KB → 148 KB
```

The status line carries the before and after file size. It appears after Pi rebuilds the compacted
chat; switching sessions before it appears cancels the notice. The session name, its ID and its file
stay the same, so nothing in the transcript looks like a resumed session.

If Pi cannot point the live session at a rewritten file, automatic surgery turns itself off for that
session and says so, instead of falling back to a switch. Validation failures also turn it off with
one short explanation. Loading the session again re-enables the configured behavior; unrecoverable
history needs investigation before retrying.

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