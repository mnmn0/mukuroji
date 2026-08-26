import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import type {
  AiAssistanceCitation,
  AiSummaryDraft,
  AiWorkItemSource,
  CuratedContextSource,
} from '@mukuroji/contracts'
import { createAiAssistantSessionKey } from '../../features/ai-assistance/model/assistantSessionKey'
import { AiSummaryAssistant } from '../../features/ai-assistance/ui/AiSummaryAssistant'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { WatchIcon } from '../../shared/ui/icons'
import type { WorkspaceMember } from '../../workspace/api'
import type { IssueCollaborationController } from '../mutations/useIssueCollaboration'
import type { TeamIssueActivityEvent, TeamIssueComment } from '../api'
import {
  issueCollaborationTabs,
  resolveIssueCollaborationTabTarget,
  type IssueCollaborationRoute,
  type IssueCollaborationTab,
} from '../model/collaborationTabs'
import {
  createActivityContextSource,
  type IssueContextDraft,
} from '../model/contextDrafts'
import {
  createIssueSourceEntries,
  resolveIssueSourceFocus,
  type IssueSourceTarget,
} from '../model/contextSources'
import { IssueActivityTab } from './IssueActivityTab'
import { IssueConversationTab } from './IssueConversationTab'
import { IssueDecisionsTab } from './IssueDecisionsTab'
import { IssueSourcesTab } from './IssueSourcesTab'

/**
 * Authentication and revision-fenced source for an optional Work Item brief.
 *
 * The source is rendered only when the parent route has already resolved the
 * current viewer's permission-safe context.
 */
export type IssueSummaryAiAssistance = {
  /** Active Workspace member bearer token. */
  accessToken: string
  /** Work Item reference resolved and re-authorized by the server. */
  source: AiWorkItemSource
}

/**
 * Props for the Work Item collaboration panel.
 *
 * The panel owns presentation and local draft promotion while existing
 * collaboration controllers remain the only mutation boundary.
 */
