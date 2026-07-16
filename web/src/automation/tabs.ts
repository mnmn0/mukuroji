/** Automation 管理画面で選択できる tab です。 */
export const automationManagementTabs = [
  'rules',
  'webhooks',
  'templates',
  'recurring',
  'runs',
] as const

/** Automation 管理画面で選択できる tab です。 */
export type AutomationManagementTab = (typeof automationManagementTabs)[number]

/** URL query で受け取った automation tab を安全に解決します。 */
export function readAutomationManagementTab(value: string | null | undefined): AutomationManagementTab {
  return automationManagementTabs.find((tab) => tab === value) ?? 'rules'
}
