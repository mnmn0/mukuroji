import type {
  WorkItemRelation,
  WorkItemRelationType,
} from '@mukuroji/contracts'
import {
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import {
  createTranslator,
  type Locale,
} from '../i18n'
import { resolveAvailableWorkItemRelationCandidates } from './workItemRelations'

/**
 * Relation editor で選択できる同一 Team 内の Work Item です。
 */
export type WorkItemRelationCandidate = {
  /**
   * Relation target として送信する Work Item ID です。
   */
  id: string
  /**
   * Select と relation row に表示する Work Item 名です。
   */
  title: string
}

/**
 * Relation 作成 callback に渡す入力です。
 */
export type WorkItemRelationEditorInput = {
  /**
   * 現在の Work Item から見た作成可能 relation 種別です。
   */
  type: WorkItemRelationType
  /**
   * Relation の相手 Work Item ID です。
   */
  targetWorkItemId: string
}

/**
 * WorkItemRelationsEditor が受け取る props です。
 */
export type WorkItemRelationsEditorProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * 自己 relation を候補から除外する現在の Work Item ID です。
   */
  currentWorkItemId: string
  /**
   * API detail が返した現在の relation 一覧です。
   */
  relations: readonly WorkItemRelation[]
  /**
   * 同一 Team 内から選択できる relation target です。
   */
  candidates: readonly WorkItemRelationCandidate[]
  /**
   * Relation 一覧を取得中かどうかです。
   */
  isLoading?: boolean
  /**
   * API 取得または mutation error の表示文言です。
   */
  errorMessage?: string
  /**
   * Relation mutation を許可しない参照専用状態です。
   */
  readOnly?: boolean
  /**
   * Relation を作成する callback です。
   */
  onAddRelation?: (input: WorkItemRelationEditorInput) => Promise<void>
  /**
   * 表示中 relation を reciprocal edge ごと削除する callback です。
   */
  onDeleteRelation?: (relation: WorkItemRelation) => Promise<void>
}

const relationCreateTypes = [
  'parent',
  'blocks',
  'related',
  'duplicate',
] as const satisfies readonly WorkItemRelationType[]

/**
 * Work Item detail 内で reciprocal relation の追加と解除を行う編集面です。
 */