export type IssueCollaborationPanelProps = {
  /** Optional AI summary access; omission removes the Brief tab and its source from markup. */
  aiAssistance?: IssueSummaryAiAssistance
  /** Reports authenticated AI failures to the owning route session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
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
  /** Route-owned collaboration state for this detail pane. */
  route?: IssueCollaborationRoute
  /** Optional initial tab for uncontrolled rendering. */
  defaultTab?: IssueCollaborationTab
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
 * @remarks The optional Brief tab is permission-gated and its Add as draft
 * action opens the existing Decisions editor without writing a ledger entry.
 *
 * @param props - Collaboration data, locale, deep-link targets, and actions.
 * @returns The collaboration panel.
 */
export function IssueCollaborationPanel({
  aiAssistance,
  artifacts,
  className = '',
  contextDraft: externalContextDraft,
  controller,
  currentMemberKey,
  defaultTab = 'conversation',
  focusedCommentId,
  focusedRootCommentId,
  locale,
  members,
  onAuthenticatedApiError,
  onContextDraftConsumed,
  readOnlyMessage,
  route,
}: IssueCollaborationPanelProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [uncontrolledTab, setUncontrolledTab] = useState(defaultTab)
  const [promotedContextDraft, setPromotedContextDraft] =
    useState<IssueContextDraft>()
  const [selectedSource, setSelectedSource] = useState<IssueSourceTarget>()
  const [hasOverriddenDraftTab, setHasOverriddenDraftTab] = useState(false)
  const contextDraft = externalContextDraft ?? promotedContextDraft
  const panelIdPrefix = useId()
  const aiAssistantSessionKey = aiAssistance
    ? createAiAssistantSessionKey(aiAssistance.source)
    : undefined
  const activeAiAssistantSessionKeyRef = useRef(aiAssistantSessionKey)
  const visibleTabs = aiAssistance
    ? [...issueCollaborationTabs]
    : issueCollaborationTabs.filter((tab) => tab !== 'brief')
  const requestedTab = contextDraft && !hasOverriddenDraftTab
    ? 'decisions'
    : route?.collaborationTab ?? uncontrolledTab
  const selectedTab = requestedTab === 'brief' && !aiAssistance
    ? 'conversation'
    : requestedTab
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
    brief: 0,
    conversation: threadCount,
    decisions: controller.context.items.length,
    sources: createIssueSourceEntries(controller.context.items).length,
  }
  const sourceFocus = resolveIssueSourceFocus(
    {
      contextItemId: route?.focusedContextItemId,
      kind: route?.focusedSourceKind,
      sourceId: route?.focusedSourceId,
    },
    route?.onCollaborationSourceChange ? undefined : selectedSource,
  )

  useEffect(() => {
    activeAiAssistantSessionKeyRef.current = aiAssistantSessionKey
  }, [aiAssistantSessionKey])

  /**
   * Opens a human-curated editor backed by immutable source provenance.
   *
   * @param source - Comment or activity evidence captured by the caller.
   */
  function promoteSource(source: CuratedContextSource) {
    setPromotedContextDraft({ body: '', kind: 'context', source, title: '' })
    setHasOverriddenDraftTab(false)
    if (route?.collaborationTab === undefined) {
      setUncontrolledTab('decisions')
    } else {
      route.onCollaborationTabChange?.('decisions')
    }
  }

  /**
   * Opens a context draft backed by one captured comment snapshot.
   *
   * @param comment - Permission-filtered comment selected by the viewer.
   */
  function promoteCommentSource(comment: TeamIssueComment) {
    const actorKey = comment.authorMemberKey
    const actor = members.find(
      (member) =>
        member.memberKey === actorKey ||
        member.id === actorKey ||
        member.email === actorKey,
    )
    const originalBody = comment.bodyMarkdown
    promoteSource({
      actor: {
        displayName: actor?.name?.trim() || actor?.email || actorKey,
        id: actorKey,
      },
      availability: comment.deletedAt ? 'deleted' : 'available',
      availabilityReason: comment.deletedAt
        ? t('collaboration.sources.commentDeletedReason')
        : undefined,
      capturedRevision: comment.version,
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
  }

  /**
   * Opens a context draft backed by one canonical activity snapshot.
   *
   * @param event - Permission-filtered audit event selected by the viewer.
   */
  function promoteActivitySource(event: TeamIssueActivityEvent) {
    const actor = members.find(
      (member) =>
        member.memberKey === event.actorUserId ||
        member.id === event.actorUserId ||
        member.email === event.actorUserId,
    )
    promoteSource(
      createActivityContextSource(event, {
        displayName:
          actor?.name?.trim() || actor?.email || event.actorUserId,
        id: event.actorUserId,
      }),
    )
  }

  /** Opens an approved AI summary in the existing human-owned context editor. */
  function openAiSummaryDraft(
    draft: AiSummaryDraft,
    citations: readonly AiAssistanceCitation[],
  ) {
    setPromotedContextDraft({
      body: formatAiSummaryContextBody(draft, citations, t),
      kind: 'context',
      title: t('ai.summary.contextDraftTitle'),
    })
    setHasOverriddenDraftTab(false)
    if (route?.collaborationTab === undefined) {
      setUncontrolledTab('decisions')
    } else {
      route.onCollaborationTabChange?.('decisions')
    }
  }

  /**
   * Selects a tab in controlled or uncontrolled mode.
   *
   * @param tab - Collaboration tab to display.
   */
  function selectTab(tab: IssueCollaborationTab) {
    if (contextDraft) setHasOverriddenDraftTab(true)
    if (route?.collaborationTab === undefined) setUncontrolledTab(tab)
    route?.onCollaborationTabChange?.(tab)
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
      visibleTabs,
    )
    if (!target) return

    event.preventDefault()
    selectTab(target)
    document.getElementById(createCollaborationTabId(panelIdPrefix, target))?.focus()
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
          {visibleTabs.map((tab) => (
            <button
              aria-controls={createCollaborationPanelId(panelIdPrefix)}
              aria-selected={selectedTab === tab}
              className={`relative inline-flex min-h-[44px] flex-none items-center gap-1.5 whitespace-nowrap px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--workbench-primary)] ${
                selectedTab === tab
                  ? 'text-[var(--workbench-primary)]'
                  : 'text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]'
              }`}
              id={createCollaborationTabId(panelIdPrefix, tab)}
              key={tab}
              onClick={() => selectTab(tab)}
              onKeyDown={(event) => handleTabKeyDown(event, tab)}
              role="tab"
              tabIndex={selectedTab === tab ? 0 : -1}
              type="button"
            >
              {t(`collaboration.tabs.${tab}`)}
              {tab === 'brief' ? null : (
                <span className="text-[0.65rem] text-[var(--workbench-muted-soft)]">
                  {tabCounts[tab]}
                </span>
              )}
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
        aria-labelledby={createCollaborationTabId(panelIdPrefix, selectedTab)}
        id={createCollaborationPanelId(panelIdPrefix)}
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
            hasResolutionError={controller.context.hasResolutionMutationError}
            locale={locale}
            members={members}
            onPromoteComment={
              controller.context.capabilities.canCreate
                ? promoteCommentSource
                : undefined
            }
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
              if (succeeded) {
                try {
                  await controller.refresh()
                } catch (refreshError) {
                  console.error(
                    'Issue collaboration revalidation failed after accepted resolution:',
                    refreshError,
                  )
                }
              }
              return succeeded
            }}
            readOnlyMessage={readOnlyMessage}
            resolutionErrorStatus={
              controller.context.resolutionMutationErrorStatus
            }
          />
        ) : null}
        {selectedTab === 'activity' ? (
          <IssueActivityTab
            controller={controller}
            focusedActivityEventId={route?.focusedActivityEventId}
            locale={locale}
            members={members}
            onPromoteActivity={
              controller.context.capabilities.canCreate
                ? promoteActivitySource
                : undefined
            }
          />
        ) : null}
        {selectedTab === 'brief' && aiAssistance && aiAssistantSessionKey ? (
          <div className="px-5 py-5">
            <AiSummaryAssistant
              accessToken={aiAssistance.accessToken}
              adoptLabel={t('ai.summary.adoptContext')}
              key={aiAssistantSessionKey}
              locale={locale}
              onAuthenticatedApiError={onAuthenticatedApiError}
              onAdopt={controller.context.capabilities.canCreate && !contextDraft
                ? (draft, citations) => {
                    if (
                      activeAiAssistantSessionKeyRef.current !==
                      aiAssistantSessionKey
                    ) return
                    openAiSummaryDraft(draft, citations)
                  }
                : undefined}
              sources={[aiAssistance.source]}
              t={t}
            />
          </div>
        ) : null}
        {selectedTab === 'decisions' ? (
          <IssueDecisionsTab
            controller={controller.context}
            decisionsTabId={createCollaborationTabId(panelIdPrefix, 'decisions')}
            draft={contextDraft}
            focusedContextItemId={route?.focusedContextItemId}
            locale={locale}
            members={members}
            onDraftConsumed={() => {
              setPromotedContextDraft(undefined)
              onContextDraftConsumed?.()
            }}
            onOpenSource={(item, source) => {
              const target = {
                contextItemId: item.id,
                kind: source.kind,
                sourceId: source.sourceId,
              }
              if (route?.onCollaborationSourceChange) {
                // The controlled route callback persists the source and tab in one
                // search-parameter update. Calling selectTab afterward would clear
                // the exact contextItemId that was just written.
                route.onCollaborationSourceChange(target)
              } else {
                setSelectedSource(target)
                selectTab('sources')
              }
            }}
          />
        ) : null}
        {selectedTab === 'sources' ? (
          <IssueSourcesTab
            controller={controller.context}
              focusedContextItemId={sourceFocus.contextItemId}
            focusedSourceId={sourceFocus.sourceId}
            focusedSourceKind={sourceFocus.kind}
            locale={locale}
          />
        ) : null}
      </div>
    </section>
  )
}

