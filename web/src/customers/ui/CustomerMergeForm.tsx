import { useState } from 'react'
import type { Customer } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Props for the form that merges a duplicate Customer into the Customer to keep. */
export type CustomerMergeFormProps = {
  /** Duplicate Customer that is merged away. */
  source: Customer
  /** Customers the duplicate may be merged into. The source itself is left out. */
  candidates: readonly Customer[]
  /** Whether a change is being sent. */
  isSaving: boolean
  /** Merges the source into the chosen Customer. Resolves true when it was merged. */
  onMerge: (target: Customer) => Promise<boolean>
  /** Closes the form without merging. */
  onCancel: () => void
  /** Translator for form copy. */
  t: (key: MessageKey) => string
}

/** Lets a Customer manager pick the Customer to keep, read what moves, and confirm the merge.
 *
 * @param props Source Customer, merge candidates, and callbacks.
 * @returns The Customer merge form.
 */
export function CustomerMergeForm({
  candidates,
  isSaving,
  onCancel,
  onMerge,
  source,
  t,
}: CustomerMergeFormProps) {
  const options = candidates.filter((candidate) => candidate.id !== source.id)
  const [targetId, setTargetId] = useState('')
  const [isConfirming, setIsConfirming] = useState(false)
  const target = options.find((candidate) => candidate.id === targetId)
  return (
    <form
      aria-label={t('customers.merge.title')}
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!target || isSaving) return
        if (!isConfirming) {
          setIsConfirming(true)
          return
        }
        void onMerge(target)
      }}
    >
      <h3 className="text-sm font-bold text-[var(--workbench-text)]">{t('customers.merge.title')}</h3>
      <p className="text-xs text-[var(--workbench-muted)]">{t('customers.merge.description')}</p>
      {options.length === 0 ? (
        <p className="text-sm text-[var(--workbench-muted)]">{t('customers.merge.noCandidates')}</p>
      ) : (
        <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          <span>{t('customers.merge.target')}</span>
          <select
            className="workbench-input min-h-10 w-full"
            disabled={isConfirming}
            onChange={(event) => setTargetId(event.target.value)}
            value={targetId}
          >
            <option value="">{t('customers.merge.chooseTarget')}</option>
            {options.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.domain ? `${candidate.name} (${candidate.domain})` : candidate.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {target && isConfirming ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-fg-amber-800" role="alert">
          {t('customers.merge.confirmMessage')
            .replaceAll('{source}', source.name)
            .replaceAll('{target}', target.name)
            .replace('{contacts}', String(source.contactCount))
            .replace('{requests}', String(source.requestCount))}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          className={isConfirming
            ? 'min-h-9 rounded-md border border-red-200 bg-red-50 px-3 text-xs font-semibold text-fg-red-700'
            : 'workbench-button-primary min-h-9 px-3 text-xs'}
          disabled={!target || isSaving}
          type="submit"
        >
          {isSaving ? t('customers.merge.merging') : isConfirming ? t('customers.merge.confirm') : t('customers.merge.next')}
        </button>
        <button
          className="workbench-button-secondary min-h-9 px-3 text-xs"
          onClick={() => {
            if (isConfirming) setIsConfirming(false)
            else onCancel()
          }}
          type="button"
        >
          {isConfirming ? t('customers.merge.back') : t('customers.edit.cancel')}
        </button>
      </div>
    </form>
  )
}
