import type { ProjectDecisionOrigin } from '@mukuroji/contracts'
import { useId, useMemo, useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import { useModalFocus } from '../../shared/ui/useModalFocus'
import {
  toProjectDecisionEntryInput,
  toProjectDecisionFormValues,
  type ProjectDecisionFormPrefill,
  type ProjectDecisionFormValues,
} from '../model/projectDecisionForm'
import { describeProjectDecisionSaveError } from '../model/projectDecisionMessages'
import type { useSaveProjectDecision } from '../mutations/useSaveProjectDecision'
import { isActiveProjectAssignmentCandidate } from '../api/members'
import { useProjectMembers } from '../queries/useProjectMembers'
import { ProjectDecisionForm, type ProjectDecisionReferenceOption } from './ProjectDecisionForm'

/** One Project a decision may be recorded in. */
export type RecordDecisionProjectOption = {
  /** Team that owns the Project. */
  teamId: string
  /** Project ID. */
  id: string
  /** Text shown for the Project. */
  name: string
}

/**
 * Builds the select value of a Project, unique even when two Teams use the same Project ID.
 *
 * @param project - Team and Project.
 * @returns The value.
 */
function projectKey(project: Pick<RecordDecisionProjectOption, 'teamId' | 'id'>) {
  return JSON.stringify([project.teamId, project.id])
}

/** Form of a save that failed, kept so reopening the dialog retries exactly the same request. */
export type RecordDecisionUnsentDraft = {
  /** Select value of the chosen Project. */
  projectKey: string
  /** Form values sent with the failed save. */
  values: ProjectDecisionFormValues
}

/** Props of the dialog that records a decision from a Work Item or Document screen. */
export type RecordDecisionDialogProps = {
  /** Cognito access token. */
  accessToken?: string
  /** Saves the decision; owned by the opener so a retry keeps its Idempotency-Key. */
  save: ReturnType<typeof useSaveProjectDecision>
  /** Projects the decision may belong to. */
  projects: readonly RecordDecisionProjectOption[]
  /** Project chosen first, such as the Work Item's Project. */
  defaultProject?: Pick<RecordDecisionProjectOption, 'teamId' | 'id'>
  /** Whether the Project cannot be changed, such as for a Work Item of one Project. */
  lockProject?: boolean
  /** Values the screen suggests. */
  prefill: ProjectDecisionFormPrefill
  /** Form of an earlier failed save; when present it replaces the prefill. */
  unsentDraft?: RecordDecisionUnsentDraft
  /**
   * Receives the form of a save that failed, so the opener can offer it again.
   *
   * @param draft - Project and values sent with the failed save.
   */
  onUnsent?: (draft: RecordDecisionUnsentDraft) => void
  /** Labels of the Work Items the prefill names. */
  workItemOptions?: readonly ProjectDecisionReferenceOption[]
  /** Screen the decision is recorded from. */
  origin: ProjectDecisionOrigin
  /** Translator. */
  t: (key: MessageKey) => string
  /** Closes the dialog. */
  onClose: () => void
  /**
   * Receives the Project of the recorded decision, so the screen can say where it went.
   *
   * @param project - Project the decision was recorded in.
   */
  onRecorded: (project: RecordDecisionProjectOption) => void
}

/**
 * Records one decision in a Project's decision log from another screen (ADR 0114).
 *
 * @param props - Session, Projects, prefill, and handlers.
 * @returns The modal dialog.
 */
export function RecordDecisionDialog({
  accessToken,
  save,
  projects,
  defaultProject,
  lockProject = false,
  prefill,
  unsentDraft,
  onUnsent,
  workItemOptions,
  origin,
  t,
  onClose,
  onRecorded,
}: RecordDecisionDialogProps) {
  const titleId = useId()
  const [isSaving, setIsSaving] = useState(false)
  // A save in flight keeps the dialog open, so its result is shown where it was started.
  const closeUnlessSaving = () => {
    if (!isSaving) onClose()
  }
  const dialogRef = useModalFocus<HTMLElement>(closeUnlessSaving)
  const [selectedKey, setSelectedKey] = useState(() => {
    if (unsentDraft) return unsentDraft.projectKey
    const initial = defaultProject ?? (projects.length === 1 ? projects[0] : undefined)
    return initial ? projectKey(initial) : ''
  })
  const selected = projects.find((project) => projectKey(project) === selectedKey)
  const projectId = selected?.id ?? ''
  const [values, setValues] = useState(() => unsentDraft?.values ?? toProjectDecisionFormValues(undefined, prefill))
  const [saveError, setSaveError] = useState<string>()
  // A Team-qualified lookup resolves a Project ID that several Teams share.
  const members = useProjectMembers(accessToken, projectId || undefined, Boolean(projectId), selected?.teamId)
  const memberOptions = useMemo(
    () => (members.data ?? [])
      .filter(isActiveProjectAssignmentCandidate)
      .map((member) => ({ id: member.id, label: member.name || member.email })),
    [members.data],
  )

  /** Records the decision in the chosen Project. */
  async function handleSubmit() {
    if (!selected) {
      setSaveError(t('projects.decisionLog.record.noProject'))
      return
    }
    if (!accessToken) {
      setSaveError(t('projects.decisionLog.record.noSession'))
      return
    }
    setIsSaving(true)
    setSaveError(undefined)
    try {
      const stored = await save(selected.teamId, selected.id, undefined, toProjectDecisionEntryInput(values, origin))
      if (stored) onRecorded(selected)
      else setSaveError(t('projects.decisionLog.record.noSession'))
    } catch (error) {
      // The outcome may be unknown, so the same form is kept and a retry sends the same request.
      onUnsent?.({ projectKey: selectedKey, values })
      setSaveError(describeProjectDecisionSaveError(error, t))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm" onMouseDown={closeUnlessSaving}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="workbench-panel flex max-h-[calc(100svh-3rem)] w-full max-w-[760px] flex-col overflow-hidden shadow-[0_24px_72px_rgba(23,32,29,0.28)]"
        data-testid="record-decision-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
          <h2 className="mr-auto text-lg font-semibold text-[var(--workbench-text)]" id={titleId}>
            {t('projects.decisionLog.record.title')}
          </h2>
        </div>
        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto p-5">
          <p className="text-sm text-[var(--workbench-muted)]">{t('projects.decisionLog.record.description')}</p>
          <label className="grid gap-1.5 text-sm font-semibold text-fg-505967">
            {t('projects.decisionLog.record.project')}
            <select
              className="h-10 rounded-md border border-tone-d3d8df bg-surface px-3 text-sm font-medium text-fg-1c1d1f disabled:bg-[var(--workbench-surface-muted)]"
              data-testid="record-decision-project"
              disabled={lockProject || isSaving}
              value={selectedKey}
              onChange={(event) => {
                setSelectedKey(event.target.value)
                // Deciders and Work Items belong to one Project, so a new Project starts without them.
                setValues((current) => ({ ...current, deciderMemberIds: [], relatedWorkItemIds: [] }))
              }}
            >
              <option value="">{t('projects.decisionLog.record.projectPlaceholder')}</option>
              {projects.map((project) => (
                <option key={projectKey(project)} value={projectKey(project)}>{project.name}</option>
              ))}
            </select>
          </label>
          {members.error ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('projects.decisionLog.record.membersError')}</p>
              <button className="workbench-button-secondary min-h-9 px-3" type="button" onClick={() => void members.mutate()}>
                {t('projects.decisionLog.reload')}
              </button>
            </div>
          ) : null}
          <ProjectDecisionForm
            isSaving={isSaving}
            memberOptions={memberOptions}
            replacementOptions={[]}
            saveError={saveError}
            t={t}
            testId="record-decision-form"
            values={values}
            {...(workItemOptions ? { workItemOptions } : {})}
            onCancel={closeUnlessSaving}
            onChange={setValues}
            onSubmit={() => void handleSubmit()}
          />
        </div>
      </section>
    </div>
  )
}
