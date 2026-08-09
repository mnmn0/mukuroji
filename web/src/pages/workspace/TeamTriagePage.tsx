import { useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { createTranslator } from '../../shared/i18n/i18n'
import { TriageApiError } from '../../triage/api'
import { useTriageMutations } from '../../triage/mutations/useTriageMutations'
import {
  createTriageSearchParams,
  readTriageRouteState,
  type TriageRouteView,
} from '../../triage/model/queryState'
import {
  countTriageEntryViews,
  createTriageEntryView,
  filterTriageEntryViews,
} from '../../triage/model/triageView'
import {
  useTriageEntry,
  useTriageQueue,
  useTriageSettings,
} from '../../triage/queries/useTriageQueries'
import { TriageWorkbench } from '../../triage/ui/TriageWorkbench'
import { WorkspaceRouteContent } from '../../workspace/ui/WorkspaceRoute'
import { useWorkspaceRouteContext } from '../../workspace/ui/WorkspaceRouteProvider'

/**
 * Renders one Team's shared multi-source triage queue and configuration surface.
 *
 * @returns Team triage content inside the persistent Workspace shell.
 */
export function TeamTriagePage() {
  const workspace = useWorkspaceRouteContext()
  const params = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedEntryIds, setSelectedEntryIds] = useState<readonly string[]>([])
  const teamId = params.teamId
  const activeTeam = workspace.teams.find((team) => team.id === teamId)
  const routeState = useMemo(() => readTriageRouteState(searchParams), [searchParams])
  const t = useMemo(() => createTranslator(workspace.locale), [workspace.locale])
  const queue = useTriageQueue(
    workspace.accessToken,
    teamId,
    routeState.filters,
    workspace.canLoadWorkspaceData && Boolean(activeTeam) && routeState.view === 'queue',
  )
  const loadedEntries = useMemo(() => Array.from(new Map(
    (queue.data ?? [])
      .flatMap((page) => page.entries)
      .map((entry) => [entry.id, entry]),
  ).values()), [queue.data])
  const entryViews = useMemo(() => filterTriageEntryViews(
    loadedEntries,
    routeState.filters,
    workspace.userIdentityAliases,
  ), [loadedEntries, routeState.filters, workspace.userIdentityAliases])
  const selectedEntryId = routeState.entryId ?? entryViews[0]?.entry.id
  const detail = useTriageEntry(
    workspace.accessToken,
    teamId,
    selectedEntryId,
    workspace.canLoadWorkspaceData && Boolean(activeTeam) && routeState.view === 'queue',
  )
  const selectedEntry = detail.data ? createTriageEntryView(detail.data) : undefined
  const settings = useTriageSettings(
    workspace.accessToken,
    teamId,
    workspace.canLoadWorkspaceData && Boolean(activeTeam) && routeState.view === 'settings',
  )
  const mutation = useTriageMutations({
    accessToken: workspace.accessToken,
    refreshEntry: () => detail.mutate(),
    refreshQueue: () => queue.mutate(),
    refreshSettings: () => settings.mutate(),
    teamId,
    updateEntry: (entry) => detail.mutate(entry, { revalidate: false }),
    updateSettings: (configuration) => settings.mutate(configuration, { revalidate: false }),
  })
  const lastQueuePage = queue.data?.at(-1)
  const allowedBulkActions = queue.data?.[0]?.allowedBulkActions ?? []
  const isLoadingMore = Boolean(
    queue.data && queue.data.length < queue.size && queue.isValidating,
  )
  const queueErrorMessage = queue.error
    ? t('triage.queue.error')
    : undefined
  const detailErrorMessage = mutation.error
    ? readMutationErrorMessage(mutation.error, t)
    : detail.error
      ? t('triage.detail.error')
      : undefined
  const configurationErrorMessage = settings.error || (
    mutation.error && routeState.view === 'settings'
  )
    ? readConfigurationErrorMessage(settings.error ?? mutation.error, t)
    : undefined

  const replaceRouteState = (
    nextView: TriageRouteView,
    entryId: string | null = routeState.entryId ?? null,
    filters = routeState.filters,
  ) => {
    setSearchParams(createTriageSearchParams({
      filters,
      view: nextView,
      ...(entryId && nextView === 'queue' ? { entryId } : {}),
    }), { replace: true })
  }

  return (
    <WorkspaceRouteContent
      sessionErrors={[
        queue.error,
        detail.error,
        settings.error,
        mutation.error,
      ]}
    >
      <TriageWorkbench
        allowedBulkActions={allowedBulkActions}
        bulkResults={mutation.bulkResults}
        canManageConfiguration={workspace.canMutateTeamConfiguration}
        configuration={settings.data}
        configurationErrorMessage={configurationErrorMessage}
        counts={countTriageEntryViews(entryViews)}
        detailErrorMessage={detailErrorMessage}
        didSaveConfiguration={mutation.didSaveSettings}
        entries={entryViews}
        explicitEntryId={routeState.entryId}
        filters={routeState.filters}
        hasMore={Boolean(lastQueuePage?.nextCursor)}
        isBulkPending={mutation.isBulkPending}
        isConfigurationLoading={settings.isLoading}
        isDetailLoading={Boolean(selectedEntryId && detail.isLoading)}
        isQueueLoading={queue.isLoading}
        isQueueLoadingMore={isLoadingMore}
        isQueuePermissionDenied={queue.error instanceof TriageApiError && queue.error.status === 403}
        isSavingConfiguration={mutation.isSavingSettings}
        locale={workspace.locale}
        pendingEntryId={mutation.pendingEntryId}
        queueErrorMessage={queueErrorMessage}
        routeView={routeState.view}
        selectedEntry={selectedEntry}
        selectedEntryIds={selectedEntryIds}
        t={t}
        teamName={activeTeam?.name ?? t('workspace.team.missing')}
        onAction={mutation.applyAction}
        onBackToQueue={() => replaceRouteState('queue', null)}
        onBulkAction={mutation.applyBulkAction}
        onClearSelection={() => {
          setSelectedEntryIds([])
          mutation.clearFeedback()
        }}
        onEntrySelectionChange={(entryId, selected) => setSelectedEntryIds((current) =>
          selected
            ? current.includes(entryId) ? current : [...current, entryId]
            : current.filter((candidate) => candidate !== entryId)
        )}
        onFiltersChange={(filters) => {
          setSelectedEntryIds([])
          mutation.clearFeedback()
          replaceRouteState('queue', null, filters)
        }}
        onLoadMore={() => void queue.setSize(queue.size + 1)}
        onRetryConfiguration={() => void settings.mutate()}
        onRetryDetail={() => void detail.mutate()}
        onRetryQueue={() => void queue.mutate()}
        onSaveConfiguration={mutation.saveSettings}
        onSelectEntry={(entryId) => replaceRouteState('queue', entryId)}
        onViewChange={(view) => {
          mutation.clearFeedback()
          replaceRouteState(view, view === 'queue' ? routeState.entryId ?? null : null)
        }}
        onVisibleSelectionChange={(entryIds, selected) => setSelectedEntryIds((current) => {
          const next = new Set(current)
          for (const entryId of entryIds) {
            if (selected) next.add(entryId)
            else next.delete(entryId)
          }
          return [...next]
        })}
      />
    </WorkspaceRouteContent>
  )
}

/** Maps a triage mutation failure to permission-safe localized feedback. */
function readMutationErrorMessage(
  error: unknown,
  t: ReturnType<typeof createTranslator>,
) {
  if (error instanceof TriageApiError && error.status === 409) {
    return t('triage.action.conflict')
  }
  if (error instanceof TriageApiError && error.status === 403) {
    return t('triage.action.permissionDenied')
  }
  return t('triage.action.error')
}

/** Maps a settings load or save failure to localized recovery guidance.
 *
 * @param error The unknown API or transport failure.
 * @param t The active locale translator.
 * @returns A permission-safe localized message.
 */
function readConfigurationErrorMessage(
  error: unknown,
  t: ReturnType<typeof createTranslator>,
) {
  if (error instanceof TriageApiError && error.status === 409) {
    return t('triage.settings.conflict')
  }
  if (error instanceof TriageApiError && error.status === 403) {
    return t('triage.action.permissionDenied')
  }
  return t('triage.settings.saveError')
}
