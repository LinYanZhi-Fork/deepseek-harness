// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsRootComponentProps } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type Row = { id: string; order: number; label: string }
type Step = { id: string; order: number }

/** Slot-content stand-ins: the shell renders whatever the seats contribute. */
const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
  'settings.header': 'Settings Title',
  'settings.action': 'Open configuration file',
  'settings.close': 'Close',
}

type AttentionSnapshot = Parameters<Parameters<SettingsRootComponentProps['useSessionPendingInteraction']>[0]>[0]
type ConnectionSnapshot = Parameters<Parameters<SettingsRootComponentProps['useConnectionState']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: SettingsRootComponentProps['useSessionPendingInteraction'] = selector => selector(noAttention)

function mount({
  wide = true,
  connectionState = 'connected',
  onboardingActive = true,
  rows = [
    { id: 'general', order: 0, label: 'General' },
    { id: 'models', order: 10, label: 'Models' },
    { id: 'agent-presets', order: 20, label: 'Agent presets' },
  ],
  steps = [
    { id: 'welcome', order: -100 },
    { id: 'credential', order: 0 },
  ],
}: {
  wide?: boolean
  connectionState?: ConnectionSnapshot
  onboardingActive?: boolean
  rows?: Row[]
  steps?: Step[]
} = {}) {
  // Mutable row source standing in for the bound useSections hook; bump()
  // plays a ledger change through the same observable contract.
  let current = rows
  let currentConnectionState = connectionState
  const listeners = new Set<() => void>()
  const connectionListeners = new Set<() => void>()
  const reconnect = vi.fn()
  const setSectionOrder = vi.fn()
  const renderSlot = vi.fn(
    ((key: string, _owner: unknown, opts?: { only?: string }) => {
      if (key === 'settings.section') return <div data-testid={`section-${opts?.only ?? 'all'}`} />
      return SEAT_CONTENT[key]
    }) as SettingsRootComponentProps['renderSlot'],
  )
  const useSessions = ((select: (state: unknown) => unknown) => select(onboardingActive
    ? { phase: 'ready', current: undefined, byId: {} }
    : {
      phase: 'ready',
      current: 'active-session',
      byId: { 'active-session': { blank: false } },
    })) as never
  const unusedHook = (() => { throw new Error('unused by SettingsRoot') }) as never
  const props: SettingsRootComponentProps = {
    useSessions,
    useSessionPendingInteraction,
    useWorkspaces: unusedHook,
    wide,
    reconnect,
    setSectionOrder,
    t: makeTranslate(en),
    useConnectionState: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        connectionListeners.add(listener)
        return () => { connectionListeners.delete(listener) }
      }, [])
      return select(currentConnectionState)
    },
    useOnboardingSteps: select => select(steps),
    useSections: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return select(current)
    },
    renderSlot,
  }
  const view = render(<SettingsRoot {...props} />)
  const bump = (next: Row[]) => {
    act(() => {
      current = next
      for (const fn of [...listeners]) fn()
    })
  }
  const setConnectionState = (next: typeof currentConnectionState) => {
    act(() => {
      currentConnectionState = next
      for (const fn of [...connectionListeners]) fn()
    })
  }
  return { view, renderSlot, bump, listeners, reconnect, setSectionOrder, setConnectionState }
}

function openPanel() {
  const trigger = screen.getByRole('button', { name: 'Settings' })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

describe('SettingsRoot trigger', () => {
  it('renders the trigger seat content as the accessible name (no aria-label of its own)', () => {
    const { renderSlot } = mount()
    const trigger = screen.getByRole('button', { name: 'Settings' })
    expect(trigger.hasAttribute('aria-label')).toBe(false)
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: true })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings', expanded: true })).toBeTruthy()
  })

  it('hands the rail state to the trigger seat', () => {
    const { renderSlot } = mount({ wide: false })
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: false })
  })

  it('shows outage, retry progress, and a two-second recovery confirmation', () => {
    vi.useFakeTimers()
    const mounted = mount()
    expect(screen.queryByRole('button', { name: 'Disconnected, reconnect now' })).toBeNull()

    mounted.setConnectionState('disconnected')
    const indicator = screen.getByRole('button', { name: 'Disconnected, reconnect now' })
    expect(indicator.textContent).toContain('Disconnected')
    expect(indicator.hasAttribute('title')).toBe(false)
    expect(indicator.querySelector('svg')).toBeTruthy()
    fireEvent.click(indicator)
    expect(mounted.reconnect).toHaveBeenCalledOnce()

    mounted.setConnectionState('connecting')
    expect(screen.getByRole('button', { name: 'Connecting, restart now' }).textContent)
      .toContain('Connecting...')

    mounted.setConnectionState('connected')
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1_999) })
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the reconnect indicator out of the collapsed rail', () => {
    mount({ wide: false, connectionState: 'disconnected' })
    expect(screen.queryByRole('button', { name: 'Disconnected, reconnect now' })).toBeNull()
  })
})

