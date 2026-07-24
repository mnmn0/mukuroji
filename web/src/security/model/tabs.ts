import type { EnterpriseSecuritySnapshot } from '../api'

/**
 * Enterprise identity と security policy の管理画面で選択できる tab です。
 */
export const enterpriseSecurityTabs = [
  'overview',
  'identity',
  'provisioning',
  'access',
  'sessions',
  'privileged',
] as const

/**
 * Enterprise identity と security policy の管理画面で選択できる tab です。
 */
export type EnterpriseSecurityTab = (typeof enterpriseSecurityTabs)[number]

/**
 * Resolves the tabs visible under the current capability boundary.
 *
 * @param capabilities - Enterprise security capabilities, when loaded.
 * @returns Visible tabs in their stable keyboard-navigation order.
 */
export function resolveVisibleEnterpriseSecurityTabs(
  capabilities: EnterpriseSecuritySnapshot['capabilities'] | undefined,
): EnterpriseSecurityTab[] {
  if (!capabilities) {
    return ['overview']
  }

  return enterpriseSecurityTabs.filter((tab) => {
    if (tab === 'overview') {
      return true
    }

    if (tab === 'identity') {
      return capabilities.canViewIdentity
    }

    if (tab === 'provisioning') {
      return capabilities.canViewProvisioning
    }

    if (tab === 'access') {
      return capabilities.canViewAccess
    }

    if (tab === 'sessions') {
      return capabilities.canViewSessions
    }

    return capabilities.canViewPrivileged
  })
}

/**
 * Falls back to overview when a requested tab is outside the capability boundary.
 *
 * @param requestedTab - Tab requested by the route or caller.
 * @param capabilities - Enterprise security capabilities, when loaded.
 * @returns The requested visible tab or overview.
 */
export function resolveVisibleEnterpriseSecurityTab(
  requestedTab: EnterpriseSecurityTab,
  capabilities: EnterpriseSecuritySnapshot['capabilities'] | undefined,
): EnterpriseSecurityTab {
  const visibleTabs = resolveVisibleEnterpriseSecurityTabs(capabilities)

  return visibleTabs.includes(requestedTab) ? requestedTab : 'overview'
}

/**
 * URL query で受け取った Enterprise security tab を安全に解決します。
 *
 * @param value - `securityTab` query の値です。
 * @returns 対応する tab。未対応値では overview です。
 */
export function readEnterpriseSecurityTab(
  value: string | null | undefined,
): EnterpriseSecurityTab {
  return enterpriseSecurityTabs.find((tab) => tab === value) ?? 'overview'
}

/**
 * Arrow / Home / End key で移動する Enterprise security tab を返します。
 *
 * @param currentTab - 現在 focus されている tab です。
 * @param key - Keyboard event の key です。
 * @param visibleTabs - 権限に応じて表示中の tab です。
 * @returns キーに対応する tab。対象外の key では undefined です。
 */
export function resolveEnterpriseSecurityTabTarget(
  currentTab: EnterpriseSecurityTab,
  key: string,
  visibleTabs: readonly EnterpriseSecurityTab[],
): EnterpriseSecurityTab | undefined {
  const currentIndex = visibleTabs.indexOf(currentTab)

  if (currentIndex < 0 || visibleTabs.length === 0) {
    return undefined
  }

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
