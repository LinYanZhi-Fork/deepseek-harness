import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply } from '../src/index.ts'
import { NAV_ORDER_SETTINGS_NAMESPACE } from '../src/nav-settings.ts'

/** Mirrors the module-local namespace id in src/index.ts. */
const ONBOARDING_SETTINGS_NAMESPACE = 'ui-onboarding'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('ui-settings-general host', () => {
  it('registers and disposes the durable onboarding and nav-order namespaces with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(ctx.settings.describe().map(row => row.ns)).toEqual(expect.arrayContaining([
      ONBOARDING_SETTINGS_NAMESPACE,
      NAV_ORDER_SETTINGS_NAMESPACE,
    ]))
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(
      ONBOARDING_SETTINGS_NAMESPACE,
    )
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(
      NAV_ORDER_SETTINGS_NAMESPACE,
    )
  })
})
