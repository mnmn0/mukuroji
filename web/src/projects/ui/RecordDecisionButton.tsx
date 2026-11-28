import type { ProjectDecisionOrigin } from '@mukuroji/contracts'
import { useRef, useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { ProjectDecisionFormPrefill } from '../model/projectDecisionForm'
import { useSaveProjectDecision } from '../mutations/useSaveProjectDecision'
import type { ProjectDecisionReferenceOption } from './ProjectDecisionForm'
import { RecordDecisionDialog, type RecordDecisionProjectOption, type RecordDecisionUnsentDraft } from './RecordDecisionDialog'
import {
  currentUnsentDecisionDraftGeneration,
  dropUnsentDecisionDraft,
  keepUnsentDecisionDraft,
  readUnsentDecisionDraft,
  unsentDecisionDraftKey,
} from './unsentDecisionDrafts'

/** Props of the button that records a decision from another screen. */
export type RecordDecisionButtonProps = {
  /** Cognito access token. */
  accessToken?: string
  /** Projects the decision may belong to. */
  projects: readonly RecordDecisionProjectOption[]
  /** Project chosen first. */
  defaultProject?: Pick<RecordDecisionProjectOption, 'teamId' | 'id'>
  /** Whether the Project cannot be changed. */
  lockProject?: boolean
  /** Builds the values the screen suggests when the dialog opens. */
  createPrefill: () => ProjectDecisionFormPrefill
  /** Labels of the Work Items the prefill names. */
  workItemOptions?: readonly ProjectDecisionReferenceOption[]
  /** Screen the decision is recorded from. */
  origin: ProjectDecisionOrigin
  /** Class names of the button, so it matches the screen's other actions. */
  className?: string
  /** Disables the button, such as while another operation runs. */
  disabled?: boolean
  /**
   * Names what the decision is recorded from, such as one Work Item, so a failed save's form
   * comes back to the same account when the same item is shown again after another one was
   * selected.
   */
  draftKey?: string
  /** Translator. */
  t: (key: MessageKey) => string
}

/**
 * Renders a "Record as decision" button that opens the record dialog and confirms the save.
 *
 * @param props - Session, Projects, and prefill.
 * @returns The button, its confirmation, and the dialog while open.
 */
export function RecordDecisionButton({
  accessToken,
  projects,
  defaultProject,
  lockProject,
  createPrefill,
  workItemOptions,
  origin,
  className = 'workbench-button-secondary h-8 px-3 text-xs',
  disabled = false,
  draftKey,
  t,
}: RecordDecisionButtonProps) {
  const [prefill, setPrefill] = useState<ProjectDecisionFormPrefill>()
  const [recordedProjectName, setRecordedProjectName] = useState<string>()
  // The save hook lives here rather than in the dialog, so a retry after reopening the dialog
  // reuses the Idempotency-Key of the attempt that may already have been stored.
  const save = useSaveProjectDecision({ accessToken })
  // Each opening gets its own number, so only the dialog that saved can close itself.
  const openCount = useRef(0)
  const [openedAs, setOpenedAs] = useState(0)
  // A failed save's form is reopened as it was, so its retry reuses the same Idempotency-Key.
  const storeKey = unsentDecisionDraftKey(accessToken, draftKey)
  // Sign-outs counted when the open dialog was opened. Each dialog's callbacks keep the value of
  // the render that made them, so a save that fails after a sign-out cannot keep its form, even
  // when another dialog was opened since.
  const [openedGeneration, setOpenedGeneration] = useState(currentUnsentDecisionDraftGeneration)
  const [unsentDraft, setUnsentDraftState] = useState<RecordDecisionUnsentDraft | undefined>(
    () => (storeKey === undefined ? undefined : readUnsentDecisionDraft(storeKey)),
  )
  /**
   * Keeps the failed form of a dialog, also for a later mount with the same draft key.
   *
   * @param draft - Form of the failed save.
   * @param generation - Sign-outs counted when that dialog was opened.
   */
  const keepUnsentDraft = (draft: RecordDecisionUnsentDraft, generation: number) => {
    if (generation !== currentUnsentDecisionDraftGeneration()) return
    setUnsentDraftState(draft)
    if (storeKey !== undefined) keepUnsentDecisionDraft(storeKey, draft, generation)
  }
  /** Drops the failed form once it was saved or discarded. */
  const clearUnsentDraft = () => {
    setUnsentDraftState(undefined)
    if (storeKey !== undefined) dropUnsentDecisionDraft(storeKey)
  }
  /** Opens a new dialog with a fresh prefill, replacing any dialog that is open. */
  const openDialog = () => {
    setOpenedGeneration(currentUnsentDecisionDraftGeneration())
    openCount.current += 1
    setOpenedAs(openCount.current)
    setPrefill(createPrefill())
  }
  return (
    <>
      <button
        className={className}
        data-testid="record-decision-open"
        disabled={disabled || projects.length === 0}
        type="button"
        onClick={() => {
          setRecordedProjectName(undefined)
          openDialog()
        }}
      >
        {t('projects.decisionLog.record.button')}
      </button>
      {recordedProjectName !== undefined ? (
        <span className="text-xs font-semibold text-fg-505967" role="status">
          {t('projects.decisionLog.record.saved').replace('{project}', recordedProjectName)}
        </span>
      ) : null}
      {prefill ? (
        <RecordDecisionDialog
          accessToken={accessToken}
          key={openedAs}
          save={save}
          {...(unsentDraft ? { unsentDraft } : {})}
          onUnsent={(draft) => keepUnsentDraft(draft, openedGeneration)}
          onDiscardUnsent={() => {
            clearUnsentDraft()
            openDialog()
          }}
          {...(defaultProject ? { defaultProject } : {})}
          lockProject={lockProject}
          origin={origin}
          prefill={prefill}
          projects={projects}
          t={t}
          {...(workItemOptions ? { workItemOptions } : {})}
          onClose={() => setPrefill(undefined)}
          onRecorded={(project) => {
            if (openCount.current !== openedAs) return
            clearUnsentDraft()
            setPrefill(undefined)
            setRecordedProjectName(project.name)
          }}
        />
      ) : null}
    </>
  )
}
