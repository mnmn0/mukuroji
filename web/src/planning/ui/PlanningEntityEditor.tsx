import type {
  PlanningEntity,
  PlanningEntityPatch,
  PlanningEntityStatus,
  PlanningHealth,
  PlanningProgressMode,
  PlanningRisk,
} from '@mukuroji/contracts'
import { useId, useState, type ReactNode } from 'react'
import {
  createPlanningEntityEditorDraft,
  planningEntityStatusOptions,
  planningHealthOptions,
  planningProgressModeOptions,
  planningRiskOptions,
  readPlanningOption,
  rebasePlanningEntityEditorDraft,
  resolvePlanningEntityEdit,
  resolvePlanningOwnerOptions,
  type PlanningEntityEditorDraft,
  type PlanningEntityEditorProblem,
  type PlanningOwnerOption,
} from '../model/entityEditor'

/** Localized text for the Planning entity editor. */
export type PlanningEntityEditorLabels = {
  /** Section heading. */
  title: string
  /** Entity title field. */
  name: string
  /** Description field. */
  description: string
  /** Owner field. */
  owner: string
  /** Hint under the owner field when the owner is typed. */
  ownerHint: string
  /** Hint under the owner field when the owner is picked from members. */
  ownerPickerHint: string
  /** Lifecycle status field. */
  status: string
  /** Health field. */
  health: string
  /** Risk field. */
  risk: string
  /** Progress mode field. */
  progressMode: string
  /** Manual progress percentage field. */
  manualProgress: string
  /** Baseline start date field. */
  baselineStart: string
  /** Baseline end date field. */
  baselineEnd: string
  /** Forecast start date field. */
  forecastStart: string
  /** Forecast end date field. */
  forecastEnd: string
  /** Single-day baseline date field for Milestones. */
  baselineDate: string
  /** Single-day forecast date field for Milestones. */
  forecastDate: string
  /** Save button. */
  save: string
  /** Reset button that restores the stored values. */
  reset: string
  /** Shown when the draft has no changes to save. */
  unchanged: string
  /** Shown when the user cannot edit the entity. */
  readOnly: string
  /** Validation messages by problem. */
  problems: Record<PlanningEntityEditorProblem, string>
  /** Display names of lifecycle statuses. */
  statuses: Record<PlanningEntityStatus, string>
  /** Display names of health values. */
  healthValues: Record<PlanningHealth, string>
  /** Display names of risk levels. */
  riskValues: Record<PlanningRisk, string>
  /** Display names of progress modes. */
  progressModes: Record<PlanningProgressMode, string>
}

/** Props for {@link PlanningEntityEditor}. */
export type PlanningEntityEditorProps = {
  /**
   * Entity being edited. Remount the editor (via `key`) only when another entity is selected:
   * a newer version of the same entity keeps the user's unsaved edits.
   */
  entity: PlanningEntity
  /** Localized text. */
  labels: PlanningEntityEditorLabels
  /** Owner member keys offered as suggestions. */
  ownerCandidates: readonly string[]
  /**
   * Workspace members suggested by the owner field with their names. The owner can still be
   * typed, so a member missing from a partially loaded list stays assignable.
   */
  ownerOptions?: readonly PlanningOwnerOption[]
  /** Notice under the owner field, such as a member-list load failure with a retry button. */
  ownerNotice?: ReactNode
  /** Disables every control, for example while an AI review is pending. */
  disabled?: boolean
  /** Saves the changed fields. Omit to render the editor read-only. */
  onSave?: (entity: PlanningEntity, patch: PlanningEntityPatch) => void | Promise<void>
}

/**
 * Edits the title, description, owner, status, health, risk, progress and dates of one
 * Planning entity, and sends only the changed fields.
 *
 * @param props - Entity, labels, owner suggestions and the save callback.
 * @returns The editor form.
 */
