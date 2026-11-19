import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { ProjectDirectoryTeam } from '../../projects/api'
import { useActiveProjectMembers } from '../../projects/queries/useProjectMembers'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { ChecklistWorkItemInput } from '../model/checklistWorkItems'
import { focusFirstModalElement, trapModalFocus } from './modalFocus'

/**
 * Props of the dialog that turns a checklist item into a Work Item.
 */
export type ChecklistWorkItemDialogProps = {
  /** Workspace API token used to read Project members. */
  accessToken?: string
  /** Text of the checklist item, used as the initial title. */
  itemText: string
  /** Teams and Projects the Work Item can belong to. */
  teams: ProjectDirectoryTeam[]
  /** Project selected first, such as the Project that owns the Document. */
  defaultProjectId?: string
  /** Normalized member key of the current user, selected first as owner. */
  currentUserKey?: string
  /** Resolves display text. */
  t: (key: MessageKey) => string
  /** Creates the Work Item and links it to the checklist item. */
  onSubmit: (input: ChecklistWorkItemInput) => Promise<void>
  /** Closes the dialog without creating anything. */
  onClose: () => void
}

/**
 * One Team-qualified Project the Work Item can be assigned to.
 */
type ProjectOption = {
  /** Team that owns the Project entry. */
  teamId: string
  /** Project ID. */
  projectId: string
  /** Label combining Team and Project names. */
  label: string
}

/**
 * Dialog that creates a Work Item from a Document checklist item.
 *
 * @param props - Item text, Projects, defaults, and callbacks.
 * @returns The modal dialog.
 */
export function ChecklistWorkItemDialog({
  accessToken,
  currentUserKey,
  defaultProjectId,
  itemText,
  onClose,
  onSubmit,
  t,
  teams,
}: ChecklistWorkItemDialogProps) {
  const projectOptions: ProjectOption[] = teams.flatMap((team) =>
    team.projects.map((project) => ({
      label: `${team.name} / ${project.name}`,
      projectId: project.id,
      teamId: team.id,
    })),
  )
  const defaultOptionIndex = Math.max(
    0,
    projectOptions.findIndex((option) => option.projectId === defaultProjectId),
  )
  const [optionIndex, setOptionIndex] = useState(defaultOptionIndex)
  const [title, setTitle] = useState(itemText.trim())
  const [dueDate, setDueDate] = useState('')
  const [selectedAssignee, setSelectedAssignee] = useState<string>()
  const [errorMessage, setErrorMessage] = useState<string>()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const fieldId = useId()
  const selectedOption = projectOptions[optionIndex]
  const {
    data: memberResult,
    error: memberError,
    isLoading: isMembersLoading,
    mutate: reloadMembers,
  } = useActiveProjectMembers(
    accessToken,
    selectedOption ? [selectedOption.projectId] : [],
  )
  const members = memberResult?.members ?? []
  // The aggregate query resolves with per-Project errors instead of
  // rejecting, so both shapes mean the assignee list could not be read.
  const hasMemberLoadError =
    memberError !== undefined || (memberResult?.errors.length ?? 0) > 0
  const assigneeUserId =
    selectedAssignee !== undefined &&
    members.some((member) => member.id === selectedAssignee)
      ? selectedAssignee
      : members.find((member) => member.id === currentUserKey)?.id ?? ''

  useEffect(() => {
    const previousFocus = globalThis.document.activeElement
    focusFirstModalElement(dialogRef.current)
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus()
      }
    }
  }, [])

  /**
   * Validates the form and creates the Work Item.
   *
   * @param event - Form submit event.
   */
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSubmitting) return
    const trimmedTitle = title.trim()
    if (!selectedOption || !trimmedTitle || !assigneeUserId) {
      setErrorMessage(t('documents.checklistWorkItem.required'))
      return
    }
    setErrorMessage(undefined)
    setIsSubmitting(true)
    try {
      await onSubmit({
        assigneeUserId,
        projectId: selectedOption.projectId,
        teamId: selectedOption.teamId,
        title: trimmedTitle,
        ...(dueDate ? { dueDate } : {}),
      })
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof Error && error.message
          ? error.message
          : t('documents.checklistWorkItem.error'),
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm"
      onMouseDown={isSubmitting ? undefined : onClose}
    >
      <section
        aria-labelledby={`${fieldId}-title`}
        aria-modal="true"
        className="w-full max-w-[520px] rounded-xl border border-[var(--workbench-border)] bg-surface p-6 shadow-[0_28px_90px_rgba(23,32,29,0.3)]"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !isSubmitting) onClose()
          trapModalFocus(event, dialogRef.current)
        }}
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2
          className="m-0 text-lg font-semibold text-[var(--workbench-text)]"
          id={`${fieldId}-title`}
        >
          {t('documents.checklistWorkItem.title')}
        </h2>
        <p className="m-0 mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('documents.checklistWorkItem.description')}
        </p>
        <form className="mt-5 grid gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <fieldset className="contents" disabled={isSubmitting}>
            <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('documents.checklistWorkItem.workItemTitle')}
              <input
                className="workbench-input min-h-10 px-3"
                onChange={(event) => setTitle(event.target.value)}
                required
                value={title}
              />
            </label>
            <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('documents.checklistWorkItem.project')}
              <select
                className="workbench-input min-h-10 px-3"
                onChange={(event) => {
                  setOptionIndex(Number(event.target.value))
                  setSelectedAssignee(undefined)
                }}
                required
                value={selectedOption ? String(optionIndex) : ''}
              >
                {projectOptions.length === 0 ? (
                  <option value="">{t('documents.checklistWorkItem.noProject')}</option>
                ) : null}
                {projectOptions.map((option, index) => (
                  <option key={`${option.teamId}/${option.projectId}`} value={String(index)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('documents.checklistWorkItem.assignee')}
              <select
                className="workbench-input min-h-10 px-3"
                onChange={(event) => setSelectedAssignee(event.target.value)}
                required
                value={assigneeUserId}
              >
                <option value="">
                  {isMembersLoading
                    ? t('documents.checklistWorkItem.loadingAssignees')
                    : t('documents.checklistWorkItem.chooseAssignee')}
                </option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name ?? member.email}
                  </option>
                ))}
              </select>
            </label>
            {hasMemberLoadError ? (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-fg-red-800"
                role="alert"
              >
                <span>{t('documents.checklistWorkItem.assigneesError')}</span>
                <button
                  className="workbench-button-secondary min-h-9 px-3 text-xs"
                  onClick={() => void reloadMembers()}
                  type="button"
                >
                  {t('documents.checklistWorkItem.retryAssignees')}
                </button>
              </div>
            ) : null}
            <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('documents.checklistWorkItem.dueDate')}
              <input
                className="workbench-input min-h-10 px-3"
                onChange={(event) => setDueDate(event.target.value)}
                type="date"
                value={dueDate}
              />
            </label>
            {errorMessage ? (
              <p
                className="m-0 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-fg-red-800"
                role="alert"
              >
                {errorMessage}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                className="workbench-button-secondary min-h-10 px-4"
                onClick={onClose}
                type="button"
              >
                {t('documents.checklistWorkItem.cancel')}
              </button>
              <button className="workbench-button-primary min-h-10 px-4" type="submit">
                {isSubmitting
                  ? t('documents.checklistWorkItem.submitting')
                  : t('documents.checklistWorkItem.submit')}
              </button>
            </div>
          </fieldset>
        </form>
      </section>
    </div>
  )
}
