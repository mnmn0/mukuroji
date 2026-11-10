import { WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT, type WorkItemAcceptanceCriterion } from '@mukuroji/contracts'
import { useId } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import {
  ACCEPTANCE_CRITERIA_DRAFT_FORM_FIELD,
  countSatisfiedAcceptanceCriteria,
  createEmptyAcceptanceCriterionDraftRow,
  serializeAcceptanceCriterionDraftRows,
  toAcceptanceCriterionDraftRows,
  type AcceptanceCriterionDraftRow,
} from '../model/acceptanceCriteria'
import type { AcceptanceCriteriaDraftState } from './useAcceptanceCriteriaDraft'

/**
 * Props accepted by the Work Item acceptance criteria editor.
 */
export type WorkItemAcceptanceCriteriaEditorProps = {
  /** Display locale. */
  locale: Locale
  /** Criteria stored on the Work Item. */
  criteria: readonly WorkItemAcceptanceCriterion[] | undefined
  /**
   * Editor form that submits the open draft with its other changes. The draft travels in a
   * hidden field, so the criteria are saved with the form's other edits at one revision.
   */
  formId?: string
  /** Draft held by the owning editor, so unsaved rows survive this section moving in the layout. */
  draftState: AcceptanceCriteriaDraftState
  /** Shows criteria without edit controls. */
  readOnly?: boolean
}

/**
 * Shows the conditions a Work Item must meet and edits them as one replacement list.
 *
 * Coding agents mark criteria met or unmet as they work; people add, remove, reorder, and reword
 * them here. The draft is saved with the owning form, so editing criteria never discards unsaved
 * edits elsewhere in the form.
 *
 * @param props - Stored criteria, the owning form, and the draft state.
 * @returns The acceptance criteria section.
 */
