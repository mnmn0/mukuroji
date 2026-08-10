import type {
  BulkOperation,
  BulkOperationPreview,
  BulkOperationRequest,
} from '@mukuroji/contracts'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import { BulkOperationResultPanel } from './BulkOperationResultPanel'
import {
  bulkEditFields,
  createBulkEditPatch,
  isBulkOperationPreviewRequestCurrent,
  type BulkEditField,
  type BulkOperationSelection,
} from '../model/bulkOperation'
import {
  resolveBulkOperationToolbarActionSelection,
  type BulkOperationTaskActionId,
  type BulkOperationToolbarAction,
} from '../model/bulkOperationActionHandshake'
import { resolveBulkOperationTaskActionUndoToken } from '../model/bulkOperationTaskAction'

export type { BulkOperationSelection } from '../model/bulkOperation'

const bulkPriorities = ['high', 'medium', 'low'] as const

/** Canonical bulk action requested by another Project action entrance. */
export type BulkOperationTaskActionRequest = {
  /** Project action to reveal in the bulk-operation toolbar. */
  actionId: BulkOperationTaskActionId
  /** Project that owned the selection when the action was requested. */
  projectId: string
  /** Monotonic identifier that permits repeated requests for the same action. */
  requestId: number
}

/** Invocation identity retained by non-operation terminal bulk outcomes. */
type BulkOperationTaskActionInterruptionIdentity = {
  /** Monotonic request accepted by the toolbar instance that produced this outcome. */
  requestId?: number
}