export function PlanningEntityEditor({
  disabled = false,
  entity,
  labels,
  onSave,
  ownerCandidates,
  ownerNotice,
  ownerOptions = [],
}: PlanningEntityEditorProps) {
  const [draft, setDraft] = useState(() => createPlanningEntityEditorDraft(entity))
  const [baseEntity, setBaseEntity] = useState(entity)
  if (baseEntity !== entity) {
    // A refresh (after a save, a conflict or revalidation) keeps edits the user has not saved.
    setBaseEntity(entity)
    setDraft(rebasePlanningEntityEditorDraft(baseEntity, entity, draft))
  }
  const [message, setMessage] = useState<string>()
  const [isSaving, setIsSaving] = useState(false)
  const ownerListId = useId()
  const readOnly = !onSave
  const locked = readOnly || disabled || isSaving
  const singleDay = entity.type === 'milestone'

  /** Applies one field change and clears a stale validation message. */
  const update = (change: Partial<PlanningEntityEditorDraft>) => {
    setDraft((current) => ({ ...current, ...change }))
    setMessage(undefined)
  }

  return (
    <form
      className="workbench-panel grid gap-4 p-5"
      data-testid="planning-entity-editor"
      onSubmit={(event) => {
        event.preventDefault()
        if (!onSave || locked) return
        const result = resolvePlanningEntityEdit(entity, draft)
        if (result.kind === 'invalid') {
          setMessage(labels.problems[result.problem])
          return
        }
        if (result.kind === 'unchanged') {
          setMessage(labels.unchanged)
          return
        }
        setIsSaving(true)
        // Start inside a promise so a synchronous throw cannot leave the form locked.
        void Promise.resolve()
          .then(() => onSave(entity, result.patch))
          .finally(() => setIsSaving(false))
      }}
    >
      <div className="grid gap-1">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">{labels.title}</h2>
        <p className="text-sm font-semibold text-[var(--workbench-muted)]">{entity.title}</p>
      </div>
      <fieldset className="grid gap-3" disabled={locked}>
        <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
          <EditorField label={labels.name}>
            <input
              className="workbench-input h-10 px-3"
              maxLength={500}
              name="title"
              required
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
            />
          </EditorField>
          <div className="grid content-start gap-2">
            <EditorField hint={ownerOptions.length > 0 ? labels.ownerPickerHint : labels.ownerHint} label={labels.owner}>
              <input
                autoComplete="off"
                className="workbench-input h-10 px-3"
                list={ownerListId}
                name="ownerMemberKey"
                required
                value={draft.ownerMemberKey}
                onChange={(event) => update({ ownerMemberKey: event.target.value })}
              />
              <datalist id={ownerListId}>
                {resolvePlanningOwnerOptions(ownerOptions, ownerCandidates).map((option) => (
                  <option key={option.memberKey} label={option.label} value={option.memberKey} />
                ))}
              </datalist>
            </EditorField>
            {ownerNotice}
          </div>
        </div>
        <EditorField label={labels.description}>
          <textarea
            className="workbench-input min-h-20 px-3 py-2"
            name="description"
            value={draft.description}
            onChange={(event) => update({ description: event.target.value })}
          />
        </EditorField>
        <div className="grid grid-cols-3 gap-3 max-[640px]:grid-cols-1">
          <EditorSelect
            label={labels.status}
            name="status"
            options={planningEntityStatusOptions}
            optionLabels={labels.statuses}
            value={draft.status}
            onChange={(status) => update({ status })}
          />
          <EditorSelect
            label={labels.health}
            name="health"
            options={planningHealthOptions}
            optionLabels={labels.healthValues}
            value={draft.health}
            onChange={(health) => update({ health })}
          />
          <EditorSelect
            label={labels.risk}
            name="risk"
            options={planningRiskOptions}
            optionLabels={labels.riskValues}
            value={draft.risk}
            onChange={(risk) => update({ risk })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
          <EditorSelect
            label={labels.progressMode}
            name="progressMode"
            options={planningProgressModeOptions}
            optionLabels={labels.progressModes}
            value={draft.progressMode}
            onChange={(progressMode) => update({ progressMode })}
          />
          {draft.progressMode === 'manual' ? (
            <EditorField label={labels.manualProgress}>
              <input
                className="workbench-input h-10 px-3"
                max={100}
                min={0}
                name="manualProgress"
                required
                step="any"
                type="number"
                value={draft.manualProgress}
                onChange={(event) => update({ manualProgress: event.target.value })}
              />
            </EditorField>
          ) : null}
        </div>
        <div className={`grid gap-3 max-[640px]:grid-cols-1 ${singleDay ? 'grid-cols-2' : 'grid-cols-4 max-[1000px]:grid-cols-2'}`}>
          {singleDay ? null : (
            <EditorDate label={labels.baselineStart} name="baselineStart" value={draft.baselineStart} onChange={(baselineStart) => update({ baselineStart })} />
          )}
          <EditorDate label={singleDay ? labels.baselineDate : labels.baselineEnd} name="baselineEnd" value={draft.baselineEnd} onChange={(baselineEnd) => update({ baselineEnd })} />
          {singleDay ? null : (
            <EditorDate label={labels.forecastStart} name="forecastStart" value={draft.forecastStart} onChange={(forecastStart) => update({ forecastStart })} />
          )}
          <EditorDate label={singleDay ? labels.forecastDate : labels.forecastEnd} name="forecastEnd" value={draft.forecastEnd} onChange={(forecastEnd) => update({ forecastEnd })} />
        </div>
      </fieldset>
      {message ? (
        <p className="text-sm font-semibold text-[var(--workbench-muted)]" data-testid="planning-entity-editor-message" role="status">
          {message}
        </p>
      ) : null}
      {readOnly ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{labels.readOnly}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button className="workbench-button-primary min-h-10 px-4 disabled:opacity-50" disabled={locked} type="submit">
            {labels.save}
          </button>
          <button
            className="workbench-button-secondary min-h-10 px-4 disabled:opacity-50"
            disabled={locked}
            type="button"
            onClick={() => {
              setDraft(createPlanningEntityEditorDraft(entity))
              setMessage(undefined)
            }}
          >
            {labels.reset}
          </button>
        </div>
      )}
    </form>
  )
}

