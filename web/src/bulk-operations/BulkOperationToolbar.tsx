import type {
  BulkOperation,
  BulkOperationAction,
  BulkOperationPreview,
  BulkOperationRequest,
} from '@mukuroji/contracts'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MessageKey } from '../i18n'
import { BulkOperationResultPanel } from './BulkOperationResultPanel'
import { bulkEditFields, createBulkEditPatch, type BulkEditField } from './helpers'

const bulkPriorities = ['high', 'medium', 'low'] as const

/** Bulk selection を API identity と table selection key へ結び付けます。 */
export type BulkOperationSelection = {
  /** TaskPage 内で checkbox state を識別する key です。 */
  selectionKey: string
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Team 内の Work Item ID です。 */
  workItemId: string
  /** Preview/apply の optimistic concurrency revision です。 */
  expectedRevision: number
  /** Toolbar の selection summary に表示する label です。 */
  label: string
}

/** Move action で選択できる Project です。 */
export type BulkOperationProjectOption = {
  /** API に渡す Project ID です。 */
  id: string
  /** Select に表示する Project 名です。 */
  label: string
}

/** BulkOperationToolbar の props です。 */
export type BulkOperationToolbarProps = {
  /** API が request scope として検証する Workspace ID です。 */
  workspaceId: string
  /** Checkbox 選択済み item です。 */
  selectedItems: BulkOperationSelection[]
  /** 現在の filter で表示中の item です。 */
  visibleItems: BulkOperationSelection[]
  /** Move action の Project 候補です。 */
  projectOptions?: BulkOperationProjectOption[]
  /** 権限不足で mutation を禁止するかどうかです。 */
  readOnly?: boolean
  /** 現在 locale の翻訳関数です。 */
  t: (key: MessageKey) => string
  /** 表示中 item の checkbox state をまとめて変更します。 */
  onVisibleSelectionChange: (selectionKeys: string[], selected: boolean) => void
  /** Request の validation preview を取得します。 */
  onPreview?: (request: BulkOperationRequest) => Promise<BulkOperationPreview>
  /** Preview token で operation を確定します。 */
  onApply?: (
    request: BulkOperationRequest,
    preview: BulkOperationPreview,
  ) => Promise<BulkOperation>
  /** Failed item だけを再試行します。 */
  onRetry?: (operationId: string) => Promise<BulkOperation>
  /** 成功 item を undo します。 */
  onUndo?: (operationId: string) => Promise<BulkOperation>
  /** Operation 更新後に selection と親 cache を同期します。 */
  onOperationComplete?: (operation: BulkOperation) => void
  /** Story/test で表示する初期 preview です。 */
  initialPreview?: BulkOperationPreview
  /** Story/test で表示する初期 operation です。 */
  initialOperation?: BulkOperation
}

/**
 * 選択中 Work Item の edit/move/archive を preview してから確定する toolbar です。
 */