/** Non-operation terminal outcome returned by the bulk editor to a pending canonical action. */
export type BulkOperationTaskActionInterruption = BulkOperationTaskActionInterruptionIdentity & (
  | {
      /** User dismissed the preview or switched to the non-canonical generic editor. */
      kind: 'cancelled'
    }
  | {
      /** Preview or apply raised an unexpected mutation error. */
      kind: 'failed'
      /** Original error retained for the surface's safe failure mapper. */
      error: unknown
    }
  | {
      /** Authoritative preview rejected persistence for one or more targets. */
      kind: 'preview-rejected'
      /** Revision-bound per-target validation outcomes. */
      preview: BulkOperationPreview
    }
)

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
  /** Canonical action requested by command-menu or another shared entrance. */
  taskActionRequest?: BulkOperationTaskActionRequest
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
  /** Returns an applied operation to the exact canonical request that opened this toolbar. */
  onTaskActionOperationComplete?: (
    request: BulkOperationTaskActionRequest,
    operation: BulkOperation,
  ) => void
  /** Claims the exact canonical request immediately before apply dispatch. */
  onTaskActionMutationStart?: (request: BulkOperationTaskActionRequest) => boolean
  /** Runs a toolbar action entrance through the shared Project action registry. */
  onTaskActionRequest?: (
    actionId: BulkOperationTaskActionRequest['actionId'],
  ) => Promise<boolean>
  /** Acknowledges that the current canonical entrance initialized this toolbar instance. */
  onTaskActionRequestConsumed?: (requestId: number) => void
  /** Returns cancellation, preview rejection, or mutation failure to the pending action bridge. */
  onTaskActionInterrupted?: (interruption: BulkOperationTaskActionInterruption) => void
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
  taskActionRequest,
  t,
  onVisibleSelectionChange,
  onPreview,
  onApply,
  onRetry,
  onUndo,
  onOperationComplete,
  onTaskActionOperationComplete,
  onTaskActionMutationStart,
  onTaskActionRequest,
  onTaskActionRequestConsumed,
  onTaskActionInterrupted,
  initialPreview,
  initialOperation,
}: BulkOperationToolbarProps) {
  const fieldId = useId()
  const valueId = useId()
  const targetProjectId = useId()
  const selectAllRef = useRef<HTMLInputElement>(null)
  const [action, setAction] = useState<BulkOperationToolbarAction>(
    taskActionRequest?.actionId ?? 'edit',
  )
  const [editField, setEditField] = useState<BulkEditField>(
    taskActionRequest?.actionId === 'assign' ? 'assigneeUserId' : 'workflowStatusId',
  )
  const [editValue, setEditValue] = useState('')
  const [moveProjectId, setMoveProjectId] = useState('')
  const [previewedRequest, setPreviewedRequest] = useState<BulkOperationRequest>()
  const [preview, setPreview] = useState<BulkOperationPreview | undefined>(initialPreview)
  const [operation, setOperation] = useState<BulkOperation | undefined>(initialOperation)
  const [activeTaskActionRequest, setActiveTaskActionRequest] = useState(taskActionRequest)
  const [errorMessage, setErrorMessage] = useState<string>()
  const [busyState, setBusyState] = useState<
    'preview' | 'apply' | 'resume' | 'retry' | 'undo'
  >()
  const selectedKeySet = useMemo(
    () => new Set(selectedItems.map((item) => item.selectionKey)),
    [selectedItems],
  )
  const allVisibleSelected = visibleItems.length > 0 &&
    visibleItems.every((item) => selectedKeySet.has(item.selectionKey))
  const someVisibleSelected = visibleItems.some((item) => selectedKeySet.has(item.selectionKey))

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
  const isPreviewRequestCurrent = !previewedRequest ||
    isBulkOperationPreviewRequestCurrent(previewedRequest, request)
  const activePreview = isPreviewRequestCurrent ? preview : undefined
  const requestReady = request !== undefined
  const mutationsAvailable = !readOnly && Boolean(onPreview && onApply)

  const resetReview = useCallback(() => {
    setPreview(undefined)
    setPreviewedRequest(undefined)
    setOperation(undefined)
    setErrorMessage(undefined)
  }, [])

  /** Dismisses preview state and cancels an accepted action that has not applied. */
  const closeReview = useCallback(() => {
    onTaskActionInterrupted?.({
      kind: 'cancelled',
      ...(activeTaskActionRequest
        ? { requestId: activeTaskActionRequest.requestId }
        : {}),
    })
    setActiveTaskActionRequest(undefined)
    resetReview()
  }, [activeTaskActionRequest, onTaskActionInterrupted, resetReview])

  /** Activates one toolbar mode after its canonical entrance has been accepted. */
  const activateAction = useCallback((nextAction: BulkOperationToolbarAction) => {
    setAction(nextAction)
    if (nextAction === 'assign') setEditField('assigneeUserId')
    if (nextAction === 'edit') setEditField('workflowStatusId')
    resetReview()
  }, [resetReview])

  useEffect(() => {
    if (!taskActionRequest) return
    queueMicrotask(() => {
      activateAction(taskActionRequest.actionId)
      setActiveTaskActionRequest(taskActionRequest)
    })
    onTaskActionRequestConsumed?.(taskActionRequest.requestId)
  }, [activateAction, onTaskActionRequestConsumed, taskActionRequest])

  /** Routes parameterized Project actions through the shared registry before revealing inputs. */
  const selectAction = (nextAction: BulkOperationToolbarAction) => {
    const selection = resolveBulkOperationToolbarActionSelection(
      nextAction,
      onTaskActionRequest !== undefined,
    )
    if (selection.immediateAction) {
      onTaskActionInterrupted?.({
        kind: 'cancelled',
        ...(activeTaskActionRequest
          ? { requestId: activeTaskActionRequest.requestId }
          : {}),
      })
      setActiveTaskActionRequest(undefined)
      activateAction(selection.immediateAction)
      return
    }
    if (!selection.requestedActionId || !onTaskActionRequest) return

    setErrorMessage(undefined)
    void onTaskActionRequest(selection.requestedActionId).catch((error: unknown) => {
      setErrorMessage(toBulkErrorMessage(error, t))
    })
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
      if (!nextPreview.canApply && activeTaskActionRequest) {
        onTaskActionInterrupted?.({
          kind: 'preview-rejected',
          preview: nextPreview,
          requestId: activeTaskActionRequest.requestId,
        })
        setActiveTaskActionRequest(undefined)
        resetReview()
      }
    } catch (error) {
      setErrorMessage(toBulkErrorMessage(error, t))
      if (activeTaskActionRequest) {
        onTaskActionInterrupted?.({
          error,
          kind: 'failed',
          requestId: activeTaskActionRequest.requestId,
        })
        setActiveTaskActionRequest(undefined)
        resetReview()
      }
    } finally {
      setBusyState(undefined)
    }
  }

  const handleApply = async () => {
    if (!previewedRequest || !activePreview || !onApply) {
      return
    }
    if (
      activeTaskActionRequest &&
      onTaskActionMutationStart &&
      !onTaskActionMutationStart(activeTaskActionRequest)
    ) {
      setActiveTaskActionRequest(undefined)
      resetReview()
      return
    }

    setBusyState('apply')
    setErrorMessage(undefined)
    try {
      const nextOperation = await onApply(previewedRequest, activePreview)
      setOperation(nextOperation)
      if (activeTaskActionRequest) {
        onTaskActionOperationComplete?.(activeTaskActionRequest, nextOperation)
        setActiveTaskActionRequest(undefined)
      }
      onOperationComplete?.(nextOperation)
    } catch (error) {
      setErrorMessage(toBulkErrorMessage(error, t))
      if (activeTaskActionRequest) {
        onTaskActionInterrupted?.({
          error,
          kind: 'failed',
          requestId: activeTaskActionRequest.requestId,
        })
        setActiveTaskActionRequest(undefined)
        resetReview()
      }
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
    const undoToken = resolveBulkOperationTaskActionUndoToken(operation)
    if (!undoToken) return

    setBusyState('undo')
    setErrorMessage(undefined)
    try {
      const nextOperation = await onUndo(undoToken)
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
            disabled={readOnly || visibleItems.length === 0 || busyState !== undefined}
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
        {(['edit', 'move', 'assign', 'archive'] as const).map((candidate) => (
          <button
            aria-pressed={action === candidate}
            className={`h-9 rounded-md border px-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
              action === candidate
                ? 'border-[var(--workbench-primary)] bg-[#e5f7f4] text-[var(--workbench-primary)]'
                : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-text)] hover:border-[var(--workbench-primary)]'
            }`}
            disabled={
              !mutationsAvailable || selectedItems.length === 0 || busyState !== undefined
            }
            key={candidate}
            onClick={() => void selectAction(candidate)}
            type="button"
          >
            {resolveBulkOperationActionLabel(candidate, t)}
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
                  {bulkEditFields.filter((field) => field !== 'assigneeUserId').map((field) => (
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
                    type="text"
                    value={editValue}
                  />
                )}
              </label>
            </>
          ) : null}
          {action === 'assign' ? (
            <label className="grid min-w-56 flex-1 gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={valueId}>
              {t('bulk.edit.field.assigneeUserId')}
              <input
                className="workbench-input h-9 px-3 text-sm"
                id={valueId}
                onChange={(event) => {
                  setEditValue(event.target.value)
                  resetReview()
                }}
                placeholder={t('bulk.edit.placeholder.assigneeUserId')}
                type="text"
                value={editValue}
              />
            </label>
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
          onClose={closeReview}
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
  action: BulkOperationToolbarAction,
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
    const normalizedProjectId = moveProjectId.trim()
    if (!normalizedProjectId) {
      return undefined
    }
    return {
      action: { targetProjectId: normalizedProjectId, type: action },
      items,
      workspaceId,
    }
  }

  if (action === 'assign') {
    if (!editValue.trim()) return undefined
    return {
      action: {
        patch: createBulkEditPatch('assigneeUserId', editValue),
        type: 'edit',
      },
      items,
      workspaceId,
    }
  }

  if (!editValue.trim()) {
    return undefined
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

/** Resolves one localized toolbar action label without widening message keys. */
function resolveBulkOperationActionLabel(
  action: BulkOperationToolbarAction,
  t: (key: MessageKey) => string,
): string {
  if (action === 'assign') return t('taskViews.action.assign')
  if (action === 'edit') return t('bulk.action.edit')
  if (action === 'move') return t('bulk.action.move')
  return t('bulk.action.archive')
}

function toBulkErrorMessage(error: unknown, t: (key: MessageKey) => string) {
  return error instanceof Error && error.message ? error.message : t('bulk.error')
}
