import {
  type CreateSavedTaskViewInput,
  type SavedTaskView,
  type SavedTaskViewCapabilities,
  type TaskViewDefinition,
  type TaskViewLayoutMode,
  type TaskViewMigrationWarning,
  type TaskViewScope,
  type TaskViewSurface,
  type TaskViewUrlOverride,
  type TaskViewWorkflowStatusFilter,
  type UpdateSavedTaskViewInput,
} from '@mukuroji/contracts'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import {
  createSavedTaskView,
  deleteSavedTaskView,
  duplicateSavedTaskView,
  updateSavedTaskView,
} from '../api/savedTaskViews'
import {
  deduplicateTaskViewMigrationWarnings,
  hasTaskViewUrlOverride,
  resolveTaskViewDefinition,
  sanitizeTaskViewDefinition,
} from '../model/taskViewDefinition'
import { createTaskViewUrlOverride } from '../model/taskViewSurfaceState'
import {
  createTaskViewUrlStateFingerprint,
  parseTaskViewUrlState,
  updateTaskViewUrlState,
} from '../model/taskViewUrlState'
import { useSavedTaskViews } from '../queries/useSavedTaskViews'

/** Reserved URL identifier that explicitly selects the built-in route definition. */
export const BUILT_IN_TASK_VIEW_ID = '__built-in__'

const emptySavedTaskViews: SavedTaskView[] = []
const deniedSavedTaskViewCapabilities = {
  canManageSharedViews: false,
  canSetTeamDefault: false,
  canWrite: false,
  writableProjectScopes: [],
  writableTeamIds: [],
} satisfies SavedTaskViewCapabilities

/** Current surface capabilities used for client-side migration and fallback. */
export type TaskViewControllerCapabilities = {
  /** Column field identifiers visible to the current viewer. */
  columns: readonly string[]
  /** Field identifiers available for grouping, sorting, and filters. */
  fields: readonly string[]
  /** Layout modes implemented by the consuming surface. */
  layoutModes: readonly TaskViewLayoutMode[]
  /** Legacy status identifiers visible to a single-Team surface. */
  legacyStatusIds?: readonly string[]
  /** Columns that must remain visible after migration. */
  requiredColumns?: readonly string[]
  /** Team-qualified workflow statuses visible to the current viewer. */
  workflowStatuses: readonly TaskViewWorkflowStatusFilter[]
}

/** Input used to compose saved-view data, URL state, and lifecycle mutations. */
export type UseTaskViewControllerInput = {
  /** Bearer token used by saved task-view endpoints. */
  accessToken?: string
  /** Permission-safe built-in definition for the current route. */
  builtInDefinition: TaskViewDefinition
  /** Current surface fields, layouts, and status references. */
  capabilities: TaskViewControllerCapabilities
  /** Whether authenticated saved-view loading is enabled. */
  enabled?: boolean
  /** Commits canonical route parameters while the page owns navigation options. */
  onSearchParamsChange: (searchParams: URLSearchParams) => void
  /** Current route query parameters, including unrelated deep-link state. */
  searchParams: URLSearchParams
  /** Route and authorization scope for the consuming surface. */
  scope: TaskViewScope
  /** Product surface consuming the task-view definition. */
  surface: TaskViewSurface
}