/**
 * Wraps one control with its visible label and an optional hint.
 *
 * @param props - Label text, optional hint and the control.
 * @returns The labelled control.
 */
function EditorField({ children, hint, label }: { children: ReactNode; hint?: string; label: string }) {
  return (
    <label className="grid content-start gap-2 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      {children}
      {hint ? <span className="text-xs font-medium text-[var(--workbench-muted)]">{hint}</span> : null}
    </label>
  )
}

/**
 * Renders a select whose value is narrowed back to its option type.
 *
 * @param props - Label, field name, allowed options, their display names, value and change callback.
 * @returns The labelled select.
 */
function EditorSelect<T extends string>({
  label,
  name,
  onChange,
  optionLabels,
  options,
  value,
}: {
  label: string
  name: string
  onChange: (value: T) => void
  optionLabels: Record<T, string>
  options: readonly T[]
  value: T
}) {
  return (
    <EditorField label={label}>
      <select
        className="workbench-input h-10 px-3"
        name={name}
        value={value}
        onChange={(event) => {
          const next = readPlanningOption(event.target.value, options)
          if (next !== undefined) onChange(next)
        }}
      >
        {options.map((option) => <option key={option} value={option}>{optionLabels[option]}</option>)}
      </select>
    </EditorField>
  )
}

/**
 * Renders a required date input.
 *
 * @param props - Label, field name, value and change callback.
 * @returns The labelled date input.
 */
function EditorDate({
  label,
  name,
  onChange,
  value,
}: {
  label: string
  name: string
  onChange: (value: string) => void
  value: string
}) {
  return (
    <EditorField label={label}>
      <input
        className="workbench-input h-10 px-3"
        name={name}
        required
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </EditorField>
  )
}
