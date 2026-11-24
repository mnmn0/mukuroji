import { useMemo, useState } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { useWorkspaceTimePeriodMutations } from '../mutations/useTimePeriodMutations'
import { useWorkspaceTimePeriod } from '../queries/useTimePeriods'
import { previousMonth } from './timePeriodForm'
import { WorkspaceTimePeriodPanel } from './WorkspaceTimePeriodPanel'

/** Props of the Workspace month close view connected to the API. */
export type WorkspaceTimePeriodContainerProps = {
  /** Session access token, or undefined while signed out. */
  accessToken: string | undefined
  /** Display locale. */
  locale: Locale
  /** IANA timezone a new close uses. */
  timeZone: string
  /** Current time, injectable for stories and tests. */
  now?: Date
}

/**
 * Connects the Workspace month close view to the Workspace month close API. The Workspace
 * settings show it to administrators, so it needs no access to any Team.
 *
 * @param props - Session and display settings.
 * @returns Connected Workspace month close view.
 */
export function WorkspaceTimePeriodContainer({ accessToken, locale, now, timeZone }: WorkspaceTimePeriodContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [month, setMonth] = useState(() => previousMonth(now ?? new Date()))
  const workspace = useWorkspaceTimePeriod(accessToken, month, true)
  const mutations = useWorkspaceTimePeriodMutations(accessToken)

  return (
    <WorkspaceTimePeriodPanel
      hasWorkspaceLoadError={Boolean(workspace.error)}
      isWorkspaceLoading={workspace.isLoading}
      onCloseWorkspaceMonth={(selected) => mutations.closeWorkspaceMonth(selected, timeZone)}
      onReopenWorkspaceMonth={(selected, reason) => mutations.reopenWorkspaceMonth(selected, reason)}
      onRetryWorkspace={() => { void workspace.mutate().catch(() => undefined) }}
      onWorkspaceMonthChange={setMonth}
      t={t}
      timeZone={timeZone}
      workspaceMonth={month}
      {...(workspace.data ? { workspaceState: workspace.data } : {})}
    />
  )
}
