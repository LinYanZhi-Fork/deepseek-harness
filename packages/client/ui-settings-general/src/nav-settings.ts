/** User-ordered settings-section navigation stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the settings shell (ui-settings-general). */
export const NAV_ORDER_SETTINGS_NAMESPACE = 'ui-settings-nav'

/** Field carrying the user-ordered settings-section id list. */
export const NAV_ORDER_FIELD = 'order'

/** Durable nav-order section shared by the Host schema and the browser scope. */
export interface SettingsNavOrder {
  /**
   * Section ids in the user's preferred navigation order. Sections absent from
   * this list keep their plugin-declared `order` and render after the listed
   * ones, so new registrants never displace a pinned position.
   */
  order: string[]
}

/** Durable nav-order schema; also the wire envelope the browser scope validates against. */
export const SettingsNavOrderSchema: z<SettingsNavOrder> = z.object({
  [NAV_ORDER_FIELD]: z.array(z.string()).default([]),
})
