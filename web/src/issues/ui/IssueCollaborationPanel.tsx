import { useMemo, useState, type KeyboardEvent } from 'react'
import type { CuratedContextSource } from '@mukuroji/contracts'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { WatchIcon } from '../../shared/ui/icons'
import type { WorkspaceMember } from '../../workspace/api'
import type { IssueCollaborationController } from '../mutations/useIssueCollaboration'
import {
  issueCollaborationTabs,
  resolveIssueCollaborationTabTarget,
  type IssueCollaborationTab,
} from '../model/collaborationTabs'
import type { IssueContextDraft } from '../model/contextDrafts'
import {
  createIssueSourceEntries,
  type IssueSourceTarget,
} from '../model/contextSources'
import { IssueActivityTab } from './IssueActivityTab'
import { IssueConversationTab } from './IssueConversationTab'
import { IssueDecisionsTab } from './IssueDecisionsTab'
import { IssueSourcesTab } from './IssueSourcesTab'

/**
 * Props for the Work Item collaboration panel.
 */
export type IssueCollaborationPanelProps = {
  /** Locale used for all collaboration messages. */
  locale: Locale
  /** Workspace members used for mentions, actors, and presence. */
  members: WorkspaceMember[]
  /** Current Workspace member key. */
  currentMemberKey?: string
  /** Existing conversation, watch, presence, and activity controller. */
  controller: IssueCollaborationController
  /** Optional file controller used for comment attachments. */
  artifacts?: FileArtifactsController
  /** Reason the current viewer cannot mutate conversation content. */
  readOnlyMessage?: string
  /** Comment targeted by a notification deep link. */
  focusedCommentId?: string
  /** Root comment required to page toward a focused reply. */
  focusedRootCommentId?: string
  /** Optional controlled collaboration tab. */
  activeTab?: IssueCollaborationTab
  /** Optional initial tab for uncontrolled rendering. */
  defaultTab?: IssueCollaborationTab
  /** Called when the selected collaboration tab changes. */
  onTabChange?: (tab: IssueCollaborationTab) => void
  /** Curated context item targeted by a deep link. */
  focusedContextItemId?: string
  /** Source provenance entry targeted by a deep link. */
  focusedSourceId?: string
  /** Source category that disambiguates a deep-linked provenance entry. */
  focusedSourceKind?: IssueSourceTarget['kind']
  /** Activity event targeted by a deep link. */
  focusedActivityEventId?: string
  /** External document or chat source draft opened by an adjacent integration. */
  contextDraft?: IssueContextDraft
  /** Called after an externally supplied source draft is opened. */
  onContextDraftConsumed?: () => void
  /** Optional outer layout class name. */
  className?: string
}

/**
 * Renders one detail-pane collaboration workspace with accessible section tabs.
 *
 * @param props - Collaboration data, locale, deep-link targets, and actions.
 * @returns The collaboration panel.
 */