/** Result returned by the shared task-view controller. */
export type TaskViewController = {
  /** Saved view currently supplying the effective base, including a default view. */
  activeSavedView?: SavedTaskView
  /** Definition before temporary URL overrides. */
  baselineDefinition: TaskViewDefinition
  /** Whether the server authorizes Workspace-shared task-view management in this scope. */
  canManageShared: boolean
  /** Whether the server authorizes assigning a Team default in this scope. */
  canSetTeamDefault: boolean
  /** Whether the server authorizes task-view lifecycle mutations in this scope. */
  canWrite: boolean
  /** Copies the current canonical route as a permalink. */
  copyPermalink: () => Promise<void>
  /** Deletes one revision-bound saved view. */
  deleteView: (viewId: string) => Promise<void>
  /** Duplicates one accessible saved view through the lifecycle API. */
  duplicateView: (viewId: string) => Promise<void>
  /** Permission-safe effective definition after URL overrides and migration. */
  effectiveDefinition: TaskViewDefinition
  /** Current saved-view loading or mutation error. */
  errorMessage?: string
  /** Whether temporary URL state differs from the selected base. */
  isDirty: boolean
  /** Whether saved views are loading. */
  isLoading: boolean
  /** Whether a lifecycle mutation is running. */
  isSaving: boolean
  /** URL, storage, permission, and capability migration notices. */
  migrationWarnings: readonly TaskViewMigrationWarning[]
  /** Changes favorite, pin, personal-default, or Team-default state. */
  patchPreference: (
    viewId: string,
    patch: TaskViewPreferenceMutation,
  ) => Promise<void>
  /** Clears temporary URL overrides while retaining the active base. */
  resetOverrides: () => void
  /** Persists the effective definition as a new saved view. */
  saveAs: (input: TaskViewSaveMutation) => Promise<void>
  /** Selects a saved view or the explicit built-in fallback. */
  selectView: (viewId?: string) => void
  /** Layers a complete next effective definition over the current base in the URL. */
  setEffectiveDefinition: (definition: TaskViewDefinition) => void
  /** Updates the active editable saved definition with current temporary changes. */
  updateActiveView: () => Promise<void>
  /** Saved views visible for the current surface and scope. */
  views: readonly SavedTaskView[]
  /** Server-authoritative Team-qualified Project scopes where Work Items may be mutated. */
  writableProjectScopes: SavedTaskViewCapabilities['writableProjectScopes']
  /** Server-authoritative Team scopes for unassigned Work Item mutation and Team-view audiences. */
  writableTeamIds: readonly string[]
}

/** Preference mutation accepted by task-view lifecycle UI. */
export type TaskViewPreferenceMutation = {
  /** Next favorite preference. */
  favorite?: boolean
  /** Whether to make this view the personal default. */
  isDefault?: boolean
  /** Whether to make this view the Team default. */
  isTeamDefault?: boolean
  /** Next pin preference. */
  pinned?: boolean
}

/** New-view metadata supplied by the save sheet. */
export type TaskViewSaveMutation = {
  /** Optional human-readable description. */
  description?: string
  /** Human-readable view name. */
  name: string
  /** Team receiving a Team-visible view. */
  teamId?: string
  /** Sharing boundary of the new view. */
  visibility: CreateSavedTaskViewInput['visibility']
}

/** Cache change that appends a newly created or duplicated saved view. */
type AppendSavedTaskViewCacheChange = {
  /** Reconciliation discriminator. */
  type: 'append'
  /** Canonical mutation response to append or replace by identifier. */
  view: SavedTaskView
}

/** Cache change that replaces an updated saved view. */
type ReplaceSavedTaskViewCacheChange = {
  /** Reconciliation discriminator. */
  type: 'replace'
  /** Canonical mutation response to replace or insert by identifier. */
  view: SavedTaskView
}

/** Cache change that removes a deleted saved view. */
type RemoveSavedTaskViewCacheChange = {
  /** Reconciliation discriminator. */
  type: 'remove'
  /** Identifier acknowledged by the delete endpoint. */
  viewId: string
}

/** Canonical cache transition produced by one acknowledged saved-view mutation. */
export type SavedTaskViewCacheChange =
  | AppendSavedTaskViewCacheChange
  | ReplaceSavedTaskViewCacheChange
  | RemoveSavedTaskViewCacheChange

/**
 * Reconciles one acknowledged mutation response into the saved-view collection.
 *
 * Append and replace changes both avoid duplicate identifiers. A replace response is inserted when
 * the prior cache was incomplete, while a missing removal preserves the original collection.
 *
 * @param views - Current permission-filtered saved-view cache.
 * @param change - Canonical append, replace, or remove transition.
 * @returns Reconciled collection suitable for publishing before revalidation.
 */
