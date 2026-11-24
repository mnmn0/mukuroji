import type { MyRequest, MyRequestDetail } from '@mukuroji/contracts'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { createTeamIssuesPath } from '../../shared/routing/paths'
import { resolveMyRequestCategoryKey, resolveMyRequestStatusKey } from '../model/myRequests'

/** Props of the "My requests" view. */
export type MyRequestsViewProps = {
  /** Requests loaded so far, newest first. */
  requests: readonly MyRequest[]
  /** Whether the first page is loading. */
  isLoading: boolean
  /** Whether the list failed to load. */
  hasLoadError: boolean
  /** Whether more pages can be loaded. */
  canLoadMore: boolean
  /** Loads the next page. */
  onLoadMore: () => void
  /** ID of the selected request. */
  selectedRequestId?: string
  /** Selects a request, or clears the selection. */
  onSelectRequest: (requestId: string | undefined) => void
  /** Detail of the selected request, once loaded. */
  selectedRequest?: MyRequestDetail
  /** Whether the selected request failed to load. */
  hasDetailError: boolean
  /** Sends a reply to the selected request. */
  onReply: (requestId: string, body: string) => Promise<void>
  /** Reader's locale, used for dates. */
  locale: Locale
  /** Message translator. */
  t: (key: MessageKey) => string
}

/**
 * Shows the requests the member sent, with the selected request's status, questions from the
 * team, reply form, and resulting Work Item.
 *
 * @param props - Requests, selection, and callbacks.
 * @returns The "My requests" list and detail.
 */
export function MyRequestsView(props: MyRequestsViewProps) {
  const { requests, selectedRequestId, t } = props
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <section
        aria-label={t('requests.mine.listLabel')}
        className={`workbench-panel grid content-start gap-2 p-4 ${selectedRequestId ? 'hidden lg:grid' : ''}`}
      >
        {props.hasLoadError ? (
          <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('requests.mine.loadError')}</p>
        ) : null}
        {!props.isLoading && !props.hasLoadError && requests.length === 0 ? (
          <p className="text-sm text-[var(--workbench-muted)]">{t('requests.mine.empty')}</p>
        ) : null}
        <ul className="grid gap-2">
          {requests.map((request) => (
            <li key={request.id}>
              <button
                aria-current={request.id === selectedRequestId ? 'true' : undefined}
                className={`grid w-full gap-1 rounded-lg border px-4 py-3 text-left ${
                  request.id === selectedRequestId
                    ? 'border-[var(--workbench-primary)] bg-[var(--workbench-surface-muted)]'
                    : 'border-[var(--workbench-border)] bg-surface'
                }`}
                onClick={() => props.onSelectRequest(request.id)}
                type="button"
              >
                <span className="text-sm font-semibold text-[var(--workbench-text)]">{request.formTitle}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-[var(--workbench-muted)]">
                  <span className="font-semibold">{t(resolveMyRequestStatusKey(request))}</span>
                  {request.awaitingReply ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-fg-amber-800">
                      {t('requests.mine.awaitingReply')}
                    </span>
                  ) : null}
                  <span>{t('requests.mine.submittedAt').replace('{date}', formatDate(request.submittedAt, props.locale))}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {props.canLoadMore ? (
          <button className="workbench-button-secondary min-h-10 justify-self-center px-4" onClick={props.onLoadMore} type="button">
            {t('requests.mine.loadMore')}
          </button>
        ) : null}
      </section>
      <section className={`workbench-panel p-5 ${selectedRequestId ? '' : 'hidden lg:block'}`}>
        {selectedRequestId ? (
          <>
            <button
              className="workbench-button-secondary mb-4 min-h-9 px-3 lg:hidden"
              onClick={() => props.onSelectRequest(undefined)}
              type="button"
            >
              {t('requests.mine.back')}
            </button>
            {props.hasDetailError ? (
              <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('requests.mine.loadError')}</p>
            ) : props.selectedRequest ? (
              <MyRequestDetailPanel
                key={props.selectedRequest.id}
                locale={props.locale}
                onReply={props.onReply}
                request={props.selectedRequest}
                t={t}
              />
            ) : null}
          </>
        ) : (
          <p className="text-sm text-[var(--workbench-muted)]">{t('requests.mine.selectPrompt')}</p>
        )}
      </section>
    </div>
  )
}

/** Props of one request's detail. */
type MyRequestDetailPanelProps = {
  /** The selected request with its thread. */
  request: MyRequestDetail
  /** Sends a reply to the request. */
  onReply: (requestId: string, body: string) => Promise<void>
  /** Reader's locale, used for dates. */
  locale: Locale
  /** Message translator. */
  t: (key: MessageKey) => string
}

/**
 * Shows one request's status, resulting Work Item, conversation, and reply form.
 *
 * @param props - Request, locale, translator, and reply callback.
 * @returns The request detail.
 */
