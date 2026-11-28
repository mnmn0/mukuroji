import type { ProjectDecisionOrigin } from '@mukuroji/contracts'
import { useRef, useState } from 'react'
import { readAccessTokenSubject } from '../../auth/session'
import { onSessionDraftsDiscarded } from '../../auth/sessionDrafts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { ProjectDecisionFormPrefill } from '../model/projectDecisionForm'
import { useSaveProjectDecision } from '../mutations/useSaveProjectDecision'
import type { ProjectDecisionReferenceOption } from './ProjectDecisionForm'
import { RecordDecisionDialog, type RecordDecisionProjectOption, type RecordDecisionUnsentDraft } from './RecordDecisionDialog'

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
 * Forms whose save failed, by signed-in account and draft key, kept while another item is shown.
 * Another account never sees them, and signing out drops them.
 */
const unsentDrafts = new Map<string, RecordDecisionUnsentDraft>()
onSessionDraftsDiscarded(() => unsentDrafts.clear())

/**
 * Builds the key a failed form is kept under.
 *
 * @param accessToken - Token of the signed-in account.
 * @param draftKey - Item the decision is recorded from.
 * @returns The key, or `undefined` when the account or the item is unknown and nothing is kept.
 */
function unsentDraftStoreKey(accessToken: string | undefined, draftKey: string | undefined): string | undefined {
  const owner = accessToken ? readAccessTokenSubject(accessToken) : undefined
  return owner && draftKey !== undefined ? JSON.stringify([owner, draftKey]) : undefined
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
  const storeKey = unsentDraftStoreKey(accessToken, draftKey)
  const [unsentDraft, setUnsentDraftState] = useState<RecordDecisionUnsentDraft | undefined>(
    () => (storeKey === undefined ? undefined : unsentDrafts.get(storeKey)),
  )
  /**
   * Keeps or drops the failed form, also for a later mount with the same draft key.
   *
   * @param draft - Form to keep, or `undefined` once it was saved.
   */
  const setUnsentDraft = (draft: RecordDecisionUnsentDraft | undefined) => {
    setUnsentDraftState(draft)
    if (storeKey === undefined) return
    if (draft) unsentDrafts.set(storeKey, draft)
    else unsentDrafts.delete(storeKey)
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
          openCount.current += 1
          setOpenedAs(openCount.current)
          setPrefill(createPrefill())
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
          onUnsent={setUnsentDraft}
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
            setUnsentDraft(undefined)
            setPrefill(undefined)
            setRecordedProjectName(project.name)
          }}
        />
      ) : null}
    </>
  )
}