export function WorkItemAcceptanceCriteriaEditor({
  criteria,
  draftState,
  formId,
  locale,
  readOnly = false,
}: WorkItemAcceptanceCriteriaEditorProps) {
  const t = createTranslator(locale)
  const headingId = useId()
  // The row at fault points its text field at the error message.
  const errorId = `${headingId}-error`
  const { draft, setDraft } = draftState
  const { rows, submitError } = draft
  const canEdit = !readOnly && formId !== undefined
  const { satisfied, total } = countSatisfiedAcceptanceCriteria(criteria)

  /**
   * Replaces or updates the draft rows; undefined closes the draft.
   *
   * @param action - Next rows or an updater of the current rows.
   */
  const setRows = (
    action:
      | AcceptanceCriterionDraftRow[]
      | undefined
      | ((current: AcceptanceCriterionDraftRow[] | undefined) => AcceptanceCriterionDraftRow[] | undefined),
  ) => {
    setDraft((current) => {
      const next = typeof action === 'function' ? action(current.rows) : action
      return next ? { ...current, rows: next } : { nextRowNumber: current.nextRowNumber }
    })
  }

  /**
   * Replaces fields of one draft row.
   *
   * @param key - Row being edited.
   * @param patch - Fields to replace.
   */
  const updateRow = (key: string, patch: Partial<AcceptanceCriterionDraftRow>) => {
    setRows((current) => current?.map((row) => row.key === key ? { ...row, ...patch } : row))
  }

  /**
   * Moves one draft row up or down.
   *
   * @param index - Current position of the row.
   * @param offset - -1 to move up, 1 to move down.
   */
  const moveRow = (index: number, offset: -1 | 1) => {
    setRows((current) => {
      if (!current) return current
      const target = index + offset
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const [row] = next.splice(index, 1)
      if (row) next.splice(target, 0, row)
      return next
    })
  }

  return (
    <section
      aria-labelledby={headingId}
      className="workbench-panel-muted grid min-w-0 gap-3 p-3"
      data-testid="work-item-acceptance-criteria"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]" id={headingId}>
          {t('workItems.acceptanceCriteria.title')}
        </h3>
        {total > 0 ? (
          <span className="text-xs text-[var(--workbench-muted)]">
            {t('workItems.acceptanceCriteria.progress')
              .replace('{satisfied}', String(satisfied))
              .replace('{total}', String(total))}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-[var(--workbench-muted)]">{t('workItems.acceptanceCriteria.help')}</p>

      {rows === undefined ? (
        <>
          {total === 0 ? (
            <p className="text-sm text-[var(--workbench-muted)]">{t('workItems.acceptanceCriteria.empty')}</p>
          ) : (
            <ul className="grid gap-1.5" data-testid="work-item-acceptance-criterion-list">
              {(criteria ?? []).map((criterion) => (
                <li className="flex min-w-0 items-start gap-2 text-sm text-[var(--workbench-text)]" key={criterion.id}>
                  <span
                    aria-hidden="true"
                    className={criterion.satisfied ? 'text-[var(--workbench-success)]' : 'text-[var(--workbench-muted)]'}
                  >
                    {criterion.satisfied ? '☑' : '☐'}
                  </span>
                  <span className="min-w-0 break-words">
                    <span className="sr-only">
                      {criterion.satisfied
                        ? t('workItems.acceptanceCriteria.satisfied')
                        : t('workItems.acceptanceCriteria.unsatisfied')}
                      {': '}
                    </span>
                    {criterion.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canEdit ? (
            <button
              className="workbench-button-secondary h-8 justify-self-start px-3 text-sm"
              onClick={() => setRows(toAcceptanceCriterionDraftRows(criteria))}
              type="button"
            >
              {t('workItems.acceptanceCriteria.edit')}
            </button>
          ) : null}
        </>
      ) : (
        <div className="grid gap-2">
          {rows.map((row, index) => {
            const rowLabel = `${t('workItems.acceptanceCriteria.criterion')} ${index + 1}`
            const hasRowError = submitError?.rowKey === row.key
            return (
              <fieldset
                className={`grid min-w-0 gap-2 rounded-md border p-2 ${
                  hasRowError ? 'border-[var(--workbench-danger)]' : 'border-[var(--workbench-border)]'
                }`}
                data-testid="work-item-acceptance-criterion-row"
                key={row.key}
              >
                <legend className="sr-only">{rowLabel}</legend>
                <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-text)]">
                  {rowLabel}
                  <textarea
                    aria-describedby={hasRowError ? errorId : undefined}
                    aria-invalid={hasRowError || undefined}
                    className="workbench-input min-h-16 w-full min-w-0 px-2 py-1.5 text-sm"
                    onChange={(event) => updateRow(row.key, { text: event.target.value })}
                    value={row.text}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-[var(--workbench-text)]">
                    <input
                      checked={row.satisfied}
                      onChange={(event) => updateRow(row.key, { satisfied: event.target.checked })}
                      type="checkbox"
                    />
                    {t('workItems.acceptanceCriteria.satisfied')}
                  </label>
                  <button
                    aria-label={`${t('workItems.acceptanceCriteria.moveUp')}: ${rowLabel}`}
                    className="workbench-button-secondary h-7 px-2 text-xs"
                    disabled={index === 0}
                    onClick={() => moveRow(index, -1)}
                    type="button"
                  >
                    {t('workItems.acceptanceCriteria.moveUp')}
                  </button>
                  <button
                    aria-label={`${t('workItems.acceptanceCriteria.moveDown')}: ${rowLabel}`}
                    className="workbench-button-secondary h-7 px-2 text-xs"
                    disabled={index === rows.length - 1}
                    onClick={() => moveRow(index, 1)}
                    type="button"
                  >
                    {t('workItems.acceptanceCriteria.moveDown')}
                  </button>
                  <button
                    aria-label={`${t('workItems.acceptanceCriteria.remove')}: ${rowLabel}`}
                    className="workbench-button-secondary h-7 px-2 text-xs"
                    onClick={() => setRows((current) => current?.filter((candidate) => candidate.key !== row.key))}
                    type="button"
                  >
                    {t('workItems.acceptanceCriteria.remove')}
                  </button>
                </div>
              </fieldset>
            )
          })}
          {formId ? (
            <input
              form={formId}
              name={ACCEPTANCE_CRITERIA_DRAFT_FORM_FIELD}
              type="hidden"
              value={serializeAcceptanceCriterionDraftRows(rows)}
            />
          ) : null}
          {submitError ? (
            <p className="text-sm font-semibold text-[var(--workbench-danger)]" id={errorId} role="alert">
              {t(`workItems.acceptanceCriteria.error.${submitError.error}`)}
            </p>
          ) : (
            <p className="text-xs text-[var(--workbench-muted)]">{t('workItems.acceptanceCriteria.pendingSave')}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className="workbench-button-secondary h-8 px-3 text-sm"
              disabled={rows.length >= WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT}
              onClick={() => {
                setDraft((current) => ({
                  rows: [...(current.rows ?? []), createEmptyAcceptanceCriterionDraftRow(`new-${current.nextRowNumber}`)],
                  nextRowNumber: current.nextRowNumber + 1,
                }))
              }}
              type="button"
            >
              {t('workItems.acceptanceCriteria.add')}
            </button>
            <button
              className="workbench-button-secondary h-8 px-3 text-sm"
              onClick={() => setRows(undefined)}
              type="button"
            >
              {t('workItems.acceptanceCriteria.cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
