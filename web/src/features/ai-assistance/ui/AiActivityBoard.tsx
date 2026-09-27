import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { isSafeApplicationPath } from '../../../shared/routing/applicationPath'
import { ChevronIcon, ClockIcon, ExternalLinkIcon } from '../../../shared/ui/icons'
import {
  getAiActivityPhase, getAiActivityStatus,
  type AiActivity, type AiActivityStatus,
} from '../model/aiActivity'

/** Props for the session activity board without transport or authentication concerns. */
export type AiActivityBoardProps = {
  /** Real operations observed in the current session. */
  activities: readonly AiActivity[]
  /** Locale for observed timestamps. */
  locale: Locale
  /** Current browser clock, including retention expiry. */
  now: number
  /** Closes the board and restores the underlying screen. */
  onClose?: () => void
  /** Removes terminal session history without affecting live work. */
  onClearHistory?: () => void
  /** Returns to the source screen through the application's navigation guard. */
  onOpenOrigin?: (origin: string) => void
  /** Resolves localized activity labels. */
  t: (key: MessageKey) => string
}

/** Status order prioritizes active work and the operator's next decision. */
const statuses: readonly AiActivityStatus[] = ['running', 'review', 'paused', 'completed', 'failed']

/** Semantic color treatments always appear alongside explicit state text. */
const statusStyles: Record<AiActivityStatus, { /** State marker color. */ dot: string; /** Readable state text color. */ text: string }> = {
  running: { dot: 'bg-blue-600', text: 'text-blue-700' },
  review: { dot: 'bg-amber-500', text: 'text-amber-800' },
  paused: { dot: 'bg-slate-400', text: 'text-slate-600' },
  completed: { dot: 'bg-emerald-600', text: 'text-emerald-700' },
  failed: { dot: 'bg-red-600', text: 'text-red-700' },
}

/**
 * Renders horizontal state lanes with a companion detail pane.
 * @param props - Observed metadata, clock, and explicit navigation actions.
 * @returns A responsive activity workspace with searchable, keyboard-selectable entries.
 */
