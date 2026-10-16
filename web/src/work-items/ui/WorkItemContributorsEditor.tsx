import type {
  WorkItemContributorAssignment,
  WorkItemContributorAssignmentInput,
  WorkItemJobRoleDefinition,
} from '@mukuroji/contracts'
import { useId, useState } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import type { ProjectMember } from '../../projects/api/members'
import {
  CONTRIBUTOR_DRAFT_FORM_FIELD,
  contributionStatuses,
  createEmptyContributorDraftRow,
  formatPlannedEffortHours,
  listSelectableJobRoles,
  parseContributorDraftRows,
  serializeContributorDraftRows,
  sumContributorPlannedEffort,
  toContributorDraftRows,
  type ContributorDraftError,
  type ContributorDraftRow,
} from '../model/contributorAssignments'

/**
 * Props accepted by the Work Item contributor editor.
 */
export type WorkItemContributorsEditorProps = {
  /** Display locale. */
  locale: Locale
  /** Contributors stored on the Work Item. */
  assignments: readonly WorkItemContributorAssignment[] | undefined
  /** Job roles defined by the Work Item configuration. */
  jobRoles: readonly WorkItemJobRoleDefinition[]
  /** Active members who can be added as contributors. */
  memberOptions: readonly Pick<ProjectMember, 'email' | 'id' | 'name'>[]
  /** Workspace user ID of the accountable owner, shown to keep the roles distinct. */
  ownerUserId: string
  /**
   * Editor form that submits the open draft with its other changes. When set, the
   * draft travels in a hidden field and this section has no save button of its own.
   */
  formId?: string
  /** Draft error reported by the owning form's submit handler. */
  submitError?: ContributorDraftSubmitError
  /** Saves a complete replacement contributor list on its own, outside any editor form. */
  onSave?: (assignments: WorkItemContributorAssignmentInput[]) => Promise<void>
  /** Shows contributors without edit controls. */
  readOnly?: boolean
}

/**
 * Draft problem shown next to the contributor rows.
 */
export type ContributorDraftSubmitError = {
  /** Why the draft cannot be saved. */
  error: ContributorDraftError
  /** Row that caused the problem, when one row is at fault. */
  rowKey?: string
}

/**
 * Shows the contributors who share a Work Item and edits them as one replacement list.
 *
 * The accountable owner is edited elsewhere; this editor only manages contributors,
 * so adding contributors never changes who is accountable. Inside a Work Item editor
 * the draft is saved together with the form's other changes, so saving contributors
 * never discards unsaved edits elsewhere in the form.
 *
 * @param props - Stored contributors, selectable members and job roles, and the save callback.
 * @returns The contributor section.
 */
