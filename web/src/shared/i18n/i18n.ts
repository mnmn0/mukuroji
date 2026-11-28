import type { ArchiveImpactLabels } from '../ui/archive-impact'
import type { SidebarLabels, SidebarNavId } from '../ui/sidebar'
import { enMessages } from './locales/en'
import { jaMessages, type MessageKey } from './locales/ja'

export type { MessageKey } from './locales/ja'

/**
 * ユーザーが選択できる表示言語の一覧です。
 */
export const localeOptions = [
  { locale: 'ja', label: '日本語' },
  { locale: 'en', label: 'English' },
] as const

/**
 * mukuroji がサポートする locale code です。
 */
export type Locale = (typeof localeOptions)[number]['locale']

const storageKey = 'mukuroji.locale'

const dictionaries = {
  ja: jaMessages,
  en: enMessages,
} as const

function resolveLocale(value: string | null | undefined): Locale {
  return value?.toLowerCase().startsWith('en') ? 'en' : 'ja'
}

/**
 * 保存済み設定またはブラウザ言語から初期 locale を解決します。
 */
export function getInitialLocale(): Locale {
  const savedLocale = window.localStorage.getItem(storageKey)

  if (savedLocale) {
    return resolveLocale(savedLocale)
  }

  return resolveLocale(window.navigator.language)
}

/** Listeners notified when the saved locale preference may have changed. */
const localePreferenceListeners = new Set<() => void>()

/**
 * ユーザーが選択した locale をブラウザに保存します。
 */
export function setLocalePreference(locale: Locale) {
  window.localStorage.setItem(storageKey, locale)

  for (const listener of localePreferenceListeners) {
    listener()
  }
}

/**
 * Subscribes to locale preference changes from this tab or another tab.
 *
 * Use with `useSyncExternalStore` and `getInitialLocale` for UI that lives outside the routes
 * that own the locale state.
 *
 * @param listener - Callback invoked when the saved locale may have changed.
 * @returns Unsubscribe function.
 */
export function subscribeToLocalePreference(listener: () => void): () => void {
  /**
   * Forwards cross-tab updates to the saved locale key, including `localStorage.clear()`,
   * which reports a `null` key.
   *
   * @param event - Storage event raised by another tab.
   */
  const handleStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) {
      listener()
    }
  }

  localePreferenceListeners.add(listener)
  window.addEventListener('storage', handleStorage)

  return () => {
    localePreferenceListeners.delete(listener)
    window.removeEventListener('storage', handleStorage)
  }
}

/**
 * 指定 locale の翻訳関数を生成します。
 */
export function createTranslator(locale: Locale) {
  return (key: MessageKey) => dictionaries[locale][key]
}

/**
 * Creates the localized labels consumed by the shared sidebar.
 *
 * @param locale - Locale used to resolve every sidebar message.
 * @returns A complete set of localized sidebar labels.
 */
