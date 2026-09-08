# Agent Note: User-pinned settings-section nav order

Status: implemented

English | [中文](2026-09-08-settings-nav-drag-reorder.zh.md)

## Problem

Every feature plugin registers its settings page into the `settings.section` ledger with its own `order` value. As the plugin population grows, the Settings panel's left nav rail mixes arbitrary, uncoordinated positions: the user has no way to bring frequently used pages to the top or to group related pages, and each new plugin can land mid-list at an author-chosen position.

## Decision

The settings shell (ui-settings-general) lets the user drag nav rows into a personal order, persisted to the user-settings document in a new `ui-settings-nav` namespace (`{ order: string[] }`) registered by the package's Host half. The shell binds the namespace through the shared `ctx.settingsScope` seam — no new wire read, the same boundary every other GUI preference (theme, locale, conversation) uses. The nav projection merges the persisted ids over the plugin-declared `order`: listed ids render first in the listed sequence, stale ids with no live registration are dropped, duplicates collapse, and sections registered after the user pinned their layout append at the tail instead of displacing a pinned position. With no persisted order the projection is byte-for-byte the previous plugin-order sort.

The interaction is HTML5 drag-and-drop on the nav rows (the workspace browser's established pattern): the whole row is draggable, hovering another row's top/bottom half shows a 2px insert line, and the drop commits the full visible id sequence through an injected `setSectionOrder` callback. The drop resolves its target and half from the drop event itself rather than the hover state, so a fast drop never reads a stale marker; a `dragend` without a delivered drop (released outside a row, or a hover commit that lagged) falls back to the last hovered position, guarded against double-commit by a per-drag flag. Drag state stays local to the panel component; the write rides the scope, whose echo re-projects the rows through a cache key that now includes the namespace revision. No grip glyph or other visual handle marks the rows as draggable — the affordance is the drag cursor and the insert line.

## Alternatives considered

**Store the order in a browser-local store with localStorage persistence.** Rejected: every other durable GUI preference rides the user-settings document (cross-machine, provider-owned, validated by schema); a second persistence channel would diverge from the established preference mechanism.

**Let every section keep its plugin `order` and store only an index perturbation.** Rejected: plugin authors own `order` and can change it under the user; a full id list makes the user's layout authoritative and unambiguous, and the append-at-tail rule keeps future plugins from violating it.

**Keyboard reorder affordance (up/down actions) in addition to drag.** Deferred: HTML5 drag has no keyboard path, but adding per-row actions changes the nav's chrome and copy surface; the drag-only gap is recorded in the package README's Known Limitations.

## Consequences

- The nav order persists in the user-settings document (`ui-settings-nav.order`) and survives restarts and plugin reloads; a section that unmounts and remounts returns to its pinned slot.
- Non-loopback (remote) browsers get the existing scope behavior: the write is a no-op in memory mode, so the order stays session-local there — identical to every other preference row.
- A new plugin's section renders at the tail until the user moves it, so plugin `order` stops being the only layout authority.
- The shell's nav projection cache now keys on the scope revision as well as the section ledger and locale revisions; the merge helper `applyNavOrder` is a pure function with direct unit coverage, and the projection/write wiring is covered by shell tests (100% per-file coverage gate).
