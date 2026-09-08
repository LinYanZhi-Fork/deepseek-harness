/** Settings shell registration: slot declaration injection, the ledger projections, and HMR recovery. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'
import type { SettingsRootInjected } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'
import {
  NAV_ORDER_FIELD, NAV_ORDER_SETTINGS_NAMESPACE, SettingsNavOrderSchema,
} from '../src/nav-settings.ts'

async function bench(options: { isLoopback?: boolean; navOrder?: string[] } = {}) {
  const { isLoopback = false, navOrder } = options
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  // Copy machinery the shell only reads a revision from; the real locale
  // plugin would drag its own settings-row dependencies into this bench.
  ctx.provide('locale', {
    register: () => () => {},
    bind: () => (key: string) => key,
    getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }),
    subscribe: () => () => {},
  } as never)
  // The shell mounts ui-settings, which injects `remote.settings`; without the
  // namespace provided its fiber parks and no slot is ever declared. When a
  // nav order is staged, the bench serves the nav namespace so the mirror
  // holds a document and the scope can echo writes back.
  const section: Record<string, unknown> = { [NAV_ORDER_FIELD]: navOrder ?? [] }
  let revision = 0
  const namespace = () => ({
    ns: NAV_ORDER_SETTINGS_NAMESPACE,
    schema: SettingsNavOrderSchema.toJSON(),
    value: { ...section },
    applies: 'live' as const,
    secrets: [],
    revision,
  })
  const describe = vi.fn(() => navOrder === undefined
    ? Promise.resolve({ ok: false, error: new RemoteError('gateway/internal', 'no settings', {}) })
    : Promise.resolve({
      ok: true as const,
      value: { writable: true, hasDocument: true, namespaces: [namespace()] },
    }))
  const mutate = vi.fn((_ns: string, ops: { path: string[]; value: unknown }[]) => {
    const op = ops[0]!
    section[op.path[0]!] = op.value
    revision += 1
    return Promise.resolve({ ok: true as const, value: namespace() })
  })
  const reconnect = vi.fn()
  const connectionState = {
    getSnapshot: () => 'connected' as const,
    subscribe: () => () => {},
  }
  ctx.provide('connection', { state: connectionState, reconnect } as never)
  ctx.provide('remote', {
    $on: () => () => {},
    $host: { home: undefined, isLoopback },
    settings: { describe, mutate },
  } as never)
  ctx.provide('remote.settings', { describe, mutate } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, connectionState, reconnect, mutate }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    { name: 'root', children: { 'sidebar.settings': { kind: 'single', scope: 'root' } } } as never,
    () => null,
  )
}

function injectedOf(slots: SlotRegistry): SettingsRootInjected {
  const entry = slots.entries('sidebar.settings')[0]!
  return (entry.inject as () => SettingsRootInjected)()
}

/** The shell's child declarations (chrome, actions, sections, and onboarding overlays). */
const CHILD_SPECS = {
  'settings.trigger': { kind: 'single', scope: 'root' },
  'settings.header': { kind: 'single', scope: 'root' },
  'settings.action': { kind: 'list', scope: 'root' },
  'settings.close': { kind: 'single', scope: 'root' },
  'settings.section': { kind: 'list', scope: 'root' },
  'settings.onboarding': { kind: 'list', scope: 'root' },
} as const

