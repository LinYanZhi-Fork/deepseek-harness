/** Pure user-order merge semantics for the settings-section nav projection. */
import { describe, expect, it } from 'vitest'
import { applyNavOrder } from '../src/client/nav-order.ts'

describe('applyNavOrder', () => {
  it('returns the plugin rows untouched when no user order is persisted', () => {
    const rows = [{ id: 'general', order: 0 }, { id: 'z', order: 20 }]
    expect(applyNavOrder(rows, [])).toEqual(rows)
  })

  it('pins listed sections first, dropping stale and duplicate ids', () => {
    const rows = [
      { id: 'general', order: 0 },
      { id: 'models', order: 10 },
      { id: 'plugins', order: 20 },
    ]
    // 'gone' has no registration and 'plugins' is listed twice.
    expect(applyNavOrder(rows, ['plugins', 'gone', 'plugins', 'general']).map(row => row.id))
      .toEqual(['plugins', 'general', 'models'])
  })

  it('keeps unlisted sections in plugin order after the listed ones', () => {
    const rows = [
      { id: 'general', order: 0 },
      { id: 'a', order: 1 },
      { id: 'b', order: 2 },
    ]
    expect(applyNavOrder(rows, ['b']).map(row => row.id)).toEqual(['b', 'general', 'a'])
  })
})
