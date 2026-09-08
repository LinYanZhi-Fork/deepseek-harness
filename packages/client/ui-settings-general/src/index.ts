/** Host loader entry for the browser implementation exported from `./client`. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import {
  NAV_ORDER_SETTINGS_NAMESPACE, SettingsNavOrderSchema,
} from './nav-settings.ts'

export {
  NAV_ORDER_FIELD, NAV_ORDER_SETTINGS_NAMESPACE, SettingsNavOrderSchema,
  type SettingsNavOrder,
} from './nav-settings.ts'

/** Durable settings namespace for product-wide GUI onboarding facts. */
const ONBOARDING_SETTINGS_NAMESPACE = 'ui-onboarding'

interface OnboardingSettings {
  /** Last version acknowledged by the current product welcome step. */
  welcomeNoticeVersion?: string
}

const OnboardingSettingsSchema: z<OnboardingSettings> = z.object({
  welcomeNoticeVersion: z.string(),
})

/** Register the durable GUI-onboarding and nav-order sections when a settings provider exists. */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      ONBOARDING_SETTINGS_NAMESPACE,
      OnboardingSettingsSchema,
    )
    settingsCtx.settings.register(
      NAV_ORDER_SETTINGS_NAMESPACE,
      SettingsNavOrderSchema,
    )
  })
}
