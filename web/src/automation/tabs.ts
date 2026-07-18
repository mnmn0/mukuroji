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

/** キー操作後に選択する表示中の Automation 管理 tab を解決します。 */
export function resolveAutomationManagementTabTarget(
  currentTab: AutomationManagementTab,
  key: string,
  visibleTabs: readonly AutomationManagementTab[],
): AutomationManagementTab | undefined {
  const currentIndex = visibleTabs.indexOf(currentTab)
  if (currentIndex < 0 || visibleTabs.length === 0) return undefined

  if (key === 'ArrowRight') {
    return visibleTabs[(currentIndex + 1) % visibleTabs.length]
  }
  if (key === 'ArrowLeft') {
    return visibleTabs[(currentIndex - 1 + visibleTabs.length) % visibleTabs.length]
  }
  if (key === 'Home') {
    return visibleTabs[0]
  }
  if (key === 'End') {
    return visibleTabs.at(-1)
  }

  return undefined
}

/** URL query で受け取った automation tab を安全に解決します。 */
export function readAutomationManagementTab(value: string | null | undefined): AutomationManagementTab {
  return automationManagementTabs.find((tab) => tab === value) ?? 'rules'
}
