import type {
  FocusItem,
  FocusPolicyOverrides,
  FocusPolicyTarget,
  FocusQueueResponse,
  FocusQueueSection,
  ResolvedWorkItemConfiguration,
  WorkItemScheduleChangePreview,
  WorkItemScheduleOperation,
  WorkflowStatusDefinition,
} from '@mukuroji/contracts'
import {
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { ChevronIcon, EyeIcon, LockIcon } from '../../../shared/ui/icons'
import {
  focusQueueSectionOrder,
  createFocusScheduleOperation,
  formatFocusTimestamp,
  getFocusActionabilityMessageKey,
  getFocusEmptyMessageKey,
  getFocusQueueItems,
  getFocusQueueSectionCounts,
  getFocusPolicyForEditor,
  getFocusSourcePath,
  getFocusResolutionMessageKey,
  getFocusSectionMessageKey,
  getFocusSignalMessageKey,
  resolveFocusQueueNavigationIndex,
  resolveFocusSnoozeUntil,
  type FocusQueueNavigationKey,
} from '../model/focusQueue'
import type {
  FocusQueueActionId,
  FocusQueueMutationError,
  FocusQueueSnoozeFeedback,
} from '../mutations/useFocusQueueActions'
import { FocusPolicyPanel } from './FocusPolicyPanel'

/** Props for the server-ranked Focus queue view. */
export type FocusQueueProps = {
  /** Resolved Work Item configurations keyed by owning Team. */
  configurationsByTeam?: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Whether the current Focus request failed. */
  hasError?: boolean
  /** Whether the first Focus snapshot is loading. */
  isLoading?: boolean
  /** Current application locale used for evidence timestamps. */
  locale: Locale
  /** Latest non-policy queue action failure when present. */
  mutationError?: FocusQueueMutationError
  /** Whether the latest policy replacement failed. */
  policyError?: boolean
  /** Assigns an authorized item to the current viewer. */
  onAssignToViewer?: (item: FocusItem) => Promise<void>
  /** Completes an authorized item through one resolved completed status. */
  onComplete?: (item: FocusItem, completedStatusId: string) => Promise<void>
  /** Confirms a dependency-aware schedule preview. */
  onConfirmSchedule?: (
    item: FocusItem,
    operation: WorkItemScheduleOperation,
    preview: WorkItemScheduleChangePreview,
  ) => Promise<void>
  /** Removes the latest action error notice. */
  onDismissMutationError?: () => void
  /** Removes the latest snooze feedback notice. */
  onDismissSnoozeFeedback?: () => void
  /** Opens one canonical Work Item. */
  onOpenItem?: (item: FocusItem) => void
  /** Opens an authorized signal source. */
  onOpenSource?: (item: FocusItem) => void
  /** Retries a failed Focus query. */
  onRetry?: () => void
  /** Requests a server-authoritative schedule impact preview. */
  onPreviewSchedule?: (
    item: FocusItem,
    operation: WorkItemScheduleOperation,
  ) => Promise<WorkItemScheduleChangePreview>
  /** Changes the queue section represented in the URL. */
  onSectionChange: (section: FocusQueueSection) => void
  /** Snoozes or unsnoozes one Focus item. */
  onSnooze?: (item: FocusItem, snoozedUntil: string | null) => Promise<void>
  /** Changes one authorized Work Item workflow status. */
  onStatusChange?: (item: FocusItem, workflowStatusId: string) => Promise<void>
  /** Restores the snooze state captured by the latest feedback. */
  onUndoSnooze?: () => Promise<void>
  /** Replaces the caller's complete personal policy override. */
  onUpdatePolicy?: (
    target: FocusPolicyTarget,
    expectedVersion: number,
    overrides: FocusPolicyOverrides,
  ) => Promise<void>
  /** Changes one Focus item's watch state. */
  onWatchingChange?: (item: FocusItem, watching: boolean) => Promise<void>
  /** Returns whether one item action is currently in flight. */
  isActionPending?: (itemId: string, action: FocusQueueActionId) => boolean
  /** Permission-filtered Focus queue response. */
  response?: FocusQueueResponse
  /** Item requested by an Inbox correlation, when it remains visible. */
  requestedItemId?: string
  /** Currently selected queue section. */
  section: FocusQueueSection
  /** Latest successful snooze available for Undo. */
  snoozeFeedback?: FocusQueueSnoozeFeedback
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders a compact, explanation-first Focus queue without recalculating server rank.
 *
 * @param props - Focus snapshot, route state, translations, and authorized actions.
 * @returns A responsive single-column queue with roving keyboard focus.
 */
export function FocusQueue({
  configurationsByTeam = {},
  hasError = false,
  isActionPending = () => false,
  isLoading = false,
  locale,
  mutationError,
  onAssignToViewer,
  onComplete,
  onConfirmSchedule,
  onDismissMutationError,
  onDismissSnoozeFeedback,
  onOpenItem,
  onOpenSource,
  onPreviewSchedule,
  onRetry,
  onSectionChange,
  onSnooze,
  onStatusChange,
  onUndoSnooze,
  onUpdatePolicy,
  onWatchingChange,
  policyError = false,
  requestedItemId,
  response,
  section,
  snoozeFeedback,
  t,
}: FocusQueueProps) {
  const items = getFocusQueueItems(response, section)
  const counts = getFocusQueueSectionCounts(response)
  const [selectedItemId, setSelectedItemId] = useState<string>()
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const requestedItem = requestedItemId
    ? items.find((item) => item.id === requestedItemId)
    : undefined
  const selectedItem = items.find((item) => item.id === selectedItemId) ??
    requestedItem ??
    items[0]
  const editorPolicy = getFocusPolicyForEditor(response, selectedItem)
  const editorTeamId = editorPolicy?.teamId
  const editorTeamPolicy = editorTeamId === undefined
    ? undefined
    : response?.teamPolicies.find((candidate) =>
        candidate.target.type === 'team' && candidate.target.teamId === editorTeamId
      )
  const canEditEditorTeam = editorTeamId !== undefined &&
    response?.policyCapabilities.editableTeamIds.includes(editorTeamId) === true

  /** Restores focus to the mutated row or the nearest remaining server-ordered row. */
  const restoreFocusAfterMutation = (itemId: string, previousIndex: number) => {
    globalThis.requestAnimationFrame(() => {
      const preferredRow = rowRefs.current.get(itemId)
      const remainingRows = Array.from(rowRefs.current.values())
      const fallbackIndex = Math.min(previousIndex, Math.max(remainingRows.length - 1, 0))
      const sectionTab = document.getElementById(`focus-queue-tab-${section}`)
      const target = preferredRow ?? remainingRows[fallbackIndex] ??
        (sectionTab instanceof HTMLElement ? sectionTab : undefined)
      target?.focus({ preventScroll: true })
      target?.scrollIntoView({ block: 'nearest' })
    })
  }

  /** Moves selection and DOM focus together after one queue navigation key. */
  const moveFocus = (key: FocusQueueNavigationKey) => {
    if (!selectedItem) return
    const currentIndex = items.findIndex((item) => item.id === selectedItem.id)
    const nextIndex = resolveFocusQueueNavigationIndex(currentIndex, items.length, key)
    const nextItem = items[nextIndex]
    if (!nextItem) return
    setSelectedItemId(nextItem.id)
    rowRefs.current.get(nextItem.id)?.focus({ preventScroll: true })
    rowRefs.current.get(nextItem.id)?.scrollIntoView({ block: 'nearest' })
  }

  /** Handles J/K and standard directional keys on the queue list. */
  const handleQueueKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || isTextEntryTarget(event.target)) return
    const direction = getQueueNavigationKey(event.key)
    if (direction) {
      event.preventDefault()
      moveFocus(direction)
      return
    }
    if (
      event.key === 'Enter' &&
      selectedItem &&
      event.target instanceof HTMLElement &&
      event.target.hasAttribute('data-focus-queue-primary')
    ) {
      event.preventDefault()
      onOpenItem?.(selectedItem)
    }
  }

  return (
    <section aria-label={t('workspace.focus.title')} className="grid gap-4">
      <div className="workbench-toolbar overflow-hidden">
        <div
          aria-label={t('workspace.focus.title')}
          className="flex min-w-0 overflow-x-auto border-b border-[var(--workbench-border)]"
          role="tablist"
        >
          {focusQueueSectionOrder.map((queueSection) => (
            <button
              aria-controls="focus-queue-panel"
              aria-selected={section === queueSection}
              className={`min-h-[44px] shrink-0 border-b-2 px-4 text-app-meta font-semibold transition-colors ${
                section === queueSection
                  ? 'border-[var(--workbench-primary)] bg-[var(--workbench-surface-muted)] text-[var(--workbench-primary)]'
                  : 'border-transparent text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-text)]'
              }`}
              id={`focus-queue-tab-${queueSection}`}
              key={queueSection}
              onClick={() => onSectionChange(queueSection)}
              onKeyDown={(event) => handleSectionKeyDown(event, queueSection, onSectionChange)}
              role="tab"
              tabIndex={section === queueSection ? 0 : -1}
              type="button"
            >
              {t(getFocusSectionMessageKey(queueSection))}
              <span className="ml-2 tabular-nums text-[var(--workbench-muted)]">
                {counts[queueSection]}
              </span>
            </button>
          ))}
        </div>
        {response ? (
          <div className="flex min-h-10 items-center justify-between gap-3 px-4 text-app-caption text-[var(--workbench-muted)]">
            <span>
              {t('workspace.focus.generatedAt').replace(
                '{time}',
                formatFocusTimestamp(response.generatedAt, locale),
              )}
            </span>
            <span className="hidden sm:inline">{t('workspace.focus.keyboardHint')}</span>
          </div>
        ) : null}
      </div>

      {mutationError ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-l-4 border-[var(--workbench-danger)] bg-white px-4 py-3 text-app-meta text-[var(--workbench-danger)]"
          role="alert"
        >
          <span>
            {t(mutationError === 'conflict'
              ? 'workspace.focus.actionConflict'
              : 'workspace.focus.actionError')}
          </span>
          <button
            className="min-h-[44px] px-3 font-semibold"
            onClick={onDismissMutationError}
            type="button"
          >
            {t('workspace.focus.action.dismiss')}
          </button>
        </div>
      ) : null}

      {snoozeFeedback ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-l-4 border-[var(--workbench-primary)] bg-white px-4 py-3 text-app-meta"
          role="status"
        >
          <span>
            {snoozeFeedback.snoozedUntil
              ? t('workspace.focus.snooze.feedback').replace(
                  '{time}',
                  formatFocusTimestamp(snoozeFeedback.snoozedUntil, locale),
                )
              : t('workspace.focus.action.unsnooze')}
          </span>
          <span className="flex gap-2">
            <button
              className="workbench-button-secondary min-h-[44px] px-3"
              onClick={() => {
                const request = onUndoSnooze?.()
                if (request) void request.then(() => undefined, () => undefined)
              }}
              type="button"
            >
              {t('workspace.focus.action.undo')}
            </button>
            <button
              className="min-h-[44px] px-3 font-semibold text-[var(--workbench-muted)]"
              onClick={onDismissSnoozeFeedback}
              type="button"
            >
              {t('workspace.focus.action.dismiss')}
            </button>
          </span>
        </div>
      ) : null}

      <div
        aria-labelledby={`focus-queue-tab-${section}`}
        className="workbench-panel overflow-hidden"
        id="focus-queue-panel"
        role="tabpanel"
      >
        {isLoading ? <FocusQueueLoading t={t} /> : null}
        {!isLoading && hasError ? <FocusQueueError onRetry={onRetry} t={t} /> : null}
        {!isLoading && !hasError && items.length === 0 ? (
          <FocusQueueEmpty section={section} t={t} />
        ) : null}
        {!isLoading && !hasError && items.length > 0 ? (
          <ol className="divide-y divide-[var(--workbench-border)]" onKeyDown={handleQueueKeyDown}>
            {items.map((item, index) => (
              <FocusQueueRow
                configuration={configurationsByTeam[item.workItem.teamId]}
                isPending={(action) => isActionPending(item.id, action)}
                isSelected={selectedItem?.id === item.id}
                item={item}
                key={item.id}
                locale={locale}
                onAssignToViewer={onAssignToViewer}
                onComplete={onComplete}
                onConfirmSchedule={onConfirmSchedule}
                onOpenItem={onOpenItem}
                onOpenSource={onOpenSource}
                onPreviewSchedule={onPreviewSchedule}
                onActionSettled={() => restoreFocusAfterMutation(item.id, index)}
                onPrimaryRef={(element) => {
                  if (element) rowRefs.current.set(item.id, element)
                  else rowRefs.current.delete(item.id)
                }}
                onSelect={() => setSelectedItemId(item.id)}
                onSnooze={onSnooze}
                onStatusChange={onStatusChange}
                onWatchingChange={onWatchingChange}
                rank={index + 1}
                t={t}
              />
            ))}
          </ol>
        ) : null}
      </div>
      <FocusPolicyPanel
        canEditPersonal={response?.policyCapabilities.canEditPersonal === true}
        canEditTeam={canEditEditorTeam}
        hasError={policyError}
        isSaving={isActionPending('policy-editor', 'policy')}
        onSave={onUpdatePolicy}
        personalPolicy={response?.userPolicy}
        policy={editorPolicy}
        teamPolicy={editorTeamPolicy}
        t={t}
      />
    </section>
  )
}

