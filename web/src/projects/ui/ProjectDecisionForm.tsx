import {
  PROJECT_DECISION_DECIDERS_MAX,
  PROJECT_DECISION_DECIDER_NOTE_MAX_LENGTH,
  PROJECT_DECISION_RELATED_WORK_ITEMS_MAX,
  PROJECT_DECISION_SOURCES_MAX,
  PROJECT_DECISION_SOURCE_LABEL_MAX_LENGTH,
  PROJECT_DECISION_SOURCE_URL_MAX_LENGTH,
  PROJECT_DECISION_STATUSES,
  PROJECT_DECISION_TEXT_MAX_LENGTH,
  PROJECT_DECISION_TITLE_MAX_LENGTH,
} from '@mukuroji/contracts'
import type { FormEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { ProjectDecisionFormValues } from '../model/projectDecisionForm'
import { decisionStatusMessageKey } from '../model/projectDecisionMessages'

/** One choosable member, Work Item, or decision. */
export type ProjectDecisionReferenceOption = {
  /** Identifier sent to the API. */
  id: string
  /** Text shown for it. */
  label: string
}

/** Props of the decision form. */
export type ProjectDecisionFormProps = {
  /** Current values. */
  values: ProjectDecisionFormValues
  /** Receives the next values. */
  onChange: (values: ProjectDecisionFormValues) => void
  /** Project members who may be named as deciders. */
  memberOptions: readonly ProjectDecisionReferenceOption[]
  /** Work Items of the Project that may be named as related; the picker is hidden without them. */
  workItemOptions?: readonly ProjectDecisionReferenceOption[]
  /** Other decisions of the Project that may replace this one. */
  replacementOptions: readonly ProjectDecisionReferenceOption[]
  /** Whether a save is in flight; the fields are locked meanwhile. */
  isSaving: boolean
  /** Message of the last failed save. */
  saveError?: string
  /** Translator for every label. */
  t: (key: MessageKey) => string
  /** Saves the values. */
  onSubmit: () => void
  /** Closes the form without saving. */
  onCancel: () => void
  /** Test ID prefix, so two forms on one page stay distinguishable. */
  testId?: string
}

const inputClassName =
  'h-10 rounded-md border border-tone-d3d8df bg-surface px-3 text-sm font-medium text-fg-1c1d1f outline-none transition focus:border-tone-2563eb focus:ring-4 focus:ring-tone-2563eb/10 disabled:bg-[var(--workbench-surface-muted)]'
const textAreaClassName =
  'min-h-20 rounded-md border border-tone-d3d8df bg-surface px-3 py-2 text-sm font-medium text-fg-1c1d1f outline-none transition focus:border-tone-2563eb focus:ring-4 focus:ring-tone-2563eb/10'
const labelClassName = 'grid gap-1.5 text-sm font-semibold text-fg-505967'

/**
 * Renders the fields of one decision: what, why, who, when, related Work Items, and sources.
 *
 * @param props - Values, options, and handlers.
 * @returns The form.
 */
export function ProjectDecisionForm({
  values,
  onChange,
  memberOptions,
  workItemOptions,
  replacementOptions,
  isSaving,
  saveError,
  t,
  onSubmit,
  onCancel,
  testId = 'project-decision-form',
}: ProjectDecisionFormProps) {
  /**
   * Changes one field.
   *
   * @param key - Field to change.
   * @param value - New value.
   */
  function update<K extends keyof ProjectDecisionFormValues>(key: K, value: ProjectDecisionFormValues[K]) {
    onChange({ ...values, [key]: value })
  }

  /**
   * Submits the form without a page navigation.
   *
   * @param event - Form submission.
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!isSaving) onSubmit()
  }

  const remainingMembers = memberOptions.filter((option) => !values.deciderMemberIds.includes(option.id))
  const remainingWorkItems = (workItemOptions ?? []).filter((option) => !values.relatedWorkItemIds.includes(option.id))
  const labelOf = (options: readonly ProjectDecisionReferenceOption[], id: string) =>
    options.find((option) => option.id === id)?.label ?? id

  return (
    <form
      className="grid grid-cols-2 gap-3 rounded-md border border-tone-d3d8df p-3 max-[780px]:grid-cols-1"
      data-testid={testId}
      onSubmit={handleSubmit}
    >
      <fieldset className="contents" disabled={isSaving}>
        <label className={`${labelClassName} col-span-2 max-[780px]:col-span-1`}>
          {t('projects.decisionLog.field.title')}
          <input
            className={inputClassName}
            data-testid={`${testId}-title`}
            maxLength={PROJECT_DECISION_TITLE_MAX_LENGTH}
            required
            value={values.title}
            onChange={(event) => update('title', event.target.value)}
          />
        </label>
        <label className={`${labelClassName} col-span-2 max-[780px]:col-span-1`}>
          {t('projects.decisionLog.field.content')}
          <textarea
            className={textAreaClassName}
            data-testid={`${testId}-content`}
            maxLength={PROJECT_DECISION_TEXT_MAX_LENGTH}
            required
            value={values.content}
            onChange={(event) => update('content', event.target.value)}
          />
        </label>
        <label className={`${labelClassName} col-span-2 max-[780px]:col-span-1`}>
          {t('projects.decisionLog.field.rationale')}
          <textarea
            className={textAreaClassName}
            data-testid={`${testId}-rationale`}
            maxLength={PROJECT_DECISION_TEXT_MAX_LENGTH}
            value={values.rationale}
            onChange={(event) => update('rationale', event.target.value)}
          />
        </label>
        <label className={labelClassName}>
          {t('projects.decisionLog.field.decidedAt')}
          <input
            className={inputClassName}
            data-testid={`${testId}-decided-at`}
            required
            type="datetime-local"
            value={values.decidedAtLocal}
            onChange={(event) => update('decidedAtLocal', event.target.value)}
          />
        </label>
        <label className={labelClassName}>
          {t('projects.decisionLog.field.status')}
          <select
            className={inputClassName}
            data-testid={`${testId}-status`}
            value={values.status}
            onChange={(event) => {
              const status = PROJECT_DECISION_STATUSES.find((candidate) => candidate === event.target.value)
              if (status) onChange({ ...values, status, ...(status === 'superseded' ? {} : { supersededByEntryId: '' }) })
            }}
          >
            {PROJECT_DECISION_STATUSES.map((status) => (
              <option key={status} value={status}>{t(decisionStatusMessageKey(status))}</option>
            ))}
          </select>
        </label>
        {values.status === 'superseded' && replacementOptions.length > 0 ? (
          <label className={`${labelClassName} col-span-2 max-[780px]:col-span-1`}>
            {t('projects.decisionLog.field.supersededBy')}
            <select
              className={inputClassName}
              data-testid={`${testId}-superseded-by`}
              value={values.supersededByEntryId}
              onChange={(event) => update('supersededByEntryId', event.target.value)}
            >
              <option value="">{t('projects.decisionLog.supersededBy.none')}</option>
              {replacementOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        ) : null}

        <div className={`${labelClassName} col-span-2 max-[780px]:col-span-1`}>
          <span>{t('projects.decisionLog.field.deciders')}</span>
          <ChosenList
            items={values.deciderMemberIds.map((id) => ({ id, label: labelOf(memberOptions, id) }))}
            removeLabel={t('projects.decisionLog.remove')}
            onRemove={(id) => update('deciderMemberIds', values.deciderMemberIds.filter((candidate) => candidate !== id))}
          />
          {values.deciderMemberIds.length < PROJECT_DECISION_DECIDERS_MAX && remainingMembers.length > 0 ? (
            <select
              aria-label={t('projects.decisionLog.deciders.add')}
              className={inputClassName}
              data-testid={`${testId}-decider-add`}
              value=""
              onChange={(event) => {
                if (event.target.value) update('deciderMemberIds', [...values.deciderMemberIds, event.target.value])
              }}
            >
              <option value="">{t('projects.decisionLog.deciders.add')}</option>
              {remainingMembers.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          ) : null}
        </div>
        <label className={`${labelClassName} col-span-2 max-[780px]:col-span-1`}>
          {t('projects.decisionLog.field.deciderNote')}
          <input
            className={inputClassName}
            data-testid={`${testId}-decider-note`}
            maxLength={PROJECT_DECISION_DECIDER_NOTE_MAX_LENGTH}
            placeholder={t('projects.decisionLog.deciderNote.placeholder')}
            value={values.deciderNote}
            onChange={(event) => update('deciderNote', event.target.value)}
          />
        </label>

        {workItemOptions || values.relatedWorkItemIds.length > 0 ? (
          <div className={`${labelClassName} col-span-2 max-[780px]:col-span-1`}>
            <span>{t('projects.decisionLog.field.relatedWorkItems')}</span>
            <ChosenList
              items={values.relatedWorkItemIds.map((id) => ({ id, label: labelOf(workItemOptions ?? [], id) }))}
              removeLabel={t('projects.decisionLog.remove')}
              onRemove={(id) => update('relatedWorkItemIds', values.relatedWorkItemIds.filter((candidate) => candidate !== id))}
            />
            {values.relatedWorkItemIds.length < PROJECT_DECISION_RELATED_WORK_ITEMS_MAX && remainingWorkItems.length > 0 ? (
              <select
                aria-label={t('projects.decisionLog.related.add')}
                className={inputClassName}
                data-testid={`${testId}-work-item-add`}
                value=""
                onChange={(event) => {
                  if (event.target.value) update('relatedWorkItemIds', [...values.relatedWorkItemIds, event.target.value])
                }}
              >
                <option value="">{t('projects.decisionLog.related.add')}</option>
                {remainingWorkItems.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            ) : null}
          </div>
        ) : null}

        <fieldset className="col-span-2 grid gap-2 max-[780px]:col-span-1">
          <legend className="text-sm font-semibold text-fg-505967">{t('projects.decisionLog.field.sources')}</legend>
          <p className="text-xs font-medium text-fg-505967">{t('projects.decisionLog.sources.help')}</p>
          {values.sources.map((source, index) => (
            <div className="grid grid-cols-[2fr_1fr_auto] gap-2 max-[780px]:grid-cols-1" key={index}>
              <input
                aria-label={t('projects.decisionLog.sources.url')}
                className={inputClassName}
                data-testid={`${testId}-source-url-${index}`}
                inputMode="url"
                maxLength={PROJECT_DECISION_SOURCE_URL_MAX_LENGTH}
                placeholder="https://"
                type="url"
                value={source.url}
                onChange={(event) => update('sources', values.sources.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, url: event.target.value } : item))}
              />
              <input
                aria-label={t('projects.decisionLog.sources.label')}
                className={inputClassName}
                maxLength={PROJECT_DECISION_SOURCE_LABEL_MAX_LENGTH}
                placeholder={t('projects.decisionLog.sources.label')}
                value={source.label ?? ''}
                onChange={(event) => update('sources', values.sources.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, label: event.target.value } : item))}
              />
              <button
                className="workbench-button-secondary min-h-10 px-3"
                type="button"
                onClick={() => update('sources', values.sources.filter((_, itemIndex) => itemIndex !== index))}
              >
                {t('projects.decisionLog.remove')}
              </button>
            </div>
          ))}
          {values.sources.length < PROJECT_DECISION_SOURCES_MAX ? (
            <button
              className="workbench-button-secondary min-h-10 w-fit px-4"
              data-testid={`${testId}-source-add`}
              type="button"
              onClick={() => update('sources', [...values.sources, { url: '' }])}
            >
              {t('projects.decisionLog.sources.add')}
            </button>
          ) : null}
        </fieldset>

        {saveError ? (
          <p className="col-span-2 text-sm font-semibold text-fg-red-700 max-[780px]:col-span-1" role="alert">{saveError}</p>
        ) : null}
        <div className="col-span-2 flex flex-wrap justify-end gap-2 max-[780px]:col-span-1">
          <button className="workbench-button-secondary min-h-10 px-4" type="button" onClick={onCancel}>
            {t('projects.decisionLog.cancel')}
          </button>
          <button className="workbench-button-primary min-h-10 px-4" data-testid={`${testId}-save`} type="submit">
            {t('projects.decisionLog.save')}
          </button>
        </div>
      </fieldset>
    </form>
  )
}

/** Props of the list of chosen members or Work Items. */
type ChosenListProps = {
  /** Chosen items. */
  items: readonly ProjectDecisionReferenceOption[]
  /** Accessible text of the remove buttons, with `{item}` for the item. */
  removeLabel: string
  /** Removes one item. */
  onRemove: (id: string) => void
}

/**
 * Renders chosen members or Work Items as removable chips.
 *
 * @param props - Items and the remove handler.
 * @returns The list, or nothing when empty.
 */
function ChosenList({ items, removeLabel, onRemove }: ChosenListProps) {
  if (items.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li className="flex items-center gap-1 rounded-full border border-tone-d3d8df px-3 py-1 text-xs font-semibold text-fg-1c1d1f" key={item.id}>
          <span>{item.label}</span>
          <button
            aria-label={`${removeLabel}: ${item.label}`}
            className="text-fg-505967 hover:text-fg-1c1d1f"
            type="button"
            onClick={() => onRemove(item.id)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  )
}
