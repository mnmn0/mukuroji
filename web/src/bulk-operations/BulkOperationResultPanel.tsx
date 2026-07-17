import type {
  BulkOperation,
  BulkOperationItemResult,
  BulkOperationPreview,
} from '@mukuroji/contracts'
import type { MessageKey } from '../i18n'
import {
  createBulkItemIdentity,
  getResumableBulkOperationItems,
  getRetryableBulkOperationItems,
  getSucceededBulkOperationItems,
} from './helpers'

/** Bulk operation review/result panel の props です。 */
export type BulkOperationResultPanelProps = {
  /** Apply 前に表示する validation preview です。 */
  preview?: BulkOperationPreview
  /** Apply、retry、undo 後の最新 operation です。 */
  operation?: BulkOperation
  /** Apply request を送信中かどうかです。 */
  isApplying?: boolean
  /** Failed item の retry request を送信中かどうかです。 */
  isRetrying?: boolean
  /** Running operation の apply request を再送信中かどうかです。 */
  isResuming?: boolean
  /** Undo request を送信中かどうかです。 */
  isUndoing?: boolean
  /** API failure 時に表示する安全な message です。 */
  errorMessage?: string
  /** 現在 locale の翻訳関数です。 */
  t: (key: MessageKey) => string
  /** Preview を確定する callback です。 */
  onApply?: () => void
  /** Failed item だけを retry する callback です。 */
  onRetry?: () => void
  /** Running operation の未完了 item を同じ apply request で再開する callback です。 */
  onResume?: () => void
  /** 成功済み item を undo する callback です。 */
  onUndo?: () => void
  /** Review/result を閉じる callback です。 */
  onClose: () => void
}

/**
 * Preview validation と item ごとの apply/retry/undo 結果を表示します。
 */