/** Internal props for one divider-based Focus queue row. */
type FocusQueueRowProps = {
  /** Resolved Team workflow configuration. */
  configuration?: ResolvedWorkItemConfiguration
  /** Returns whether one action is in flight for this row. */
  isPending: (action: FocusQueueActionId) => boolean
  /** Whether this row exposes its evidence and actions. */
  isSelected: boolean
  /** Server-ranked Focus item displayed by the row. */
  item: FocusItem
  /** Current locale used for evidence timestamps. */
  locale: Locale
  /** Assigns the item to the viewer. */
  onAssignToViewer?: (item: FocusItem) => Promise<void>
  /** Restores queue focus after an asynchronous action settles. */
  onActionSettled: () => void
  /** Completes the item through a resolved completed status. */
  onComplete?: (item: FocusItem, completedStatusId: string) => Promise<void>
  /** Confirms a previously loaded schedule preview. */
  onConfirmSchedule?: FocusQueueProps['onConfirmSchedule']
  /** Opens the canonical Work Item. */
  onOpenItem?: (item: FocusItem) => void
  /** Opens one authorized source. */
  onOpenSource?: (item: FocusItem) => void
  /** Loads one dependency-aware schedule preview. */
  onPreviewSchedule?: FocusQueueProps['onPreviewSchedule']
  /** Registers the roving-focus button element. */
  onPrimaryRef: (element: HTMLButtonElement | null) => void
  /** Selects this row for contextual actions. */
  onSelect: () => void
  /** Changes the item's snooze state. */
  onSnooze?: (item: FocusItem, snoozedUntil: string | null) => Promise<void>
  /** Changes the canonical workflow status. */
  onStatusChange?: (item: FocusItem, workflowStatusId: string) => Promise<void>
  /** Changes the item's watch state. */
  onWatchingChange?: (item: FocusItem, watching: boolean) => Promise<void>
  /** One-based server-order rank within the active section. */
  rank: number
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders one compact row and its selection-only evidence surface. */
function FocusQueueRow({
  configuration,
  isPending,
  isSelected,
  item,
  locale,
  onAssignToViewer,
  onActionSettled,
  onComplete,
  onConfirmSchedule,
  onOpenItem,
  onOpenSource,
  onPreviewSchedule,
  onPrimaryRef,
  onSelect,
  onSnooze,
  onStatusChange,
  onWatchingChange,
  rank,
  t,
}: FocusQueueRowProps) {
  const statuses = configuration?.configuration.workflow.statuses ?? []
  const completedStatus = statuses.find((status) => status.category === 'completed')
  const busy = isAnyFocusActionPending(isPending)
  const assignee = item.workItem.assigneeName ||
    item.workItem.assigneeEmail ||
    item.workItem.assigneeUserId

  /** Runs a row mutation and consumes its handled failure before restoring queue focus. */
  const runRowAction = (request: Promise<void>) => {
    void request.then(onActionSettled, onActionSettled)
  }

  return (
    <li data-testid={`focus-item-${item.workItem.teamId}-${item.workItem.id}`}>
      <button
        aria-expanded={isSelected}
        aria-controls={`focus-item-details-${item.id}`}
        className={`grid min-h-[76px] w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors max-[720px]:grid-cols-[40px_minmax(0,1fr)] ${
          isSelected
            ? 'bg-[var(--workbench-surface-muted)]'
            : 'bg-white hover:bg-[var(--workbench-surface-muted)]'
        }`}
        data-focus-queue-primary="true"
        onClick={onSelect}
        ref={onPrimaryRef}
        tabIndex={isSelected ? 0 : -1}
        type="button"
      >
        <span className="text-center text-app-caption font-bold tabular-nums text-[var(--workbench-muted)]">
          {t('workspace.focus.metadata.rank').replace('{rank}', String(rank))}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-app-body font-semibold text-[var(--workbench-text)]">
            {item.workItem.title}
          </span>
          <span className="mt-1 flex flex-wrap gap-1.5">
            {item.signals.map((signal) => (
              <span className={getSignalChipClassName(signal.type)} key={signal.id}>
                {t(getFocusSignalMessageKey(signal.type))}
              </span>
            ))}
          </span>
        </span>
        <span className="flex items-center gap-4 text-right max-[720px]:col-span-2 max-[720px]:ml-[52px] max-[720px]:w-[calc(100%-52px)] max-[720px]:justify-between max-[720px]:text-left">
          <span className="hidden text-app-caption text-[var(--workbench-muted)] sm:block">
            <span className="block">
              {assignee
                ? t('workspace.focus.metadata.assignee').replace('{name}', assignee)
                : t('workspace.focus.metadata.unassigned')}
            </span>
            <span className="block">
              {item.workItem.dueDate
                ? t('workspace.focus.metadata.due').replace('{date}', item.workItem.dueDate)
                : t('workspace.focus.metadata.noDue')}
            </span>
          </span>
          <ChevronIcon className={`h-5 w-5 text-[var(--workbench-muted)] transition-transform ${isSelected ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {isSelected ? (
        <div
          className="border-t border-[var(--workbench-border)] bg-white px-4 py-4 sm:pl-[68px]"
          id={`focus-item-details-${item.id}`}
        >
          {!item.actionability.actionable && item.actionability.reasons.length > 0 ? (
            <div className="mb-4 flex items-start gap-2 border-l-2 border-[var(--workbench-warning)] pl-3 text-app-meta text-[var(--workbench-warning)]">
              <LockIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {item.actionability.reasons
                  .map((reason) => t(getFocusActionabilityMessageKey(reason)))
                  .join(' · ')}
              </span>
            </div>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.7fr)]">
            <div>
              <h3 className="text-app-caption font-bold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
                {t('workspace.focus.why')}
              </h3>
              <ul className="mt-2 grid gap-2">
                {item.signals.map((signal) => (
                  <li className="grid gap-1 text-app-meta sm:grid-cols-[140px_minmax(0,1fr)]" key={signal.id}>
                    <span className="font-semibold text-[var(--workbench-text)]">
                      {t(getFocusSignalMessageKey(signal.type))}
                    </span>
                    <span className="text-[var(--workbench-muted)]">
                      {t(getFocusResolutionMessageKey(signal.resolution.condition))}
                      <span className="ml-2 text-app-caption">
                        {t('workspace.focus.sourceUpdated').replace(
                          '{time}',
                          formatFocusTimestamp(signal.freshness.evaluatedAt, locale),
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-app-caption font-bold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
                {t('workspace.focus.rank')}
              </h3>
              <p className="mt-2 text-app-body font-bold tabular-nums text-[var(--workbench-text)]">
                {t('workspace.focus.rankScore').replace('{score}', String(item.rank.score))}
              </p>
              <ul className="mt-1 grid gap-1 text-app-caption text-[var(--workbench-muted)]">
                {item.rank.components.map((component) => (
                  <li key={`${component.signalId}-${component.signalType}`}>
                    {t('workspace.focus.rankContribution')
                      .replace('{signal}', t(getFocusSignalMessageKey(component.signalType)))
                      .replace('{contribution}', String(component.contribution))}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--workbench-border)] pt-4">
            {onOpenItem ? (
              <button
                className="workbench-button-primary min-h-[44px] px-4"
                disabled={busy}
                onClick={() => onOpenItem(item)}
                type="button"
              >
                {t('workspace.action.openTask')}
              </button>
            ) : null}
            {item.capabilities.complete && completedStatus && onComplete ? (
              <button
                className="workbench-button-secondary min-h-[44px] px-4"
                disabled={busy}
                onClick={() => runRowAction(onComplete(item, completedStatus.id))}
                type="button"
              >
                {t('workspace.focus.action.complete')}
              </button>
            ) : null}
            {item.capabilities.assign && onAssignToViewer ? (
              <button
                className="workbench-button-secondary min-h-[44px] px-4"
                disabled={busy}
                onClick={() => runRowAction(onAssignToViewer(item))}
                type="button"
              >
                {t('workspace.focus.action.assignToMe')}
              </button>
            ) : null}
            {item.capabilities.changeStatus && onStatusChange && statuses.length > 0 ? (
              <FocusStatusSelect
                disabled={busy}
                item={item}
                onStatusChange={onStatusChange}
                onActionSettled={onActionSettled}
                statuses={statuses}
                t={t}
              />
            ) : null}
            {item.capabilities.schedule && onPreviewSchedule && onConfirmSchedule ? (
              <FocusScheduleControl
                disabled={busy}
                item={item}
                onConfirmSchedule={onConfirmSchedule}
                onActionSettled={onActionSettled}
                onPreviewSchedule={onPreviewSchedule}
                t={t}
              />
            ) : null}
            {item.capabilities.snooze && onSnooze ? (
              item.snoozedUntil ? (
                <button
                  className="workbench-button-secondary min-h-[44px] px-4"
                  disabled={busy}
                  onClick={() => runRowAction(onSnooze(item, null))}
                  type="button"
                >
                  {t('workspace.focus.action.unsnooze')}
                </button>
              ) : (
                <FocusSnoozeControl
                  disabled={busy}
                  item={item}
                  onActionSettled={onActionSettled}
                  onSnooze={onSnooze}
                  t={t}
                />
              )
            ) : null}
            {item.capabilities.watch && onWatchingChange ? (
              <button
                className="workbench-button-secondary min-h-[44px] px-4"
                disabled={busy}
                onClick={() => runRowAction(onWatchingChange(item, !item.watching))}
                type="button"
              >
                <EyeIcon className="mr-2 inline h-4 w-4" />
                {t(item.watching
                  ? 'workspace.focus.action.unwatch'
                  : 'workspace.focus.action.watch')}
              </button>
            ) : null}
            {getFocusSourcePath(item) && onOpenSource ? (
              <button
                className="min-h-[44px] px-3 text-app-meta font-semibold text-[var(--workbench-primary)] hover:underline"
                disabled={busy}
                onClick={() => onOpenSource(item)}
                type="button"
              >
                {t('workspace.focus.action.openSource')}
              </button>
            ) : null}
            {!hasVisibleFocusAction(item, statuses, {
              onAssignToViewer,
              onComplete,
              onOpenItem,
              onOpenSource,
              onPreviewSchedule,
              onSnooze,
              onStatusChange,
              onWatchingChange,
            }) ? (
              <span className="flex min-h-[44px] items-center gap-2 text-app-meta text-[var(--workbench-muted)]">
                <LockIcon className="h-4 w-4" />
                {t('workspace.focus.permissionUnavailable')}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  )
}

/** Props for the compact status action. */
type FocusStatusSelectProps = {
  /** Whether queue mutation is in flight. */
  disabled: boolean
  /** Focus item whose status is edited. */
  item: FocusItem
  /** Restores queue focus after the status mutation settles. */
  onActionSettled: () => void
  /** Applies one selected workflow status. */
  onStatusChange: (item: FocusItem, workflowStatusId: string) => Promise<void>
  /** Team workflow statuses available to this item. */
  statuses: readonly WorkflowStatusDefinition[]
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders an immediately applied workflow status selector. */
function FocusStatusSelect({
  disabled,
  item,
  onActionSettled,
  onStatusChange,
  statuses,
  t,
}: FocusStatusSelectProps) {
  return (
    <label className="inline-flex min-h-[44px] items-center gap-2">
      <span className="sr-only">{t('workspace.focus.action.status')}</span>
      <select
        aria-label={t('workspace.focus.action.status')}
        className="workbench-input min-h-[44px] px-3"
        disabled={disabled}
        onChange={(event) => {
          if (event.target.value !== item.workItem.workflowStatusId) {
            void onStatusChange(item, event.target.value).then(
              onActionSettled,
              onActionSettled,
            )
          }
        }}
        value={item.workItem.workflowStatusId}
      >
        {statuses.map((status) => (
          <option key={status.id} value={status.id}>{status.name}</option>
        ))}
      </select>
    </label>
  )
}

/** Props for the dependency-aware inline schedule editor. */
type FocusScheduleControlProps = {
  /** Whether another row action is in flight. */
  disabled: boolean
  /** Focus item whose canonical schedule is edited. */
  item: FocusItem
  /** Restores queue focus after schedule confirmation settles. */
  onActionSettled: () => void
  /** Confirms a schedule preview against its observed graph revisions. */
  onConfirmSchedule: (
    item: FocusItem,
    operation: WorkItemScheduleOperation,
    preview: WorkItemScheduleChangePreview,
  ) => Promise<void>
  /** Loads a server-authoritative schedule impact preview. */
  onPreviewSchedule: (
    item: FocusItem,
    operation: WorkItemScheduleOperation,
  ) => Promise<WorkItemScheduleChangePreview>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders a preview-before-confirm schedule action inside the selected row. */
function FocusScheduleControl({
  disabled,
  item,
  onActionSettled,
  onConfirmSchedule,
  onPreviewSchedule,
  t,
}: FocusScheduleControlProps) {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [previewState, setPreviewState] = useState<{
    operation: WorkItemScheduleOperation
    preview: WorkItemScheduleChangePreview
  }>()

  /** Closes the inline editor and restores keyboard focus to its trigger. */
  const closeEditor = () => {
    setPreviewState(undefined)
    setIsOpen(false)
    globalThis.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  if (!isOpen) {
    return (
      <button
        className="workbench-button-secondary min-h-[44px] px-4"
        disabled={disabled}
        onClick={() => setIsOpen(true)}
        ref={triggerRef}
        type="button"
      >
        {t('workspace.focus.action.schedule')}
      </button>
    )
  }

  if (previewState) {
    const dependencyImpactCount = previewState.preview.impacts.filter(
      (impact) => impact.kind === 'dependency',
    ).length
    const hasConflicts = previewState.preview.conflicts.length > 0
    return (
      <div className="flex w-full flex-wrap items-center gap-2 border-l-2 border-[var(--workbench-warning)] pl-3 text-app-caption sm:w-auto">
        <span className="text-[var(--workbench-muted)]">
          {t('workspace.focus.schedule.impactCount').replace(
            '{count}',
            String(dependencyImpactCount),
          )}
          {(previewState.preview.warnings.length > 0 || hasConflicts)
            ? ` · ${t('workspace.focus.schedule.warnings')}`
            : ''}
        </span>
        <button
          className="workbench-button-primary min-h-[44px] px-4"
          disabled={disabled || hasConflicts}
          onClick={() => {
            void onConfirmSchedule(item, previewState.operation, previewState.preview)
              .then(() => {
                setPreviewState(undefined)
                setIsOpen(false)
                onActionSettled()
              }, onActionSettled)
          }}
          type="button"
        >
          {t('workspace.focus.action.scheduleConfirm')}
        </button>
        <button
          className="min-h-[44px] px-3 font-semibold text-[var(--workbench-muted)]"
          onClick={() => setPreviewState(undefined)}
          type="button"
        >
          {t('workspace.focus.action.cancel')}
        </button>
      </div>
    )
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          closeEditor()
        }
      }}
      onSubmit={(event) => {
        event.preventDefault()
        const formData = new FormData(event.currentTarget)
        const date = formData.get('focusScheduleDate')
        if (typeof date !== 'string' || date.length === 0) return
        const operation = createFocusScheduleOperation(item, date)
        void onPreviewSchedule(item, operation).then((preview) => {
          setPreviewState({ operation, preview })
        }, () => undefined)
      }}
    >
      <label className="grid gap-1 text-app-caption font-semibold text-[var(--workbench-muted)]">
        <span className="sr-only">{t('workspace.focus.schedule.date')}</span>
        <input
          aria-label={t('workspace.focus.schedule.date')}
          autoFocus
          className="workbench-input min-h-[44px] px-3"
          defaultValue={item.workItem.dueDate}
          disabled={disabled}
          name="focusScheduleDate"
          required
          type="date"
        />
      </label>
      <button className="workbench-button-primary min-h-[44px] px-4" disabled={disabled} type="submit">
        {t('workspace.focus.action.schedulePreview')}
      </button>
      <button
        className="min-h-[44px] px-3 font-semibold text-[var(--workbench-muted)]"
        onClick={closeEditor}
        type="button"
      >
        {t('workspace.focus.action.cancel')}
      </button>
    </form>
  )
}

/** Props for the inline snooze preset and confirmation control. */
type FocusSnoozeControlProps = {
  /** Whether another action prevents snooze submission. */
  disabled: boolean
  /** Focus item to snooze. */
  item: FocusItem
  /** Restores queue focus after the snooze mutation settles. */
  onActionSettled: () => void
  /** Applies the confirmed wake timestamp. */
  onSnooze: (item: FocusItem, snoozedUntil: string | null) => Promise<void>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders a preset-first snooze flow with explicit confirmation and Escape cancellation. */
function FocusSnoozeControl({
  disabled,
  item,
  onActionSettled,
  onSnooze,
  t,
}: FocusSnoozeControlProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [preset, setPreset] = useState<'later-today' | 'tomorrow' | 'next-week'>('tomorrow')
  const triggerRef = useRef<HTMLButtonElement>(null)

  /** Closes the preset editor and restores keyboard focus to its trigger. */
  const closeEditor = () => {
    setIsOpen(false)
    globalThis.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  if (!isOpen) {
    return (
      <button
        className="workbench-button-secondary min-h-[44px] px-4"
        disabled={disabled}
        onClick={() => setIsOpen(true)}
        ref={triggerRef}
        type="button"
      >
        {t('workspace.focus.action.snooze')}
      </button>
    )
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          closeEditor()
        }
      }}
      onSubmit={(event) => {
        event.preventDefault()
        void onSnooze(item, resolveFocusSnoozeUntil(preset, new Date())).then(
          onActionSettled,
          onActionSettled,
        )
        setIsOpen(false)
      }}
    >
      <select
        aria-label={t('workspace.focus.snooze.label')}
        autoFocus
        className="workbench-input min-h-[44px] px-3"
        disabled={disabled}
        onChange={(event) => {
          if (
            event.target.value === 'later-today' ||
            event.target.value === 'tomorrow' ||
            event.target.value === 'next-week'
          ) {
            setPreset(event.target.value)
          }
        }}
        value={preset}
      >
        <option value="later-today">{t('workspace.focus.snooze.laterToday')}</option>
        <option value="tomorrow">{t('workspace.focus.snooze.tomorrow')}</option>
        <option value="next-week">{t('workspace.focus.snooze.nextWeek')}</option>
      </select>
      <button className="workbench-button-primary min-h-[44px] px-4" disabled={disabled} type="submit">
        {t('workspace.focus.action.confirm')}
      </button>
      <button
        className="min-h-[44px] px-3 text-app-meta font-semibold text-[var(--workbench-muted)]"
        onClick={closeEditor}
        type="button"
      >
        {t('workspace.focus.action.cancel')}
      </button>
    </form>
  )
}

/** Renders the queue skeleton without changing section layout. */
function FocusQueueLoading({ t }: { t: (key: MessageKey) => string }) {
  return (
    <div aria-live="polite" className="grid gap-0" role="status">
      <span className="sr-only">{t('workspace.focus.loading')}</span>
      {[0, 1, 2].map((index) => (
        <span
          aria-hidden="true"
          className="grid min-h-[76px] grid-cols-[52px_1fr] items-center gap-3 border-b border-[var(--workbench-border)] px-4"
          key={index}
        >
          <span className="h-4 w-7 animate-pulse rounded bg-[var(--workbench-surface-muted)]" />
          <span className="grid gap-2">
            <span className="h-4 w-2/3 animate-pulse rounded bg-[var(--workbench-surface-muted)]" />
            <span className="h-3 w-1/3 animate-pulse rounded bg-[var(--workbench-surface-muted)]" />
          </span>
        </span>
      ))}
    </div>
  )
}

/** Renders a retryable queue error. */
function FocusQueueError({
  onRetry,
  t,
}: {
  onRetry?: () => void
  t: (key: MessageKey) => string
}) {
  return (
    <div className="grid min-h-48 place-items-center gap-3 px-5 py-10 text-center" role="alert">
      <p className="text-app-body font-semibold text-[var(--workbench-text)]">
        {t('workspace.focus.loadError')}
      </p>
      {onRetry ? (
        <button className="workbench-button-secondary min-h-[44px] px-4" onClick={onRetry} type="button">
          {t('workspace.focus.retry')}
        </button>
      ) : null}
    </div>
  )
}

/** Renders a section-specific empty state. */
function FocusQueueEmpty({
  section,
  t,
}: {
  section: FocusQueueSection
  t: (key: MessageKey) => string
}) {
  return (
    <div className="grid min-h-48 place-items-center px-5 py-10 text-center">
      <p className="text-app-body font-medium text-[var(--workbench-muted)]">
        {t(getFocusEmptyMessageKey(section))}
      </p>
    </div>
  )
}

/** Maps a raw DOM key to queue navigation intent. */
function getQueueNavigationKey(key: string): FocusQueueNavigationKey | undefined {
  if (key === 'j' || key === 'J' || key === 'ArrowDown') return 'next'
  if (key === 'k' || key === 'K' || key === 'ArrowUp') return 'previous'
  if (key === 'Home') return 'first'
  if (key === 'End') return 'last'
  return undefined
}

/** Returns whether keyboard input belongs to a text-entry or selection control. */
function isTextEntryTarget(target: EventTarget): boolean {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
}

/** Applies semantic color without introducing feature-local visual tokens. */
function getSignalChipClassName(type: FocusItem['signals'][number]['type']): string {
  const base = 'inline-flex min-h-6 items-center rounded-md border px-2 text-app-micro font-bold'
  if (type === 'overdue' || type === 'sla') {
    return `${base} border-red-200 bg-red-50 text-[var(--workbench-danger)]`
  }
  if (type === 'blocker' || type === 'urgent') {
    return `${base} border-amber-200 bg-amber-50 text-[var(--workbench-warning)]`
  }
  if (type === 'approval' || type === 'review-request' || type === 'mention') {
    return `${base} border-teal-200 bg-teal-50 text-[var(--workbench-primary)]`
  }
  return `${base} border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] text-[var(--workbench-muted)]`
}

/** Returns whether any item action is currently pending. */
function isAnyFocusActionPending(
  isPending: (action: FocusQueueActionId) => boolean,
): boolean {
  return [
    'assign',
    'complete',
    'schedule',
    'snooze',
    'status',
    'watch',
  ].some((action) => isPendingActionId(action) && isPending(action))
}

/** Narrows one local pending action identifier. */
function isPendingActionId(value: string): value is FocusQueueActionId {
  return value === 'assign' ||
    value === 'complete' ||
    value === 'schedule' ||
    value === 'snooze' ||
    value === 'status' ||
    value === 'watch'
}

/** Callback subset used to determine whether permission leaves any visible action. */
type FocusVisibleActionCallbacks = {
  /** Optional assign callback. */
  onAssignToViewer?: FocusQueueRowProps['onAssignToViewer']
  /** Optional complete callback. */
  onComplete?: FocusQueueRowProps['onComplete']
  /** Optional open callback. */
  onOpenItem?: FocusQueueRowProps['onOpenItem']
  /** Optional source callback. */
  onOpenSource?: FocusQueueRowProps['onOpenSource']
  /** Optional schedule-preview callback. */
  onPreviewSchedule?: FocusQueueRowProps['onPreviewSchedule']
  /** Optional snooze callback. */
  onSnooze?: FocusQueueRowProps['onSnooze']
  /** Optional status callback. */
  onStatusChange?: FocusQueueRowProps['onStatusChange']
  /** Optional watch callback. */
  onWatchingChange?: FocusQueueRowProps['onWatchingChange']
}

/** Returns whether one selected row has at least one rendered action. */
function hasVisibleFocusAction(
  item: FocusItem,
  statuses: readonly WorkflowStatusDefinition[],
  callbacks: FocusVisibleActionCallbacks,
): boolean {
  return Boolean(callbacks.onOpenItem) ||
    Boolean(item.capabilities.assign && callbacks.onAssignToViewer) ||
    Boolean(item.capabilities.complete && callbacks.onComplete &&
      statuses.some((status) => status.category === 'completed')) ||
    Boolean(item.capabilities.changeStatus && callbacks.onStatusChange && statuses.length > 0) ||
    Boolean(item.capabilities.schedule && callbacks.onPreviewSchedule) ||
    Boolean(item.capabilities.snooze && callbacks.onSnooze) ||
    Boolean(item.capabilities.watch && callbacks.onWatchingChange) ||
    Boolean(getFocusSourcePath(item) && callbacks.onOpenSource)
}

/** Moves section-tab focus and selection with standard horizontal tab keys. */
function handleSectionKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  section: FocusQueueSection,
  onSectionChange: (section: FocusQueueSection) => void,
): void {
  const currentIndex = focusQueueSectionOrder.indexOf(section)
  let nextIndex: number | undefined
  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % focusQueueSectionOrder.length
  if (event.key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + focusQueueSectionOrder.length) % focusQueueSectionOrder.length
  }
  if (event.key === 'Home') nextIndex = 0
  if (event.key === 'End') nextIndex = focusQueueSectionOrder.length - 1
  if (nextIndex === undefined) return
  const nextSection = focusQueueSectionOrder[nextIndex]
  if (!nextSection) return
  event.preventDefault()
  onSectionChange(nextSection)
  globalThis.requestAnimationFrame(() => {
    document.getElementById(`focus-queue-tab-${nextSection}`)?.focus()
  })
}