export function WorkItemContributorsEditor({
  assignments,
  formId,
  jobRoles,
  locale,
  memberOptions,
  onSave,
  ownerUserId,
  readOnly = false,
  submitError,
}: WorkItemContributorsEditorProps) {
  const t = createTranslator(locale)
  const headingId = useId()
  const [rows, setRows] = useState<ContributorDraftRow[] | undefined>()
  const [draftError, setDraftError] = useState<{ error: ContributorDraftError | 'save'; rowKey?: string }>()
  const [isSaving, setIsSaving] = useState(false)
  const [nextRowNumber, setNextRowNumber] = useState(1)
  const totalMinutes = sumContributorPlannedEffort(assignments)
  const canEdit = !readOnly && (formId !== undefined || onSave !== undefined)
  const visibleError = draftError ?? (rows ? submitError : undefined)
  /**
   * Resolves the display label of a contributor.
   *
   * @param memberUserId - Workspace member ID of the contributor.
   * @returns The member's name or email, or the raw ID when the member is unknown.
   */
  const memberName = (memberUserId: string) => {
    const member = memberOptions.find((candidate) => candidate.id === memberUserId)
    return member?.name ?? member?.email ?? memberUserId
  }
  /**
   * Resolves the display label of a job role.
   *
   * @param jobRoleId - Configured job role ID.
   * @returns The role's name, or a localized "unknown role" label when it is no longer configured.
   */
  const jobRoleName = (jobRoleId: string) =>
    jobRoles.find((jobRole) => jobRole.id === jobRoleId)?.name ?? t('workItems.contributors.jobRoleUnknown')

  /** Starts editing from the stored list. */
  const startEditing = () => {
    setRows(toContributorDraftRows(assignments))
    setDraftError(undefined)
  }

  /**
   * Replaces one field of one draft row.
   *
   * @param key - Row being edited.
   * @param patch - Fields to replace.
   */
  const updateRow = (key: string, patch: Partial<ContributorDraftRow>) => {
    setRows((current) => current?.map((row) => row.key === key ? { ...row, ...patch } : row))
  }

  /** Validates the draft and saves it as the new contributor list. */
  const save = async () => {
    if (!rows || !onSave) return
    const parsed = parseContributorDraftRows(rows)
    if ('error' in parsed) {
      setDraftError(parsed)
      return
    }
    setDraftError(undefined)
    setIsSaving(true)
    try {
      await onSave(parsed.assignments)
      setRows(undefined)
    } catch {
      setDraftError({ error: 'save' })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="workbench-panel-muted grid min-w-0 gap-3 p-3"
      data-testid="work-item-contributors"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]" id={headingId}>
          {t('workItems.contributors.title')}
        </h3>
        {totalMinutes > 0 ? (
          <span className="text-xs text-[var(--workbench-muted)]">
            {t('workItems.contributors.effortSummary').replace('{hours}', formatPlannedEffortHours(totalMinutes))}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-[var(--workbench-muted)]">{t('workItems.contributors.help')}</p>

      {rows === undefined ? (
        <>
          {(assignments ?? []).length === 0 ? (
            <p className="text-sm text-[var(--workbench-muted)]">{t('workItems.contributors.empty')}</p>
          ) : (
            <ul className="grid gap-1.5" data-testid="work-item-contributor-list">
              {(assignments ?? []).map((assignment) => (
                <li
                  className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--workbench-text)]"
                  key={assignment.assignmentId}
                >
                  <span className="min-w-0 truncate font-semibold">
                    {assignment.memberUserId
                      ? memberName(assignment.memberUserId)
                      : t('workItems.contributors.memberUndecided')}
                  </span>
                  {assignment.memberUserId === ownerUserId ? (
                    <span className="rounded-full border border-[var(--workbench-border)] px-2 text-xs text-[var(--workbench-muted)]">
                      {t('workItems.contributors.isOwner')}
                    </span>
                  ) : null}
                  {assignment.jobRoleId ? (
                    <span className="text-[var(--workbench-muted)]">{jobRoleName(assignment.jobRoleId)}</span>
                  ) : null}
                  {assignment.plannedEffortMinutes === undefined ? null : (
                    <span className="text-[var(--workbench-muted)]">
                      {formatPlannedEffortHours(assignment.plannedEffortMinutes)}h
                    </span>
                  )}
                  <span className="rounded-full bg-[var(--workbench-surface)] px-2 text-xs text-[var(--workbench-muted)]">
                    {t(`workItems.contributors.status.${assignment.status}`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canEdit ? (
            <button className="workbench-button-secondary h-8 justify-self-start px-3 text-sm" onClick={startEditing} type="button">
              {t('workItems.contributors.edit')}
            </button>
          ) : null}
        </>
      ) : (
        <div className="grid gap-3">
          {rows.map((row, index) => {
            const rowLabel = `${t('workItems.contributors.title')} ${index + 1}`
            const storedJobRoleId = (assignments ?? []).find((assignment) =>
              assignment.assignmentId === row.assignmentId)?.jobRoleId
            const hasRowError = visibleError?.rowKey === row.key
            return (
              <fieldset
                aria-invalid={hasRowError || undefined}
                className={`grid min-w-0 gap-2 rounded-md border p-2 sm:grid-cols-2 ${
                  hasRowError ? 'border-[var(--workbench-danger)]' : 'border-[var(--workbench-border)]'
                }`}
                data-testid="work-item-contributor-row"
                key={row.key}
              >
                <legend className="sr-only">{rowLabel}</legend>
                <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-text)]">
                  {t('workItems.contributors.member')}
                  <select
                    className="workbench-input h-9 w-full min-w-0 px-2"
                    onChange={(event) => updateRow(row.key, { memberUserId: event.target.value })}
                    value={row.memberUserId}
                  >
                    <option value="">{t('workItems.contributors.memberUndecided')}</option>
                    {row.memberUserId && !memberOptions.some((member) => member.id === row.memberUserId) ? (
                      <option value={row.memberUserId}>{row.memberUserId}</option>
                    ) : null}
                    {memberOptions.map((member) => (
                      <option key={member.id} value={member.id}>{member.name ?? member.email}</option>
                    ))}
                  </select>
                </label>
                <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-text)]">
                  {t('workItems.contributors.jobRole')}
                  <select
                    className="workbench-input h-9 w-full min-w-0 px-2"
                    onChange={(event) => updateRow(row.key, { jobRoleId: event.target.value })}
                    value={row.jobRoleId}
                  >
                    <option value="">{t('workItems.contributors.jobRoleNone')}</option>
                    {row.jobRoleId && !jobRoles.some((jobRole) => jobRole.id === row.jobRoleId) ? (
                      <option value={row.jobRoleId}>{t('workItems.contributors.jobRoleUnknown')}</option>
                    ) : null}
                    {listSelectableJobRoles(jobRoles, storedJobRoleId).map((jobRole) => (
                      <option key={jobRole.id} value={jobRole.id}>{jobRole.name}</option>
                    ))}
                  </select>
                </label>
                <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-text)]">
                  {t('workItems.contributors.effortHours')}
                  <input
                    className="workbench-input h-9 w-full min-w-0 px-2"
                    inputMode="decimal"
                    onChange={(event) => updateRow(row.key, { plannedEffortHours: event.target.value })}
                    value={row.plannedEffortHours}
                  />
                </label>
                <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-text)]">
                  {t('workItems.contributors.status')}
                  <select
                    className="workbench-input h-9 w-full min-w-0 px-2"
                    onChange={(event) => {
                      const status = contributionStatuses.find((candidate) => candidate === event.target.value)
                      if (status) updateRow(row.key, { status })
                    }}
                    value={row.status}
                  >
                    {contributionStatuses.map((status) => (
                      <option key={status} value={status}>{t(`workItems.contributors.status.${status}`)}</option>
                    ))}
                  </select>
                </label>
                <button
                  aria-label={`${t('workItems.contributors.remove')}: ${rowLabel}`}
                  className="workbench-button-secondary h-8 justify-self-start px-3 text-sm sm:col-span-2"
                  onClick={() => setRows((current) => current?.filter((candidate) => candidate.key !== row.key))}
                  type="button"
                >
                  {t('workItems.contributors.remove')}
                </button>
              </fieldset>
            )
          })}
          {formId ? (
            <input
              form={formId}
              name={CONTRIBUTOR_DRAFT_FORM_FIELD}
              type="hidden"
              value={serializeContributorDraftRows(rows)}
            />
          ) : null}
          {visibleError ? (
            <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
              {t(`workItems.contributors.error.${visibleError.error}`)}
            </p>
          ) : formId ? (
            <p className="text-xs text-[var(--workbench-muted)]">{t('workItems.contributors.pendingSave')}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              className="workbench-button-secondary h-8 px-3 text-sm"
              onClick={() => {
                setRows((current) => [...(current ?? []), createEmptyContributorDraftRow(`new-${nextRowNumber}`)])
                setNextRowNumber((current) => current + 1)
              }}
              type="button"
            >
              {t('workItems.contributors.add')}
            </button>
            {onSave && !formId ? (
              <button
                className="workbench-button-primary h-8 px-3 text-sm"
                disabled={isSaving}
                onClick={() => void save()}
                type="button"
              >
                {isSaving ? t('workItems.contributors.saving') : t('workItems.contributors.save')}
              </button>
            ) : null}
            <button
              className="workbench-button-secondary h-8 px-3 text-sm"
              disabled={isSaving}
              onClick={() => {
                setRows(undefined)
                setDraftError(undefined)
              }}
              type="button"
            >
              {t('workItems.contributors.cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
