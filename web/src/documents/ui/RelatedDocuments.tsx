import { useState, type FormEvent } from 'react'
import useSWR from 'swr'
import type {
  DocumentRelation,
  DocumentRelationTarget,
} from '@mukuroji/contracts'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createDocumentPath } from '../../shared/routing/paths'
import {
  applyDocumentOperations,
  createDocument,
  getDocument,
  getDocumentBacklinks,
  getProjectDocuments,
  type DocumentBacklink,
  type DocumentRecord,
} from '../api'
import { createDocumentOperationId } from '../model/document'
import { useDocumentBacklinks } from '../queries/useDocumentQueries'
import {
  LinkableDocumentPicker,
  type LinkableDocumentOption,
} from './DocumentLinkPicker'

/** Which inline composer is open on the related-Documents panel. */
type RelatedDocumentsComposer = 'link' | 'create'

/**
 * 実行対象から逆引きする Document 一覧の props です。
 */
export type RelatedDocumentsProps = {
  /**
   * Documents API の access token です。
   */
  accessToken?: string
  /**
   * Relation target 種別です。
   */
  targetKind: 'work-item' | 'project' | 'goal'
  /**
   * Canonical relation target ID です。
   */
  targetId?: string
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Opens a human-authored curated-context draft sourced from a related document.
   */
  onPromoteToContext?: (
    backlink: DocumentBacklink,
    document: DocumentRecord,
    returnFocusId: string,
  ) => void
}

/**
 * Renders a panel that links a Work Item, Project, or Goal to related Documents.
 */