export function BulkOperationResultPanel({
  preview,
  operation,
  isApplying = false,
  isRetrying = false,
  isResuming = false,
  isUndoing = false,
  errorMessage,
  t,
  onApply,
  onRetry,
  onResume,
  onUndo,
  onClose,
}: BulkOperationResultPanelProps) {
  const retryableItems = operation ? getRetryableBulkOperationItems(operation) : []
  const resumableItems = operation ? getResumableBulkOperationItems(operation) : []
  const succeededItems = operation ? getSucceededBulkOperationItems(operation) : []
  const canUndo = Boolean(
    operation &&
    onUndo &&
    succeededItems.some((item) => item.undoable) &&
    operation.status !== 'running' &&
    operation.status !== 'undone',
  )

  return (
    <section
      aria-label={t(operation ? 'bulk.result.title' : 'bulk.preview.title')}
      className="mt-3 rounded-lg border border-[var(--workbench-border)] bg-white shadow-[0_12px_30px_rgba(28,40,64,0.08)]"
      data-testid="bulk-operation-review"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3">
        <div>
          <h3 className="text-sm font-bold text-[var(--workbench-text)]">
            {t(operation ? 'bulk.result.title' : 'bulk.preview.title')}
          </h3>
          {operation ? (
            <p className="mt-1 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('bulk.operation.id')}: {operation.id}
            </p>
          ) : null}
        </div>
        <button
          className="workbench-button-secondary h-8 px-3 text-xs"
          onClick={onClose}
          type="button"
        >
          {t('bulk.close')}
        </button>
      </div>

      {preview ? <PreviewSummary preview={preview} t={t} /> : null}
      {operation ? <OperationSummary operation={operation} t={t} /> : null}

      {errorMessage ? (
        <p className="mx-4 mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2 px-4 py-3">
        {!operation && preview && onApply ? (
          <button
            className="workbench-button-primary h-9 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isApplying || !preview.canApply}
            onClick={onApply}
            type="button"
          >
            {t(isApplying ? 'bulk.applying' : 'bulk.apply')}
          </button>
        ) : null}
        {operation && onResume && resumableItems.length > 0 ? (
          <button
            className="workbench-button-secondary h-9 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="bulk-resume"
            disabled={isResuming || isRetrying || isUndoing}
            onClick={onResume}
            type="button"
          >
            {t(isResuming ? 'bulk.resuming' : 'bulk.resume')
              .replace('{count}', String(resumableItems.length))}
          </button>
        ) : null}
        {operation && operation.status !== 'running' && onRetry && retryableItems.length > 0 ? (
          <button
            className="workbench-button-secondary h-9 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="bulk-retry-failed"
            disabled={isRetrying || isResuming || isUndoing}
            onClick={onRetry}
            type="button"
          >
            {t(isRetrying ? 'bulk.retrying' : 'bulk.retryFailed')
              .replace('{count}', String(retryableItems.length))}
          </button>
        ) : null}
        {operation && canUndo ? (
          <button
            className="workbench-button-secondary h-9 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="bulk-undo"
            disabled={isUndoing || isRetrying || isResuming}
            onClick={onUndo}
            type="button"
          >
            {t(isUndoing ? 'bulk.undoing' : 'bulk.undo')}
          </button>
        ) : null}
      </div>
    </section>
  )
}

function PreviewSummary({
  preview,
  t,
}: {
  preview: BulkOperationPreview
  t: (key: MessageKey) => string
}) {
  const validCount = preview.items.filter((item) => item.status === 'ready').length

  return (
    <div className="px-4 py-3">
      <p className="text-sm font-semibold text-[var(--workbench-text)]">
        {t('bulk.preview.summary')
          .replace('{valid}', String(validCount))
          .replace('{total}', String(preview.items.length))}
      </p>
      <ul className="mt-3 grid max-h-64 gap-2 overflow-auto" data-testid="bulk-preview-items">
        {preview.items.map((item) => (
          <li
            className={`rounded-md border px-3 py-2 text-sm ${
              item.status === 'ready'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-red-200 bg-red-50 text-red-800'
            }`}
            key={createBulkItemIdentity(item.teamId, item.workItemId)}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold">{item.teamId} / {item.workItemId}</span>
              <span className="text-xs font-bold uppercase">
                {t(item.status === 'ready' ? 'bulk.item.valid' : 'bulk.item.validation')}
              </span>
            </div>
            {item.errorMessage ? <p className="mt-1 text-xs font-medium">{item.errorMessage}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function OperationSummary({
  operation,
  t,
}: {
  operation: BulkOperation
  t: (key: MessageKey) => string
}) {
  const counts = countBulkOperationItemStatuses(operation.items)

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={resolveOperationToneClassName(operation.status)}>
          {t(`bulk.operation.status.${operation.status}`)}
        </span>
        <span className="text-xs font-semibold text-[var(--workbench-muted)]">
          {t('bulk.result.summary')
            .replace('{succeeded}', String(counts.succeeded))
            .replace('{failed}', String(counts.failed))
            .replace('{conflict}', String(counts.conflict))}
        </span>
      </div>
      <ul className="mt-3 grid max-h-72 gap-2 overflow-auto" data-testid="bulk-operation-items">
        {operation.items.map((item) => (
          <BulkOperationResultItem item={item} key={createBulkItemIdentity(item.teamId, item.workItemId)} t={t} />
        ))}
      </ul>
    </div>
  )
}

function BulkOperationResultItem({
  item,
  t,
}: {
  item: BulkOperationItemResult
  t: (key: MessageKey) => string
}) {
  return (
    <li className={`rounded-md border px-3 py-2 text-sm ${resolveItemToneClassName(item.status)}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">{item.teamId} / {item.workItemId}</span>
        <span className="text-xs font-bold uppercase">
          {t(isBulkOperationConflict(item) ? 'bulk.item.status.conflict' : `bulk.item.status.${item.status}`)}
        </span>
      </div>
      {item.errorMessage ? <p className="mt-1 text-xs font-medium">{item.errorMessage}</p> : null}
    </li>
  )
}

function countBulkOperationItemStatuses(items: BulkOperationItemResult[]) {
  return {
    conflict: items.filter(isBulkOperationConflict).length,
    failed: items.filter((item) => item.status === 'failed' && !isBulkOperationConflict(item)).length,
    succeeded: items.filter((item) => item.status === 'succeeded').length,
  }
}

function resolveOperationToneClassName(status: BulkOperation['status']) {
  if (status === 'succeeded' || status === 'undone') {
    return 'workbench-badge-success'
  }
  if (status === 'partial' || status === 'running' || status === 'pending' || status === 'undoing') {
    return 'workbench-badge-warning'
  }
  return 'workbench-badge-danger'
}

function resolveItemToneClassName(status: BulkOperationItemResult['status']) {
  if (status === 'succeeded' || status === 'undone') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800'
  }
  if (status === 'ready' || status === 'skipped') {
    return 'border-amber-200 bg-amber-50 text-amber-800'
  }
  return 'border-red-200 bg-red-50 text-red-800'
}

function isBulkOperationConflict(item: BulkOperationItemResult) {
  return item.status === 'failed' && Boolean(item.errorCode?.toLowerCase().includes('conflict'))
}
