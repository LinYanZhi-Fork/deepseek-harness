# Post-mortem 0005: An orphaned settings-writer lock silently blocked every settings write

English | [中文](0005-settings-writer-lock-orphaned-blocks-settings-writes.zh.md)

Status: resolved

## Executive summary

An abrupt server restart during a settings write left the dead process's `settings.yaml.lock` on disk. `withFileLock` never removes an existing lock because file age cannot prove its owner stopped — orphan recovery is deliberately an operator action — so every later settings write waited out the two-second deadline and failed with `settings/rejected: atomic-write: timed out waiting for the writer lock`. The browser settings scope swallows a write rejection by reloading its mirror, so the failures were silent: navigation reorder and theme changes simply did nothing. The reported "reorder sometimes fails" was therefore dominated by a blocked write path rather than the drag code; the drag drop did also carry a minor stale-hover-state race on fast drops, fixed separately. Deleting the orphan lock and its leftover temp file restored writes immediately. No code change ships with this record: stale-lock auto-recovery stays deferred because a recycled PID could falsely clear a live writer's lock on Windows and `dsh-atomic-write` is shared with the credentials path.

## Summary

[`withFileLock`](../../packages/util/atomic-write/src/index.ts) serializes writers of one file through a `wx`-created `<file>.lock` sibling holding the owner's PID, then removes it in a `finally`. A writer killed between lock creation and that `finally` leaves the lock behind with no owner. The protocol intentionally treats such an orphan as operator-cleared: a contender backs off and fails after the default two seconds instead of guessing whether the PID is stale, because file age cannot prove the owner stopped and a recycled PID could clear a live writer's lock and corrupt concurrent writes.

The [settings-file provider](../../packages/settings/settings-file/src/index.ts) commits every namespace through this lock (read-modify-write: reconcile from disk, render, atomic rename). While an orphan lock exists, every `settings/mutate` RPC rejects with the lock timeout. The client [`SettingsScope`](../../packages/client/ui-settings/src/client/settings-scope.ts) treats a rejected write as recoverable: it reloads the mirror and returns normally, so the UI shows the pre-write order with no error surface. The user experience is a feature that silently does nothing.

## Impact

On the affected instance every settings write was dead from the 23:38 restart until an operator removed the lock: navigation reorder, the theme preference, and any other preference write. The failure was invisible to the user and produced no diagnostic at the settings scope — only the Host's `settings/rejected` on the wire. No data was corrupted: the atomic-rename commit never ran, so the on-disk document stayed at its last committed state.

## Timeline

- A settings backup and a server restart occurred at 23:37–23:38 (`settings.yaml.bak-fix-volc-context-20260908-235600`, then the new web server PID 20440 starting at 23:38:48).
- The dying process left `settings.yaml.lock` (content PID 70852, since dead, created 23:38:28) and the in-flight temp file `settings.yaml.dbcfd7130fa1.tmp` from 23:38:46.
- Every later settings write failed with `settings/rejected: atomic-write: timed out waiting for the writer lock at ...\settings.yaml.lock`; the client reloaded its mirror and showed no change.
- Diagnosis isolated the write path by probing `settings/mutate` directly and confirming the lock owner PID was dead; removing the lock and the stale temp file restored theme and reorder writes immediately.

## Root cause

The lock protocol has no orphan recovery by design, and the client makes a rejected write indistinguishable from a no-op. Together they turned an availability failure into a silent feature failure: the write path is down and nothing says so. The drag interaction contributed a separate intermittent cause — the drop read hover state that React had not yet committed on fast drags — which produced the same symptom without the write path being involved.

## Guardrails added

- No code change ships with this record (operator decision to keep the status quo). The operator recovery procedure is: verify the lock content PID is dead, remove `settings.yaml.lock` and any leftover `settings.yaml.<suffix>.tmp`, then retry the write.
- The drag drop race was fixed: the drop resolves its target and half from the drop event, a `dragend` without a delivered drop falls back to the last hovered position, and a per-drag flag prevents double-commit.
- Deferred by design: stale-lock auto-recovery that reads the lock PID, probes liveness, and removes-and-retries when dead — not implemented because a recycled PID can clear a live writer's lock, and `dsh-atomic-write` also guards the credentials path.

## Lessons

- A write path that swallows rejection converts an availability bug into a "feature is broken" report. A single `settings/mutate` RPC probe distinguishes a UI race from a persistence failure and is the first step when a settings write "sometimes fails".
- Orphan locks are expected after abrupt process death; anyone debugging settings writes should know the operator action (verify the PID, remove the lock and the stale temp file) before touching the provider.
- A documented design decision (no auto-clear) is safe only while an operator action exists and is known; the residual cost was diagnosability, mitigated here by a written recovery procedure.
