import type {
  CuratedContextItem,
  CuratedContextItemKind,
  CuratedContextItemState,
  CuratedContextSource,
} from '@mukuroji/contracts'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import {
  createTranslator,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../../workspace/api'
import type {
  CuratedContextRevisionHistoryState,
  IssueContextController,
} from '../mutations/useIssueContext'
import { resolveIssueMentionMemberKeys } from '../model/commentMentions'
import {
  canSubmitContextEditor,
  type IssueContextDraft,
} from '../model/contextDrafts'
import {
  advanceDeepLinkTraversal,
  type DeepLinkTraversalState,
} from '../model/deepLinkTraversal'
import { SafeCommentBody } from './SafeCommentBody'

const contextKinds: readonly CuratedContextItemKind[] = [
  'decision',
  'action',
  'risk',
  'context',
]

const mutableContextStates: readonly Exclude<
  CuratedContextItemState,
  'superseded'
>[] = ['active', 'accepted', 'completed']

/**
 * Props for the Decisions ledger.
 */
export type IssueDecisionsTabProps = {
  /** Locale used for messages and timestamps. */
  locale: Locale
  /** Workspace members used to resolve mentions. */
  members: WorkspaceMember[]
  /** Independently paginated curated context controller. */
  controller: IssueContextController
  /** Optional promoted-source draft that opens the editor. */
  draft?: IssueContextDraft
  /** Called after the promoted draft is accepted by the editor. */
  onDraftConsumed?: () => void
  /** Opens one unambiguous evidence source in the Sources tab. */
  onOpenSource?: (
    item: CuratedContextItem,
    source: CuratedContextSource,
  ) => void
  /** Context item targeted by a deep link. */
  focusedContextItemId?: string
  /** Instance-specific tab ID used when restoring focus to the tablist. */
  decisionsTabId: string
}

/**
 * Internal editor state for create, edit, and replace flows.
 */
type ContextEditorState = {
  /** Editor operation. */
  mode: 'create' | 'edit' | 'replace'
  /** Existing item edited or superseded by the operation. */
  item?: CuratedContextItem
  /** Semantic category selected by the curator. */
  kind: CuratedContextItemKind
  /** Non-superseded lifecycle state selected for an in-place edit. */
  state: Exclude<CuratedContextItemState, 'superseded'>
  /** Human-authored label. */
  title: string
  /** Human-authored Markdown explanation. */
  body: string
  /** Immutable evidence attached to the draft. */
  source?: CuratedContextSource
  /** Existing active item atomically superseded by a newly promoted evidence item. */
  supersedesItemId?: string
}

/**
 * Props for the keyed context editor that owns one user-initiated editing session.
 */
type ContextEditorFormProps = {
  /** Curated context mutation controller. */
  controller: IssueContextController
  /** Immutable starting values for this keyed editing session. */
  initialEditor: ContextEditorState
  /** Locale used for editor copy. */
  locale: Locale
  /** Workspace members used to resolve mentions. */
  members: WorkspaceMember[]
  /** Active items that an evidence-backed create operation may supersede. */
  replaceableItems: readonly CuratedContextItem[]
  /** Closes the current editing session after cancel or a successful save. */
  onClose: () => void
}

/**
 * Renders a flat decision, action, risk, and context ledger with human-only editing.
 *
 * @param props - Context data, editor draft, locale, and cross-tab navigation.
 * @returns The Decisions tab.
 */
export function IssueDecisionsTab({
  controller,
  decisionsTabId,
  draft,
  focusedContextItemId,
  locale,
  members,
  onDraftConsumed,
  onOpenSource,
}: IssueDecisionsTabProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const panelInstanceId = useId()
  const [editorRequest, setEditorRequest] = useState<ContextEditorState>()
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const editorReturnFocusRef = useRef<HTMLElement | undefined>(undefined)
  const handledFocusTargetRef = useRef<string | undefined>(undefined)
  const [deepLinkExhausted, setDeepLinkExhausted] = useState(false)
  const deepLinkTraversalRef = useRef<DeepLinkTraversalState>({
    requestedPages: 0,
  })
  const initialEditor: ContextEditorState | undefined =
    editorRequest ??
    (draft ? { ...draft, mode: 'create', state: 'active' } : undefined)

  useEffect(() => {
    if (!focusedContextItemId) {
      handledFocusTargetRef.current = undefined
      deepLinkTraversalRef.current = { requestedPages: 0 }
      queueMicrotask(() => setDeepLinkExhausted(false))
      return
    }
    if (
      handledFocusTargetRef.current === focusedContextItemId ||
      controller.isLoading
    ) {
      return
    }
    const target = document.getElementById(
      createContextItemAnchorId(panelInstanceId, focusedContextItemId),
    )

    const traversal = advanceDeepLinkTraversal(
      deepLinkTraversalRef.current,
      focusedContextItemId,
      !target && controller.hasMore && !controller.isLoadingMore,
    )
    deepLinkTraversalRef.current = traversal.state

    if (traversal.shouldLoad) {
      void controller.loadMore()
      return
    }

    if (!target) {
      queueMicrotask(() => setDeepLinkExhausted(traversal.exhausted))
      return
    }
    queueMicrotask(() => setDeepLinkExhausted(false))
    handledFocusTargetRef.current = focusedContextItemId
    const frameId = window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: 'center', behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [
    controller,
    controller.hasMore,
    controller.isLoading,
    controller.isLoadingMore,
    controller.items,
    focusedContextItemId,
    panelInstanceId,
  ])

  /**
   * Opens an editor and remembers the control that should regain focus.
   *
   * @param trigger - User-activated control that opened the editor.
   * @param request - Immutable values for the new editing session.
   */
  function openEditor(trigger: HTMLElement, request: ContextEditorState) {
    editorReturnFocusRef.current = trigger
    setEditorRequest(request)
  }

  /**
   * Closes the editor and returns keyboard focus after its DOM is removed.
   */
  function closeEditor() {
    const returnTarget = editorReturnFocusRef.current
    const hasExplicitEditorRequest = editorRequest !== undefined
    if (hasExplicitEditorRequest) setEditorRequest(undefined)
    else if (draft) onDraftConsumed?.()

    window.requestAnimationFrame(() => {
      if (returnTarget?.isConnected) {
        returnTarget.focus()
        return
      }
      const fallback =
        (draft?.returnFocusId
          ? document.getElementById(draft.returnFocusId)
          : null) ??
        createButtonRef.current ??
        document.getElementById(decisionsTabId)
      fallback?.focus()
    })
  }

  return (
    <section
      aria-busy={controller.isLoading || controller.isLoadingMore}
      aria-label={t('collaboration.tabs.decisions')}
      className="px-5 py-4"
      data-testid="issue-decisions-tab"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[28rem] text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('collaboration.decisions.description')}
        </p>
        {controller.capabilities.canCreate ? (
          <button
            className="workbench-button-secondary min-h-[44px] px-3 text-xs"
            onClick={(event) =>
              openEditor(event.currentTarget, {
                body: '',
                kind: 'decision',
                mode: 'create',
                state: 'active',
                title: '',
              })
            }
            ref={createButtonRef}
            type="button"
          >
            {t('collaboration.decisions.create')}
          </button>
        ) : null}
      </div>
      {deepLinkExhausted ? (
        <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
          {t('collaboration.deepLink.exhausted')}
        </p>
      ) : null}

      {controller.hasLoadError ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-red-200 bg-red-50 px-3 py-2.5" role="alert">
          <p className="text-sm font-semibold text-red-700">
            {t('collaboration.decisions.error')}
          </p>
          <button
            className="min-h-[44px] text-xs font-bold text-red-700 underline underline-offset-2"
            onClick={() => void controller.refresh()}
            type="button"
          >
            {t('collaboration.retry')}
          </button>
        </div>
      ) : null}
      {controller.hasMutationError ? (
        <p
          className="mt-4 border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-700"
          role="alert"
        >
          {t(
            controller.mutationErrorStatus === 409
              ? 'collaboration.error.conflict'
              : 'collaboration.error.mutation',
          )}
        </p>
      ) : null}

      {initialEditor ? (
        <ContextEditorForm
          controller={controller}
          initialEditor={initialEditor}
          key={createContextEditorKey(draft, initialEditor)}
          locale={locale}
          members={members}
          onClose={closeEditor}
          replaceableItems={controller.items.filter(
            (item) => item.state !== 'superseded',
          )}
        />
      ) : null}

      {controller.hasLoadError ? null : controller.isLoading ? (
        <div className="mt-4 grid gap-2" aria-hidden="true">
          <div className="h-20 motion-safe:animate-pulse bg-[var(--workbench-surface-muted)]" />
          <div className="h-20 motion-safe:animate-pulse bg-[var(--workbench-surface-muted)]" />
        </div>
      ) : controller.items.length > 0 ? (
        <ol className="mt-4 divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
          {controller.items.map((item) => (
            <li
              className="min-w-0 py-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--workbench-primary)] focus-visible:ring-offset-2"
              id={createContextItemAnchorId(panelInstanceId, item.id)}
              key={item.id}
              tabIndex={-1}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className={createContextKindClassName(item.kind)}>
                  {t(`collaboration.decisions.kind.${item.kind}`)}
                </span>
                <span className="text-[0.68rem] font-semibold text-[var(--workbench-muted)]">
                  {t(`collaboration.decisions.state.${item.state}`)}
                </span>
                <time
                  className="ml-auto text-[0.68rem] font-medium text-[var(--workbench-muted-soft)]"
                  dateTime={item.updatedAt}
                >
                  {formatContextDate(item.updatedAt, locale)}
                </time>
              </div>
              <h3 className="mt-2 text-sm font-semibold leading-5 text-[var(--workbench-text)]">
                {item.title}
              </h3>
              <SafeCommentBody bodyMarkdown={item.body} className="mt-1.5" />
              <p className="mt-2 text-[0.68rem] font-medium text-[var(--workbench-muted)]">
                {t('collaboration.decisions.updatedBy')
                  .replace('{actor}', item.updatedBy.displayName)
                  .replace('{revision}', String(item.revision))}
              </p>
              {item.supersededByItemId ? (
                <a
                  className="mt-2 inline-flex min-h-[44px] items-center text-xs font-semibold text-[var(--workbench-primary)] underline underline-offset-2"
                  href={`#${createContextItemAnchorId(panelInstanceId, item.supersededByItemId)}`}
                >
                  {t('collaboration.decisions.openReplacement')}
                </a>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-x-3">
                {item.source && onOpenSource ? (
                  <a
                    className="inline-flex min-h-[44px] items-center text-xs font-semibold text-[var(--workbench-primary)] underline underline-offset-2"
                    href={createContextSourcePermalink(item, item.source)}
                    onClick={(event) => {
                      event.preventDefault()
                      if (item.source) onOpenSource(item, item.source)
                    }}
                  >
                    {t('collaboration.decisions.openSource')}
                  </a>
                ) : null}
                {controller.capabilities.canEdit && item.state !== 'superseded' ? (
                  <button
                    className="min-h-[44px] text-xs font-semibold text-[var(--workbench-muted)] underline underline-offset-2"
                    onClick={(event) =>
                      openEditor(event.currentTarget, {
                        body: item.body,
                        item,
                        kind: item.kind,
                        mode: 'edit',
                        source: item.source,
                        state: readMutableContextState(item.state) ?? 'active',
                        title: item.title,
                      })
                    }
                    type="button"
                  >
                    {t('collaboration.decisions.edit')}
                  </button>
                ) : null}
                {controller.capabilities.canReplace && item.state !== 'superseded' ? (
                  <button
                    className="min-h-[44px] text-xs font-semibold text-[var(--workbench-muted)] underline underline-offset-2"
                    onClick={(event) =>
                      openEditor(event.currentTarget, {
                        body: item.body,
                        item,
                        kind: item.kind,
                        mode: 'replace',
                        source: item.source,
                        state: 'active',
                        title: item.title,
                      })
                    }
                    type="button"
                  >
                    {t('collaboration.decisions.replace')}
                  </button>
                ) : null}
                {item.revision > 1 ? (
                  <button
                    aria-controls={createContextHistoryPanelId(panelInstanceId, item.id)}
                    aria-expanded={
                      controller.revisionHistory.contextItemId === item.id
                    }
                    className="min-h-[44px] text-xs font-semibold text-[var(--workbench-muted)] underline underline-offset-2"
                    id={createContextHistoryButtonId(panelInstanceId, item.id)}
                    onClick={() => {
                      if (controller.revisionHistory.contextItemId === item.id) {
                        controller.closeRevisionHistory()
                      } else {
                        controller.openRevisionHistory(item.id)
                      }
                    }}
                    type="button"
                  >
                    {t(
                      controller.revisionHistory.contextItemId === item.id
                        ? 'collaboration.decisions.history.hide'
                        : 'collaboration.decisions.history.show',
                    )}
                  </button>
                ) : null}
              </div>
              {controller.revisionHistory.contextItemId === item.id ? (
                <ContextRevisionHistory
                  currentItem={item}
                  history={controller.revisionHistory}
                  instanceId={panelInstanceId}
                  locale={locale}
                  onLoadMore={controller.loadMoreRevisions}
                  onRetry={controller.retryRevisionHistory}
                  t={t}
                />
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <div className="mt-4 border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] px-4 py-7 text-center">
          <p className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('collaboration.decisions.empty.title')}
          </p>
          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
            {t(
              controller.capabilities.canCreate
                ? 'collaboration.decisions.empty.description'
                : 'collaboration.decisions.empty.readOnlyDescription',
            )}
          </p>
        </div>
      )}

      {controller.hasMore ? (
        <button
          className="mt-4 min-h-[44px] text-sm font-semibold text-[var(--workbench-primary)] underline underline-offset-2 disabled:opacity-60"
          disabled={controller.isLoadingMore}
          onClick={() => void controller.loadMore()}
          type="button"
        >
          {t(
            controller.isLoadingMore
              ? 'collaboration.loadingMore'
              : 'collaboration.decisions.loadEarlier',
          )}
        </button>
      ) : null}
    </section>
  )
}

/**
 * Props for one selected curated item's immutable revision ledger.
 */
type ContextRevisionHistoryProps = {
  /** Current item already rendered above the history. */
  currentItem: CuratedContextItem
  /** Lazy cursor state for the selected item. */
  history: CuratedContextRevisionHistoryState
  /** React instance identifier used to isolate DOM IDs between panels. */
  instanceId: string
  /** Locale used for audit timestamps. */
  locale: Locale
  /** Loads the next page of older snapshots. */
  onLoadMore: () => Promise<void>
  /** Retries the first or latest failed history request. */
  onRetry: () => Promise<void>
  /** Collaboration translator. */
  t: (key: MessageKey) => string
}

/**
 * Renders prior item snapshots as a bounded, newest-first audit ledger.
 *
 * @param props - Current item, lazy history state, and pagination actions.
 * @returns Accessible revision history region.
 */
function ContextRevisionHistory({
  currentItem,
  history,
  instanceId,
  locale,
  onLoadMore,
  onRetry,
  t,
}: ContextRevisionHistoryProps) {
  const priorRevisions = history.items.filter(
    (item) => item.revision < currentItem.revision,
  )

  return (
    <section
      aria-busy={history.isLoading || history.isLoadingMore}
      aria-labelledby={createContextHistoryButtonId(instanceId, currentItem.id)}
      className="mt-3 border-l-2 border-[var(--workbench-border-strong)] pl-3"
      id={createContextHistoryPanelId(instanceId, currentItem.id)}
    >
      <h4 className="py-2 text-xs font-semibold text-[var(--workbench-text)]">
        {t('collaboration.decisions.history.title')}
      </h4>
      {history.hasLoadError ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-y border-red-200 bg-red-50 py-2"
          role="alert"
        >
          <p className="text-xs font-semibold text-red-700">
            {t('collaboration.decisions.history.error')}
          </p>
          <button
            className="min-h-[44px] text-xs font-bold text-red-700 underline underline-offset-2"
            onClick={() => void onRetry()}
            type="button"
          >
            {t('collaboration.retry')}
          </button>
        </div>
      ) : history.isLoading ? (
        <p
          className="min-h-[44px] py-3 text-xs font-medium text-[var(--workbench-muted)]"
          role="status"
        >
          {t('collaboration.decisions.history.loading')}
        </p>
      ) : priorRevisions.length === 0 ? (
        <p className="min-h-[44px] py-3 text-xs font-medium text-[var(--workbench-muted)]">
          {t('collaboration.decisions.history.empty')}
        </p>
      ) : (
        <ol className="divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
          {priorRevisions.map((revision) => (
            <li className="py-3" key={revision.revision}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[0.68rem] font-bold text-[var(--workbench-muted)]">
                  {t('collaboration.decisions.history.revision').replace(
                    '{revision}',
                    String(revision.revision),
                  )}
                </span>
                <span className="text-[0.68rem] font-semibold text-[var(--workbench-muted)]">
                  {t(`collaboration.decisions.state.${revision.state}`)}
                </span>
                <time
                  className="ml-auto text-[0.68rem] text-[var(--workbench-muted-soft)]"
                  dateTime={revision.updatedAt}
                >
                  {formatContextDateTime(revision.updatedAt, locale)}
                </time>
              </div>
              <h5 className="mt-1.5 text-xs font-semibold leading-5 text-[var(--workbench-text)]">
                {revision.title}
              </h5>
              <SafeCommentBody
                bodyMarkdown={revision.body}
                className="mt-1 text-xs"
              />
              <p className="mt-1 text-[0.68rem] text-[var(--workbench-muted)]">
                {t('collaboration.decisions.history.changedBy').replace(
                  '{actor}',
                  revision.updatedBy.displayName,
                )}
              </p>
              {revision.source ? (
                <ContextRevisionSource source={revision.source} t={t} />
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {!history.hasLoadError && !history.isLoading && history.hasMore ? (
        <button
          className="min-h-[44px] text-xs font-semibold text-[var(--workbench-primary)] underline underline-offset-2 disabled:opacity-60"
          disabled={history.isLoadingMore}
          onClick={() => void onLoadMore()}
          type="button"
        >
          {t(
            history.isLoadingMore
              ? 'collaboration.loadingMore'
              : 'collaboration.decisions.history.loadEarlier',
          )}
        </button>
      ) : null}
    </section>
  )
}

/**
 * Props for provenance captured on an immutable context revision.
 */
type ContextRevisionSourceProps = {
  /** Permission-filtered source snapshot. */
  source: CuratedContextSource
  /** Collaboration translator. */
  t: (key: MessageKey) => string
}

/**
 * Renders captured evidence without revealing content after permission loss.
 *
 * @param props - Permission-filtered provenance snapshot and translator.
 * @returns Compact evidence block for one immutable revision.
 */
function ContextRevisionSource({ source, t }: ContextRevisionSourceProps) {
  const capturedEvidence = source.quote?.text ?? source.originalBody
  const sensitiveContentIsRedacted =
    source.availability === 'permission-lost' ||
    ((source.availability === 'deleted' ||
      source.availability === 'retention-expired') &&
      !capturedEvidence)

  return (
    <div className="mt-2 border-l-[3px] border-[#99d7cf] pl-3">
      <div className="flex flex-wrap items-center gap-2 text-[0.68rem] font-semibold text-[var(--workbench-muted)]">
        <span>{t(`collaboration.sources.kind.${source.kind}`)}</span>
        <span>{t(`collaboration.sources.availability.${source.availability}`)}</span>
        {source.capturedRevision !== undefined ? (
          <span>
            {t('collaboration.sources.revisionValue').replace(
              '{revision}',
              String(source.capturedRevision),
            )}
          </span>
        ) : null}
      </div>
      {source.availabilityReason ? (
        <p className="mt-1 text-[0.68rem] leading-5 text-[var(--workbench-muted)]">
          {source.availabilityReason}
        </p>
      ) : null}
      {sensitiveContentIsRedacted ? (
        <p className="mt-1 text-[0.68rem] leading-5 text-[var(--workbench-muted)]">
          {t('collaboration.sources.sensitiveRedacted')}
        </p>
      ) : capturedEvidence ? (
        <SafeCommentBody
          bodyMarkdown={capturedEvidence}
          className="mt-1 text-xs"
        />
      ) : (
        <p className="mt-1 text-[0.68rem] text-[var(--workbench-muted)]">
          {t('collaboration.sources.noQuote')}
        </p>
      )}
    </div>
  )
}

/**
 * Renders one keyed editing session without synchronizing draft props through an effect.
 *
 * @param props - Initial editor values, mutation controller, members, and close event.
 * @returns The context create, edit, or replace form.
 */
function ContextEditorForm({
  controller,
  initialEditor,
  locale,
  members,
  onClose,
  replaceableItems,
}: ContextEditorFormProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const editorInstanceId = useId()
  const quoteErrorId = `context-source-quote-error-${encodeURIComponent(editorInstanceId)}`
  const [editor, setEditor] = useState<ContextEditorState>(
    () => initialEditor,
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const sourceQuoteIsValid = isSourceQuoteValid(editor.source)
  const editorIsAuthorized = canSubmitContextEditor(
    editor.mode,
    editor.supersedesItemId,
    controller.capabilities,
  )
  const editorControlsAreDisabled = isSubmitting || !editorIsAuthorized

  /**
   * Submits the current create, edit, or replace operation.
   *
   * @param event - Native editor form submission.
   */
  async function submitEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      !editorIsAuthorized ||
      !editor.title.trim() ||
      !editor.body.trim() ||
      !sourceQuoteIsValid
    ) {
      return
    }

    setIsSubmitting(true)
    const mentionMemberKeys = resolveIssueMentionMemberKeys(
      editor.body,
      members.map((member) => member.memberKey),
      members,
    )
    const succeeded =
      editor.mode === 'edit' && editor.item
        ? await controller.updateItem(editor.item, {
            body: editor.body.trim(),
            expectedRevision: editor.item.revision,
            kind: editor.kind,
            mentionMemberKeys,
            state: editor.state,
            title: editor.title.trim(),
          })
        : await controller.createItem({
            body: editor.body.trim(),
            kind: editor.kind,
            mentionMemberKeys,
            ...(editor.mode === 'create' && editor.source
              ? { source: editor.source }
              : {}),
            ...(editor.mode === 'replace' && editor.item
              ? { supersedesItemId: editor.item.id }
              : editor.mode === 'create' && editor.supersedesItemId
                ? { supersedesItemId: editor.supersedesItemId }
                : {}),
            title: editor.title.trim(),
          })
    setIsSubmitting(false)

    if (succeeded) onClose()
  }

  return (
    <form
      className="mt-4 grid gap-3 border-y border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] py-4"
      onSubmit={(event) => void submitEditor(event)}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
          {t(`collaboration.decisions.editor.${editor.mode}`)}
        </h3>
        <button
          className="min-h-[44px] text-xs font-semibold text-[var(--workbench-muted)]"
          onClick={onClose}
          type="button"
        >
          {t('collaboration.cancel')}
        </button>
      </div>
      {!editorIsAuthorized ? (
        <p
          className="border border-[var(--workbench-border-strong)] bg-white px-3 py-2.5 text-xs font-semibold leading-5 text-[var(--workbench-muted)]"
          role="status"
        >
          {t('collaboration.decisions.editor.permissionLost')}
        </p>
      ) : null}
      <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
        {t('collaboration.decisions.kind')}
        <select
          className="workbench-input min-h-[44px]"
          disabled={editorControlsAreDisabled}
          onChange={(event) => {
            const kind = readContextKind(event.target.value)
            if (kind) setEditor((current) => ({ ...current, kind }))
          }}
          value={editor.kind}
        >
          {contextKinds.map((kind) => (
            <option key={kind} value={kind}>
              {t(`collaboration.decisions.kind.${kind}`)}
            </option>
          ))}
        </select>
      </label>
      {editor.mode === 'edit' ? (
        <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
          {t('collaboration.decisions.state')}
          <select
            className="workbench-input min-h-[44px]"
            disabled={editorControlsAreDisabled}
            onChange={(event) => {
              const state = readMutableContextState(event.target.value)
              if (state) setEditor((current) => ({ ...current, state }))
            }}
            value={editor.state}
          >
            {mutableContextStates.map((state) => (
              <option key={state} value={state}>
                {t(`collaboration.decisions.state.${state}`)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
        {t('collaboration.decisions.title')}
        <input
          autoFocus
          className="workbench-input min-h-[44px]"
          disabled={editorControlsAreDisabled}
          maxLength={200}
          onChange={(event) =>
            setEditor((current) => ({
              ...current,
              title: event.target.value,
            }))
          }
          required
          value={editor.title}
        />
      </label>
      {editor.mode === 'create' &&
      editor.source &&
      controller.capabilities.canReplace &&
      replaceableItems.length > 0 ? (
        <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
          {t('collaboration.decisions.supersedesOptional')}
          <select
            className="workbench-input min-h-[44px]"
            disabled={editorControlsAreDisabled}
            onChange={(event) =>
              setEditor((current) => ({
                ...current,
                supersedesItemId: event.target.value || undefined,
              }))
            }
            value={editor.supersedesItemId ?? ''}
          >
            <option value="">
              {t('collaboration.decisions.supersedesNone')}
            </option>
            {replaceableItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <span className="font-medium leading-5 text-[var(--workbench-muted)]">
            {t('collaboration.decisions.supersedesHelp')}
          </span>
        </label>
      ) : null}
      <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
        {t('collaboration.decisions.body')}
        <textarea
          className="workbench-input min-h-28 resize-y py-2"
          disabled={editorControlsAreDisabled}
          maxLength={20_000}
          onChange={(event) =>
            setEditor((current) => ({
              ...current,
              body: event.target.value,
            }))
          }
          required
          value={editor.body}
        />
      </label>
      {editor.source ? (
        <div className="grid gap-2 border-l-[3px] border-[var(--workbench-primary)] pl-3">
          <p className="text-xs leading-5 text-[var(--workbench-muted)]">
            {t('collaboration.decisions.sourceAttached')}{' '}
            {t(`collaboration.sources.kind.${editor.source.kind}`)}
          </p>
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-text)]">
            {t('collaboration.decisions.quote')}
            <textarea
              aria-describedby={
                sourceQuoteIsValid
                  ? undefined
                  : quoteErrorId
              }
              className="workbench-input min-h-20 resize-y py-2"
              disabled={
                editorControlsAreDisabled ||
                editor.mode !== 'create' ||
                !editor.source.originalBody
              }
              maxLength={20_000}
              onChange={(event) => {
                const quote = event.target.value
                setEditor((current) =>
                  current.source
                    ? {
                        ...current,
                        source: updateContextSourceQuote(
                          current.source,
                          quote,
                        ),
                      }
                    : current,
                )
              }}
              value={editor.source.quote?.text ?? ''}
            />
          </label>
          {!sourceQuoteIsValid ? (
            <p
              className="text-xs font-semibold text-red-700"
              id={quoteErrorId}
              role="alert"
            >
              {t('collaboration.decisions.quoteInvalid')}
            </p>
          ) : null}
          {!editor.source.originalBody ? (
            <p className="text-[0.68rem] text-[var(--workbench-muted)]">
              {t('collaboration.decisions.quoteImmutable')}
            </p>
          ) : null}
          {editor.mode !== 'create' ? (
            <p className="text-[0.68rem] text-[var(--workbench-muted)]">
              {t('collaboration.decisions.sourcePreserved')}
            </p>
          ) : null}
        </div>
      ) : null}
      <button
        className="workbench-button-primary min-h-[44px] justify-self-start px-4"
        data-testid="context-editor-submit"
        disabled={
          isSubmitting ||
          !editorIsAuthorized ||
          !editor.title.trim() ||
          !editor.body.trim() ||
          !sourceQuoteIsValid
        }
        type="submit"
      >
        {t(
          isSubmitting
            ? 'collaboration.saving'
            : 'collaboration.decisions.save',
        )}
      </button>
    </form>
  )
}

/**
 * Builds the React key that defines one immutable context-editor starting point.
 *
 * @param draft - Optional externally or internally promoted source draft.
 * @param editor - Initial editor values rendered for the session.
 * @returns Stable key that remounts the editor when the starting point changes.
 */
function createContextEditorKey(
  draft: IssueContextDraft | undefined,
  editor: ContextEditorState,
): string {
  return [
    draft ? 'draft' : 'editor',
    editor.mode,
    editor.item?.id ?? 'new',
    editor.kind,
    editor.title,
    editor.body,
    editor.source?.kind ?? draft?.source?.kind ?? 'manual',
    editor.source?.sourceId ?? draft?.source?.sourceId ?? 'new',
    editor.source?.capturedRevision ?? draft?.source?.capturedRevision ?? '',
    editor.source?.quote?.text ?? draft?.source?.quote?.text ?? '',
  ].join(':')
}

/**
 * Reads an editor select value without asserting an untrusted string.
 *
 * @param value - Select value.
 * @returns A supported context kind or undefined.
 */
function readContextKind(value: string): CuratedContextItemKind | undefined {
  return contextKinds.find((kind) => kind === value)
}

/**
 * Reads an editor select value as a lifecycle state that can be updated in place.
 *
 * @param value - Select value from the edit form.
 * @returns A supported non-superseded state or undefined.
 */
function readMutableContextState(
  value: string,
): Exclude<CuratedContextItemState, 'superseded'> | undefined {
  return mutableContextStates.find((state) => state === value)
}

/**
 * Updates a source quote only when it is a continuous substring of the captured original.
 *
 * @param source - Immutable provenance source being curated.
 * @param quoteText - Human-selected continuous excerpt.
 * @returns Source with an updated quote and exact UTF-16 offsets.
 */
function updateContextSourceQuote(
  source: CuratedContextSource,
  quoteText: string,
): CuratedContextSource {
  if (!quoteText) return { ...source, quote: undefined }
  const startOffset = source.originalBody?.indexOf(quoteText) ?? -1

  return startOffset < 0
    ? { ...source, quote: { text: quoteText } }
    : {
        ...source,
        quote: {
          endOffset: startOffset + quoteText.length,
          startOffset,
          text: quoteText,
        },
      }
}

/**
 * Checks that a mutable quote remains an exact continuous range of its captured original.
 *
 * @param source - Source currently attached to the editor.
 * @returns Whether the quote can be saved without falsifying provenance.
 */
function isSourceQuoteValid(source: CuratedContextSource | undefined): boolean {
  if (!source?.quote?.text || !source.originalBody) return true
  return source.originalBody.includes(source.quote.text)
}

/**
 * Creates a stable focus anchor for one curated item.
 *
 * @param instanceId - React instance identifier for this Decisions panel.
 * @param itemId - Curated item identifier.
 * @returns DOM-safe anchor ID.
 */
function createContextItemAnchorId(instanceId: string, itemId: string): string {
  return `context-item-${encodeURIComponent(instanceId)}-${encodeURIComponent(itemId)}`
}

/**
 * Creates the toggle ID that labels one revision history region.
 *
 * @param instanceId - React instance identifier for this Decisions panel.
 * @param itemId - Curated context item identifier.
 * @returns DOM-safe history toggle ID.
 */
function createContextHistoryButtonId(instanceId: string, itemId: string): string {
  return `context-history-toggle-${encodeURIComponent(instanceId)}-${encodeURIComponent(itemId)}`
}

/**
 * Creates the controlled region ID for one revision history.
 *
 * @param instanceId - React instance identifier for this Decisions panel.
 * @param itemId - Curated context item identifier.
 * @returns DOM-safe history panel ID.
 */
function createContextHistoryPanelId(instanceId: string, itemId: string): string {
  return `context-history-panel-${encodeURIComponent(instanceId)}-${encodeURIComponent(itemId)}`
}

/**
 * Creates a copyable route to one exact item-owned provenance snapshot.
 *
 * @param item - Curated context item that owns the snapshot.
 * @param source - Displayed source discriminator retained for legacy lookup.
 * @returns Same-pane route with context-item identity as its primary key.
 */
function createContextSourcePermalink(
  item: CuratedContextItem,
  source: CuratedContextSource,
): string {
  const search = new URLSearchParams(
    typeof window === 'undefined' ? '' : window.location.search,
  )
  search.set('collaborationTab', 'sources')
  search.set('contextItemId', item.id)
  search.set('sourceId', source.sourceId)
  search.set('sourceKind', source.kind)
  search.delete('activityEventId')
  search.delete('commentId')
  search.delete('rootCommentId')
  return `?${search.toString()}`
}

/**
 * Selects an existing semantic badge style without introducing a new palette.
 *
 * @param kind - Curated item semantic kind.
 * @returns Workbench badge class name.
 */
function createContextKindClassName(kind: CuratedContextItemKind): string {
  if (kind === 'decision') return 'workbench-badge-primary'
  if (kind === 'action') return 'workbench-badge-success'
  if (kind === 'risk') return 'workbench-badge-warning'
  return 'workbench-badge'
}

/**
 * Formats one curated item timestamp.
 *
 * @param value - ISO timestamp.
 * @param locale - Application locale.
 * @returns Localized compact timestamp.
 */
function formatContextDate(value: string, locale: Locale): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

/**
 * Formats an immutable revision timestamp with both date and time.
 *
 * @param value - ISO timestamp.
 * @param locale - Application locale.
 * @returns Localized audit timestamp.
 */
function formatContextDateTime(value: string, locale: Locale): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}