export function IssueCollaborationPanel({
  activeTab,
  artifacts,
  className = '',
  contextDraft: externalContextDraft,
  controller,
  currentMemberKey,
  defaultTab = 'conversation',
  focusedCommentId,
  focusedActivityEventId,
  focusedContextItemId,
  focusedRootCommentId,
  focusedSourceId,
  focusedSourceKind,
  locale,
  members,
  onTabChange,
  onContextDraftConsumed,
  readOnlyMessage,
}: IssueCollaborationPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [uncontrolledTab, setUncontrolledTab] = useState(defaultTab)
  const [promotedContextDraft, setPromotedContextDraft] =
    useState<IssueContextDraft>()
  const [selectedSource, setSelectedSource] = useState<IssueSourceTarget>()
  const contextDraft = externalContextDraft ?? promotedContextDraft
  const selectedTab = externalContextDraft
    ? 'decisions'
    : activeTab ?? uncontrolledTab
  const uniquePresence = useMemo(
    () =>
      Array.from(
        new Map(
          controller.presence.map((presence) => [presence.memberKey, presence]),
        ).values(),
      ),
    [controller.presence],
  )
  const visiblePresence = uniquePresence.filter(
    (presence) => presence.memberKey !== currentMemberKey,
  )
  const threadCount = controller.comments.filter(
    (comment) => !comment.parentCommentId,
  ).length
  const tabCounts: Record<IssueCollaborationTab, number> = {
    activity: controller.activity.length,
    conversation: threadCount,
    decisions: controller.context.items.length,
    sources: createIssueSourceEntries(controller.context.items).length,
  }

  /**
   * Opens a human-curated editor backed by immutable source provenance.
   *
   * @param source - Comment or activity evidence captured by the caller.
   */
  function promoteSource(source: CuratedContextSource) {
    setPromotedContextDraft({ body: '', kind: 'context', source, title: '' })
    selectTab('decisions')
  }

  /**
   * Selects a tab in controlled or uncontrolled mode.
   *
   * @param tab - Collaboration tab to display.
   */
  function selectTab(tab: IssueCollaborationTab) {
    if (activeTab === undefined) setUncontrolledTab(tab)
    onTabChange?.(tab)
  }

  /**
   * Applies the WAI-ARIA tab keyboard convention and moves DOM focus.
   *
   * @param event - Keyboard event raised by a tab.
   * @param tab - Tab that currently owns focus.
   */
  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    tab: IssueCollaborationTab,
  ) {
    const target = resolveIssueCollaborationTabTarget(
      tab,
      event.key,
      issueCollaborationTabs,
    )
    if (!target) return

    event.preventDefault()
    selectTab(target)
    document.getElementById(createCollaborationTabId(target))?.focus()
  }

  return (
    <section
      className={`border-t border-[var(--workbench-border)] bg-white ${className}`}
      data-testid="issue-collaboration-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h2 className="workbench-eyebrow text-[var(--workbench-muted)]">
            {t('collaboration.title')}
          </h2>
          {visiblePresence.length > 0 ? (
            <p
              className="mt-1.5 truncate text-xs font-medium text-[var(--workbench-muted)]"
              data-testid="collaboration-presence"
            >
              {t('collaboration.presence.viewing').replace(
                '{count}',
                String(visiblePresence.length),
              )}
            </p>
          ) : null}
        </div>
        {controller.watch ? (
          <button
            aria-pressed={controller.watch.subscribed}
            className={`inline-flex min-h-[44px] items-center gap-2 rounded-md border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-55 ${
              controller.watch.subscribed
                ? 'border-[#72c9bf] bg-[#e5f7f4] text-[#116b63]'
                : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:border-[#99d7cf] hover:text-[var(--workbench-text)]'
            }`}
            disabled={!controller.capabilities.canWatch}
            onClick={() => void controller.toggleWatch()}
            title={formatWatchTitle(
              controller.watch.subscribed ? controller.watch.reasons : [],
              t,
            )}
            type="button"
          >
            <WatchIcon
              className="h-4 w-4 stroke-current stroke-[1.8] [stroke-linecap:round] [stroke-linejoin:round]"
              filled={controller.watch.subscribed}
            />
            {t(
              controller.watch.subscribed
                ? 'collaboration.watch.watching'
                : 'collaboration.watch.watch',
            )}
            <span className="text-[0.68rem] opacity-75">
              {controller.watch.watcherCount}
            </span>
          </button>
        ) : null}
      </div>

      {controller.watch?.subscribed && controller.watch.automatic ? (
        <p className="mx-5 -mt-2 mb-3 text-xs font-medium text-[var(--workbench-muted)]">
          {t('collaboration.watch.automatic')}
        </p>
      ) : null}
      {controller.watch?.projectSubscribed !== undefined &&
      controller.toggleProjectWatch ? (
        <div className="mx-5 -mt-2 mb-3">
          <button
            aria-pressed={controller.watch.projectSubscribed}
            className="min-h-[44px] text-xs font-semibold text-[var(--workbench-primary)] underline underline-offset-2 disabled:opacity-55"
            data-testid="project-watch-toggle"
            disabled={!controller.capabilities.canWatch}
            onClick={() => void controller.toggleProjectWatch?.()}
            type="button"
          >
            {t(
              controller.watch.projectSubscribed
                ? 'collaboration.watch.projectWatchingButton'
                : 'collaboration.watch.projectWatch',
            )}{' '}
            ({controller.watch.projectWatcherCount ?? 0})
          </button>
        </div>
      ) : null}

      <div className="sticky top-0 z-10 border-y border-[var(--workbench-border)] bg-white px-3">
        <div
          aria-label={t('collaboration.tabs.aria')}
          className="flex min-w-0 gap-0 overflow-x-auto"
          role="tablist"
        >
          {issueCollaborationTabs.map((tab) => (
            <button
              aria-controls={createCollaborationPanelId()}
              aria-selected={selectedTab === tab}
              className={`relative inline-flex min-h-[44px] flex-none items-center gap-1.5 whitespace-nowrap px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--workbench-primary)] ${
                selectedTab === tab
                  ? 'text-[var(--workbench-primary)]'
                  : 'text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'
              }`}
              id={createCollaborationTabId(tab)}
              key={tab}
              onClick={() => selectTab(tab)}
              onKeyDown={(event) => handleTabKeyDown(event, tab)}
              role="tab"
              tabIndex={selectedTab === tab ? 0 : -1}
              type="button"
            >
              {t(`collaboration.tabs.${tab}`)}
              <span className="text-[0.65rem] text-[var(--workbench-muted-soft)]">
                {tabCounts[tab]}
              </span>
              {selectedTab === tab ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-3 bottom-0 h-0.5 bg-[var(--workbench-primary)]"
                />
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div
        aria-labelledby={createCollaborationTabId(selectedTab)}
        id={createCollaborationPanelId()}
        role="tabpanel"
      >
        {selectedTab === 'conversation' ? (
          <IssueConversationTab
            artifacts={artifacts}
            canAcceptResolution={
              controller.context.capabilities.canAcceptResolution
            }
            controller={controller}
            currentMemberKey={currentMemberKey}
            focusedCommentId={focusedCommentId}
            focusedRootCommentId={focusedRootCommentId}
            hasResolutionError={controller.context.hasMutationError}
            locale={locale}
            members={members}
            onPromoteComment={(comment) => {
              const actorKey =
                comment.authorMemberKey ??
                comment.actorUserId ??
                'unknown-member'
              const actor = members.find(
                (member) =>
                  member.memberKey === actorKey ||
                  member.id === actorKey ||
                  member.email === actorKey,
              )
              const originalBody =
                comment.bodyMarkdown ?? comment.body ?? ''
              promoteSource({
                actor: {
                  displayName:
                    actor?.name?.trim() || actor?.email || actorKey,
                  id: actorKey,
                },
                availability: comment.deletedAt ? 'deleted' : 'available',
                availabilityReason: comment.deletedAt
                  ? t('collaboration.sources.commentDeletedReason')
                  : undefined,
                capturedRevision: comment.version ?? 1,
                containerId:
                  comment.rootCommentId ?? comment.parentCommentId ?? comment.id,
                kind: 'comment',
                occurredAt: comment.createdAt,
                originalBody,
                permalink: `?commentId=${encodeURIComponent(
                  comment.id,
                )}&rootCommentId=${encodeURIComponent(
                  comment.rootCommentId ?? comment.id,
                )}`,
                quote: originalBody
                  ? {
                      endOffset: originalBody.length,
                      startOffset: 0,
                      text: originalBody,
                    }
                  : undefined,
                sourceId: comment.id,
              })
            }}
            onSetAcceptedResolution={async (
              rootComment,
              sourceComment,
              summary,
            ) => {
              const succeeded =
                await controller.context.setAcceptedResolution(
                  rootComment.id,
                  {
                    commentId: sourceComment.id,
                    expectedThreadVersion: rootComment.version ?? 1,
                    summary,
                  },
                )
              if (succeeded) await controller.refresh()
              return succeeded
            }}
            readOnlyMessage={readOnlyMessage}
            resolutionErrorStatus={controller.context.mutationErrorStatus}
          />
        ) : null}
        {selectedTab === 'activity' ? (
          <IssueActivityTab
            controller={controller}
            focusedActivityEventId={focusedActivityEventId}
            locale={locale}
            members={members}
            onPromoteActivity={(event) => {
              const actor = members.find(
                (member) =>
                  member.memberKey === event.actorUserId ||
                  member.id === event.actorUserId ||
                  member.email === event.actorUserId,
              )
              promoteSource({
                actor: {
                  displayName:
                    actor?.name?.trim() ||
                    actor?.email ||
                    event.actorUserId,
                  id: event.actorUserId,
                },
                availability: 'available',
                kind: 'activity',
                occurredAt: event.occurredAt,
                originalBody: event.summary,
                permalink: `?activityEventId=${encodeURIComponent(
                  event.eventId,
                )}`,
                quote: event.summary
                  ? {
                      endOffset: event.summary.length,
                      startOffset: 0,
                      text: event.summary,
                    }
                  : undefined,
                sourceId: event.eventId,
              })
            }}
          />
        ) : null}
        {selectedTab === 'decisions' ? (
          <IssueDecisionsTab
            controller={controller.context}
            draft={contextDraft}
            focusedContextItemId={focusedContextItemId}
            locale={locale}
            members={members}
            onDraftConsumed={() => {
              setPromotedContextDraft(undefined)
              onContextDraftConsumed?.()
            }}
            onOpenSource={(item, source) => {
              setSelectedSource({
                contextItemId: item.id,
                kind: source.kind,
                sourceId: source.sourceId,
              })
              selectTab('sources')
            }}
          />
        ) : null}
        {selectedTab === 'sources' ? (
          <IssueSourcesTab
            controller={controller.context}
            focusedContextItemId={
              selectedTab === 'sources'
                ? focusedContextItemId ?? selectedSource?.contextItemId
                : selectedSource?.contextItemId
            }
            focusedSourceId={focusedSourceId ?? selectedSource?.sourceId}
            focusedSourceKind={
              focusedSourceKind ??
              (focusedSourceId ? undefined : selectedSource?.kind)
            }
            locale={locale}
          />
        ) : null}
      </div>
    </section>
  )
}

/**
 * Creates a stable collaboration tab ID.
 *
 * @param tab - Collaboration tab.
 * @returns DOM ID for the tab.
 */
function createCollaborationTabId(tab: IssueCollaborationTab): string {
  return `issue-collaboration-tab-${tab}`
}

/**
 * Creates a stable collaboration tabpanel ID.
 *
 * @returns DOM ID for the tabpanel.
 */
function createCollaborationPanelId(): string {
  return 'issue-collaboration-tabpanel'
}

/**
 * Formats an accessible explanation for automatic watch reasons.
 *
 * @param reasons - Server-provided automatic watch reasons.
 * @param t - Collaboration translator.
 * @returns Visible tooltip content.
 */
function formatWatchTitle(
  reasons: string[],
  t: (key: MessageKey) => string,
): string {
  return reasons.length > 0
    ? `${t('collaboration.watch.automatic')}: ${reasons.join(', ')}`
    : t('collaboration.watch.watch')
}