export function reconcileSavedTaskViews(
  views: readonly SavedTaskView[],
  change: SavedTaskViewCacheChange,
): SavedTaskView[] {
  const reconciledViews = change.type === 'remove'
    ? views.filter((view) => view.id !== change.viewId)
    : (() => {
        const existingIndex = views.findIndex((view) => view.id === change.view.id)
        if (existingIndex < 0) return [...views, change.view]
        return views.map((view, index) => index === existingIndex ? change.view : view)
      })()
  return reconcileSavedTaskViewDefaults(reconciledViews, change)
}

/**
 * Recomputes effective personal and Team defaults after one local cache transition.
 *
 * The mutation response is authoritative for its target. All other cached rows are normalized so
 * an old default cannot remain effective after the server has moved or removed that default.
 *
 * @param views - Saved views after applying the identifier-level cache transition.
 * @param change - Mutation that produced the transition.
 * @returns Views with mutually consistent default metadata.
 */
function reconcileSavedTaskViewDefaults(
  views: readonly SavedTaskView[],
  change: SavedTaskViewCacheChange,
): SavedTaskView[] {
  const changedView = change.type === 'remove' ? undefined : change.view
  const personalDefaultId = changedView?.preference.isPersonalDefault
    ? changedView.id
    : views.find((view) => view.preference.isPersonalDefault)?.id
  const teamDefaultId = changedView?.preference.isTeamDefault
    ? changedView.id
    : views.find((view) => view.preference.isTeamDefault)?.id

  return views.map((view) => {
    const isPersonalDefault = view.id === personalDefaultId
    const isTeamDefault = view.id === teamDefaultId
    const isDefault = isPersonalDefault || (!personalDefaultId && isTeamDefault)
    const defaultSource: SavedTaskView['preference']['defaultSource'] = isPersonalDefault
      ? 'personal'
      : isDefault && isTeamDefault
        ? 'team'
        : undefined
    const preference = { ...view.preference }
    delete preference.defaultSource
    return {
      ...view,
      preference: {
        ...preference,
        isDefault,
        isPersonalDefault,
        isTeamDefault,
        ...(defaultSource ? { defaultSource } : {}),
      },
    }
  })
}

/**
 * Publishes one acknowledged mutation response locally before attempting server revalidation.
 *
 * Cache publication and revalidation failures are converted into warnings so an API success is not
 * reported as a failed mutation. Revalidation still runs when local cache publication fails.
 *
 * @param change - Canonical cache transition derived from the mutation response.
 * @param updateCache - Publishes a functional collection update without revalidation.
 * @param refresh - Revalidates the saved-view collection from the server.
 * @returns A combined non-fatal warning when either cache operation fails.
 */
export async function publishSavedTaskViewMutationResult(
  change: SavedTaskViewCacheChange,
  updateCache: (
    update: (views: readonly SavedTaskView[]) => SavedTaskView[],
  ) => Promise<unknown>,
  refresh: () => Promise<unknown>,
): Promise<string | undefined> {
  let cacheUpdateErrorMessage: string | undefined
  try {
    await updateCache((views) => reconcileSavedTaskViews(views, change))
  } catch (error) {
    cacheUpdateErrorMessage = error instanceof Error
      ? `The task view change was saved, but the local list could not be updated: ${error.message}`
      : 'The task view change was saved, but the local list could not be updated.'
  }

  const refreshErrorMessage = await refreshSavedTaskViewsAfterMutation(refresh)
  const warningMessage = [cacheUpdateErrorMessage, refreshErrorMessage]
    .filter((message) => message !== undefined)
    .join(' ')
  return warningMessage || undefined
}

/**
 * Refreshes saved views after an acknowledged mutation without converting success into failure.
 *
 * @param refresh - Cache revalidation triggered after the mutation response is accepted.
 * @returns A safe warning message when revalidation fails, otherwise undefined.
 */
