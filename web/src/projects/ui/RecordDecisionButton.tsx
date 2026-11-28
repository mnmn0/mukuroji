import type { ProjectDecisionOrigin } from '@mukuroji/contracts'
import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { ProjectDecisionFormPrefill } from '../model/projectDecisionForm'
import type { ProjectDecisionReferenceOption } from './ProjectDecisionForm'
import { RecordDecisionDialog, type RecordDecisionProjectOption } from './RecordDecisionDialog'

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
  t,
}: RecordDecisionButtonProps) {
  const [prefill, setPrefill] = useState<ProjectDecisionFormPrefill>()
  const [recordedProjectName, setRecordedProjectName] = useState<string>()
  return (
    <>
      <button
        className={className}
        data-testid="record-decision-open"
        disabled={disabled || projects.length === 0}
        type="button"
        onClick={() => {
          setRecordedProjectName(undefined)
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
          {...(defaultProject ? { defaultProject } : {})}
          lockProject={lockProject}
          origin={origin}
          prefill={prefill}
          projects={projects}
          t={t}
          {...(workItemOptions ? { workItemOptions } : {})}
          onClose={() => setPrefill(undefined)}
          onRecorded={(project) => {
            setPrefill(undefined)
            setRecordedProjectName(project.name)
          }}
        />
      ) : null}
    </>
  )
}