export function RelatedDocuments({
  accessToken,
  onPromoteToContext,
  targetId,
  targetKind,
  t,
}: RelatedDocumentsProps) {
  const {
    data,
    error,
    isLoading,
    mutate,
    key,
  } = useDocumentBacklinks(accessToken, targetKind, targetId)
  const [isLoadingMore, setIsLoadingMore] =
    useState(false)
  const [promotingDocumentId, setPromotingDocumentId] =
    useState<string>()
  const [promotionErrorDocumentId, setPromotionErrorDocumentId] =
    useState<string>()
  const [composer, setComposer] =
    useState<RelatedDocumentsComposer>()
  const [newTitle, setNewTitle] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [hasCreateError, setHasCreateError] = useState(false)
  const projectDocuments = useSWR(
    accessToken && targetKind === 'project' && targetId
      ? ['project-documents', accessToken, targetId] as const
      : null,
    ([, token, projectId]) => getProjectDocuments(token, projectId),
    { revalidateOnFocus: false },
  )

  if (!key) return null

  const backlinks = data?.backlinks ?? []
  const linkedDocumentIds = new Set(
    backlinks.map(({ documentId }) => documentId),
  )
  const unlinkedProjectDocuments = (projectDocuments.data ?? []).filter(
    (document) =>
      document.kind !== 'folder' &&
      !linkedDocumentIds.has(document.id),
  )
  const target = targetId
    ? createRelationTarget(targetKind, targetId)
    : undefined

  /**
   * Adds a Document-level relation from one Document to this panel's target.
   *
   * @param documentId - Document that should link to the target.
   */
  const linkDocumentToTarget = async (documentId: string) => {
    if (!accessToken || !target) return
    const document = await getDocument(accessToken, documentId)
    const relation: DocumentRelation = {
      createdAt: new Date().toISOString(),
      createdByUserId: 'current-user',
      id: createDocumentOperationId(),
      source: { kind: 'document' },
      target,
    }
    await applyDocumentOperations(
      accessToken,
      documentId,
      {
        baseRevision: document.revision,
        clientId: createDocumentOperationId(),
        operations: [{
          operationId: createDocumentOperationId(),
          relation,
          type: 'upsert-relation',
        }],
      },
      createMutationRequestContext(),
    )
    await mutate()
  }

  /**
   * Links the Document chosen in the existing-Document picker.
   *
   * @param option - Document chosen by the member.
   */
  const handleLinkExisting = async (option: LinkableDocumentOption) => {
    await linkDocumentToTarget(option.documentId)
  }

  /**
   * Creates an empty page and links it to this panel's target.
   *
   * @param event - Submit event of the create form.
   */
  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const title = newTitle.trim()
    if (!accessToken || !target || !title || isCreating) return
    setIsCreating(true)
    setHasCreateError(false)
    try {
      const document = await createDocument(
        accessToken,
        {
          blocks: [],
          kind: 'page',
          scope:
            target.kind === 'project'
              ? { type: 'project', projectId: target.projectId }
              : { type: 'workspace' },
          title,
        },
        createMutationRequestContext(),
      )
      await linkDocumentToTarget(document.id)
      await projectDocuments.mutate()
      setNewTitle('')
      setComposer(undefined)
    } catch {
      setHasCreateError(true)
    } finally {
      setIsCreating(false)
    }
  }

  const handleLoadMore = async () => {
    if (
      !accessToken ||
      !targetId ||
      !data?.nextCursor ||
      isLoadingMore
    ) {
      return
    }
    setIsLoadingMore(true)
    try {
      const next = await getDocumentBacklinks(
        accessToken,
        targetKind,
        targetId,
        data.nextCursor,
      )
      await mutate(
        {
          backlinks: mergeBacklinks(
            backlinks,
            next.backlinks,
          ),
          nextCursor: next.nextCursor,
        },
        { revalidate: false },
      )
    } finally {
      setIsLoadingMore(false)
    }
  }

  /**
   * Reads the currently authorized Document body before opening quote selection.
   *
   * @param backlink - Permission-filtered relation selected by the curator.
   */
  const handlePromoteToContext = async (backlink: DocumentBacklink) => {
    if (
      !accessToken ||
      !onPromoteToContext ||
      promotingDocumentId
    ) {
      return
    }

    setPromotingDocumentId(backlink.documentId)
    setPromotionErrorDocumentId(undefined)
    try {
      const document = await getDocument(
        accessToken,
        backlink.documentId,
      )
      onPromoteToContext(
        backlink,
        document,
        createRelatedDocumentPromotionTriggerId(
          backlink.documentId,
          backlink.relation.id,
        ),
      )
    } catch {
      setPromotionErrorDocumentId(backlink.documentId)
    } finally {
      setPromotingDocumentId(undefined)
    }
  }

  return (
    <section className="grid gap-3 border-t border-[var(--workbench-border)] px-6 py-5">
      <div>
        <p className="workbench-eyebrow">
          {t('documents.related.eyebrow')}
        </p>
        <h3 className="mt-1 text-sm font-semibold text-[var(--workbench-text)]">
          {t('documents.related.title')}
        </h3>
      </div>
      {accessToken && target ? (
        <div className="flex flex-wrap gap-2">
          {(['link', 'create'] as const).map((option) => (
            <button
              aria-expanded={composer === option}
              className="workbench-button-secondary min-h-9 px-3 text-xs"
              key={option}
              onClick={() =>
                setComposer((current) =>
                  current === option ? undefined : option,
                )
              }
              type="button"
            >
              {composer === option
                ? t('documents.related.closeComposer')
                : option === 'link'
                  ? t('documents.related.linkExisting')
                  : t('documents.related.createNew')}
            </button>
          ))}
        </div>
      ) : null}
      {accessToken && target && composer === 'link' ? (
        <LinkableDocumentPicker
          accessToken={accessToken}
          linkedDocumentIds={linkedDocumentIds}
          onSelect={handleLinkExisting}
          t={t}
        />
      ) : null}
      {accessToken && target && composer === 'create' ? (
        <form className="flex flex-wrap gap-2" onSubmit={handleCreate}>
          <input
            aria-label={t('documents.related.newTitleLabel')}
            autoFocus
            className="workbench-input h-10 min-w-0 flex-1 px-3 text-sm"
            maxLength={500}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder={t('documents.related.newTitlePlaceholder')}
            value={newTitle}
          />
          <button
            className="workbench-button-primary min-h-10 px-3 text-xs disabled:opacity-50"
            disabled={isCreating || !newTitle.trim()}
            type="submit"
          >
            {isCreating
              ? t('documents.related.creating')
              : t('documents.related.create')}
          </button>
          {hasCreateError ? (
            <p className="m-0 w-full text-xs font-semibold text-fg-red-700" role="alert">
              {t('documents.related.createError')}
            </p>
          ) : null}
        </form>
      ) : null}
      {isLoading ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]">
          {t('documents.context.loading')}
        </p>
      ) : null}
      {error ? (
        <p
          className="text-sm font-semibold text-fg-red-700"
          role="alert"
        >
          {t('documents.related.error')}
        </p>
      ) : null}
      {!isLoading &&
      !error &&
      backlinks.length === 0 &&
      unlinkedProjectDocuments.length === 0 ? (
        <p className="text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('documents.related.empty')}
        </p>
      ) : null}
      {backlinks.length > 0 ? (
        <div className="grid gap-2">
          {backlinks.map((backlink) => (
            <div
              className="flex min-w-0 items-stretch rounded-lg border border-[var(--workbench-border)] bg-surface"
              key={`${backlink.documentId}:${backlink.relation.id}`}
            >
              <a
                className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 px-3 py-2.5 hover:bg-tone-f2fbf9"
                href={createDocumentPath(
                  backlink.documentId,
                )}
              >
                <span
                  aria-hidden="true"
                  className="grid h-8 w-8 flex-none place-items-center rounded-md bg-tone-e5f7f4 text-sm font-bold text-[var(--workbench-primary-text)]"
                >
                  D
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--workbench-text)]">
                  {backlink.documentTitle}
                </span>
                <span
                  aria-hidden="true"
                  className="text-[var(--workbench-muted)]"
                >
                  →
                </span>
              </a>
              {accessToken && onPromoteToContext ? (
                <button
                  aria-label={`${
                    promotingDocumentId === backlink.documentId
                      ? t('documents.related.promotingToContext')
                      : t('documents.related.promoteToContext')
                  }: ${backlink.documentTitle}`}
                  className="min-h-[44px] flex-none border-l border-[var(--workbench-border)] px-3 text-xs font-semibold text-[var(--workbench-primary-text)] hover:bg-tone-f2fbf9"
                  data-testid={createRelatedDocumentPromotionTriggerId(
                    backlink.documentId,
                    backlink.relation.id,
                  )}
                  disabled={promotingDocumentId === backlink.documentId}
                  id={createRelatedDocumentPromotionTriggerId(
                    backlink.documentId,
                    backlink.relation.id,
                  )}
                  onClick={() => void handlePromoteToContext(backlink)}
                  type="button"
                >
                  {promotingDocumentId === backlink.documentId
                    ? t('documents.related.promotingToContext')
                    : t('documents.related.promoteToContext')}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {unlinkedProjectDocuments.length > 0 ? (
        <div className="grid gap-2">
          <p className="m-0 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('documents.related.projectDocuments')}
          </p>
          {unlinkedProjectDocuments.map((document) => (
            <a
              className="flex min-h-[44px] min-w-0 items-center gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface px-3 py-2.5 hover:bg-tone-f2fbf9"
              href={createDocumentPath(document.id)}
              key={document.id}
            >
              <span
                aria-hidden="true"
                className="grid h-8 w-8 flex-none place-items-center rounded-md bg-tone-e5f7f4 text-sm font-bold text-[var(--workbench-primary-text)]"
              >
                D
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--workbench-text)]">
                {document.title}
              </span>
            </a>
          ))}
        </div>
      ) : null}
      {promotionErrorDocumentId ? (
        <p className="text-sm font-semibold text-fg-red-700" role="alert">
          {t('documents.related.promoteToContextError')}
        </p>
      ) : null}
      {data?.nextCursor ? (
        <button
          className="workbench-button-secondary min-h-9 px-3 text-xs"
          disabled={isLoadingMore}
          onClick={() => void handleLoadMore()}
          type="button"
        >
          {isLoadingMore
            ? t('documents.context.loading')
            : t('documents.context.loadMore')}
        </button>
      ) : null}
    </section>
  )
}

/**
 * Creates a stable focus-return target for one related Document promotion action.
 *
 * @param documentId - Permission-filtered Document identifier.
 * @param relationId - Canonical relation identifier for this backlink.
 * @returns DOM-safe button ID.
 */
function createRelatedDocumentPromotionTriggerId(
  documentId: string,
  relationId: string,
): string {
  return `related-document-promote-${encodeURIComponent(documentId)}-${encodeURIComponent(relationId)}`
}

function mergeBacklinks(
  current: readonly DocumentBacklink[],
  next: readonly DocumentBacklink[],
) {
  return [
    ...new Map(
      [...current, ...next].map((backlink) => [
        `${backlink.documentId}:${backlink.relation.id}`,
        backlink,
      ]),
    ).values(),
  ]
}

/**
 * Builds the relation target for this panel's target kind and ID.
 *
 * @param kind - Relation target kind.
 * @param id - Canonical target ID.
 * @returns Relation target saved on the linking Document.
 */
function createRelationTarget(
  kind: RelatedDocumentsProps['targetKind'],
  id: string,
): DocumentRelationTarget {
  switch (kind) {
    case 'work-item':
      return { kind: 'work-item', workItemId: id }
    case 'project':
      return { kind: 'project', projectId: id }
    case 'goal':
      return { goalId: id, kind: 'goal' }
  }
}
