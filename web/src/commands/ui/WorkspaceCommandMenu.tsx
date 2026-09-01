import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import type { SearchEntityType, WorkspaceSearchFilters, WorkspaceSearchResult } from '@mukuroji/contracts'
import { getAuthSession } from '../../auth/session'
import { createTranslator, getInitialLocale, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { resolveSearchResultPath, searchWorkspaceAcrossCursors } from '../../search/api'
import {
  createWorkspaceCommandMenuWorkItemActionRegistry,
  executeWorkspaceCommandMenuWorkItemAction,
  type ResolvedWorkspaceCommandMenuWorkItemAction,
  WorkspaceCommandMenuContext,
  type WorkspaceCommandMenuContextValue,
} from './WorkspaceCommandMenuContext'

/**
 * Command menu内に表示する最近開いた検索結果です。
 */
type RecentCommandItem = {
  /**
   * 履歴行を一意に識別するkeyです。
   */
  id: string
  /**
   * 検索結果のentity typeです。
   */
  entityType: SearchEntityType
  /**
   * 履歴行の主表示です。
   */
  label: string
  /**
   * 履歴行の補助表示です。
   */
  meta?: string
  /**
   * 遷移先のsame-origin pathです。
   */
  path: string
}

/**
 * Keyboard選択できるcommand menuの行です。
 */
type CommandMenuItem = {
  /**
   * 行を一意に識別するkeyです。
   */
  id: string
  /**
   * 行に表示する主ラベルです。
   */
  label: string
  /**
   * 行に表示する補助ラベルです。
   */
  meta?: string
  /**
   * 行の右端に表示するshortcutです。
   */
  shortcut?: string
  /**
   * Optional same-origin navigation destination.
   */
  path?: string
  /**
   * 検索結果由来の行です。
   */
  result?: WorkspaceSearchResult
  /**
   * Canonical action contributed by the currently mounted task surface.
   */
  workItemAction?: ResolvedWorkspaceCommandMenuWorkItemAction
}

/**
 * WorkspaceCommandMenu presentationへ渡すpropsです。
 */
export type WorkspaceCommandMenuProps = {
  /**
   * Search APIのAuthorization headerに使うaccess tokenです。
   */
  accessToken?: string
  /**
   * Recent itemをuser / Workspace単位に分離するID tokenまたはaccess tokenです。
   */
  recentIdentityToken?: string
  /**
   * 現在のlocation pathとqueryです。
   */
  currentLocation: string
  /**
   * Command menuを表示するかどうかです。
   */
  isOpen: boolean
  /**
   * 表示localeです。
   */
  locale: Locale
  /**
   * Command menuを閉じるcallbackです。
   */
  onClose: () => void
  /**
   * 選択したcommandのpathへ遷移するcallbackです。
   */
  onNavigate: (path: string) => void
  /**
   * Canonical Work Item actions resolved from currently mounted task surfaces.
   */
  workItemActions?: readonly ResolvedWorkspaceCommandMenuWorkItemAction[]
}

const commandListId = 'workspace-command-menu-list'
const recentCommandStorageKey = 'mukuroji.command-menu.recent'
const searchEntityLabelKeys: Record<SearchEntityType, MessageKey> = {
  'work-item': 'search.entity.work-item',
  project: 'search.entity.project',
  team: 'search.entity.team',
  comment: 'search.entity.comment',
  'context-item': 'search.entity.context-item',
  file: 'search.entity.file',
  document: 'search.entity.document',
}

/**
 * 認証済みrouteをcommand menu context配下へ配置するReact Router layoutです。
 */
export function WorkspaceCommandMenuLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [isOpen, setIsOpen] = useState(false)
  const [locale] = useState<Locale>(() => getInitialLocale())
  const [session] = useState(() => getAuthSession())
  const [workItemActionRegistry] = useState(
    () => createWorkspaceCommandMenuWorkItemActionRegistry(),
  )
  const workItemActions = useSyncExternalStore(
    workItemActionRegistry.subscribe,
    workItemActionRegistry.getSnapshot,
    workItemActionRegistry.getSnapshot,
  )

  useEffect(() => {
    const handleShortcut = (event: WindowEventMap['keydown']) => {
      if (event.repeat || event.key.toLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey)) {
        return
      }

      event.preventDefault()
      setIsOpen(true)
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  const contextValue = useMemo<WorkspaceCommandMenuContextValue>(
    () => ({
      open: () => setIsOpen(true),
      registerWorkItemActions: workItemActionRegistry.register,
    }),
    [workItemActionRegistry],
  )

  return (
    <WorkspaceCommandMenuContext.Provider value={contextValue}>
      <div aria-hidden={isOpen || undefined} inert={isOpen || undefined}>
        <Outlet />
      </div>
      <WorkspaceCommandMenu
        accessToken={session?.accessToken}
        currentLocation={`${location.pathname}${location.search}`}
        isOpen={isOpen}
        locale={locale}
        onClose={() => setIsOpen(false)}
        onNavigate={(path) => {
          setIsOpen(false)
          navigate(path)
        }}
        recentIdentityToken={session?.idToken ?? session?.accessToken}
        workItemActions={workItemActions}
      />
    </WorkspaceCommandMenuContext.Provider>
  )
}

/**
 * Navigation、recent、quick create、permission-aware search resultをまとめるcommand menuです。
 */
export function WorkspaceCommandMenu({
  accessToken,
  currentLocation,
  isOpen,
  locale,
  onClose,
  onNavigate,
  recentIdentityToken,
  workItemActions = [],
}: WorkspaceCommandMenuProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const scopedRecentStorageKey = useMemo(
    () => createRecentCommandStorageKey(recentIdentityToken ?? accessToken),
    [accessToken, recentIdentityToken],
  )
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])
  const [resultsQuery, setResultsQuery] = useState('')
  const [recentItems, setRecentItems] = useState<RecentCommandItem[]>(() =>
    readRecentCommandItems(createRecentCommandStorageKey(recentIdentityToken ?? accessToken)),
  )
  const [activeIndex, setActiveIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [loadingQuery, setLoadingQuery] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | undefined>()
  const [errorQuery, setErrorQuery] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const navigationItems = useMemo<CommandMenuItem[]>(() => [
    { id: 'nav-home', label: t('sidebar.nav.home'), path: '/home' },
    { id: 'nav-focus', label: t('sidebar.nav.focus'), path: '/focus' },
    { id: 'nav-my-tasks', label: t('sidebar.nav.myTasks'), path: '/my-tasks' },
    { id: 'nav-inbox', label: t('sidebar.nav.inbox'), path: '/inbox' },
    { id: 'nav-requests', label: t('sidebar.nav.requests'), path: '/requests' },
    { id: 'nav-customers', label: t('sidebar.nav.customers'), path: '/customers' },
    { id: 'nav-documents', label: t('sidebar.nav.documents'), path: '/documents' },
    { id: 'nav-search', label: t('search.title'), path: '/search' },
    { id: 'nav-dashboard', label: t('sidebar.nav.dashboard'), path: '/dashboard' },
    { id: 'nav-planning', label: t('sidebar.nav.planning'), path: '/planning/timeline' },
    { id: 'nav-reports', label: t('sidebar.nav.reports'), path: '/reports' },
  ], [t])
  const createPath = createQuickCreatePath(currentLocation)
  const quickItems = useMemo<CommandMenuItem[]>(() => [
    {
      id: 'quick-search',
      label: t('command.quick.search'),
      meta: t('search.description'),
      path: '/search',
      shortcut: '↵',
    },
    ...(createPath ? [{
      id: 'quick-create',
      label: t('command.quick.create'),
      path: createPath,
      shortcut: '↵',
    }] : []),
  ], [createPath, t])
  const normalizedQuery = query.trim().toLocaleLowerCase(locale === 'ja' ? 'ja-JP' : 'en-US')
  const resultItems = useMemo<CommandMenuItem[]>(() => (
    resultsQuery === normalizedQuery ? results : []
  ).flatMap((result) => {
    const path = resolveSearchResultPath(result)

    return path ? [{
      id: `result-${result.entityType}-${result.teamId ?? ''}-${result.id}`,
      label: result.title,
      meta: [
        t(searchEntityLabelKeys[result.entityType]),
        result.subtitle,
        result.entityType === 'work-item' ? t('command.result.openHint') : undefined,
      ].filter(Boolean).join(' · '),
      path,
      result,
    }] : []
  }), [normalizedQuery, results, resultsQuery, t])
  const recentCommandItems = useMemo<CommandMenuItem[]>(() => recentItems.map((item) => ({
    id: `recent-${item.id}`,
    label: item.label,
    meta: item.meta,
    path: item.path,
  })), [recentItems])
  const workItemCommandItems = useMemo<CommandMenuItem[]>(() => workItemActions.map((action) => ({
    id: `work-item-action-${action.id}`,
    label: action.label,
    meta: action.description,
    shortcut: action.shortcut,
    workItemAction: action,
  })), [workItemActions])
  const matchingWorkItemCommandItems = normalizedQuery
    ? workItemCommandItems.filter((item) => [
        item.label,
        item.meta,
        item.shortcut,
        item.workItemAction?.id,
        item.workItemAction?.disabledReason,
      ].filter((value) => value !== undefined).join(' ').toLocaleLowerCase().includes(normalizedQuery))
    : workItemCommandItems
  const matchingNavigationItems = normalizedQuery
    ? navigationItems.filter((item) => `${item.label} ${item.meta ?? ''}`.toLocaleLowerCase().includes(normalizedQuery))
    : navigationItems
  const itemSections = normalizedQuery
    ? [
        { id: 'results', label: t('command.section.results'), items: resultItems },
        { id: 'work-item-actions', label: t('tasks.action.more'), items: matchingWorkItemCommandItems },
        { id: 'navigation', label: t('command.section.navigation'), items: matchingNavigationItems },
      ]
    : [
        { id: 'quick', label: t('command.section.quick'), items: quickItems },
        { id: 'work-item-actions', label: t('tasks.action.more'), items: workItemCommandItems },
        ...(recentCommandItems.length > 0
          ? [{ id: 'recent', label: t('command.section.recent'), items: recentCommandItems }]
          : []),
        { id: 'navigation', label: t('command.section.navigation'), items: navigationItems },
      ]
  const commandItems = itemSections.flatMap((section) => section.items)
  const activeCommandIndex = findEnabledCommandIndex(commandItems, activeIndex, 1)

  useEffect(() => {
    if (!isOpen) {
      return undefined
    }

    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.requestAnimationFrame(() => inputRef.current?.focus())

    return () => {
      document.body.style.overflow = previousOverflow
      window.requestAnimationFrame(() => returnFocusRef.current?.focus())
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || !accessToken || !normalizedQuery) {
      return undefined
    }

    const abortController = new AbortController()
    const timeoutId = window.setTimeout(() => {
      setIsLoading(true)
      setLoadingQuery(normalizedQuery)
      setErrorMessage(undefined)
      setErrorQuery('')
      const filters: WorkspaceSearchFilters = { keyword: query.trim() }

      void searchWorkspaceAcrossCursors(accessToken, filters, {
        pageLimit: 5,
        resultLimit: 12,
        signal: abortController.signal,
      })
        .then((response) => {
          setResults(response.results)
          setResultsQuery(normalizedQuery)
          setActiveIndex(0)
        })
        .catch((error: unknown) => {
          if (!abortController.signal.aborted) {
            setResults([])
            setResultsQuery(normalizedQuery)
            setErrorMessage(error instanceof Error ? error.message : t('command.error'))
            setErrorQuery(normalizedQuery)
          }
        })
        .finally(() => {
          if (!abortController.signal.aborted) {
            setIsLoading(false)
          }
        })
    }, 180)

    return () => {
      window.clearTimeout(timeoutId)
      abortController.abort()
    }
  }, [accessToken, isOpen, normalizedQuery, query, t])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    dialogRef.current
      ?.querySelector<HTMLElement>(`[data-command-index="${activeCommandIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeCommandIndex, isOpen])

  if (!isOpen) {
    return null
  }

  const executeItem = (item: CommandMenuItem) => {
    if (item.workItemAction) {
      if (item.workItemAction.disabledReason !== undefined) return

      setQuery('')
      onClose()
      executeWorkspaceCommandMenuWorkItemAction(item.workItemAction)
      return
    }

    if (!item.path) return
    const path = item.path

    if (item.result) {
      const result = item.result
      setRecentItems((currentItems) => {
        const nextItems = [{
          entityType: result.entityType,
          id: `${result.entityType}-${result.teamId ?? ''}-${result.id}`,
          label: item.label,
          meta: item.meta,
          path,
        }, ...currentItems.filter((recentItem) => recentItem.path !== path)].slice(0, 6)

        saveRecentCommandItems(scopedRecentStorageKey, nextItems)
        return nextItems
      })
    }
    setQuery('')
    onNavigate(path)
  }

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setQuery('')
      onClose()
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (commandItems.length > 0) {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((currentIndex) => findEnabledCommandIndex(
          commandItems,
          currentIndex + direction,
          direction,
        ))
      }
      return
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActiveIndex(event.key === 'Home'
        ? findEnabledCommandIndex(commandItems, 0, 1)
        : findEnabledCommandIndex(commandItems, commandItems.length - 1, -1))
      return
    }

    if (event.key === 'Enter' && commandItems[activeCommandIndex]) {
      event.preventDefault()
      executeItem(commandItems[activeCommandIndex])
      return
    }

    if (event.key === 'Tab') {
      trapFocus(event, dialogRef.current)
    }
  }

  let itemIndex = -1

  return (
    <div
      className="fixed inset-0 z-[70] grid items-start justify-items-center bg-slate-950/50 px-3 py-[clamp(12px,10vh,96px)] backdrop-blur-[2px]"
      data-testid="workspace-command-menu-backdrop"
      onMouseDown={() => {
        setQuery('')
        onClose()
      }}
    >
      <section
        aria-label={t('command.aria')}
        aria-modal="true"
        className="flex max-h-[min(720px,calc(100dvh-24px))] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-[var(--workbench-border)] bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)] max-[520px]:max-h-[calc(100dvh-24px)]"
        data-testid="workspace-command-menu"
        onKeyDown={handleDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex min-h-14 items-center gap-3 border-b border-[var(--workbench-border)] px-4">
          <SearchGlyph />
          <input
            aria-activedescendant={commandItems[activeCommandIndex]
              ? `command-option-${commandItems[activeCommandIndex].id}`
              : undefined}
            aria-autocomplete="list"
            aria-controls={commandListId}
            aria-expanded="true"
            aria-label={t('command.open')}
            className="min-w-0 flex-1 border-0 bg-transparent py-4 text-base font-medium text-[var(--workbench-text)] outline-none placeholder:text-[var(--workbench-muted-soft)]"
            onChange={(event) => {
              setActiveIndex(0)
              setQuery(event.target.value)
            }}
            placeholder={t('command.placeholder')}
            ref={inputRef}
            role="combobox"
            value={query}
          />
          <kbd className="rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-2 py-1 text-[11px] font-semibold text-[var(--workbench-muted)] max-[520px]:hidden">
            Esc
          </kbd>
          <button
            aria-label={t('command.close')}
            className="grid h-10 w-10 place-items-center rounded-lg text-xl text-[var(--workbench-muted)] transition hover:bg-[var(--workbench-surface-muted)] min-[521px]:hidden"
            onClick={() => {
              setQuery('')
              onClose()
            }}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2" id={commandListId} role="listbox">
          {itemSections.map((section) => section.items.length > 0 ? (
            <section aria-labelledby={`command-section-${section.id}`} className="py-1" key={section.id}>
              <h2
                className="px-3 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]"
                id={`command-section-${section.id}`}
              >
                {section.label}
              </h2>
              <div className="grid gap-0.5">
                {section.items.map((item) => {
                  itemIndex += 1
                  const currentIndex = itemIndex
                  const disabledReason = item.workItemAction?.disabledReason
                  const disabledReasonId = disabledReason
                    ? `command-option-${item.id}-disabled-reason`
                    : undefined
                  const isDisabled = disabledReason !== undefined
                  const isActive = activeCommandIndex === currentIndex

                  return (
                    <button
                      aria-describedby={disabledReasonId}
                      aria-disabled={isDisabled || undefined}
                      aria-selected={isActive}
                      className={`grid min-h-12 w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 text-left transition ${
                        isDisabled
                          ? 'cursor-not-allowed bg-[var(--workbench-surface-muted)] text-[var(--workbench-muted)]'
                          : isActive
                            ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
                            : 'text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]'
                      }`}
                      data-command-index={currentIndex}
                      disabled={isDisabled}
                      id={`command-option-${item.id}`}
                      key={item.id}
                      onClick={() => executeItem(item)}
                      onMouseEnter={() => {
                        if (!isDisabled) setActiveIndex(currentIndex)
                      }}
                      role="option"
                      type="button"
                    >
                      <span className="grid h-8 w-8 place-items-center rounded-md border border-current/10 bg-white/70">
                        {item.result ? <EntityGlyph entityType={item.result.entityType} /> : <ArrowGlyph />}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">
                          {item.result ? (
                            <HighlightedCommandField field="title" result={item.result} fallback={item.result.title} />
                          ) : item.label}
                        </span>
                        {item.meta ? (
                          <span className="mt-0.5 block truncate text-xs font-medium text-[var(--workbench-muted)]">
                            {item.meta}
                          </span>
                        ) : null}
                        {disabledReason ? (
                          <span
                            className="mt-0.5 block text-xs font-semibold text-amber-700"
                            id={disabledReasonId}
                          >
                            {disabledReason}
                          </span>
                        ) : null}
                        {item.result?.body ? (
                          <span className="mt-0.5 line-clamp-1 block text-xs font-medium text-[var(--workbench-muted)]">
                            <HighlightedCommandField field="body" result={item.result} fallback={item.result.body} />
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs font-semibold text-[var(--workbench-muted-soft)]">
                        {item.shortcut ?? (isDisabled ? '—' : '↵')}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          ) : null)}
          {isLoading && loadingQuery === normalizedQuery ? (
            <p className="px-4 py-8 text-center text-sm font-semibold text-[var(--workbench-muted)]" role="status">
              {t('command.loading')}
            </p>
          ) : null}
          {errorMessage && errorQuery === normalizedQuery ? (
            <p className="m-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
              {t('command.error')}
            </p>
          ) : null}
          {(!isLoading || loadingQuery !== normalizedQuery) && (!errorMessage || errorQuery !== normalizedQuery) && normalizedQuery && commandItems.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm font-semibold text-[var(--workbench-muted)]">
              {t('command.empty')}
            </p>
          ) : null}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-2 text-[11px] font-semibold text-[var(--workbench-muted)]">
          <span>↑↓ {t('command.section.navigation')}</span>
          <span>↵ {t('workspace.action.openTask')} · Esc {t('command.close')}</span>
        </footer>
      </section>
    </div>
  )
}

/**
 * Finds the next enabled command row while wrapping around the available items.
 *
 * @param items - Complete ordered command rows, including disabled actions.
 * @param startIndex - First index to consider.
 * @param direction - Positive for forward traversal and negative for reverse traversal.
 * @returns The next enabled row index, or -1 when no enabled row exists.
 */
function findEnabledCommandIndex(
  items: readonly CommandMenuItem[],
  startIndex: number,
  direction: number,
): number {
  if (items.length === 0) return -1

  const step = direction < 0 ? -1 : 1
  for (let offset = 0; offset < items.length; offset += 1) {
    const rawIndex = startIndex + offset * step
    const index = ((rawIndex % items.length) + items.length) % items.length
    if (items[index]?.workItemAction?.disabledReason === undefined) return index
  }

  return -1
}

function HighlightedCommandField({
  fallback,
  field,
  result,
}: {
  fallback: string
  field: 'body' | 'title'
  result: WorkspaceSearchResult
}) {
  const titleHighlight = result.highlights.find((highlight) => highlight.field === field)

  if (!titleHighlight) {
    return fallback
  }

  return titleHighlight.fragments.map((fragment, index) => fragment.matched ? (
    <mark className="rounded-sm bg-amber-200/70 px-0.5 text-inherit" key={`${fragment.text}-${index}`}>
      {fragment.text}
    </mark>
  ) : <span key={`${fragment.text}-${index}`}>{fragment.text}</span>)
}

function createQuickCreatePath(currentLocation: string) {
  const url = new URL(currentLocation, 'http://localhost')
  const isWorkItemView = /^\/projects\/[^/]+\/issues$/.test(url.pathname) || /^\/teams\/[^/]+\/issues$/.test(url.pathname)

  if (!isWorkItemView) {
    return undefined
  }

  url.searchParams.set('create', '1')
  return `${url.pathname}?${url.searchParams.toString()}`
}

function trapFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (!container) {
    return
  }

  const focusableElements = Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.offsetWidth > 0 || element.offsetHeight > 0)
  const firstElement = focusableElements[0]
  const lastElement = focusableElements[focusableElements.length - 1]

  if (!firstElement || !lastElement) {
    event.preventDefault()
    container.focus()
    return
  }

  if (event.shiftKey && document.activeElement === firstElement) {
    event.preventDefault()
    lastElement.focus()
  } else if (!event.shiftKey && document.activeElement === lastElement) {
    event.preventDefault()
    firstElement.focus()
  }
}

function SearchGlyph() {
  return (
    <svg aria-hidden="true" className="h-5 w-5 flex-none text-[var(--workbench-muted)]" fill="none" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-4-4" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  )
}

function ArrowGlyph() {
  return <span aria-hidden="true" className="text-base">→</span>
}

function EntityGlyph({ entityType }: { entityType: SearchEntityType }) {
  const glyphs: Record<SearchEntityType, string> = {
    'work-item': '✓',
    project: '▦',
    team: '◉',
    comment: '“',
    'context-item': '◆',
    file: '▤',
    document: '≡',
  }

  return <span aria-hidden="true" className="text-sm font-bold">{glyphs[entityType]}</span>
}

function readRecentCommandItems(storageKey: string | undefined) {
  try {
    window.localStorage.removeItem(recentCommandStorageKey)
    if (!storageKey) return []
    const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]')
    if (!Array.isArray(stored)) {
      return []
    }

    return stored.flatMap((item): RecentCommandItem[] => {
      if (!isUnknownRecord(item)) {
        return []
      }

      const entityType = isSearchEntityType(item.entityType) ? item.entityType : undefined
      const id = typeof item.id === 'string' ? item.id : undefined
      const label = typeof item.label === 'string' ? item.label : undefined
      const meta = typeof item.meta === 'string' ? item.meta : undefined
      const path = typeof item.path === 'string' && isSafeRecentPath(item.path) ? item.path : undefined

      return entityType && id && label && path
        ? [{ entityType, id, label, meta, path }]
        : []
    }).slice(0, 6)
  } catch {
    return []
  }
}

function saveRecentCommandItems(
  storageKey: string | undefined,
  items: RecentCommandItem[],
) {
  try {
    if (!storageKey) return
    window.localStorage.setItem(storageKey, JSON.stringify(items.slice(0, 6)))
    window.localStorage.removeItem(recentCommandStorageKey)
  } catch {
    // Search navigation must keep working when browser storage is unavailable.
  }
}

function createRecentCommandStorageKey(accessToken?: string) {
  if (!accessToken) {
    return `${recentCommandStorageKey}.preview`
  }

  const identityScope = readTokenIdentityScope(accessToken)
  return identityScope
    ? `${recentCommandStorageKey}.${encodeURIComponent(identityScope)}`
    : undefined
}

function readTokenIdentityScope(accessToken: string) {
  try {
    const [, encodedPayload] = accessToken.split('.')
    if (!encodedPayload) {
      return undefined
    }
    const normalizedPayload = encodedPayload.replace(/-/gu, '+').replace(/_/gu, '/')
    const paddedPayload = normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, '=')
    const parsedPayload: unknown = JSON.parse(window.atob(paddedPayload))
    if (!isUnknownRecord(parsedPayload)) return undefined

    const payload = parsedPayload
    const issuer = typeof payload.iss === 'string' ? payload.iss : ''
    const subject = typeof payload.sub === 'string'
      ? payload.sub
      : typeof payload.username === 'string'
        ? payload.username
        : ''
    const workspaceId = typeof payload['custom:workspace_id'] === 'string'
      ? payload['custom:workspace_id']
      : typeof payload['custom:directory_id'] === 'string'
        ? payload['custom:directory_id']
        : ''
    return subject ? `${issuer}\0${subject}\0${workspaceId}` : undefined
  } catch {
    return undefined
  }
}

/**
 * Narrows an unknown value to a string-keyed record.
 *
 * @param value - Unknown value read from browser storage or a token payload.
 * @returns Whether record fields can be read safely.
 */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrows an unknown value to a supported search entity identifier.
 *
 * @param value - Unknown value read from recent command-menu storage.
 * @returns Whether the value is a canonical search entity identifier.
 */
function isSearchEntityType(value: unknown): value is SearchEntityType {
  return typeof value === 'string' && Object.hasOwn(searchEntityLabelKeys, value)
}

function isSafeRecentPath(path: string) {
  try {
    const url = new URL(path, window.location.origin)
    return url.origin === window.location.origin && path.startsWith('/')
  } catch {
    return false
  }
}
