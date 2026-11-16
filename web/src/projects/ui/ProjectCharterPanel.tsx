import { useState, type FormEvent } from 'react'
import {
  PROJECT_LIFECYCLE_TRANSITIONS,
  type ProjectCharter,
  type ProjectCharterState,
  type ProjectLifecycleState,
  type UpdateProjectCharterInput,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { ProjectMember } from '../api'
import {
  createProjectCharterFormValues,
  createProjectCharterUpdateInput,
  projectLifecycleClassNames,
  projectLifecycleMessageKey,
  type ProjectCharterFormValues,
} from '../model/projectCharterView'

/** Props for the Project charter and lifecycle panel. */
export type ProjectCharterPanelProps = {
  /** Current charter state, or undefined while loading or after a failure. */
  state?: ProjectCharterState
  /** Whether the charter is loading for the first time. */
  isLoading?: boolean
  /** Whether loading the charter failed. */
  hasLoadError?: boolean
  /** Project members offered as owner and sponsor. */
  members: readonly ProjectMember[]
  /** Whether the viewer may edit the charter and move the lifecycle. */
  canEdit: boolean
  /** Whether the viewer may approve or reject a proposed Project. */
  canDecideProposal: boolean
  /** Translator for every label. */
  t: (key: MessageKey) => string
  /** Saves a complete charter replacement. Rejects with an error carrying an optional `code`. */
  onSave: (input: UpdateProjectCharterInput) => Promise<void>
  /** Moves the Project to another lifecycle state. */
  onTransition: (expectedRevision: number, state: ProjectLifecycleState) => Promise<void>
  /** Reloads the charter after a failure or conflict. */
  onReload: () => void
}

const inputClassName =
  'h-10 rounded-md border border-tone-d3d8df bg-surface px-3 text-sm font-medium text-fg-1c1d1f outline-none transition focus:border-tone-2563eb focus:ring-4 focus:ring-tone-2563eb/10 disabled:bg-[var(--workbench-surface-muted)]'
const textAreaClassName =
  'min-h-20 rounded-md border border-tone-d3d8df bg-surface px-3 py-2 text-sm font-medium text-fg-1c1d1f outline-none transition focus:border-tone-2563eb focus:ring-4 focus:ring-tone-2563eb/10 disabled:bg-[var(--workbench-surface-muted)]'
const labelClassName = 'grid gap-1.5 text-sm font-semibold text-fg-505967'

/**
 * Maps a failed charter request to a user-facing message.
 *
 * @param error - Rejected request error.
 * @param t - Translator.
 * @param fallback - Message key used for unknown failures.
 * @returns The message to display.
 */
function describeCharterError(error: unknown, t: (key: MessageKey) => string, fallback: MessageKey) {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  if (code === 'ProjectCharterRevisionConflict') return t('projects.charter.error.conflict')
  if (code === 'ProjectCodeAlreadyUsed') return t('projects.charter.error.codeUsed')
  if (code === 'ProjectCharterPersonInactive') return t('projects.charter.error.person')
  if (code === 'InvalidProjectCharter' && error instanceof Error) {
    return t('projects.charter.error.invalid').replace('{reason}', error.message)
  }
  return t(fallback)
}

/**
 * Renders the Project charter form and lifecycle actions on the Project settings tab.
 *
 * @param props - Charter state, permissions, and actions.
 * @returns The charter section.
 */
export function ProjectCharterPanel({
  state,
  isLoading = false,
  hasLoadError = false,
  members,
  canEdit,
  canDecideProposal,
  t,
  onSave,
  onTransition,
  onReload,
}: ProjectCharterPanelProps) {
  const [draft, setDraft] = useState<{ revision: number; values: ProjectCharterFormValues }>()
  const [isSaving, setIsSaving] = useState(false)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string }>()
  const [isConfirmingClose, setIsConfirmingClose] = useState(false)

  if (!state) {
    return (
      <section
        className="rounded-md border border-tone-d3d8df bg-surface p-4"
        data-testid="project-charter-panel"
      >
        <h2 className="text-base font-semibold text-fg-1c1d1f">{t('projects.charter.title')}</h2>
        {hasLoadError ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <p className="text-sm font-semibold text-fg-red-700" role="alert">
              {t('projects.charter.error.loading')}
            </p>
            <button className="workbench-button-secondary min-h-10 px-4" type="button" onClick={onReload}>
              {t('projects.charter.reload')}
            </button>
          </div>
        ) : (
          <p className="mt-3 text-sm font-medium text-fg-505967" role="status">
            {isLoading ? t('projects.charter.loading') : t('projects.charter.error.loading')}
          </p>
        )}
      </section>
    )
  }

  const values = draft && draft.revision === state.revision ? draft.values : createProjectCharterFormValues(state.charter)
  const isEditable = canEdit && state.lifecycleState !== 'archived'
  const transitions = PROJECT_LIFECYCLE_TRANSITIONS[state.lifecycleState]
  const canTransition = isEditable && (state.lifecycleState !== 'proposed' || canDecideProposal)
  const memberOptions = members.map((member) => ({
    id: member.id,
    label: member.name ? `${member.name} (${member.email})` : member.email,
  }))
  const withCurrentPerson = (person: ProjectCharter['owner']) =>
    person && !memberOptions.some((option) => option.id === person.userId)
      ? [...memberOptions, { id: person.userId, label: person.displayName }]
      : memberOptions

  /** Updates one form field while keeping the draft bound to the current revision. */
  const updateValue = (key: keyof ProjectCharterFormValues, value: string) => {
    setMessage(undefined)
    setDraft({ revision: state.revision, values: { ...values, [key]: value } })
  }

  /** Saves the form as a complete charter replacement. */
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isEditable) return
    setIsSaving(true)
    setMessage(undefined)
    try {
      await onSave(createProjectCharterUpdateInput(values, state.revision))
      setDraft(undefined)
      setMessage({ kind: 'success', text: t('projects.charter.saved') })
    } catch (error) {
      setMessage({ kind: 'error', text: describeCharterError(error, t, 'projects.charter.error.save') })
    } finally {
      setIsSaving(false)
    }
  }

  /** Moves the lifecycle, asking for confirmation before closing. */
  const handleTransition = async (target: ProjectLifecycleState) => {
    if (target === 'closed' && !isConfirmingClose) {
      setIsConfirmingClose(true)
      return
    }
    setIsTransitioning(true)
    setMessage(undefined)
    try {
      await onTransition(state.revision, target)
      setIsConfirmingClose(false)
    } catch (error) {
      setMessage({ kind: 'error', text: describeCharterError(error, t, 'projects.charter.error.transition') })
    } finally {
      setIsTransitioning(false)
    }
  }

  return (
    <section
      aria-labelledby="project-charter-title"
      className="grid gap-4 rounded-md border border-tone-d3d8df bg-surface p-4"
      data-testid="project-charter-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg-1c1d1f" id="project-charter-title">
            {t('projects.charter.title')}
          </h2>
          <p className="mt-1 text-sm font-medium text-fg-505967">{t('projects.charter.description')}</p>
        </div>
        <div className="grid justify-items-end gap-2">
          <span className="text-xs font-semibold text-fg-505967">{t('projects.charter.lifecycle')}</span>
          <span
            className={`w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${projectLifecycleClassNames[state.lifecycleState]}`}
            data-testid="project-charter-lifecycle"
          >
            {t(projectLifecycleMessageKey(state.lifecycleState))}
          </span>
        </div>
      </div>

      {state.lifecycleState === 'closed' ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-fg-slate-700">
          {t('projects.charter.lifecycle.closedNotice')}
        </p>
      ) : null}

      {isEditable && transitions.length > 0 ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            {transitions.map((target) => (
              <button
                className={target === 'closed'
                  ? 'min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-fg-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50'
                  : 'workbench-button-secondary min-h-10 px-3 disabled:cursor-not-allowed disabled:opacity-50'}
                data-testid={`project-lifecycle-${target}`}
                disabled={!canTransition || isTransitioning}
                key={target}
                type="button"
                onClick={() => void handleTransition(target)}
              >
                {t('projects.charter.lifecycle.moveTo').replace('{state}', t(projectLifecycleMessageKey(target)))}
              </button>
            ))}
          </div>
          {state.lifecycleState === 'proposed' && !canDecideProposal ? (
            <p className="text-xs font-medium text-fg-505967">{t('projects.charter.lifecycle.proposalHint')}</p>
          ) : null}
          {isConfirmingClose ? (
            <div
              className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3"
              data-testid="project-lifecycle-close-confirmation"
              role="alertdialog"
              aria-labelledby="project-lifecycle-close-title"
            >
              <p className="text-sm font-semibold text-fg-amber-800" id="project-lifecycle-close-title">
                {t('projects.charter.lifecycle.closeTitle')}
              </p>
              <p className="text-sm font-medium text-fg-amber-800">
                {t('projects.charter.lifecycle.closeDescription')}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
                  data-testid="project-lifecycle-close-confirm"
                  disabled={isTransitioning}
                  type="button"
                  onClick={() => void handleTransition('closed')}
                >
                  {t('projects.charter.lifecycle.closeConfirm')}
                </button>
                <button
                  className="workbench-button-secondary min-h-10 px-4"
                  type="button"
                  onClick={() => setIsConfirmingClose(false)}
                >
                  {t('projects.charter.lifecycle.cancel')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {!canEdit ? (
        <p className="text-xs font-medium text-fg-505967">{t('projects.charter.readOnly')}</p>
      ) : null}

      <form className="grid grid-cols-2 gap-3 max-[780px]:grid-cols-1" onSubmit={(event) => void handleSubmit(event)}>
        <label className={labelClassName}>
          {t('projects.charter.field.code')}
          <input
            className={inputClassName}
            data-testid="project-charter-code"
            disabled={!isEditable}
            maxLength={32}
            value={values.code}
            onChange={(event) => updateValue('code', event.target.value)}
          />
          <span className="text-xs font-medium text-fg-505967">{t('projects.charter.field.codeHint')}</span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={labelClassName}>
            {t('projects.charter.field.plannedStartDate')}
            <input
              className={inputClassName}
              data-testid="project-charter-start"
              disabled={!isEditable}
              type="date"
              value={values.plannedStartDate}
              onChange={(event) => updateValue('plannedStartDate', event.target.value)}
            />
          </label>
          <label className={labelClassName}>
            {t('projects.charter.field.plannedEndDate')}
            <input
              className={inputClassName}
              data-testid="project-charter-end"
              disabled={!isEditable}
              min={values.plannedStartDate || undefined}
              type="date"
              value={values.plannedEndDate}
              onChange={(event) => updateValue('plannedEndDate', event.target.value)}
            />
          </label>
        </div>
        <label className={labelClassName}>
          {t('projects.charter.field.owner')}
          <select
            className={inputClassName}
            data-testid="project-charter-owner"
            disabled={!isEditable}
            value={values.ownerUserId}
            onChange={(event) => updateValue('ownerUserId', event.target.value)}
          >
            <option value="">{t('projects.charter.field.none')}</option>
            {withCurrentPerson(state.charter.owner).map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className={labelClassName}>
          {t('projects.charter.field.sponsor')}
          <select
            className={inputClassName}
            data-testid="project-charter-sponsor"
            disabled={!isEditable}
            value={values.sponsorUserId}
            onChange={(event) => updateValue('sponsorUserId', event.target.value)}
          >
            <option value="">{t('projects.charter.field.none')}</option>
            {withCurrentPerson(state.charter.sponsor).map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className={`${labelClassName} col-span-full`}>
          {t('projects.charter.field.purpose')}
          <textarea
            className={textAreaClassName}
            data-testid="project-charter-purpose"
            disabled={!isEditable}
            maxLength={2000}
            value={values.purpose}
            onChange={(event) => updateValue('purpose', event.target.value)}
          />
        </label>
        <label className={`${labelClassName} col-span-full`}>
          {t('projects.charter.field.description')}
          <textarea
            className={textAreaClassName}
            data-testid="project-charter-description"
            disabled={!isEditable}
            maxLength={2000}
            value={values.description}
            onChange={(event) => updateValue('description', event.target.value)}
          />
        </label>
        <label className={labelClassName}>
          {t('projects.charter.field.tags')}
          <input
            className={inputClassName}
            data-testid="project-charter-tags"
            disabled={!isEditable}
            value={values.tags}
            onChange={(event) => updateValue('tags', event.target.value)}
          />
          <span className="text-xs font-medium text-fg-505967">{t('projects.charter.field.tagsHint')}</span>
        </label>
        <label className={labelClassName}>
          {t('projects.charter.field.repositoryUrls')}
          <textarea
            className={textAreaClassName}
            data-testid="project-charter-repositories"
            disabled={!isEditable}
            value={values.repositoryUrls}
            onChange={(event) => updateValue('repositoryUrls', event.target.value)}
          />
          <span className="text-xs font-medium text-fg-505967">{t('projects.charter.field.repositoryUrlsHint')}</span>
        </label>
        <div className="col-span-full flex flex-wrap items-center justify-between gap-3">
          <p
            aria-live="polite"
            className={`text-sm font-semibold ${message?.kind === 'error' ? 'text-fg-red-700' : 'text-fg-emerald-700'}`}
            data-testid="project-charter-message"
          >
            {message?.text}
          </p>
          {isEditable ? (
            <div className="flex flex-wrap gap-2">
              {message?.kind === 'error' ? (
                <button className="workbench-button-secondary min-h-10 px-4" type="button" onClick={onReload}>
                  {t('projects.charter.reload')}
                </button>
              ) : null}
              <button
                className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
                data-testid="project-charter-save"
                disabled={isSaving}
                type="submit"
              >
                {isSaving ? t('projects.charter.saving') : t('projects.charter.save')}
              </button>
            </div>
          ) : null}
        </div>
      </form>
    </section>
  )
}