export async function refreshSavedTaskViewsAfterMutation(
  refresh: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await refresh()
    return undefined
  } catch (error) {
    return error instanceof Error
      ? `The task view change was saved, but the list could not be refreshed: ${error.message}`
      : 'The task view change was saved, but the list could not be refreshed.'
  }
}

/**
 * Resolves saved/default/URL task-view state and exposes one canonical lifecycle controller.
 *
 * @param input - Route identity, current capabilities, auth, and URL ownership callbacks.
 * @returns Effective definition, lifecycle state, and deterministic mutations.
 */
export function useTaskViewController(
  input: UseTaskViewControllerInput,
): TaskViewController {
  const [mutationRunner] = useState(() => createMutationRequestRunner())
  const [isSaving, setIsSaving] = useState(false)
  const [mutationErrorMessage, setMutationErrorMessage] = useState<string>()
  const latestUrlInputRef = useRef({
    onSearchParamsChange: input.onSearchParamsChange,
    scope: input.scope,
    searchParams: input.searchParams,
    surface: input.surface,
  })
  useLayoutEffect(() => {
    latestUrlInputRef.current = {
      onSearchParamsChange: input.onSearchParamsChange,
      scope: input.scope,
      searchParams: input.searchParams,
      surface: input.surface,
    }
  }, [input.onSearchParamsChange, input.scope, input.searchParams, input.surface])
  const {
    data: savedTaskViewCollection,
    error: savedViewsError,
    isLoading,
    mutate,
  } = useSavedTaskViews(
    input.accessToken,
    input.surface,
    input.scope,
    input.enabled,
  )
  const savedViews = savedTaskViewCollection?.views ?? emptySavedTaskViews
  const savedTaskViewCapabilities = savedTaskViewCollection?.capabilities ??
    deniedSavedTaskViewCapabilities
  const writableTeamIds = useMemo(
    () => new Set(savedTaskViewCapabilities.writableTeamIds),
    [savedTaskViewCapabilities.writableTeamIds],
  )
  const parsedUrl = useMemo(
    () => parseTaskViewUrlState(input.searchParams, {
      scope: input.scope,
      surface: input.surface,
    }),
    [input.scope, input.searchParams, input.surface],
  )
  const explicitBuiltIn = parsedUrl.state.viewId === BUILT_IN_TASK_VIEW_ID
  const explicitlySelectedView = explicitBuiltIn
    ? undefined
    : savedViews.find((view) => view.id === parsedUrl.state.viewId)
  const hasExplicitSelection = parsedUrl.state.viewId !== undefined
  const personalDefault = hasExplicitSelection
    ? undefined
    : savedViews.find((view) => view.preference.isPersonalDefault)
  const teamDefault = hasExplicitSelection
    ? undefined
    : savedViews.find((view) => view.preference.isTeamDefault)
  const activeSavedView = parsedUrl.state.viewId
    ? explicitlySelectedView
    : personalDefault ?? teamDefault
  const baselineResolution = resolveTaskViewDefinition({
    builtIn: input.builtInDefinition,
    ...(teamDefault ? { teamDefault: teamDefault.definition } : {}),
    ...(personalDefault ? { personalDefault: personalDefault.definition } : {}),
    ...(explicitlySelectedView ? { selectedView: explicitlySelectedView.definition } : {}),
  })
  const baselineSanitized = sanitizeTaskViewDefinition(
    baselineResolution.definition,
    createSanitizeOptions(input, input.builtInDefinition),
  )
  const effectiveResolution = resolveTaskViewDefinition({
    builtIn: baselineSanitized.definition,
    ...(parsedUrl.state.override ? { urlOverride: parsedUrl.state.override } : {}),
  })
  const effectiveSanitized = sanitizeTaskViewDefinition(
    effectiveResolution.definition,
    createSanitizeOptions(input, baselineSanitized.definition),
  )
  const missingSelectedWarning = Boolean(input.accessToken) &&
      input.enabled !== false &&
      !isLoading &&
      parsedUrl.state.viewId &&
      parsedUrl.state.viewId !== BUILT_IN_TASK_VIEW_ID &&
      !explicitlySelectedView
    ? [createMissingSelectedWarning()]
    : []
  const migrationWarnings = deduplicateTaskViewMigrationWarnings([
    ...parsedUrl.warnings,
    ...(activeSavedView?.migrationWarnings ?? []),
    ...baselineSanitized.warnings,
    ...effectiveSanitized.warnings,
    ...missingSelectedWarning,
  ])
  const canonicalViewId = activeSavedView?.id ?? BUILT_IN_TASK_VIEW_ID

  /** Commits task-view-owned URL parameters while retaining all unrelated route state. */
  const commitUrl = (
    viewId: string | undefined,
    override: TaskViewUrlOverride | undefined,
  ) => {
    const latestUrlInput = latestUrlInputRef.current
    const nextSearchParams = updateTaskViewUrlState(
      latestUrlInput.searchParams,
      { scope: latestUrlInput.scope, surface: latestUrlInput.surface },
      { override, viewId },
    )
    latestUrlInputRef.current = {
      ...latestUrlInput,
      searchParams: nextSearchParams,
    }
    latestUrlInput.onSearchParamsChange(nextSearchParams)
  }

  /**
   * Captures the current task-view-owned URL state before an asynchronous mutation.
   *
   * @returns Stable fingerprint excluding unrelated route parameters.
   */
  const createCurrentUrlFingerprint = () => {
    const latestUrlInput = latestUrlInputRef.current
    return JSON.stringify({
      scope: latestUrlInput.scope,
      surface: latestUrlInput.surface,
      urlState: createTaskViewUrlStateFingerprint(latestUrlInput.searchParams),
    })
  }

  /**
   * Commits a mutation result only when the user has not changed task-view URL state.
   *
   * Unrelated route state still comes from the latest render through commitUrl.
   *
   * @param startedUrlFingerprint - Task-view state captured when the mutation started.
   * @param viewId - Saved-view selection to commit after a current result.
   * @param override - Temporary definition changes to commit after a current result.
   * @returns Nothing after committing or discarding the stale URL result.
   */
  const commitUrlIfTaskViewStateUnchanged = (
    startedUrlFingerprint: string,
    viewId: string | undefined,
    override: TaskViewUrlOverride | undefined,
  ) => {
    if (createCurrentUrlFingerprint() !== startedUrlFingerprint) return
    commitUrl(viewId, override)
  }

  /**
   * Runs one saved-view mutation with shared busy, error, cache, and refresh behavior.
   *
   * @param operationKey - Stable mutation-runner operation identity.
   * @param fingerprint - Deduplication fingerprint for the request payload.
   * @param request - Revision-safe API request factory.
   * @param createCacheChange - Maps the canonical response to a local cache transition.
   * @returns The canonical mutation response after non-fatal cache synchronization.
   */
  const runMutation = async <TResult,>(
    operationKey: string,
    fingerprint: string,
    request: Parameters<typeof mutationRunner.run<TResult>>[2],
    createCacheChange: (result: TResult) => SavedTaskViewCacheChange,
  ): Promise<TResult> => {
    setIsSaving(true)
    setMutationErrorMessage(undefined)
    try {
      const result = await mutationRunner.run(operationKey, fingerprint, request)
      const warningMessage = await publishSavedTaskViewMutationResult(
        createCacheChange(result),
        (update) => mutate((currentCollection) => currentCollection
          ? {
              ...currentCollection,
              views: update(currentCollection.views),
            }
          : currentCollection, { revalidate: false }),
        mutate,
      )
      if (warningMessage) setMutationErrorMessage(warningMessage)
      return result
    } catch (error) {
      setMutationErrorMessage(
        error instanceof Error ? error.message : 'The task view request failed.',
      )
      throw error
    } finally {
      setIsSaving(false)
    }
  }

  return {
    activeSavedView,
    baselineDefinition: baselineSanitized.definition,
    canManageShared: savedTaskViewCapabilities.canManageSharedViews,
    canSetTeamDefault: savedTaskViewCapabilities.canSetTeamDefault,
    canWrite: savedTaskViewCapabilities.canWrite,
    copyPermalink: async () => {
      try {
        if (!globalThis.navigator.clipboard) {
          throw new Error('Clipboard access is unavailable.')
        }
        const permalink = new URL(globalThis.location.href)
        const latestUrlInput = latestUrlInputRef.current
        permalink.search = updateTaskViewUrlState(
          latestUrlInput.searchParams,
          { scope: latestUrlInput.scope, surface: latestUrlInput.surface },
          {
            override: createTaskViewUrlOverride(
              baselineSanitized.definition,
              effectiveSanitized.definition,
            ),
            viewId: canonicalViewId,
          },
        ).toString()
        await globalThis.navigator.clipboard.writeText(permalink.toString())
      } catch (error) {
        setMutationErrorMessage(
          error instanceof Error ? error.message : 'The task view link could not be copied.',
        )
        throw error
      }
    },
    deleteView: async (viewId) => {
      const view = savedViews.find((candidate) => candidate.id === viewId)
      if (
        !input.accessToken ||
        !savedTaskViewCapabilities.canWrite ||
        !view?.canEdit
      ) return
      const startedUrlFingerprint = createCurrentUrlFingerprint()
      const shouldClearActiveView = activeSavedView?.id === viewId
      await runMutation(
        `task-view:delete:${viewId}`,
        String(view.revision),
        (context) => deleteSavedTaskView(
          input.accessToken ?? '',
          viewId,
          view.revision,
          context,
        ),
        () => ({ type: 'remove', viewId }),
      )
      if (shouldClearActiveView) {
        commitUrlIfTaskViewStateUnchanged(
          startedUrlFingerprint,
          undefined,
          undefined,
        )
      }
    },
    duplicateView: async (viewId) => {
      const view = savedViews.find((candidate) => candidate.id === viewId)
      if (!input.accessToken || !savedTaskViewCapabilities.canWrite || !view) return
      const startedUrlFingerprint = createCurrentUrlFingerprint()
      const duplicate = await runMutation(
        `task-view:duplicate:${viewId}`,
        viewId,
        (context) => duplicateSavedTaskView(
          input.accessToken ?? '',
          viewId,
          { teamId: null, visibility: 'personal' },
          context,
        ),
        (duplicate) => ({ type: 'append', view: duplicate }),
      )
      commitUrlIfTaskViewStateUnchanged(
        startedUrlFingerprint,
        duplicate.id,
        undefined,
      )
    },
    effectiveDefinition: effectiveSanitized.definition,
    errorMessage: mutationErrorMessage ?? (savedViewsError instanceof Error
      ? savedViewsError.message
      : savedViewsError ? 'The task views could not be loaded.' : undefined),
    isDirty: Boolean(
      parsedUrl.state.override && hasTaskViewUrlOverride(parsedUrl.state.override),
    ),
    isLoading,
    isSaving,
    migrationWarnings,
    patchPreference: async (viewId, patch) => {
      const view = savedViews.find((candidate) => candidate.id === viewId)
      if (
        !input.accessToken ||
        !savedTaskViewCapabilities.canWrite ||
        !view ||
        (
          patch.isTeamDefault !== undefined &&
          !savedTaskViewCapabilities.canSetTeamDefault
        )
      ) return
      const update: UpdateSavedTaskViewInput = {
        expectedRevision: view.revision,
        ...(patch.favorite === undefined ? {} : { favorite: patch.favorite }),
        ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
        ...(patch.isTeamDefault
          ? { defaultSource: 'team' }
          : patch.isDefault
            ? { defaultSource: 'personal' }
            : patch.isTeamDefault === false
              ? { clearDefaultSource: 'team' }
              : patch.isDefault === false
                ? { clearDefaultSource: 'personal' }
                : {}),
      }
      await runMutation(
        `task-view:preference:${viewId}`,
        JSON.stringify(update),
        (context) => updateSavedTaskView(
          input.accessToken ?? '',
          viewId,
          update,
          context,
        ),
        (updatedView) => ({ type: 'replace', view: updatedView }),
      )
    },
    resetOverrides: () => commitUrl(parsedUrl.state.viewId, undefined),
    saveAs: async (draft) => {
      if (
        !input.accessToken ||
        !savedTaskViewCapabilities.canWrite ||
        (
          draft.visibility === 'shared' &&
          !savedTaskViewCapabilities.canManageSharedViews
        ) ||
        (draft.visibility === 'team' && (
          !draft.teamId || !writableTeamIds.has(draft.teamId)
        ))
      ) return
      const createInput: CreateSavedTaskViewInput = {
        definition: effectiveSanitized.definition,
        description: draft.description,
        name: draft.name,
        teamId: draft.teamId,
        visibility: draft.visibility,
      }
      const startedUrlFingerprint = createCurrentUrlFingerprint()
      const created = await runMutation(
        'task-view:create',
        JSON.stringify(createInput),
        (context) => createSavedTaskView(input.accessToken ?? '', createInput, context),
        (createdView) => ({ type: 'append', view: createdView }),
      )
      commitUrlIfTaskViewStateUnchanged(
        startedUrlFingerprint,
        created.id,
        undefined,
      )
    },
    selectView: (viewId) => commitUrl(viewId ?? BUILT_IN_TASK_VIEW_ID, undefined),
    setEffectiveDefinition: (definition) => commitUrl(
      canonicalViewId,
      createTaskViewUrlOverride(baselineSanitized.definition, definition),
    ),
    updateActiveView: async () => {
      if (
        !input.accessToken ||
        !savedTaskViewCapabilities.canWrite ||
        !activeSavedView?.canEdit
      ) return
      const update: UpdateSavedTaskViewInput = {
        definition: effectiveSanitized.definition,
        expectedRevision: activeSavedView.revision,
      }
      const startedUrlFingerprint = createCurrentUrlFingerprint()
      await runMutation(
        `task-view:update:${activeSavedView.id}`,
        JSON.stringify(update),
        (context) => updateSavedTaskView(
          input.accessToken ?? '',
          activeSavedView.id,
          update,
          context,
        ),
        (updatedView) => ({ type: 'replace', view: updatedView }),
      )
      commitUrlIfTaskViewStateUnchanged(
        startedUrlFingerprint,
        activeSavedView.id,
        undefined,
      )
    },
    views: savedViews,
    writableProjectScopes: savedTaskViewCapabilities.writableProjectScopes,
    writableTeamIds: savedTaskViewCapabilities.writableTeamIds,
  }
}

/** Creates client migration options from current route capabilities. */
function createSanitizeOptions(
  input: UseTaskViewControllerInput,
  fallback: TaskViewDefinition,
) {
  return {
    canRead: true,
    canExposeUnknownReferenceIds: false,
    columns: input.capabilities.columns,
    expectedScope: input.scope,
    expectedSurface: input.surface,
    fallback,
    fields: input.capabilities.fields,
    layoutModes: input.capabilities.layoutModes,
    legacyStatusIds: input.capabilities.legacyStatusIds,
    requiredColumns: input.capabilities.requiredColumns,
    workflowStatuses: input.capabilities.workflowStatuses,
  }
}

/** Creates the safe fallback warning for an inaccessible permalink view identifier. */
function createMissingSelectedWarning(): TaskViewMigrationWarning {
  return {
    code: 'permission-redacted',
    fallback: 'unavailable',
    section: 'scope',
  }
}