/**
 * Formats an approved summary as an editable context draft without persisting it.
 *
 * @param draft - Currently authorized summary returned after approval.
 * @param citations - Permission-safe citations returned with the approved draft.
 * @param t - Localized label resolver.
 * @returns Markdown-like plain text for the existing human-owned editor.
 */
function formatAiSummaryContextBody(
  draft: AiSummaryDraft,
  citations: readonly AiAssistanceCitation[],
  t: (key: MessageKey) => string,
): string {
  const citationById = new Map(citations.map((citation) => [citation.id, citation]))
  const formatItem = (item: AiSummaryDraft['overview']): string[] => {
    const lines = [`- ${item.text}`]
    const evidence = item.citationIds
      .map((citationId) => citationById.get(citationId))
      .filter((citation): citation is AiAssistanceCitation => citation !== undefined)
      .map((citation) => {
        const label = citation.label.replace(/[\\[\]]/gu, '\\$&')
        return `[${label}](<${escapeMarkdownLinkDestination(citation.href)}>)`
      })
    if (evidence.length > 0) lines.push(`  ${t('ai.summary.evidence')}: ${evidence.join(', ')}`)
    return lines
  }
  const sections = [
    [t('ai.summary.decisions'), draft.decisions],
    [t('ai.summary.actions'), draft.actions],
    [t('ai.summary.risks'), draft.risks],
  ] as const
  const lines = [draft.overview.text, ...formatItem(draft.overview).slice(1)]
  for (const [title, items] of sections) {
    if (items.length === 0) continue
    lines.push('', `## ${title}`, ...items.flatMap(formatItem))
  }
  return lines.join('\n')
}

/**
 * Encodes Markdown destination delimiters while preserving application routing.
 *
 * @param href - Permission-safe application path used as the link destination.
 * @returns A destination that cannot terminate or reshape the Markdown link.
 */
function escapeMarkdownLinkDestination(href: string): string {
  return href.replace(/[()<>\\\s]/gu, (character) => encodeURIComponent(character))
}

/**
 * Creates a stable collaboration tab ID.
 *
 * @param tab - Collaboration tab.
 * @returns DOM ID for the tab.
 */
function createCollaborationTabId(
  prefix: string,
  tab: IssueCollaborationTab,
): string {
  return `${prefix}-collaboration-tab-${tab}`
}

/**
 * Creates a stable collaboration tabpanel ID.
 *
 * @returns DOM ID for the tabpanel.
 */
function createCollaborationPanelId(prefix: string): string {
  return `${prefix}-collaboration-tabpanel`
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
