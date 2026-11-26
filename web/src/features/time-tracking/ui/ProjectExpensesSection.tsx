import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { toLocalDateKey } from '../model/timePeriod'
import { useProjectExpenseMutations } from '../mutations/useProjectExpenseMutations'
import { useProjectExpenses } from '../queries/useProjectExpenses'
import type { Locale } from '../../../shared/i18n/i18n'
import { ProjectExpensesPanel } from './ProjectExpensesPanel'
import type { TimeTrackingTranslator } from './timeTrackingText'

/** Props of {@link ProjectExpensesSection}. */
export type ProjectExpensesSectionProps = {
  /** Cognito access token. */
  accessToken?: string
  /** Team that owns the Project. */
  teamId: string
  /** Project identifier. */
  projectId: string
  /** Display locale. */
  locale: Locale
  /** Translator. */
  t: TimeTrackingTranslator
  /** Currency the form starts with: the budget currency, else the Workspace default. */
  defaultCurrency: string
  /** Whether loading is allowed for the current session. */
  enabled: boolean
}

/**
 * Connects the Project expenses panel to its API. Expenses are for Project managers only, so a
 * 403 or 404 hides the section instead of showing an error.
 *
 * @param props - Session, Project identity, and form defaults.
 * @returns The section, or nothing for a viewer who may not read it.
 */
export function ProjectExpensesSection({ accessToken, defaultCurrency, enabled, locale, projectId, t, teamId }: ProjectExpensesSectionProps) {
  const list = useProjectExpenses(accessToken, teamId, projectId, enabled)
  const mutations = useProjectExpenseMutations(accessToken, teamId, projectId)
  if (list.error instanceof TimeTrackingApiError && (list.error.status === 403 || list.error.status === 404)) return null
  return (
    <ProjectExpensesPanel
      defaultCurrency={defaultCurrency}
      hasLoadError={Boolean(list.error)}
      isLoading={list.isLoading}
      locale={locale}
      onDecide={mutations.decide}
      onDelete={mutations.remove}
      onRetry={() => { void list.mutate().catch(() => undefined) }}
      onSubmit={mutations.submit}
      t={t}
      today={toLocalDateKey(new Date())}
      {...(list.data ? { expenses: list.data.expenses, viewerMemberId: list.data.viewerMemberId } : {})}
    />
  )
}
