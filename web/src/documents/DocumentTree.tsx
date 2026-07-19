import { useMemo, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { DocumentKind, DocumentScope } from '@mukuroji/contracts'
import type { MessageKey } from '../i18n'
import type { ProjectDirectoryTeam } from '../projects/api'
import type { DocumentSummary } from './api'
import { buildDocumentTree, type DocumentTreeBranch } from './model'
import { resolveDocumentMoveErrorKey } from './ui'

const workspaceDocumentScope = { type: 'workspace' } as const

/**
 * Document tree の疑似 section filter です。
 */
export type DocumentTreeFilter = 'all' | 'favorites' | 'recent' | 'archive'

/**
 * DocumentTree の props です。
 */
export type DocumentTreeProps = {
  /**
   * Tree に表示する permission-filter 済み node 一覧です。
   */
  documents: DocumentSummary[]
  /**
   * Project scope label 解決に使う directory です。
   */
  teams: ProjectDirectoryTeam[]
  /**
   * 現在選択中の Document ID です。
   */
  selectedDocumentId?: string
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Drawer 内表示などで追加する class です。
   */
  className?: string
  /**
   * Active tree に次 page があるかどうかです。
   */
  hasMoreActive?: boolean
  /**
   * Archive tree に次 page があるかどうかです。
   */
  hasMoreArchived?: boolean
  /**
   * Document を選択したときの callback です。
   */
  onSelectDocument: (documentId: string) => void
  /**
   * 新規 node を作成するときの callback です。
   */
  onCreateDocument?: (
    kind: DocumentKind,
    scope: DocumentScope,
    parentId?: string,
  ) => void
  /**
   * Node を folder または scope root へ移動するときの callback です。
   */
  onMoveDocument?: (
    document: DocumentSummary,
    parentId: string | undefined,
    scope: DocumentScope,
  ) => Promise<void>
  /**
   * Mobile tree drawer を閉じる callback です。
   */
  onRequestClose?: () => void
  /**
   * Active または archive tree の次 page を取得する callback です。
   */
  onLoadMore?: (archived: boolean) => Promise<void>
}

/**
 * Document tree rail に表示する Project scope です。
 */
type ProjectScopeOption = {
  /**
   * Project ID です。
   */
  id: string
  /**
   * Project 表示名です。
   */
  name: string
}

/**
 * Recursive tree branch 描画へ渡す props です。
 */
type DocumentBranchProps = {
  /**
   * 描画する branch です。
   */
  branch: DocumentTreeBranch
  /**
   * Tree row の aria-level です。
   */
  level: number
  /**
   * 現在展開中の folder ID 一覧です。
   */
  expandedFolderIds: ReadonlySet<string>
  /**
   * 選択中 Document ID です。
   */
  selectedDocumentId?: string
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Drag 中 Document です。
   */
  draggingDocument?: DocumentSummary
  /**
   * Folder 展開状態を切り替える callback です。
   */
  onExpandedChange: (documentId: string, expanded: boolean) => void
  /**
   * Document を選択する callback です。
   */
  onSelectDocument: (documentId: string) => void
  /**
   * Drag を開始する callback です。
   */
  onDragStart: (document: DocumentSummary) => void
  /**
   * Drag を終了する callback です。
   */
  onDragEnd: () => void
  /**
   * Folder へ drop する callback です。
   */
  onDropDocument?: (
    document: DocumentSummary,
    parentId: string,
    scope: DocumentScope,
  ) => Promise<void>
}

const createKinds = [
  'page',
  'folder',
  'template',
  'whiteboard',
] as const satisfies readonly DocumentKind[]

const treeFilters = [
  'all',
  'favorites',
  'recent',
  'archive',
] as const satisfies readonly DocumentTreeFilter[]

/**
 * Workspace/Project scope、folder、page、template、whiteboard を表示する
 * secondary navigation rail です。
 */
export function DocumentTree({
  className = '',
  documents,
  hasMoreActive = false,
  hasMoreArchived = false,
  onCreateDocument,
  onLoadMore,
  onMoveDocument,
  onRequestClose,
  onSelectDocument,
  selectedDocumentId,
  t,
  teams,
}: DocumentTreeProps) {
  const [filter, setFilter] = useState<DocumentTreeFilter>('all')
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false)
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(
    () =>
      new Set(
        documents
          .filter((document) => document.kind === 'folder')
          .map((document) => document.id),
      ),
  )
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(['refero']),
  )
  const [draggingDocument, setDraggingDocument] =
    useState<DocumentSummary>()
  const [moveErrorKey, setMoveErrorKey] = useState<MessageKey>()
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const projectScopes = useMemo(() => deduplicateProjects(teams), [teams])
  const visibleDocuments = useMemo(
    () => filterDocuments(documents, filter),
    [documents, filter],
  )
  const workspaceBranches = useMemo(
    () => buildDocumentTree(visibleDocuments, workspaceDocumentScope),
    [visibleDocuments],
  )
  const hasMore =
    filter === 'archive' ? hasMoreArchived : hasMoreActive

  const moveDocument = async (
    document: DocumentSummary,
    parentId: string | undefined,
    scope: DocumentScope,
  ) => {
    if (!onMoveDocument) return
    setMoveErrorKey(undefined)
    try {
      await onMoveDocument(document, parentId, scope)
    } catch (error) {
      setMoveErrorKey(resolveDocumentMoveErrorKey(error))
    }
  }

  const handleScopeDrop = (
    event: DragEvent<HTMLElement>,
    scope: DocumentScope,
  ) => {
    event.preventDefault()
    if (
      draggingDocument?.capabilities.canManagePermissions &&
      !draggingDocument.archivedAt &&
      onMoveDocument
    ) {
      void moveDocument(draggingDocument, undefined, scope)
    }
    setDraggingDocument(undefined)
  }

  return (
    <aside
      aria-label={t('documents.tree.aria')}
      className={`flex h-full min-h-0 w-[278px] flex-none flex-col border-r border-[var(--workbench-border)] bg-[var(--workbench-surface)] ${className}`}
      data-testid="document-tree"
    >
      <div className="flex h-14 flex-none items-center justify-between gap-2 border-b border-[var(--workbench-border)] px-3">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-semibold text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]"
          onClick={() => setFilter('all')}
          type="button"
        >
          <span aria-hidden="true" className="text-base">
            ▤
          </span>
          <span className="truncate">{t('documents.title')}</span>
        </button>
        {onCreateDocument ? (
          <div className="relative">
            <button
              aria-expanded={isCreateMenuOpen}
              aria-haspopup="menu"
              className="grid h-9 w-9 place-items-center rounded-md text-xl text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)]"
              onClick={() => setIsCreateMenuOpen((current) => !current)}
              title={t('documents.action.create')}
              type="button"
            >
              +
            </button>
            {isCreateMenuOpen ? (
              <div
                className="absolute right-0 top-11 z-30 w-52 rounded-lg border border-[var(--workbench-border)] bg-white p-1.5 shadow-[0_16px_44px_rgba(23,32,29,0.16)]"
                role="menu"
              >
                {createKinds.map((kind) => (
                  <button
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-semibold text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]"
                    key={kind}
                    onClick={() => {
                      setIsCreateMenuOpen(false)
                      onCreateDocument(kind, workspaceDocumentScope)
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <DocumentKindGlyph kind={kind} />
                    {t(`documents.kind.${kind}`)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {onRequestClose ? (
          <button
            aria-label={t('documents.tree.close')}
            className="grid h-9 w-9 place-items-center rounded-md text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]"
            onClick={onRequestClose}
            type="button"
          >
            ×
          </button>
        ) : null}
      </div>

      <nav
        aria-label={t('documents.tree.filters')}
        className="grid flex-none gap-0.5 border-b border-[var(--workbench-border)] p-2"
      >
        {treeFilters.map((treeFilter) => (
          <button
            aria-current={filter === treeFilter ? 'page' : undefined}
            className={`flex h-9 items-center gap-3 rounded-md px-3 text-left text-sm font-semibold ${
              filter === treeFilter
                ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
                : 'text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-text)]'
            }`}
            key={treeFilter}
            onClick={() => setFilter(treeFilter)}
            type="button"
          >
            <span aria-hidden="true">{filterGlyphs[treeFilter]}</span>
            {t(`documents.tree.${treeFilter}`)}
          </button>
        ))}
      </nav>
      {moveErrorKey ? (
        <p
          className="m-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold leading-5 text-red-800"
          role="alert"
        >
          {t(moveErrorKey)}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-3">
        <DocumentScopeSection
          branches={workspaceBranches}
          draggingDocument={draggingDocument}
          expanded
          expandedFolderIds={expandedFolderIds}
          label={t('documents.scope.workspace')}
            scope={workspaceDocumentScope}
          selectedDocumentId={selectedDocumentId}
          t={t}
          onCreateDocument={onCreateDocument}
          onDragEnd={() => setDraggingDocument(undefined)}
          onDragStart={setDraggingDocument}
          onDropDocument={onMoveDocument ? moveDocument : undefined}
          onExpandedChange={(documentId, expanded) =>
            setExpandedFolderIds((current) =>
              toggleSetValue(current, documentId, expanded),
            )
          }
          onScopeDrop={handleScopeDrop}
          onSelectDocument={onSelectDocument}
        />

        {projectScopes.length > 0 ? (
          <p className="mb-1 mt-5 px-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted-soft)]">
            {t('documents.scope.projects')}
          </p>
        ) : null}
        {projectScopes.map((project) => {
          const scope = { projectId: project.id, type: 'project' } as const
          const branches = buildDocumentTree(visibleDocuments, scope)
          const expanded = expandedProjectIds.has(project.id)

          return (
            <DocumentScopeSection
              branches={branches}
              draggingDocument={draggingDocument}
              expanded={expanded}
              expandedFolderIds={expandedFolderIds}
              key={project.id}
              label={project.name}
              scope={scope}
              selectedDocumentId={selectedDocumentId}
              t={t}
              onCreateDocument={onCreateDocument}
              onDragEnd={() => setDraggingDocument(undefined)}
              onDragStart={setDraggingDocument}
              onDropDocument={onMoveDocument ? moveDocument : undefined}
              onExpandedChange={(documentId, nextExpanded) =>
                setExpandedFolderIds((current) =>
                  toggleSetValue(current, documentId, nextExpanded),
                )
              }
              onScopeDrop={handleScopeDrop}
              onScopeExpandedChange={(nextExpanded) =>
                setExpandedProjectIds((current) =>
                  toggleSetValue(current, project.id, nextExpanded),
                )
              }
              onSelectDocument={onSelectDocument}
            />
          )
        })}

        {visibleDocuments.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t(`documents.tree.empty.${filter}`)}
          </p>
        ) : null}
        {hasMore && onLoadMore ? (
          <button
            className="mt-3 min-h-9 w-full rounded-md border border-[var(--workbench-border)] bg-white px-3 text-xs font-semibold text-[var(--workbench-primary)] hover:bg-[#f4fbfa] disabled:cursor-wait disabled:opacity-60"
            disabled={isLoadingMore}
            onClick={() => {
              setIsLoadingMore(true)
              void onLoadMore(filter === 'archive').finally(() =>
                setIsLoadingMore(false)
              )
            }}
            type="button"
          >
            {isLoadingMore
              ? t('documents.tree.loadingMore')
              : t('documents.tree.loadMore')}
          </button>
        ) : null}
      </div>
    </aside>
  )
}

/**
 * 一つの Workspace/Project scope と配下 branch を描画します。
 */
function DocumentScopeSection({
  branches,
  draggingDocument,
  expanded,
  expandedFolderIds,
  label,
  onCreateDocument,
  onDragEnd,
  onDragStart,
  onDropDocument,
  onExpandedChange,
  onScopeDrop,
  onScopeExpandedChange,
  onSelectDocument,
  scope,
  selectedDocumentId,
  t,
}: {
  /**
   * Scope root 配下の tree branches です。
   */
  branches: DocumentTreeBranch[]
  /**
   * Drag 中 Document です。
   */
  draggingDocument?: DocumentSummary
  /**
   * Scope section を展開するかどうかです。
   */
  expanded: boolean
  /**
   * 展開中 folder ID 一覧です。
   */
  expandedFolderIds: ReadonlySet<string>
  /**
   * Scope の表示名です。
   */
  label: string
  /**
   * Scope 内へ node を作成する callback です。
   */
  onCreateDocument?: (
    kind: DocumentKind,
    scope: DocumentScope,
    parentId?: string,
  ) => void
  /**
   * Drag 終了 callback です。
   */
  onDragEnd: () => void
  /**
   * Drag 開始 callback です。
   */
  onDragStart: (document: DocumentSummary) => void
  /**
   * Folder へ drop する callback です。
   */
  onDropDocument?: (
    document: DocumentSummary,
    parentId: string | undefined,
    scope: DocumentScope,
  ) => Promise<void>
  /**
   * Folder 展開変更 callback です。
   */
  onExpandedChange: (documentId: string, expanded: boolean) => void
  /**
   * Scope root drop callback です。
   */
  onScopeDrop: (
    event: DragEvent<HTMLElement>,
    scope: DocumentScope,
  ) => void
  /**
   * Project scope 展開変更 callback です。
   */
  onScopeExpandedChange?: (expanded: boolean) => void
  /**
   * Document 選択 callback です。
   */
  onSelectDocument: (documentId: string) => void
  /**
   * 描画対象 scope です。
   */
  scope: DocumentScope
  /**
   * 選択中 Document ID です。
   */
  selectedDocumentId?: string
  /**
   * 翻訳関数です。
   */
  t: (key: MessageKey) => string
}) {
  return (
    <section
      className="mt-1"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onScopeDrop(event, scope)}
    >
      <div className="group flex items-center gap-1">
        <button
          aria-expanded={expanded}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs font-bold uppercase tracking-[0.05em] text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]"
          onClick={() => onScopeExpandedChange?.(!expanded)}
          type="button"
        >
          <span
            aria-hidden="true"
            className={`text-[10px] transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            ▶
          </span>
          <span className="truncate">{label}</span>
        </button>
        {onCreateDocument ? (
          <button
            aria-label={t('documents.action.create')}
            className="grid h-8 w-8 place-items-center rounded-md text-[var(--workbench-muted-soft)] opacity-0 hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)] focus-visible:opacity-100 group-hover:opacity-100"
            onClick={() => onCreateDocument('page', scope)}
            type="button"
          >
            +
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div role="tree">
          {branches.map((branch) => (
            <DocumentBranch
              branch={branch}
              draggingDocument={draggingDocument}
              expandedFolderIds={expandedFolderIds}
              key={branch.document.id}
              level={1}
              selectedDocumentId={selectedDocumentId}
              t={t}
              onDragEnd={onDragEnd}
              onDragStart={onDragStart}
              onDropDocument={onDropDocument}
              onExpandedChange={onExpandedChange}
              onSelectDocument={onSelectDocument}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function DocumentBranch({
  branch,
  draggingDocument,
  expandedFolderIds,
  level,
  onDragEnd,
  onDragStart,
  onDropDocument,
  onExpandedChange,
  onSelectDocument,
  selectedDocumentId,
  t,
}: DocumentBranchProps) {
  const { document } = branch
  const isFolder = document.kind === 'folder'
  const expanded = isFolder && expandedFolderIds.has(document.id)
  const selected = selectedDocumentId === document.id

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!isFolder) {
      return
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      onExpandedChange(document.id, true)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onExpandedChange(document.id, false)
    }
  }

  return (
    <div role="none">
      <div
        className="relative"
        onDragOver={(event) => {
          if (isFolder) event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (
            !isFolder ||
            !document.capabilities.canManagePermissions ||
            !draggingDocument?.capabilities.canManagePermissions ||
            draggingDocument.archivedAt ||
            !onDropDocument
          ) {
            return
          }
          if (draggingDocument.id !== document.id) {
            onDropDocument(draggingDocument, document.id, document.scope)
          }
        }}
      >
        <button
          aria-current={selected ? 'page' : undefined}
          aria-expanded={isFolder ? expanded : undefined}
          aria-level={level}
          className={`group flex h-9 w-full items-center gap-2 rounded-md pr-2 text-left text-sm font-medium ${
            selected
              ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
              : 'text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]'
          }`}
          draggable={Boolean(
            onDropDocument &&
              document.capabilities.canManagePermissions &&
              !document.archivedAt,
          )}
          onClick={() =>
            isFolder
              ? onExpandedChange(document.id, !expanded)
              : onSelectDocument(document.id)
          }
          onDoubleClick={() => isFolder && onSelectDocument(document.id)}
          onDragEnd={onDragEnd}
          onDragStart={(event) => {
            if (
              !onDropDocument ||
              !document.capabilities.canManagePermissions ||
              document.archivedAt
            ) {
              event.preventDefault()
              return
            }
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', document.id)
            onDragStart(document)
          }}
          onKeyDown={handleKeyDown}
          role="treeitem"
          style={{ paddingLeft: `${Math.min(12 + level * 14, 66)}px` }}
          type="button"
        >
          {isFolder ? (
            <span
              aria-hidden="true"
              className={`w-3 flex-none text-[9px] transition-transform ${expanded ? 'rotate-90' : ''}`}
            >
              ▶
            </span>
          ) : (
            <span className="w-3 flex-none" />
          )}
          <DocumentKindGlyph kind={document.kind} />
          <span className="min-w-0 flex-1 truncate">{document.title}</span>
          {document.favorite ? (
            <span aria-label={t('documents.favorite.on')} title={t('documents.favorite.on')}>
              ★
            </span>
          ) : null}
        </button>
      </div>
      {isFolder && expanded ? (
        <div role="group">
          {branch.children.map((child) => (
            <DocumentBranch
              branch={child}
              draggingDocument={draggingDocument}
              expandedFolderIds={expandedFolderIds}
              key={child.document.id}
              level={level + 1}
              selectedDocumentId={selectedDocumentId}
              t={t}
              onDragEnd={onDragEnd}
              onDragStart={onDragStart}
              onDropDocument={onDropDocument}
              onExpandedChange={onExpandedChange}
              onSelectDocument={onSelectDocument}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Document kind を compact glyph で表示します。
 */
function DocumentKindGlyph({ kind }: { kind: DocumentKind }) {
  const glyphs: Record<DocumentKind, string> = {
    folder: '▸',
    page: '▤',
    template: '◇',
    whiteboard: '⌘',
  }

  return (
    <span
      aria-hidden="true"
      className="grid h-5 w-5 flex-none place-items-center rounded text-xs text-[var(--workbench-muted)]"
    >
      {glyphs[kind]}
    </span>
  )
}

const filterGlyphs: Record<DocumentTreeFilter, string> = {
  all: '▤',
  archive: '▣',
  favorites: '★',
  recent: '◷',
}

function filterDocuments(
  documents: readonly DocumentSummary[],
  filter: DocumentTreeFilter,
) {
  if (filter === 'archive') {
    return documents.filter((document) => Boolean(document.archivedAt))
  }

  const activeDocuments = documents.filter((document) => !document.archivedAt)
  if (filter === 'favorites') {
    return activeDocuments.filter((document) => document.favorite)
  }

  if (filter === 'recent') {
    return activeDocuments
      .filter((document) => Boolean(document.lastOpenedAt))
      .sort((left, right) =>
        (right.lastOpenedAt ?? '').localeCompare(left.lastOpenedAt ?? ''),
      )
  }

  return activeDocuments
}

function deduplicateProjects(teams: readonly ProjectDirectoryTeam[]) {
  const projects = new Map<string, ProjectScopeOption>()

  for (const team of teams) {
    for (const project of team.projects) {
      if (!projects.has(project.id)) {
        projects.set(project.id, { id: project.id, name: project.name })
      }
    }
  }

  return [...projects.values()]
}

function toggleSetValue(
  values: ReadonlySet<string>,
  value: string,
  enabled: boolean,
) {
  const nextValues = new Set(values)
  if (enabled) {
    nextValues.add(value)
  } else {
    nextValues.delete(value)
  }
  return nextValues
}