function MyRequestDetailPanel({ request, onReply, locale, t }: MyRequestDetailPanelProps) {
  const [replyBody, setReplyBody] = useState('')
  const [isReplying, setIsReplying] = useState(false)
  const [replyState, setReplyState] = useState<'idle' | 'sent' | 'failed'>('idle')

  /** Sends the typed reply and clears the form when it succeeds. */
  const handleReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const body = replyBody.trim()
    if (!body || isReplying) return
    setIsReplying(true)
    try {
      await onReply(request.id, body)
      setReplyBody('')
      setReplyState('sent')
    } catch {
      setReplyState('failed')
    } finally {
      setIsReplying(false)
    }
  }

  const workItem = request.workItem
  return (
    <article className="grid gap-5">
      <header className="grid gap-1">
        <h2 className="text-xl font-semibold text-[var(--workbench-text)]">{request.formTitle}</h2>
        <p className="text-sm font-semibold text-[var(--workbench-text)]">{t(resolveMyRequestStatusKey(request))}</p>
        <p className="text-xs text-[var(--workbench-muted)]">
          {t('requests.mine.submittedAt').replace('{date}', formatDate(request.submittedAt, locale))}
          {' · '}
          {t('requests.mine.receipt').replace('{id}', request.receiptId)}
        </p>
      </header>
      {workItem ? (
        <section className="grid gap-2 rounded-lg border border-[var(--workbench-border)] bg-surface px-4 py-3">
          <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('requests.mine.workItemTitle')}</h3>
          {workItem.visibility === 'visible' ? (
            <>
              <p className="text-sm text-[var(--workbench-text)]">
                {workItem.key ? <span className="mr-2 font-mono text-xs">{workItem.key}</span> : null}
                {workItem.title}
              </p>
              <p className="text-xs text-[var(--workbench-muted)]">{t(resolveMyRequestCategoryKey(workItem.statusCategory))}</p>
              <Link
                className="text-sm font-semibold text-[var(--workbench-primary-text)]"
                to={createTeamIssuesPath(workItem.teamId, workItem.workItemId)}
              >
                {t('requests.mine.workItemOpenLink')}
              </Link>
            </>
          ) : (
            <>
              <p className="text-sm text-[var(--workbench-text)]">
                {workItem.completed ? t('requests.mine.workItemCompleted') : t('requests.mine.workItemOpen')}
              </p>
              <p className="text-xs text-[var(--workbench-muted)]">{t('requests.mine.workItemRestricted')}</p>
            </>
          )}
        </section>
      ) : null}
      <section className="grid gap-3">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('requests.mine.threadTitle')}</h3>
        {request.thread.messages.length === 0 ? (
          <p className="text-sm text-[var(--workbench-muted)]">{t('requests.mine.threadEmpty')}</p>
        ) : request.thread.messages.map((message) => (
          <div className="rounded-lg border border-[var(--workbench-border)] bg-surface px-4 py-3" key={message.id}>
            <p className="text-xs font-semibold text-[var(--workbench-muted)]">
              {message.direction === 'staff' ? t('requests.mine.threadStaff') : t('requests.mine.threadRequester')}
              {' · '}
              {formatDate(message.createdAt, locale)}
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--workbench-text)]">{message.body}</p>
          </div>
        ))}
      </section>
      {request.thread.status === 'open' ? (
        <form className="grid gap-3" onSubmit={(event) => void handleReply(event)}>
          <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
            {t('requests.mine.replyLabel')}
            <textarea
              className="workbench-input min-h-28 px-3 py-2"
              maxLength={4_000}
              onChange={(event) => {
                setReplyBody(event.target.value)
                setReplyState('idle')
              }}
              placeholder={t('requests.mine.replyPlaceholder')}
              required
              value={replyBody}
            />
          </label>
          {replyState === 'sent' ? (
            <p className="text-sm font-semibold text-fg-emerald-700" role="status">{t('requests.mine.replySuccess')}</p>
          ) : null}
          {replyState === 'failed' ? (
            <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('requests.mine.replyError')}</p>
          ) : null}
          <button className="workbench-button-primary min-h-11 justify-self-end px-5" disabled={isReplying} type="submit">
            {isReplying ? t('requests.mine.replySubmitting') : t('requests.mine.replySubmit')}
          </button>
        </form>
      ) : (
        <p className="text-sm text-[var(--workbench-muted)]">{t('requests.mine.threadClosed')}</p>
      )}
    </article>
  )
}

/**
 * Formats a timestamp as a short local date and time.
 *
 * @param value - ISO 8601 timestamp.
 * @param locale - Reader's locale.
 * @returns The formatted date, or the raw value when it cannot be parsed.
 */
function formatDate(value: string, locale: Locale) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}