describe('SettingsPanel chrome seats', () => {
  it('names the dialog via aria-labelledby pointing at the header seat node', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    const titleId = dialog.getAttribute('aria-labelledby')!
    expect(titleId).toBeTruthy()
    const title = document.getElementById(titleId)!
    expect(title.textContent).toBe('Settings Title')
    expect(screen.getByRole('dialog', { name: 'Settings Title' })).toBeTruthy()
  })

  it('names the close button through the visually-hidden close seat text', () => {
    mount()
    openPanel()
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.hasAttribute('aria-label')).toBe(false)
    expect(close.textContent).toContain('Close')
  })

  it('renders header actions before the shell-owned close control', () => {
    const { renderSlot } = mount()
    openPanel()
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('settings.action', {})
  })
})

describe('SettingsPanel close paths', () => {
  it('closes via the header button and restores trigger focus', async () => {
    mount()
    const trigger = openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('closes via a mask click and restores trigger focus', async () => {
    mount()
    const trigger = openPanel()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog.parentElement!.firstElementChild!)
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('closes via document-level Escape, restores trigger focus, and unhooks the listener', async () => {
    mount()
    const trigger = openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(document.activeElement).toBe(trigger) })
    // Ignored while closed (listener removed with the panel) and non-Escape
    // keys are ignored while open.
    fireEvent.keyDown(document, { key: 'Escape' })
    openPanel()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('lands focus on the close button when the dialog opens', () => {
    mount()
    openPanel()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })
})

describe('SettingsPanel navigation', () => {
  it('projects rows, marks the first active, and renders only that section', () => {
    mount()
    openPanel()
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('gives every section a nav glyph, distinct for the ids the shell knows', () => {
    mount({
      rows: [
        { id: 'general', order: 0, label: 'General' },
        { id: 'models', order: 10, label: 'Models' },
        { id: 'agent-presets', order: 20, label: 'Agent presets' },
        { id: 'plugins', order: 30, label: 'Plugins' },
        { id: 'contributed', order: 40, label: 'Contributed' },
      ],
    })
    openPanel()
    // Glyphs carry no id of their own, so the drawn paths are what tells them apart.
    const glyphs = ['General', 'Models', 'Agent presets', 'Plugins', 'Contributed']
      .map(name => screen.getByRole('button', { name }).querySelector('svg')?.innerHTML)

    expect(glyphs.every(glyph => glyph !== undefined && glyph !== '')).toBe(true)
    // The three ids the shell names get their own glyph; every other section —
    // including one this package never heard of — shares the gear.
    expect(new Set(glyphs.slice(0, 4)).size).toBe(4)
    expect(glyphs[4]).toBe(glyphs[0])
  })

  it('switches the rendered section on nav click', () => {
    mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
  })

  it('mounts onboarding steps in order and transfers ownership only on completion', () => {
    const { renderSlot } = mount()
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    expect(first?.[1]).toMatchObject({ stepId: 'welcome' })
    expect(first?.[2]).toEqual({ only: 'welcome' })
    act(() => {
      (first?.[1] as { complete: () => void }).complete()
      ;(first?.[1] as { complete: () => void }).complete()
    })
    const onboardingCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding')
    const second = onboardingCalls.at(-1)
    expect(second?.[1]).toMatchObject({ stepId: 'credential' })
    expect(second?.[2]).toEqual({ only: 'credential' })

    act(() => {
      (second?.[1] as { openSection: (id: string) => void }).openSection('models')
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-models')).toBeTruthy()

    cleanup()
    const inactive = mount({ onboardingActive: false }).renderSlot.mock.calls
      .filter(call => call[0] === 'settings.onboarding')
    expect(inactive).toHaveLength(0)
  })

  it('paints no takeover chrome of its own around the mounted step', () => {
    // The chrome (mask, opaque stage, #root inert) belongs to the step via
    // the step-owned dialog surface — a mounted-but-deciding step that
    // renders null must show and block nothing (the reload white-flash fix;
    // onboarding-surface.spec.tsx pins the primitive's half).
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
    const { view } = mount()
    expect(view.container.querySelector('[class*="onboarding"]')).toBeNull()
    expect(document.body.querySelector('[class*="onboarding"]')).toBeNull()
    expect(appRoot.inert).not.toBe(true)
    view.unmount()
    appRoot.remove()
  })

  it('falls back to the first row when the active entry unregisters', () => {
    const { bump } = mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    bump([{ id: 'general', order: 0, label: 'General' }])
    expect(screen.queryByRole('button', { name: 'Models' })).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('renders an empty content column when the ledger is empty', () => {
    const { renderSlot } = mount({ rows: [] })
    openPanel()
    expect(screen.getByRole('dialog')).toBeTruthy()
    const sectionCalls = renderSlot.mock.calls.filter(c => c[0] === 'settings.section')
    expect(sectionCalls).toHaveLength(0)
  })

  it('drops the ledger subscription on unmount', () => {
    const { view, listeners } = mount()
    expect(listeners.size).toBe(1)
    view.unmount()
    expect(listeners.size).toBe(0)
  })
})

describe('SettingsPanel nav reorder', () => {
  /** jsdom has no DataTransfer; the stub satisfies the few fields the handlers touch. */
  const dataTransfer = {
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn(),
    getData: vi.fn(),
  }

  /** Anchor a row's rect so `rowHalf` can resolve the pointer half. */
  function stubRect(el: HTMLElement, top: number, height = 40) {
    el.getBoundingClientRect = () => ({
      top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top,
      toJSON: () => ({}),
    })
  }

  /** jsdom lacks DragEvent — the fireEvent fallback drops clientY, so pin it on the built event. */
  function fireDrag(row: HTMLElement, kind: 'dragOver' | 'drop', clientY: number): void {
    const event = kind === 'dragOver' ? createEvent.dragOver(row) : createEvent.drop(row)
    Object.defineProperty(event, 'clientY', { value: clientY })
    Object.defineProperty(event, 'dataTransfer', { value: { ...dataTransfer } })
    fireEvent(row, event)
  }

  it('makes every nav row draggable and commits the full order on drop', () => {
    const { setSectionOrder } = mount()
    openPanel()
    const general = screen.getByRole('button', { name: 'General' })
    const models = screen.getByRole('button', { name: 'Models' })
    const presets = screen.getByRole('button', { name: 'Agent presets' })
    for (const row of [general, models, presets]) expect(row.getAttribute('draggable')).toBe('true')
    stubRect(models, 100)
    fireEvent.dragStart(general, { dataTransfer })
    // Bottom half of Models: the dragged row lands after it.
    fireDrag(models, 'dragOver', 130)
    expect(models.className).toMatch(/dropAfter/)
    fireDrag(models, 'drop', 130)
    expect(setSectionOrder).toHaveBeenCalledWith(['models', 'general', 'agent-presets'])
  })

  it('inserts before the target on the top half', () => {
    const { setSectionOrder } = mount()
    openPanel()
    const models = screen.getByRole('button', { name: 'Models' })
    const presets = screen.getByRole('button', { name: 'Agent presets' })
    stubRect(models, 100)
    fireEvent.dragStart(presets, { dataTransfer })
    fireDrag(models, 'dragOver', 105)
    expect(models.className).toMatch(/dropBefore/)
    fireDrag(models, 'drop', 105)
    expect(setSectionOrder).toHaveBeenCalledWith(['general', 'agent-presets', 'models'])
  })

  it('skips same-position drops, self-drops, and drops after dragEnd', () => {
    const { setSectionOrder } = mount()
    openPanel()
    const general = screen.getByRole('button', { name: 'General' })
    const models = screen.getByRole('button', { name: 'Models' })
    stubRect(models, 100)
    // Dropping directly before the target row restores the current order: no write.
    fireEvent.dragStart(general, { dataTransfer })
    fireDrag(models, 'dragOver', 105)
    fireDrag(models, 'drop', 105)
    // Self-drag never arms a marker.
    fireEvent.dragStart(models, { dataTransfer })
    fireDrag(models, 'dragOver', 105)
    fireDrag(models, 'drop', 105)
    // dragEnd clears the marker, so a late drop commits nothing.
    fireEvent.dragStart(general, { dataTransfer })
    fireDrag(models, 'dragOver', 105)
    fireEvent.dragEnd(general)
    fireDrag(models, 'drop', 105)
    expect(setSectionOrder).not.toHaveBeenCalled()
  })

  it('ignores drag-over until a drag starts and keeps the marker until it moves', () => {
    mount()
    openPanel()
    const general = screen.getByRole('button', { name: 'General' })
    const models = screen.getByRole('button', { name: 'Models' })
    stubRect(models, 100)
    // No active drag: hover neither arms a marker nor opens a drop target.
    fireDrag(models, 'dragOver', 130)
    expect(models.className).not.toMatch(/dropBefore|dropAfter/)
    fireEvent.dragStart(general, { dataTransfer })
    fireDrag(models, 'dragOver', 130)
    expect(models.className).toMatch(/dropAfter/)
    // The marker only moves when the pointer half changes.
    fireDrag(models, 'dragOver', 130)
    expect(models.className).toMatch(/dropAfter/)
    fireDrag(models, 'dragOver', 105)
    expect(models.className).toMatch(/dropBefore/)
    fireEvent.dragEnd(general)
    expect(models.className).not.toMatch(/dropBefore|dropAfter/)
  })

  it('commits a fast drop from the drop event without a preceding hover commit', () => {
    const { setSectionOrder } = mount()
    openPanel()
    const general = screen.getByRole('button', { name: 'General' })
    const models = screen.getByRole('button', { name: 'Models' })
    stubRect(models, 100)
    // No dragover at all: the drop event itself carries the target and half,
    // so the reorder never depends on React having committed hover state.
    fireEvent.dragStart(general, { dataTransfer })
    fireDrag(models, 'drop', 130)
    expect(setSectionOrder).toHaveBeenCalledWith(['models', 'general', 'agent-presets'])
  })

  it('drops relative to the row the drop event lands on, not the last hovered row', () => {
    const { setSectionOrder } = mount()
    openPanel()
    const general = screen.getByRole('button', { name: 'General' })
    const models = screen.getByRole('button', { name: 'Models' })
    const presets = screen.getByRole('button', { name: 'Agent presets' })
    stubRect(models, 100)
    stubRect(presets, 100)
    // Hover Models first (stale marker), then release over Agent presets:
    // the commit must target the drop row, like a pointer that flicks past
    // one row before the hover commit lands.
    fireEvent.dragStart(general, { dataTransfer })
    fireDrag(models, 'dragOver', 130)
    fireDrag(presets, 'drop', 130)
    expect(setSectionOrder).toHaveBeenCalledWith(['models', 'agent-presets', 'general'])
  })

  it('commits the last hovered position on dragEnd when no drop event fires', () => {
    const { setSectionOrder } = mount()
    openPanel()
    const general = screen.getByRole('button', { name: 'General' })
    const models = screen.getByRole('button', { name: 'Models' })
    stubRect(models, 100)
    // Released outside any row (or the browser suppressed the drop): the
    // dragEnd fallback still commits the row the pointer last hovered.
    fireEvent.dragStart(general, { dataTransfer })
    fireDrag(models, 'dragOver', 130)
    fireEvent.dragEnd(general)
    expect(setSectionOrder).toHaveBeenCalledWith(['models', 'general', 'agent-presets'])
  })

  it('never double-commits a drop on dragEnd, and dragEnd without a hover commits nothing', () => {
    const { setSectionOrder } = mount()
    openPanel()
    const general = screen.getByRole('button', { name: 'General' })
    const models = screen.getByRole('button', { name: 'Models' })
    stubRect(models, 100)
    // Drop commits, then dragEnd must not re-commit the same reorder.
    fireEvent.dragStart(general, { dataTransfer })
    fireDrag(models, 'dragOver', 130)
    fireDrag(models, 'drop', 130)
    fireEvent.dragEnd(general)
    expect(setSectionOrder).toHaveBeenCalledTimes(1)
    expect(setSectionOrder).toHaveBeenCalledWith(['models', 'general', 'agent-presets'])
    // A drag that never hovered a row has nothing to commit.
    fireEvent.dragStart(models, { dataTransfer })
    fireEvent.dragEnd(models)
    // A stray dragEnd without a drag start clears nothing and writes nothing.
    fireEvent.dragEnd(general)
    expect(setSectionOrder).toHaveBeenCalledTimes(1)
  })
})