describe('ui-settings apply', () => {
  it('declares only the slot registry (a pure composition face, no locale)', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'connection', 'remote', 'remote.settings', 'settingsScope',
    ])
  })

  it('registers the shell and declares every child slot, before or after the declaration', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.settings')[0]!.component).toBe(SettingsRoot)
    for (const name of Object.keys(CHILD_SPECS) as Array<keyof typeof CHILD_SPECS>) {
      expect(before.slots.spec(name)).toEqual(CHILD_SPECS[name])
    }

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('sidebar.settings')).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('sidebar.settings')[0]!.component).toBe(SettingsRoot)
    // The self-inflicted ledger notifications hit the duplicate guard.
    expect(after.slots.entries('sidebar.settings')).toHaveLength(1)
  })

  it('projects the section ledger into ordered nav rows with option defaults', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const { sections } = injectedOf(b.slots).hooks
    // This package registers the General section itself; every other section
    // arrives from a feature registrant.
    const GENERAL = { id: 'general', order: 0, label: 'general.nav' }
    expect(sections.getSnapshot()).toEqual([GENERAL])
    b.slots.register({ name: 'settings.section', id: 'z', order: 20, label: 'Z' } as never, () => null)
    // No order and no label: both projection defaults apply.
    b.slots.register({ name: 'settings.section', id: 'a' } as never, () => null)
    const rows = sections.getSnapshot()
    expect(rows).toEqual([
      GENERAL,
      { id: 'a', order: 0, label: '' },
      { id: 'z', order: 20, label: 'Z' },
    ])
    // Snapshot identity is stable until the ledger moves (uSES contract).
    expect(sections.getSnapshot()).toBe(rows)
    const listener = vi.fn()
    const off = sections.subscribe(listener)
    b.slots.register({ name: 'settings.section', id: 'b', order: 1, label: 'B' } as never, () => null)
    await Promise.resolve()
    expect(listener).toHaveBeenCalled()
    expect(sections.getSnapshot()).not.toBe(rows)
    off()
  })

  it('projects the Gateway connection control without copying its state', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = injectedOf(b.slots)
    expect(injected.hooks.connectionState).toBe(b.connectionState)
    injected.reconnect()
    expect(b.reconnect).toHaveBeenCalledOnce()
  })

  it('projects onboarding entries into stable coordinator order', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const { onboardingSteps } = injectedOf(b.slots).hooks
    b.slots.register({ name: 'settings.onboarding', id: 'credential', order: 0 } as never, () => null)
    b.slots.register({ name: 'settings.onboarding', id: 'welcome', order: -100 } as never, () => null)
    b.slots.register({ name: 'settings.onboarding', id: 'default-order' } as never, () => null)
    const steps = onboardingSteps.getSnapshot()
    expect(steps).toEqual([
      { id: 'welcome', order: -100 },
      { id: 'credential', order: 0 },
      { id: 'default-order', order: 0 },
    ])
    expect(onboardingSteps.getSnapshot()).toBe(steps)
    const listener = vi.fn()
    const off = onboardingSteps.subscribe(listener)
    b.slots.register({ name: 'settings.onboarding', id: 'later', order: 10 } as never, () => null)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
    off()
  })

  it('re-registers after an HMR collapse re-declares the slot (stale disposer must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('sidebar.settings')).toHaveLength(1)
    // Declarer unload: the cascade removes our entry and every child
    // declaration while our local disposer variable goes stale.
    redeclare()
    expect(b.slots.entries('sidebar.settings')).toHaveLength(0)
    expect(b.slots.spec('settings.trigger')).toBeUndefined()
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('sidebar.settings')[0]!.component).toBe(SettingsRoot)
    for (const name of Object.keys(CHILD_SPECS) as Array<keyof typeof CHILD_SPECS>) {
      expect(b.slots.spec(name)).toEqual(CHILD_SPECS[name])
    }
  })

  it('unregisters the shell and collapses every child slot on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar.settings')).toHaveLength(0)
    for (const name of Object.keys(CHILD_SPECS) as Array<keyof typeof CHILD_SPECS>) {
      expect(b.slots.spec(name)).toBeUndefined()
    }
  })
})

describe('settings nav order', () => {
  it('pins user-listed sections above the rest and appends new sections at the tail', async () => {
    const b = await bench({ isLoopback: true, navOrder: ['z', 'a'] })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const { sections } = injectedOf(b.slots).hooks
    b.slots.register({ name: 'settings.section', id: 'a', order: 1, label: 'A' } as never, () => null)
    b.slots.register({ name: 'settings.section', id: 'z', order: 20, label: 'Z' } as never, () => null)
    // The pinned order arrives once the mirror holds the served document.
    await vi.waitFor(() => {
      expect(sections.getSnapshot().map(row => row.id)).toEqual(['z', 'a', 'general'])
    })
    // A section registered after the user pinned their layout appends after
    // the pinned ones instead of displacing them.
    b.slots.register({ name: 'settings.section', id: 'later', order: 5, label: 'Later' } as never, () => null)
    expect(sections.getSnapshot().map(row => row.id)).toEqual(['z', 'a', 'general', 'later'])
  })

  it('persists a drop through setSectionOrder and re-projects on the scope echo', async () => {
    const b = await bench({ isLoopback: true, navOrder: [] })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = injectedOf(b.slots)
    const { sections } = injected.hooks
    b.slots.register({ name: 'settings.section', id: 'a', order: 1, label: 'A' } as never, () => null)
    b.slots.register({ name: 'settings.section', id: 'z', order: 20, label: 'Z' } as never, () => null)
    expect(sections.getSnapshot().map(row => row.id)).toEqual(['general', 'a', 'z'])
    const listener = vi.fn()
    const off = sections.subscribe(listener)
    injected.setSectionOrder(['z', 'general', 'a'])
    await vi.waitFor(() => {
      expect(sections.getSnapshot().map(row => row.id)).toEqual(['z', 'general', 'a'])
    })
    expect(b.mutate).toHaveBeenCalledWith(
      NAV_ORDER_SETTINGS_NAMESPACE,
      [{ op: 'set', path: [NAV_ORDER_FIELD], value: ['z', 'general', 'a'] }],
      expect.any(Number),
    )
    expect(listener).toHaveBeenCalled()
    off()
  })
})