export function WorkItemRelationsEditor({
  candidates,
  currentWorkItemId,
  errorMessage,
  isLoading = false,
  locale,
  onAddRelation,
  onDeleteRelation,
  readOnly = false,
  relations,
}: WorkItemRelationsEditorProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [relationType, setRelationType] = useState<WorkItemRelationType>('related')
  const [targetWorkItemId, setTargetWorkItemId] = useState('')
  const [savingKey, setSavingKey] = useState<string | undefined>()
  const [localErrorMessage, setLocalErrorMessage] = useState<string | undefined>()
  const availableCandidates = useMemo(
    () => resolveAvailableWorkItemRelationCandidates(
      candidates,
      currentWorkItemId,
      relations,
      relationType,
    ),
    [candidates, currentWorkItemId, relations, relationType],
  )
  const resolvedTargetWorkItemId = availableCandidates.some(
    (candidate) => candidate.id === targetWorkItemId,
  )
    ? targetWorkItemId
    : availableCandidates[0]?.id ?? ''
  const canMutate = !readOnly && Boolean(onAddRelation)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!canMutate || !onAddRelation || !resolvedTargetWorkItemId) {
      return
    }

    const operationKey = `add:${relationType}:${resolvedTargetWorkItemId}`

    setSavingKey(operationKey)
    setLocalErrorMessage(undefined)

    try {
      await onAddRelation({
        targetWorkItemId: resolvedTargetWorkItemId,
        type: relationType,
      })
      setTargetWorkItemId('')
    } catch (error) {
      setLocalErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message
          : t('workItems.relations.error'),
      )
    } finally {
      setSavingKey(undefined)
    }
  }

  const handleDelete = async (relation: WorkItemRelation) => {
    if (readOnly || !onDeleteRelation) {
      return
    }

    const operationKey = `delete:${relation.type}:${relation.targetWorkItemId}`

    setSavingKey(operationKey)
    setLocalErrorMessage(undefined)

    try {
      await onDeleteRelation(relation)
    } catch (error) {
      setLocalErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message
          : t('workItems.relations.error'),
      )
    } finally {
      setSavingKey(undefined)
    }
  }

  return (
    <section
      aria-busy={isLoading || Boolean(savingKey)}
      className="grid min-w-0 gap-4"
      data-testid="work-item-relations-editor"
    >
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('workItems.relations.title')}
          </h3>
          <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workItems.relations.description')}
          </p>
        </div>
        <span className="workbench-badge flex-none">{relations.length}</span>
      </div>

      {isLoading ? (
        <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-white px-4 py-6 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('workItems.relations.loading')}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
          {relations.length > 0 ? (
            <ul className="divide-y divide-[var(--workbench-border)]">
              {relations.map((relation) => {
                const relationKey = `${relation.type}:${relation.targetWorkItemId}`
                const target = candidates.find(
                  (candidate) => candidate.id === relation.targetWorkItemId,
                )
                const isDeleting = savingKey === `delete:${relationKey}`

                return (
                  <li
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3"
                    data-testid={`work-item-relation-${toDomToken(relationKey)}`}
                    key={relationKey}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="workbench-badge-primary flex-none">
                        {t(`workItems.relationType.${relation.type}`)}
                      </span>
                      <span className="min-w-0 truncate text-sm font-semibold text-[var(--workbench-text)]">
                        {target?.title ?? relation.targetWorkItemId}
                      </span>
                    </div>
                    {!readOnly && onDeleteRelation ? (
                      <button
                        aria-label={t('workItems.relations.removeLabel')
                          .replace('{title}', target?.title ?? relation.targetWorkItemId)}
                        className="workbench-button-secondary min-h-9 px-3 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={Boolean(savingKey)}
                        onClick={() => void handleDelete(relation)}
                        type="button"
                      >
                        {isDeleting
                          ? t('workItems.relations.removing')
                          : t('workItems.relations.remove')}
                      </button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="px-4 py-6 text-center text-sm font-medium text-[var(--workbench-muted)]">
              {t('workItems.relations.empty')}
            </p>
          )}
        </div>
      )}

      {canMutate ? (
        <form
          className="workbench-panel-muted grid grid-cols-[minmax(0,0.65fr)_minmax(0,1.35fr)_auto] items-end gap-3 p-3 max-[720px]:grid-cols-1"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
            {t('workItems.relations.type')}
            <select
              className="workbench-input min-h-10 w-full min-w-0 px-3"
              disabled={Boolean(savingKey)}
              value={relationType}
              onChange={(event) => setRelationType(event.target.value as WorkItemRelationType)}
            >
              {relationCreateTypes.map((type) => (
                <option key={type} value={type}>{t(`workItems.relationType.${type}`)}</option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
            {t('workItems.relations.target')}
            <select
              className="workbench-input min-h-10 w-full min-w-0 px-3"
              disabled={Boolean(savingKey) || availableCandidates.length === 0}
              required
              value={resolvedTargetWorkItemId}
              onChange={(event) => setTargetWorkItemId(event.target.value)}
            >
              {availableCandidates.length === 0 ? (
                <option value="">{t('workItems.relations.noCandidates')}</option>
              ) : availableCandidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.title}</option>
              ))}
            </select>
          </label>
          <button
            className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300"
            disabled={Boolean(savingKey) || availableCandidates.length === 0}
            type="submit"
          >
            {savingKey?.startsWith('add:')
              ? t('workItems.relations.adding')
              : t('workItems.relations.add')}
          </button>
        </form>
      ) : (
        <p className="text-sm font-medium text-[var(--workbench-muted)]">
          {t('workItems.relations.readOnly')}
        </p>
      )}

      {errorMessage || localErrorMessage ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
          {localErrorMessage ?? errorMessage}
        </p>
      ) : null}
    </section>
  )
}

function toDomToken(value: string) {
  return value.replaceAll(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'relation'
}