export function createSidebarLabels(locale: Locale): SidebarLabels {
  const t = createTranslator(locale)
  const navKeyMap: Record<SidebarNavId, MessageKey> = {
    home: 'sidebar.nav.home',
    focus: 'sidebar.nav.focus',
    updates: 'sidebar.nav.updates',
    'my-tasks': 'sidebar.nav.myTasks',
    'work-items': 'sidebar.nav.workItems',
    inbox: 'sidebar.nav.inbox',
    reviews: 'sidebar.nav.reviews',
    requests: 'sidebar.nav.requests',
    customers: 'sidebar.nav.customers',
    collections: 'sidebar.nav.collections',
    documents: 'sidebar.nav.documents',
    dashboard: 'sidebar.nav.dashboard',
    planning: 'sidebar.nav.planning',
    reports: 'sidebar.nav.reports',
    help: 'sidebar.nav.help',
    settings: 'sidebar.nav.settings',
  }

  return {
    ariaLabel: t('sidebar.aria'),
    globalNavigation: t('sidebar.globalNavigation'),
    utilityNavigation: t('sidebar.utilityNavigation'),
    collapse: t('sidebar.collapse'),
    expand: t('sidebar.expand'),
    search: t('sidebar.search'),
    searchShortcut: t('sidebar.searchShortcut'),
    quickAccess: t('sidebar.quickAccess'),
    manageQuickAccess: t('sidebar.manageQuickAccess'),
    quickAccessEmpty: t('sidebar.quickAccessEmpty'),
    showAllQuickAccess: t('sidebar.showAllQuickAccess'),
    quickAccessDialogTitle: t('sidebar.quickAccessDialogTitle'),
    quickAccessDialogDescription: t('sidebar.quickAccessDialogDescription'),
    closeQuickAccessDialog: t('sidebar.closeQuickAccessDialog'),
    moveQuickAccessUp: t('sidebar.moveQuickAccessUp'),
    moveQuickAccessDown: t('sidebar.moveQuickAccessDown'),
    removeQuickAccess: t('sidebar.removeQuickAccess'),
    currentTeam: t('sidebar.currentTeam'),
    switchTeam: t('sidebar.switchTeam'),
    searchTeams: t('sidebar.searchTeams'),
    noTeamsFound: t('sidebar.noTeamsFound'),
    more: t('sidebar.more'),
    allProjects: t('sidebar.allProjects'),
    teamProjects: t('sidebar.teamProjects'),
    createTeam: t('sidebar.createTeam'),
    create: {
      title: t('workspace.registration.title'),
      close: t('workspace.registration.close'),
      teamMode: t('workspace.registration.teamMode'),
      projectMode: t('workspace.registration.projectMode'),
      teamName: t('workspace.registration.teamName'),
      teamPlaceholder: t('workspace.registration.teamPlaceholder'),
      projectName: t('workspace.registration.projectName'),
      projectPlaceholder: t('workspace.registration.projectPlaceholder'),
      team: t('workspace.registration.team'),
      tone: t('workspace.registration.tone'),
      toneLabels: {
        blue: t('workspace.registration.tone.blue'),
        purple: t('workspace.registration.tone.purple'),
        green: t('workspace.registration.tone.green'),
        yellow: t('workspace.registration.tone.yellow'),
      },
      lifecycle: t('workspace.registration.lifecycle'),
      lifecycleLabels: {
        proposed: t('projects.lifecycle.proposed'),
        approved: t('projects.lifecycle.approved'),
        active: t('projects.lifecycle.active'),
      },
      createTeam: t('workspace.registration.createTeam'),
      createProject: t('workspace.registration.createProject'),
      saving: t('workspace.registration.saving'),
      teamNameRequired: t('workspace.registration.teamNameRequired'),
      projectNameRequired: t('workspace.registration.projectNameRequired'),
      error: t('workspace.registration.error'),
      loadingError: t('projects.error.loading'),
      noTeams: t('workspace.registration.noTeams'),
    },
    archive: {
      team: (name) => t('sidebar.archive.team').replace('{name}', name),
      project: (name) => t('sidebar.archive.project').replace('{name}', name),
      archiving: t('sidebar.archive.archiving'),
      error: t('sidebar.archive.error'),
      confirmTitle: t('sidebar.archive.confirmTitle'),
      confirmTeamDescription: (name) =>
        t('sidebar.archive.confirmTeamDescription').replace('{name}', name),
      confirmProjectDescription: (name) =>
        t('sidebar.archive.confirmProjectDescription').replace('{name}', name),
      cancel: t('sidebar.archive.cancel'),
      confirm: t('sidebar.archive.confirm'),
      impact: createArchiveImpactLabels(t),
    },
    teamOverview: t('sidebar.teamOverview'),
    triage: t('sidebar.triage'),
    factoryBoard: t('sidebar.factoryBoard'),
    timeTracking: t('sidebar.timeTracking'),
    issues: t('sidebar.issues'),
    members: t('sidebar.members'),
    projectCount: (count) =>
      t('sidebar.projectCount').replace('{count}', String(count)),
    projectGroup: t('sidebar.projectGroup'),
    unreadCount: (count) =>
      t('sidebar.unreadCount').replace('{count}', String(count)),
    nav: {
      home: t(navKeyMap.home),
      focus: t(navKeyMap.focus),
      updates: t(navKeyMap.updates),
      'my-tasks': t(navKeyMap['my-tasks']),
      'work-items': t(navKeyMap['work-items']),
      inbox: t(navKeyMap.inbox),
      reviews: t(navKeyMap.reviews),
      requests: t(navKeyMap.requests),
      customers: t(navKeyMap.customers),
      collections: t(navKeyMap.collections),
      documents: t(navKeyMap.documents),
      dashboard: t(navKeyMap.dashboard),
      planning: t(navKeyMap.planning),
      reports: t(navKeyMap.reports),
      help: t(navKeyMap.help),
      settings: t(navKeyMap.settings),
    },
  }
}

/**
 * Builds the labels of the Team and Project archive impact notice.
 *
 * @param t - Translator of the current locale.
 * @returns Labels with counts formatted for the locale.
 */
export function createArchiveImpactLabels(t: (key: MessageKey) => string): ArchiveImpactLabels {
  const line = (key: MessageKey) => (count: string) => t(key).replace('{count}', count)

  return {
    loading: t('archiveImpact.loading'),
    loadError: t('archiveImpact.loadError'),
    title: t('archiveImpact.title'),
    none: t('archiveImpact.none'),
    blocked: t('archiveImpact.blocked'),
    blockedByDependencyLimit: t('archiveImpact.blockedByDependencyLimit'),
    warning: t('archiveImpact.warning'),
    count: ({ count, hasMore }) =>
      t(hasMore ? 'archiveImpact.countAtLeast' : 'archiveImpact.count')
        .replace('{count}', count.toLocaleString()),
    openWorkItems: line('archiveImpact.openWorkItems'),
    activeAgentRuns: line('archiveImpact.activeAgentRuns'),
    planningEntities: line('archiveImpact.planningEntities'),
    planningWorkItemLinks: line('archiveImpact.planningWorkItemLinks'),
    planningDependencies: line('archiveImpact.planningDependencies'),
    webhookSubscriptions: line('archiveImpact.webhookSubscriptions'),
  }
}