export function BulkOperationToolbar({
  workspaceId,
  selectedItems,
  visibleItems,
  projectOptions = [],
  readOnly = false,
  t,
  onVisibleSelectionChange,
  onPreview,
  onApply,
  onRetry,
  onUndo,
  onOperationComplete,
  initialPreview,
  initialOperation,
}: BulkOperationToolbarProps) {
  const fieldId = useId()
  const valueId = useId()
  const targetProjectId = useId()
  const selectAllRef = useRef<HTMLInputElement>(null)
  const [action, setAction] = useState<BulkOperationAction['type']>('edit')
  const [editField, setEditField] = useState<BulkEditField>('workflowStatusId')
  const [editValue, setEditValue] = useState('')
  const [moveProjectId, setMoveProjectId] = useState('')
  const [previewedRequest, setPreviewedRequest] = useState<BulkOperationRequest>()
  const [preview, setPreview] = useState<BulkOperationPreview | undefined>(initialPreview)
  const [operation, setOperation] = useState<BulkOperation | undefined>(initialOperation)
  const [errorMessage, setErrorMessage] = useState<string>()
  const [busyState, setBusyState] = useState<'preview' | 'apply' | 'resume' | 'retry' | 'undo'>()
  const selectedKeySet = useMemo(
    () => new Set(selectedItems.map((item) => item.selectionKey)),
    [selectedItems],
  )
  const allVisibleSelected = visibleItems.length > 0 &&
    visibleItems.every((item) => selectedKeySet.has(item.selectionKey))
  const someVisibleSelected = visibleItems.some((item) => selectedKeySet.has(item.selectionKey))
  const selectionSignature = selectedItems
    .map((item) => `${item.teamId}\u0000${item.workItemId}\u0000${item.expectedRevision}`)
    .sort()
    .join('\u0001')
  const previewSelectionSignature = previewedRequest?.items
    .map((item) => `${item.teamId}\u0000${item.workItemId}\u0000${item.expectedRevision}`)
    .sort()
    .join('\u0001')
  const activePreview = !previewedRequest || previewSelectionSignature === selectionSignature
    ? preview
    : undefined

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected
    }
  }, [allVisibleSelected, someVisibleSelected])

  const request = createBulkOperationRequest(
    workspaceId,
    action,
    selectedItems,
    editField,
    editValue,
    moveProjectId,
  )
  const requestReady = selectedItems.length > 0 && (
    action === 'archive' ||
    (action === 'move' ? Boolean(moveProjectId.trim()) : Boolean(editValue.trim()))
  )
  const mutationsAvailable = !readOnly && Boolean(onPreview && onApply)

  const resetReview = () => {
    setPreview(undefined)
    setPreviewedRequest(undefined)
    setOperation(undefined)
    setErrorMessage(undefined)
  }

  const selectAction = (nextAction: BulkOperationAction['type']) => {
    setAction(nextAction)
    resetReview()
  }

  const handlePreview = async () => {
    if (!request || !requestReady || !onPreview) {
      return
    }

    setBusyState('preview')
    setErrorMessage(undefined)
    try {
      const nextPreview = await onPreview(request)
      setPreviewedRequest(request)
      setPreview(nextPreview)
      setOperation(undefined)
    } catch (error) {
      setErrorMessage(toBulkErrorMessage(error, t))
    } finally {
      setBusyState(undefined)
    }
  }

  const handleApply = async () => {
    if (!previewedRequest || !activePreview || !onApply) {
      return
    }

    setBusyState('apply')
    setErrorMessage(undefined)
    try {
      const nextOperation = await onApply(previewedRequest, activePreview)
      setOperation(nextOperation)
      onOperationComplete?.(nextOperation)
    } catch (error) {
      setErrorMessage(toBulkErrorMessage(error, t))
    } finally {
      setBusyState(undefined)
    }
  }

  const handleRetry = async () => {
    if (!operation || !onRetry) {
      return
    }

    setBusyState('retry')
    setErrorMessage(undefined)
    try {
      const nextOperation = await onRetry(operation.id)
      setOperation(nextOperation)
      onOperationComplete?.(nextOperation)
    } catch (error) {
      setErrorMessage(toBulkErrorMessage(error, t))
    } finally {
      setBusyState(undefined)
    }
  }

  const handleResume = async () => {
    if (!operation || !previewedRequest || !preview || !onApply) {
      return
    }

    setBusyState('resume')
    setErrorMessage(undefined)
    try {
      const nextOperation = await onApply(previewedRequest, preview)
      setOperation(nextOperation)
      onOperationComplete?.(nextOperation)
    } catch (error) {
      setErrorMessage(toBulkErrorMessage(error, t))
    } finally {
      setBusyState(undefined)
    }
  }

  const handleUndo = async () => {
    if (!operation || !onUndo) {
      return
    }

    setBusyState('undo')
    setErrorMessage(undefined)
    try {
      const nextOperation = await onUndo(operation.id)
      setOperation(nextOperation)
      onOperationComplete?.(nextOperation)
    } catch (error) {
      setErrorMessage(toBulkErrorMessage(error, t))
    } finally {
      setBusyState(undefined)
    }
  }

  return (
    <section className="workbench-toolbar mt-3 px-3 py-3" data-testid="bulk-operation-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-white px-3 text-sm font-semibold text-[var(--workbench-text)]">
          <input
            aria-label={t('bulk.selectVisible')}
            checked={allVisibleSelected}
            className="h-4 w-4 rounded border-[var(--workbench-border-strong)] text-[var(--workbench-primary)]"
            disabled={readOnly || visibleItems.length === 0}
            onChange={(event) => onVisibleSelectionChange(
              visibleItems.map((item) => item.selectionKey),
              event.target.checked,
            )}
            ref={selectAllRef}
            type="checkbox"
          />
          {t('bulk.selectVisible')}
        </label>
        <span className="workbench-badge-primary" data-testid="bulk-selected-count">
          {t('bulk.selectedCount').replace('{count}', String(selectedItems.length))}
        </span>
        {(['edit', 'move', 'archive'] as const).map((candidate) => (
          <button
            aria-pressed={action === candidate}
            className={`h-9 rounded-md border px-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
              action === candidate
                ? 'border-[var(--workbench-primary)] bg-[#e5f7f4] text-[var(--workbench-primary)]'
                : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-text)] hover:border-[var(--workbench-primary)]'
            }`}
            disabled={!mutationsAvailable || selectedItems.length === 0}
            key={candidate}
            onClick={() => selectAction(candidate)}
            type="button"
          >
            {t(`bulk.action.${candidate}`)}
          </button>
        ))}
      </div>

      {readOnly ? (
        <p className="mt-2 text-sm font-semibold text-[var(--workbench-muted)]">
          {t('bulk.readOnly')}
        </p>
      ) : selectedItems.length === 0 ? (
        <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">{t('bulk.noSelection')}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-[var(--workbench-border)] pt-3">
          {action === 'edit' ? (
            <>
              <label className="grid min-w-48 gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={fieldId}>
                {t('bulk.edit.field')}
                <select
                  className="workbench-input h-9 bg-white px-3 text-sm"
                  id={fieldId}
                  onChange={(event) => {
                    setEditField(event.target.value as BulkEditField)
                    setEditValue('')
                    resetReview()
                  }}
                  value={editField}
                >
                  {bulkEditFields.map((field) => (
                    <option key={field} value={field}>{t(`bulk.edit.field.${field}`)}</option>
                  ))}
                </select>
              </label>
              <label className="grid min-w-56 flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={valueId}>
                {t('bulk.edit.value')}
                {editField === 'priority' ? (
                  <select
                    className="workbench-input h-9 bg-white px-3 text-sm"
                    id={valueId}
                    onChange={(event) => {
                      setEditValue(event.target.value)
                      resetReview()
                    }}
                    value={editValue}
                  >
                    <option value="">{t('bulk.edit.valuePlaceholder')}</option>
                    {bulkPriorities.map((priority) => (
                      <option key={priority} value={priority}>{t(`tasks.priority.${priority}`)}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="workbench-input h-9 px-3 text-sm"
                    id={valueId}
                    onChange={(event) => {
                      setEditValue(event.target.value)
                      resetReview()
                    }}
                    placeholder={t(`bulk.edit.placeholder.${editField}`)}
                    type={editField === 'dueDate' ? 'date' : 'text'}
                    value={editValue}
                  />
                )}
              </label>
            </>
          ) : null}
          {action === 'move' ? (
            <label className="grid min-w-64 flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={targetProjectId}>
              {t('bulk.move.targetProject')}
              <select
                className="workbench-input h-9 bg-white px-3 text-sm"
                id={targetProjectId}
                onChange={(event) => {
                  setMoveProjectId(event.target.value)
                  resetReview()
                }}
                value={moveProjectId}
              >
                <option value="">{t('bulk.move.targetPlaceholder')}</option>
                {projectOptions.map((project) => (
                  <option key={project.id} value={project.id}>{project.label}</option>
                ))}
              </select>
            </label>
          ) : null}
          {action === 'archive' ? (
            <p className="min-w-64 flex-1 text-sm font-semibold text-amber-800">
              {t('bulk.archive.description')}
            </p>
          ) : null}
          <button
            className="workbench-button-primary h-9 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!requestReady || busyState !== undefined}
            onClick={() => void handlePreview()}
            type="button"
          >
            {t(busyState === 'preview' ? 'bulk.previewing' : 'bulk.preview')}
          </button>
        </div>
      )}

      {activePreview || operation || errorMessage ? (
        <BulkOperationResultPanel
          errorMessage={errorMessage}
          isApplying={busyState === 'apply'}
          isResuming={busyState === 'resume'}
          isRetrying={busyState === 'retry'}
          isUndoing={busyState === 'undo'}
          operation={operation}
          preview={activePreview}
          t={t}
          onApply={activePreview && onApply ? () => void handleApply() : undefined}
          onClose={resetReview}
          onResume={operation && previewedRequest && preview && onApply
            ? () => void handleResume()
            : undefined}
          onRetry={operation && onRetry ? () => void handleRetry() : undefined}
          onUndo={operation && onUndo ? () => void handleUndo() : undefined}
        />
      ) : null}
    </section>
  )
}

function createBulkOperationRequest(
  workspaceId: string,
  action: BulkOperationAction['type'],
  selectedItems: BulkOperationSelection[],
  editField: BulkEditField,
  editValue: string,
  moveProjectId: string,
): BulkOperationRequest | undefined {
  if (selectedItems.length === 0) {
    return undefined
  }

  const items = selectedItems.map(({ teamId, workItemId, expectedRevision }) => ({
    expectedRevision,
    teamId,
    workItemId,
  }))

  if (action === 'archive') {
    return { action: { archived: true, type: action }, items, workspaceId }
  }

  if (action === 'move') {
    return {
      action: { targetProjectId: moveProjectId.trim(), type: action },
      items,
      workspaceId,
    }
  }

  return {
    action: {
      patch: createBulkEditPatch(editField, editValue),
      type: action,
    },
    items,
    workspaceId,
  }
}

function toBulkErrorMessage(error: unknown, t: (key: MessageKey) => string) {
  return error instanceof Error && error.message ? error.message : t('bulk.error')
}