export function AiActivityBoard({ activities, locale, now, onClose, onClearHistory, onOpenOrigin, t }: AiActivityBoardProps) {
  const [selectedId, setSelectedId] = useState<string>()
  const [filter, setFilter] = useState<'all' | 'attention' | 'running'>('all')
  const [query, setQuery] = useState('')
  const [isCompact, setIsCompact] = useState(false)
  const titleId = useId()
  const detailId = useId()
  const detailRef = useRef<HTMLElement>(null)
  const boardRef = useRef<HTMLElement>(null)
  const focusedCardRef = useRef<HTMLButtonElement | null>(null)
  const selectedTriggerRef = useRef<HTMLButtonElement | null>(null)
  const filterRef = useRef<HTMLDivElement>(null)
  const hadPhoneDetailRef = useRef(false)
  const previousSelectionRef = useRef<string | undefined>(undefined)
  const normalizedQuery = query.trim().toLocaleLowerCase(locale)
  const visible = activities.filter((activity) => {
    const status = getAiActivityStatus(getAiActivityPhase(activity, now))
    const matchesFilter = filter === 'all' || (filter === 'running'
      ? status === 'running' : status === 'review' || status === 'failed')
    return matchesFilter && `${activity.label ?? ''} ${t(`ai.activity.task.${activity.task}`)}`
      .toLocaleLowerCase(locale).includes(normalizedQuery)
  })
  const selected = visible.find((activity) => activity.id === selectedId) ?? visible[0]
  const hasMobileSelection = selectedId !== undefined && visible.some((activity) => activity.id === selectedId)
  const runningCount = activities.filter((activity) => getAiActivityStatus(getAiActivityPhase(activity, now)) === 'running').length
  const reviewCount = activities.filter((activity) => getAiActivityPhase(activity, now) === 'review').length
  const hasHistory = activities.some((activity) => !['running', 'review'].includes(getAiActivityStatus(getAiActivityPhase(activity, now))))
  useLayoutEffect(() => {
    const desktop = window.matchMedia('(min-width: 1000px)')
    /** Keeps focus behavior synchronized with the visible list/detail layout. */
    const updateLayout = () => setIsCompact(!desktop.matches)
    updateLayout()
    desktop.addEventListener('change', updateLayout)
    return () => desktop.removeEventListener('change', updateLayout)
  }, [])
  // Move focus with the phone's list/detail transition; selection remains local UI state.
  useLayoutEffect(() => {
    const selectionChanged = previousSelectionRef.current !== selectedId
    previousSelectionRef.current = selectedId
    if (hasMobileSelection && isCompact) {
      if (selectionChanged || document.activeElement === document.body ||
        (document.activeElement instanceof HTMLElement && document.activeElement.getClientRects().length === 0)) detailRef.current?.focus()
      hadPhoneDetailRef.current = true
    } else if (hadPhoneDetailRef.current) {
      hadPhoneDetailRef.current = false
      if (selectedId !== undefined) {
        if (!hasMobileSelection) filterRef.current?.focus()
        else if (document.activeElement instanceof HTMLElement && document.activeElement.getClientRects().length === 0) detailRef.current?.focus()
      }
    }
  }, [hasMobileSelection, isCompact, selectedId])

  // A state change can move a focused card into another lane, replacing its DOM node.
  useLayoutEffect(() => {
    const previous = focusedCardRef.current
    if (!previous || previous.isConnected || document.activeElement !== document.body) return
    const replacement = Array.from(boardRef.current?.querySelectorAll<HTMLButtonElement>('[data-ai-activity-id]') ?? [])
      .find((card) => card.dataset.aiActivityId === previous.dataset.aiActivityId)
    if (replacement && replacement.getClientRects().length > 0) replacement.focus()
    else filterRef.current?.focus()
  }, [activities, now])

  return (
    <section aria-labelledby={titleId} className="flex h-full min-h-0 flex-col bg-[var(--workbench-canvas)] text-[var(--workbench-text)]" onBlurCapture={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) focusedCardRef.current = null
    }} onFocusCapture={() => { focusedCardRef.current = null }} ref={boardRef}>
      <header className="flex flex-none items-start justify-between gap-2 border-b border-[var(--workbench-border)] bg-white px-5 py-4 min-[760px]:items-center min-[760px]:px-7">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-lg bg-teal-700 text-sm font-bold tracking-tight text-white max-[759px]:size-8">AI</span>
          <div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-xl font-semibold tracking-tight max-[759px]:text-base" id={titleId}>{t('ai.activity.title')}</h1>
              <span className="text-xs text-[var(--workbench-muted)]">{t('ai.activity.session')}</span>
            </div>
            <p className="mt-1 text-xs text-[var(--workbench-muted)]" role="status">
              {t('ai.activity.summary').replace('{running}', String(runningCount)).replace('{review}', String(reviewCount))}
            </p>
          </div>
        </div>
        {onClose ? <button aria-label={t('ai.activity.close')} className="workbench-button-secondary min-h-[44px] min-w-[44px] shrink-0 px-3" onClick={onClose} type="button"><span className="max-[759px]:hidden">{t('ai.activity.close')}</span><span aria-hidden="true" className="text-xl min-[760px]:hidden">×</span></button> : null}
      </header>

      <div className="flex flex-none flex-wrap items-center gap-3 border-b border-[var(--workbench-border)] bg-white px-5 py-2 min-[760px]:px-7">
        <div aria-label={t('ai.activity.filter')} className="flex flex-wrap gap-1" ref={filterRef} role="group" tabIndex={-1}>
          {(['all', 'running', 'attention'] satisfies Array<typeof filter>).map((value) => (
            <button
              aria-pressed={filter === value}
              className={`min-h-[44px] rounded-md px-3 text-sm font-medium ${filter === value ? 'bg-teal-50 text-teal-800' : 'text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'}`}
              key={value}
              onClick={() => { setFilter(value); setSelectedId(undefined) }}
              type="button"
            >{t(`ai.activity.filter.${value}`)}</button>
          ))}
        </div>
        <input
          aria-label={t('ai.activity.search')}
          className="min-h-[44px] min-w-0 flex-1 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-3 text-sm min-[760px]:ml-auto min-[760px]:max-w-[260px]"
          onChange={(event) => { setQuery(event.target.value); setSelectedId(undefined) }}
          placeholder={t('ai.activity.search')}
          type="search"
          value={query}
        />
      </div>

      {activities.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-content-center gap-3 overflow-auto px-7 py-12 text-center">
          <span aria-hidden="true" className="mx-auto grid size-12 place-items-center rounded-lg border border-[var(--workbench-border)] bg-white font-semibold text-teal-700">AI</span>
          <h2 className="text-lg font-semibold">{t('ai.activity.empty')}</h2>
          <p className="max-w-sm text-sm leading-6 text-[var(--workbench-muted)]">{t('ai.activity.emptyDescription')}</p>
        </div>
      ) : visible.length === 0 ? (
        <p className="px-7 py-12 text-sm text-[var(--workbench-muted)]" role="status">{t('ai.activity.noResults')}</p>
      ) : (
        <div className="grid min-h-0 flex-1 min-[1000px]:grid-cols-[300px_minmax(0,1fr)] min-[1280px]:grid-cols-[340px_minmax(0,1fr)]">
          {selected ? (
            <aside
              aria-label={t('ai.activity.details')}
              className={`${hasMobileSelection ? 'block' : 'hidden'} min-h-0 overflow-y-auto overscroll-contain border-[var(--workbench-border)] bg-white px-5 py-5 min-[1000px]:block min-[1000px]:border-r min-[1280px]:px-7`}
              id={detailId}
              ref={detailRef}
              tabIndex={-1}
            >
              <button className="mb-4 flex min-h-[44px] items-center gap-1 text-sm font-medium text-teal-700 min-[1000px]:hidden" onClick={() => {
                setSelectedId(undefined)
                requestAnimationFrame(() => {
                  const trigger = Array.from(boardRef.current?.querySelectorAll<HTMLButtonElement>('[data-ai-activity-id]') ?? [])
                    .find((card) => card.dataset.aiActivityId === selectedId) ?? selectedTriggerRef.current
                  if (trigger?.isConnected && trigger.getClientRects().length > 0) trigger.focus()
                  else filterRef.current?.focus()
                })
              }} type="button">
                <ChevronIcon className="size-4 rotate-90 fill-none stroke-current stroke-2" />{t('ai.activity.back')}
              </button>
              <ActivityDetail activity={selected} locale={locale} now={now} onOpenOrigin={onOpenOrigin} t={t} />
            </aside>
          ) : null}
          <div className={`${hasMobileSelection ? 'hidden' : 'block'} min-h-0 overflow-y-auto overscroll-contain px-4 py-4 min-[1000px]:block min-[1280px]:px-6`}>
            {statuses.filter((status) => filter === 'all' || visible.some((activity) => getAiActivityStatus(getAiActivityPhase(activity, now)) === status)).map((status) => {
              const entries = visible.filter((activity) => getAiActivityStatus(getAiActivityPhase(activity, now)) === status)
              return (
                <section aria-label={t(`ai.activity.status.${status}`)} className="mb-4 border-b border-[var(--workbench-border)] pb-4 last:mb-0 last:border-0" key={status}>
                  <div className="mb-3 flex items-center gap-2">
                    <span aria-hidden="true" className={`h-4 w-1 rounded-sm ${statusStyles[status].dot}`} />
                    <h2 className="text-sm font-semibold">{t(`ai.activity.status.${status}`)}</h2>
                    <span className="ml-1 text-xs tabular-nums text-[var(--workbench-muted)]">{entries.length}</span>
                  </div>
                  {entries.length === 0 ? <p className="py-2 pl-3 text-xs text-[var(--workbench-muted)]">{t('ai.activity.laneEmpty')}</p> : (
                    <div className="grid gap-2 min-[640px]:grid-cols-2 min-[1280px]:grid-cols-3">
                      {entries.map((activity) => {
                        const phase = getAiActivityPhase(activity, now)
                        const isSelected = isCompact ? selectedId === activity.id : selected?.id === activity.id
                        return (
                          <button
                            aria-controls={detailId}
                            aria-pressed={isSelected}
                            className={`min-w-0 rounded-lg border bg-white p-3 text-left transition-colors ${isSelected ? 'border-teal-600 ring-1 ring-teal-600' : 'border-[var(--workbench-border)] hover:border-[var(--workbench-border-strong)]'}`}
                            data-ai-activity-id={activity.id}
                            key={activity.id}
                            onClick={(event) => {
                              selectedTriggerRef.current = event.currentTarget
                              setSelectedId(activity.id)
                            }}
                            onFocus={(event) => { focusedCardRef.current = event.currentTarget }}
                            type="button"
                          >
                            <p className={`flex items-center gap-1.5 text-xs font-medium ${statusStyles[status].text}`}>
                              <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${statusStyles[status].dot} ${phase === 'generating' ? 'motion-safe:animate-pulse' : ''}`} />
                              {t(`ai.activity.phase.${phase}`)}
                            </p>
                            <p className="mt-2 break-words text-sm font-semibold leading-6">{activity.label || t(`ai.activity.task.${activity.task}`)}</p>
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--workbench-muted)]">
                              <span>{activity.label ? t(`ai.activity.task.${activity.task}`) : t('ai.activity.assistant')}</span>
                              <time dateTime={new Date(activity.events.at(-1)?.at ?? now).toISOString()}>{formatActivityTime(activity.events.at(-1)?.at ?? now, locale)}</time>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </div>
      )}
      <footer className="flex flex-none flex-wrap items-center justify-between gap-2 border-t border-[var(--workbench-border)] bg-white px-5 py-2 text-xs text-[var(--workbench-muted)]">
        <span>{t('ai.activity.sessionNote')}</span>
        {onClearHistory && hasHistory ? <button className="min-h-[44px] px-2 font-medium text-[var(--workbench-text)] hover:underline" onClick={() => {
          onClearHistory()
          setSelectedId(undefined)
          filterRef.current?.focus()
        }} type="button">{t('ai.activity.clearHistory')}</button> : null}
      </footer>
    </section>
  )
}

/** Input for the selected operation's details. */
type ActivityDetailProps = Pick<AiActivityBoardProps, 'locale' | 'now' | 'onOpenOrigin' | 't'> & {
  /** Selected operation metadata. */
  activity: AiActivity
}

/** Renders actual state, its consequence, and observed events for one operation. */
function ActivityDetail({ activity, locale, now, onOpenOrigin, t }: ActivityDetailProps) {
  const phase = getAiActivityPhase(activity, now)
  const status = getAiActivityStatus(phase)
  return (
    <>
      <p className="text-xs font-semibold text-[var(--workbench-muted)]">{t('ai.activity.details')}</p>
      <h2 className="mt-3 break-words text-lg font-semibold leading-7">{activity.label || t(`ai.activity.task.${activity.task}`)}</h2>
      <p className="mt-2 text-xs text-[var(--workbench-muted)]">{t(`ai.activity.task.${activity.task}`)}</p>
      <div className="mt-6 border-y border-[var(--workbench-border)] py-4">
        <p className={`flex items-center gap-2 text-sm font-semibold ${statusStyles[status].text}`}>
          <span aria-hidden="true" className={`size-2 rounded-full ${statusStyles[status].dot}`} />{t(`ai.activity.phase.${phase}`)}
        </p>
        <p className="mt-2 text-sm leading-6 text-[var(--workbench-muted)]">{t(activity.sourceUnavailable && (phase === 'approved' || phase === 'rejected') ? 'ai.activity.description.reviewedUnavailable' : `ai.activity.description.${phase}`)}</p>
      </div>
      {onOpenOrigin && isSafeApplicationPath(activity.origin) ? (
        <button className="workbench-button-primary mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 px-3" onClick={() => onOpenOrigin(activity.origin)} type="button">
          {t('ai.activity.openOrigin')}<ExternalLinkIcon className="size-4 fill-none stroke-current stroke-2" />
        </button>
      ) : null}
      <h3 className="mt-7 flex items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]"><ClockIcon className="size-4 fill-none stroke-current stroke-2" />{t('ai.activity.history')}</h3>
      <ol className="mt-4 border-l border-[var(--workbench-border)] pl-4">
        {activity.events.map((event, index) => (
          <li className="relative pb-5 last:pb-0" key={`${event.at}-${index}`}>
            <span aria-hidden="true" className="absolute -left-[20px] top-1.5 size-[7px] rounded-full bg-[var(--workbench-border-strong)]" />
            <p className="text-sm">{t(`ai.activity.phase.${event.phase}`)}</p>
            <time className="mt-1 block text-xs tabular-nums text-[var(--workbench-muted)]" dateTime={new Date(event.at).toISOString()}>{formatActivityTime(event.at, locale, true)}</time>
          </li>
        ))}
      </ol>
    </>
  )
}

/** Formats an observed browser timestamp without claiming provider timing. */
function formatActivityTime(value: number, locale: Locale, includeDate = false): string {
  return new Intl.DateTimeFormat(locale, { ...(includeDate ? { month: 'short', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' }).format(value)
}
