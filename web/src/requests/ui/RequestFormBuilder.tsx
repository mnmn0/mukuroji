import type {
  RequestFormAccessMode,
  RequestLocale,
  RequestLocalizedText,
  WorkItemConfiguration,
  WorkflowStatusDefinition,
  WorkItemPriority,
} from '@mukuroji/contracts'
import { DEFAULT_WORK_ITEM_TYPE_ID } from '@mukuroji/contracts'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import type { ProjectDirectoryTeam } from '../../projects/api'
import {
  createEmptyRequestField,
  createEmptyRequestSection,
  isRequestFormDraftModelValid,
  normalizeRequestBuilderFieldForType,
  synchronizeRequestRoutingTeam,
  type RequestBuilderField,
  type RequestBuilderFieldType,
  type RequestBuilderSection,
  type RequestFormDraftModel,
  type RequestRoutingRuleDraft,
  type RequestRoutingTargetDraft,
} from '../model/requestForm'
import type {
  RequestConditionOperator,
  RequestVisibilityCondition,
} from '../model/requestFormLogic'
import {
  resolveWorkItemTypeWorkflow,
  resolveWorkItemTypes,
} from '../../work-items/model/workItemDisplay'

/**
 * RequestFormBuilder の入力です。
 */
export type RequestFormBuilderProps = {
  /**
   * Builder chrome の表示 locale です。
   */
  locale: Locale
  /**
   * 編集対象の request form draft です。
   */
  model: RequestFormDraftModel
  /**
   * Routing と scope selector に表示する Team/Project directory です。
   */
  teams: ProjectDirectoryTeam[]
  /**
   * 選択 Team で利用できる workflow status 一覧です。
   */
  workflowStatuses?: WorkflowStatusDefinition[]
  /** Work Item configurations indexed by Team ID for type-specific routing workflows. */
  workItemConfigurationsByTeam?: Readonly<Record<string, WorkItemConfiguration>>
  /**
   * Draft 保存中かどうかです。
   */
  isSaving?: boolean
  /**
   * Publish 中かどうかです。
   */
  isPublishing?: boolean
  /**
   * API または local validation error です。
   */
  errorMessage?: string
  /**
   * Current principal が draft を編集できるかどうかです。
   */
  canEdit?: boolean
  /**
   * Current principal が publish できるかどうかです。
   */
  canPublish?: boolean
  /**
   * Builder state を親 container へ反映する callback です。
   */
  onChange: (model: RequestFormDraftModel) => void
  /**
   * Draft 保存 callback です。
   */
  onSave: () => void | Promise<void>
  /**
   * Immutable version publish callback です。
   */
  onPublish?: () => void | Promise<void>
}

const fieldTypes = [
  'text',
  'textarea',
  'email',
  'url',
  'number',
  'date',
  'select',
  'multi-select',
  'checkbox',
  'attachment',
] as const satisfies readonly RequestBuilderFieldType[]

const accessModes = [
  'public',
  'auth-required',
  'internal',
] as const satisfies readonly RequestFormAccessMode[]

const priorities = ['high', 'medium', 'low'] as const satisfies readonly WorkItemPriority[]

const conditionOperators = [
  'equals',
  'not-equals',
  'contains',
  'is-empty',
  'is-not-empty',
] as const satisfies readonly RequestConditionOperator[]

/**
 * Admin が form 表示、条件、validation、consent、attachment、routing を編集する UI です。
 */
export function RequestFormBuilder({
  canEdit = true,
  canPublish = true,
  errorMessage,
  isPublishing = false,
  isSaving = false,
  locale,
  model,
  onChange,
  onPublish,
  onSave,
  teams,
  workflowStatuses = [],
  workItemConfigurationsByTeam,
}: RequestFormBuilderProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [editingLocale, setEditingLocale] = useState<RequestLocale>(model.defaultLocale)
  const [localValidationError, setLocalValidationError] = useState(false)
  const mutationPending = isSaving || isPublishing
  const editingDisabled = !canEdit || mutationPending
  const activeTeam = teams.find((team) => team.id === model.routing.teamId)
  const defaultWorkItemConfiguration = workItemConfigurationsByTeam?.[model.routing.teamId]
  const defaultWorkItemTypes = resolveWorkItemTypes(defaultWorkItemConfiguration)
  const defaultWorkflowStatuses = resolveRoutingWorkflowStatuses(
    model.routing,
    defaultWorkItemConfiguration,
    workflowStatuses,
  )
  const allFields = model.sections.flatMap((section) => section.fields)
  const publicPath = model.linkToken
    ? `/request/${encodeURIComponent(model.linkToken)}`
    : ''
  const publicUrl = publicPath && typeof window !== 'undefined'
    ? new URL(publicPath, window.location.origin).toString()
    : publicPath

  const update = (patch: Partial<RequestFormDraftModel>) => {
    if (editingDisabled) return
    setLocalValidationError(false)
    onChange({ ...model, ...patch })
  }
  const updateSections = (sections: RequestBuilderSection[]) => update({ sections })
  const updateSection = (
    sectionId: string,
    updater: (section: RequestBuilderSection) => RequestBuilderSection,
  ) => updateSections(model.sections.map((section) =>
    section.id === sectionId ? updater(section) : section,
  ))

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (editingDisabled) return
    if (!isRequestFormDraftModelValid(model)) {
      setLocalValidationError(true)
      return
    }
    runBuilderAction(onSave)
  }

  const handlePublish = () => {
    if (mutationPending || !canPublish || !model.id) return
    if (!isRequestFormDraftModelValid(model)) {
      setLocalValidationError(true)
      return
    }
    runBuilderAction(onPublish)
  }

  return (
    <form className="grid gap-5" data-testid="request-form-builder" onSubmit={handleSubmit}>
      <fieldset className="contents" data-testid="request-form-builder-controls" disabled={mutationPending}>
      <section className="workbench-panel overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
          <div>
            <p className="workbench-eyebrow">{t('requests.forms.title')}</p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--workbench-text)]">
              {t('requests.builder.title')}
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="workbench-button-secondary min-h-10 px-4"
              data-testid="request-form-builder-save"
              disabled={editingDisabled}
              type="submit"
            >
              {isSaving ? t('requests.builder.saving') : t('requests.builder.save')}
            </button>
            <button
              className="workbench-button-primary min-h-10 px-4"
              data-testid="request-form-builder-publish"
              disabled={!model.id || !canPublish || mutationPending}
              onClick={handlePublish}
              type="button"
            >
              {isPublishing ? t('requests.builder.publishing') : t('requests.builder.publish')}
            </button>
          </div>
        </div>

        <fieldset className="grid grid-cols-4 gap-4 border-0 p-5 max-[1080px]:grid-cols-2 max-[640px]:grid-cols-1" disabled={editingDisabled}>
          <BuilderLabel label={t('requests.builder.name')} span="col-span-2 max-[640px]:col-span-1">
            <input
              className="workbench-input min-h-10 px-3"
              required
              value={model.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </BuilderLabel>
          <BuilderLabel label={t('requests.builder.status')}>
            <select
              className="workbench-input min-h-10 px-3"
              value={model.status}
              onChange={(event) => update({
                status: event.target.value === 'archived'
                  ? 'archived'
                  : event.target.value === 'published'
                    ? 'published'
                    : 'draft',
              })}
            >
              <option value="draft">{t('requests.formStatus.draft')}</option>
              {model.status === 'published' ? <option value="published">{t('requests.formStatus.published')}</option> : null}
              <option value="archived">{t('requests.formStatus.archived')}</option>
            </select>
          </BuilderLabel>
          <BuilderLabel label={t('requests.builder.version')}>
            <input className="workbench-input min-h-10 px-3" readOnly value={`v${model.versionNumber}`} />
          </BuilderLabel>

          <BuilderLabel label={t('requests.builder.scope')}>
            <select
              className="workbench-input min-h-10 px-3"
              value={model.scope.type}
              onChange={(event) => {
                if (event.target.value !== 'team') {
                  update({ scope: { type: 'workspace' } })
                  return
                }

                const teamId = model.scope.type === 'team'
                  ? model.scope.teamId ?? teams[0]?.id ?? ''
                  : teams[0]?.id ?? ''
                update({
                  routing: synchronizeRequestRoutingTeam(model.routing, teamId),
                  scope: { type: 'team', teamId },
                })
              }}
            >
              <option value="workspace">{t('requests.builder.scopeWorkspace')}</option>
              <option value="team">{t('requests.builder.scopeTeam')}</option>
            </select>
          </BuilderLabel>
          {model.scope.type === 'team' ? (
            <BuilderLabel label={t('requests.builder.team')}>
              <select
                className="workbench-input min-h-10 px-3"
                required
                value={model.scope.teamId ?? ''}
                onChange={(event) => {
                  const teamId = event.target.value
                  update({
                    routing: synchronizeRequestRoutingTeam(model.routing, teamId),
                    scope: { type: 'team', teamId },
                  })
                }}
              >
                <option value="">—</option>
                {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            </BuilderLabel>
          ) : null}
          <BuilderLabel label={t('requests.builder.access')}>
            <select
              className="workbench-input min-h-10 px-3"
              value={model.accessMode}
              onChange={(event) => update({ accessMode: event.target.value as RequestFormAccessMode })}
            >
              {accessModes.map((mode) => (
                <option key={mode} value={mode}>{t(`requests.access.${mode}`)}</option>
              ))}
            </select>
          </BuilderLabel>
          <BuilderLabel label={t('requests.builder.expiry')}>
            <input
              className="workbench-input min-h-10 px-3"
              type="datetime-local"
              value={toLocalDateTimeValue(model.expiresAt)}
              onChange={(event) => update({ expiresAt: toIsoDateTime(event.target.value) })}
            />
          </BuilderLabel>

          {publicUrl ? (
            <BuilderLabel label={t('requests.builder.publicLink')} span="col-span-4 max-[1080px]:col-span-2 max-[640px]:col-span-1">
              <div className="flex min-w-0 gap-2">
                <input className="workbench-input min-h-10 min-w-0 flex-1 px-3" readOnly value={publicUrl} />
                <button
                  className="workbench-button-secondary min-h-10 px-4"
                  onClick={() => void copyText(publicUrl)}
                  type="button"
                >
                  {t('requests.builder.copyLink')}
                </button>
              </div>
            </BuilderLabel>
          ) : null}
        </fieldset>
      </section>

      <fieldset className="contents" data-testid="request-form-builder-edit-controls" disabled={!canEdit}>
      <section className="workbench-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
          <h3 className="text-lg font-semibold text-[var(--workbench-text)]">
            {t('requests.builder.locale')}
          </h3>
          <div className="inline-flex overflow-hidden rounded-lg border border-[var(--workbench-border-strong)] bg-white">
            {model.locales.map((candidate) => (
              <button
                aria-pressed={editingLocale === candidate}
                className={`min-h-9 px-4 text-sm font-semibold ${editingLocale === candidate ? 'bg-[var(--workbench-primary)] text-white' : 'text-[var(--workbench-text)]'}`}
                key={candidate}
                onClick={() => setEditingLocale(candidate)}
                type="button"
              >
                {candidate.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <fieldset className="grid grid-cols-2 gap-4 border-0 p-5 max-[720px]:grid-cols-1" disabled={editingDisabled}>
          <BuilderLabel label={t('requests.builder.defaultLocale')}>
            <select
              className="workbench-input min-h-10 px-3"
              value={model.defaultLocale}
              onChange={(event) => update({ defaultLocale: event.target.value as RequestLocale })}
            >
              {model.locales.map((candidate) => (
                <option key={candidate} value={candidate}>{candidate.toUpperCase()}</option>
              ))}
            </select>
          </BuilderLabel>
          <BuilderLabel label={t('requests.builder.formTitle')}>
            <input
              className="workbench-input min-h-10 px-3"
              required={editingLocale === model.defaultLocale}
              value={model.title[editingLocale] ?? ''}
              onChange={(event) => update({
                title: updateLocalized(model.title, editingLocale, event.target.value),
              })}
            />
          </BuilderLabel>
          <BuilderLabel label={t('requests.builder.formDescription')}>
            <textarea
              className="workbench-input min-h-24 px-3 py-2"
              value={model.description[editingLocale] ?? ''}
              onChange={(event) => update({
                description: updateLocalized(model.description, editingLocale, event.target.value),
              })}
            />
          </BuilderLabel>
          <BuilderLabel label={t('requests.builder.confirmation')}>
            <textarea
              className="workbench-input min-h-24 px-3 py-2"
              required={editingLocale === model.defaultLocale}
              value={model.confirmation[editingLocale] ?? ''}
              onChange={(event) => update({
                confirmation: updateLocalized(model.confirmation, editingLocale, event.target.value),
              })}
            />
          </BuilderLabel>
          <BuilderLabel label={t('requests.builder.redirectUrl')} span="col-span-2 max-[720px]:col-span-1">
            <input
              className="workbench-input min-h-10 px-3"
              placeholder="https://"
              type="url"
              value={model.redirectUrl}
              onChange={(event) => update({ redirectUrl: event.target.value })}
            />
          </BuilderLabel>
        </fieldset>
      </section>

      <section className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold text-[var(--workbench-text)]">
            {t('requests.builder.sections')}
          </h3>
          <button
            className="workbench-button-secondary min-h-10 px-4"
            disabled={editingDisabled}
            onClick={() => updateSections([
              ...model.sections,
              createEmptyRequestSection(createUniqueId('section', model.sections.map((section) => section.id))),
            ])}
            type="button"
          >
            + {t('requests.builder.addSection')}
          </button>
        </div>

        {model.sections.map((section, sectionIndex) => {
          const previousFields = model.sections
            .slice(0, sectionIndex)
            .flatMap((candidate) => candidate.fields)

          return (
            <section className="workbench-panel overflow-hidden" data-testid={`request-section-${section.id}`} key={section.id}>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4">
                <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                  <BuilderLabel label={t('requests.builder.sectionTitle')}>
                    <input
                      className="workbench-input min-h-10 px-3"
                      required={editingLocale === model.defaultLocale}
                      value={section.title[editingLocale] ?? ''}
                      onChange={(event) => updateSection(section.id, (current) => ({
                        ...current,
                        title: updateLocalized(current.title, editingLocale, event.target.value),
                      }))}
                    />
                  </BuilderLabel>
                  <BuilderLabel label={t('requests.builder.sectionDescription')}>
                    <input
                      className="workbench-input min-h-10 px-3"
                      value={section.description[editingLocale] ?? ''}
                      onChange={(event) => updateSection(section.id, (current) => ({
                        ...current,
                        description: updateLocalized(current.description, editingLocale, event.target.value),
                      }))}
                    />
                  </BuilderLabel>
                </div>
                <ReorderButtons
                  disableDown={sectionIndex === model.sections.length - 1}
                  disableUp={sectionIndex === 0}
                  removeDisabled={model.sections.length === 1}
                  t={t}
                  onMove={(direction) => updateSections(moveItem(model.sections, sectionIndex, direction))}
                  onRemove={() => updateSections(model.sections.filter((candidate) => candidate.id !== section.id))}
                />
              </div>
              <div className="border-b border-[var(--workbench-border)] p-4">
                <ConditionEditor
                  condition={section.condition}
                  editingLocale={editingLocale}
                  referenceFields={previousFields}
                  t={t}
                  onChange={(condition) => updateSection(section.id, (current) => ({ ...current, condition }))}
                />
              </div>
              <div className="grid gap-3 p-4">
                {section.fields.map((field, fieldIndex) => {
                  const earlierFields = [
                    ...previousFields,
                    ...section.fields.slice(0, fieldIndex),
                  ]

                  return (
                    <FieldEditor
                      editingLocale={editingLocale}
                      field={field}
                      index={fieldIndex}
                      isDefaultLocale={editingLocale === model.defaultLocale}
                      isFirst={fieldIndex === 0}
                      isLast={fieldIndex === section.fields.length - 1}
                      key={field.id}
                      referenceFields={earlierFields}
                      t={t}
                      onChange={(nextField) => updateSection(section.id, (current) => ({
                        ...current,
                        fields: current.fields.map((candidate) => candidate.id === field.id ? nextField : candidate),
                      }))}
                      onMove={(direction) => updateSection(section.id, (current) => ({
                        ...current,
                        fields: moveItem(current.fields, fieldIndex, direction),
                      }))}
                      onRemove={() => updateSection(section.id, (current) => ({
                        ...current,
                        fields: current.fields.filter((candidate) => candidate.id !== field.id),
                      }))}
                    />
                  )
                })}
                <button
                  className="workbench-button-secondary min-h-10 justify-self-start px-4"
                  disabled={editingDisabled}
                  onClick={() => updateSection(section.id, (current) => ({
                    ...current,
                    fields: [
                      ...current.fields,
                      createEmptyRequestField(createUniqueId('field', allFields.map((field) => field.id))),
                    ],
                  }))}
                  type="button"
                >
                  + {t('requests.builder.addField')}
                </button>
              </div>
            </section>
          )
        })}
      </section>

      <section className="grid grid-cols-2 gap-5 max-[900px]:grid-cols-1">
        <fieldset className="workbench-panel grid gap-4 border-0 p-5" disabled={editingDisabled}>
          <h3 className="text-lg font-semibold text-[var(--workbench-text)]">
            {t('requests.builder.consent')}
          </h3>
          <label className="flex items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
            <input
              checked={model.consent.required}
              className="h-4 w-4 accent-[var(--workbench-primary)]"
              onChange={(event) => update({ consent: { ...model.consent, required: event.target.checked } })}
              type="checkbox"
            />
            {t('requests.builder.consentRequired')}
          </label>
          <BuilderLabel label={t('requests.builder.consentText')}>
            <textarea
              className="workbench-input min-h-24 px-3 py-2"
              value={model.consent.text[editingLocale] ?? ''}
              onChange={(event) => update({
                consent: {
                  ...model.consent,
                  text: updateLocalized(model.consent.text, editingLocale, event.target.value),
                },
              })}
            />
          </BuilderLabel>
          <BuilderLabel label={t('requests.builder.privacyUrl')}>
            <input
              className="workbench-input min-h-10 px-3"
              value={model.consent.privacyUrl}
              onChange={(event) => update({ consent: { ...model.consent, privacyUrl: event.target.value } })}
            />
          </BuilderLabel>
        </fieldset>

        <fieldset className="workbench-panel grid gap-4 border-0 p-5" disabled={editingDisabled}>
          <h3 className="text-lg font-semibold text-[var(--workbench-text)]">
            {t('requests.builder.attachments')}
          </h3>
          <label className="flex items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
            <input
              checked={model.attachmentPolicy.enabled}
              className="h-4 w-4 accent-[var(--workbench-primary)]"
              onChange={(event) => update({
                attachmentPolicy: { ...model.attachmentPolicy, enabled: event.target.checked },
              })}
              type="checkbox"
            />
            {t('requests.builder.attachmentsEnable')}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <BuilderLabel label={t('requests.builder.maxFiles')}>
              <input
                className="workbench-input min-h-10 px-3"
                min={0}
                type="number"
                value={model.attachmentPolicy.maxFiles}
                onChange={(event) => update({ attachmentPolicy: {
                  ...model.attachmentPolicy,
                  maxFiles: readNumberInput(event.target.value, 0),
                } })}
              />
            </BuilderLabel>
            <BuilderLabel label={t('requests.builder.maxSize')}>
              <input
                className="workbench-input min-h-10 px-3"
                min={1}
                type="number"
                value={Math.max(1, Math.round(model.attachmentPolicy.maxSizeBytes / 1024 / 1024))}
                onChange={(event) => update({ attachmentPolicy: {
                  ...model.attachmentPolicy,
                  maxSizeBytes: readNumberInput(event.target.value, 1) * 1024 * 1024,
                } })}
              />
            </BuilderLabel>
          </div>
          <BuilderLabel label={t('requests.builder.mediaTypes')}>
            <input
              className="workbench-input min-h-10 px-3"
              value={model.attachmentPolicy.allowedContentTypes.join(', ')}
              onChange={(event) => update({ attachmentPolicy: {
                ...model.attachmentPolicy,
                allowedContentTypes: parseCommaList(event.target.value),
              } })}
            />
          </BuilderLabel>
        </fieldset>
      </section>

      <fieldset className="workbench-panel grid grid-cols-4 gap-4 border-0 p-5 max-[1080px]:grid-cols-2 max-[640px]:grid-cols-1" disabled={editingDisabled}>
        <h3 className="col-span-4 text-lg font-semibold text-[var(--workbench-text)] max-[1080px]:col-span-2 max-[640px]:col-span-1">
          {t('requests.builder.routing')}
        </h3>
        <BuilderLabel label={t('requests.builder.team')}>
          <select
            className="workbench-input min-h-10 px-3"
            data-testid="request-routing-default-team"
            disabled={model.scope.type === 'team'}
            required
            value={model.routing.teamId}
            onChange={(event) => update({ routing: {
              ...model.routing,
              projectId: '',
              teamId: event.target.value,
              workItemTypeId: DEFAULT_WORK_ITEM_TYPE_ID,
              workflowStatusId: '',
            } })}
          >
            <option value="">—</option>
            {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
        </BuilderLabel>
        <BuilderLabel label={t('requests.builder.project')}>
          <select
            className="workbench-input min-h-10 px-3"
            value={model.routing.projectId}
            onChange={(event) => update({ routing: { ...model.routing, projectId: event.target.value } })}
          >
            <option value="">—</option>
            {activeTeam?.projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </BuilderLabel>
        <BuilderLabel label={t('requests.builder.workItemType')}>
          <select
            className="workbench-input min-h-10 px-3"
            value={model.routing.workItemTypeId}
            onChange={(event) => update({ routing: {
              ...model.routing,
              workItemTypeId: event.target.value,
              workflowStatusId: '',
            } })}
          >
            {defaultWorkItemTypes
              .filter((type) => type.status === 'active' || type.id === model.routing.workItemTypeId)
              .map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}{type.status === 'archived' ? ` (${t('tasks.create.archived')})` : ''}
                </option>
              ))}
          </select>
        </BuilderLabel>
        <BuilderLabel label={t('requests.builder.workflow')}>
          <select
            className="workbench-input min-h-10 px-3"
            value={model.routing.workflowStatusId}
            onChange={(event) => update({ routing: { ...model.routing, workflowStatusId: event.target.value } })}
          >
            <option value="">—</option>
            {defaultWorkflowStatuses.map((status) => (
              <option key={status.id} value={status.id}>{status.name}</option>
            ))}
          </select>
        </BuilderLabel>
        <BuilderLabel label={t('requests.builder.assignee')}>
          <input
            className="workbench-input min-h-10 px-3"
            required
            value={model.routing.assigneeUserId}
            onChange={(event) => update({ routing: { ...model.routing, assigneeUserId: event.target.value } })}
          />
        </BuilderLabel>
        <BuilderLabel label={t('requests.builder.priority')}>
          <select
            className="workbench-input min-h-10 px-3"
            value={model.routing.priority}
            onChange={(event) => update({ routing: {
              ...model.routing,
              priority: event.target.value as WorkItemPriority,
            } })}
          >
            {priorities.map((priority) => <option key={priority} value={priority}>{t(`requests.priority.${priority}`)}</option>)}
          </select>
        </BuilderLabel>
        <BuilderLabel label={t('requests.builder.dueOffset')}>
          <input
            className="workbench-input min-h-10 px-3"
            min={0}
            type="number"
            value={model.routing.dueDateOffsetDays}
            onChange={(event) => update({ routing: {
              ...model.routing,
              dueDateOffsetDays: readNumberInput(event.target.value, 0),
            } })}
          />
        </BuilderLabel>
        <BuilderLabel label={t('requests.builder.titleMapping')}>
          <select
            className="workbench-input min-h-10 px-3"
            required
            value={model.routing.titleFieldId}
            onChange={(event) => update({ routing: { ...model.routing, titleFieldId: event.target.value } })}
          >
            <option value="">—</option>
            {allFields.map((field) => (
              <option key={field.id} value={field.id}>{field.label[editingLocale] ?? field.id}</option>
            ))}
          </select>
        </BuilderLabel>
        <BuilderLabel label={t('requests.builder.descriptionMapping')}>
          <select
            className="workbench-input min-h-24 px-3 py-2"
            multiple
            value={model.routing.descriptionFieldIds}
            onChange={(event) => update({ routing: {
              ...model.routing,
              descriptionFieldIds: Array.from(event.target.selectedOptions).map((option) => option.value),
            } })}
          >
            {allFields.map((field) => (
              <option key={field.id} value={field.id}>{field.label[editingLocale] ?? field.id}</option>
            ))}
          </select>
        </BuilderLabel>
      </fieldset>

      <RoutingRulesEditor
        defaultTarget={model.routing}
        disabled={editingDisabled}
        editingLocale={editingLocale}
        fields={allFields}
        rules={model.routing.rules}
        t={t}
        teamLocked={model.scope.type === 'team'}
        teams={teams}
        workItemConfigurationsByTeam={workItemConfigurationsByTeam}
        onChange={(rules) => update({ routing: { ...model.routing, rules } })}
      />

      <CustomFieldMappingsEditor
        disabled={editingDisabled}
        editingLocale={editingLocale}
        fields={allFields}
        mappings={model.routing.customFieldMappings}
        t={t}
        onChange={(customFieldMappings) => update({
          routing: { ...model.routing, customFieldMappings },
        })}
      />
      </fieldset>

      {localValidationError || errorMessage ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
          {localValidationError ? t('requests.builder.invalidDraft') : errorMessage}
        </p>
      ) : null}
      </fieldset>
    </form>
  )
}

function RoutingRulesEditor({
  defaultTarget,
  disabled,
  editingLocale,
  fields,
  onChange,
  rules,
  t,
  teamLocked,
  teams,
  workItemConfigurationsByTeam,
}: {
  defaultTarget: RequestRoutingTargetDraft
  disabled: boolean
  editingLocale: RequestLocale
  fields: RequestBuilderField[]
  onChange: (rules: RequestRoutingRuleDraft[]) => void
  rules: RequestRoutingRuleDraft[]
  t: ReturnType<typeof createTranslator>
  teamLocked: boolean
  teams: ProjectDirectoryTeam[]
  workItemConfigurationsByTeam?: Readonly<Record<string, WorkItemConfiguration>>
}) {
  const addRule = () => {
    const firstField = fields[0]
    if (!firstField) return

    onChange([
      ...rules,
      {
        condition: {
          match: 'all',
          rules: [{
            fieldId: firstField.id,
            operator: 'equals',
            value: defaultConditionValue(firstField),
          }],
        },
        id: createUniqueId('routing-rule', rules.map((rule) => rule.id)),
        name: t('requests.builder.ruleDefaultName').replace('{n}', String(rules.length + 1)),
        target: copyRoutingTarget(defaultTarget),
      },
    ])
  }

  return (
    <fieldset className="workbench-panel grid gap-4 border-0 p-5" disabled={disabled}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-[var(--workbench-text)]">{t('requests.builder.routingRules')}</h3>
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">{t('requests.builder.routingRulesDescription')}</p>
        </div>
        <button className="workbench-button-secondary min-h-10 px-4" disabled={fields.length === 0} onClick={addRule} type="button">
          + {t('requests.builder.addRoutingRule')}
        </button>
      </div>

      {rules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] p-4 text-sm font-medium text-[var(--workbench-muted)]">{t('requests.builder.routingRulesEmpty')}</p>
      ) : rules.map((rule, index) => (
        <article className="grid gap-4 rounded-lg border border-[var(--workbench-border)] bg-white p-4" data-testid={`request-routing-rule-${rule.id}`} key={rule.id}>
          <div className="flex items-end gap-3">
            <BuilderLabel label={t('requests.builder.ruleName')} span="min-w-0 flex-1">
              <input className="workbench-input min-h-10 px-3" required value={rule.name} onChange={(event) => onChange(rules.map((candidate) => candidate.id === rule.id ? { ...candidate, name: event.target.value } : candidate))} />
            </BuilderLabel>
            <ReorderButtons
              disableDown={index === rules.length - 1}
              disableUp={index === 0}
              removeDisabled={false}
              t={t}
              onMove={(direction) => onChange(moveItem(rules, index, direction))}
              onRemove={() => onChange(rules.filter((candidate) => candidate.id !== rule.id))}
            />
          </div>
          <ConditionEditor
            condition={rule.condition}
            editingLocale={editingLocale}
            referenceFields={fields}
            required
            t={t}
            onChange={(condition) => {
              if (!condition) return
              onChange(rules.map((candidate) => candidate.id === rule.id ? { ...candidate, condition } : candidate))
            }}
          />
          <RoutingTargetEditor
            target={rule.target}
            t={t}
            teamLocked={teamLocked}
            teams={teams}
            workItemConfiguration={workItemConfigurationsByTeam?.[rule.target.teamId]}
            onChange={(target) => onChange(rules.map((candidate) => candidate.id === rule.id ? { ...candidate, target } : candidate))}
          />
        </article>
      ))}
    </fieldset>
  )
}

function RoutingTargetEditor({
  onChange,
  target,
  t,
  teamLocked,
  teams,
  workItemConfiguration,
}: {
  onChange: (target: RequestRoutingTargetDraft) => void
  target: RequestRoutingTargetDraft
  t: ReturnType<typeof createTranslator>
  teamLocked: boolean
  teams: ProjectDirectoryTeam[]
  workItemConfiguration?: WorkItemConfiguration
}) {
  const team = teams.find((candidate) => candidate.id === target.teamId)
  const workItemTypes = resolveWorkItemTypes(workItemConfiguration)
  const workflowStatuses = resolveRoutingWorkflowStatuses(target, workItemConfiguration)

  return (
    <div className="grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[620px]:grid-cols-1">
      <BuilderLabel label={t('requests.builder.team')}>
        <select className="workbench-input min-h-10 px-3" data-testid="request-routing-rule-team" disabled={teamLocked} required value={target.teamId} onChange={(event) => onChange({ ...target, projectId: '', teamId: event.target.value, workItemTypeId: DEFAULT_WORK_ITEM_TYPE_ID, workflowStatusId: '' })}>
          <option value="">—</option>
          {teams.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
      </BuilderLabel>
      <BuilderLabel label={t('requests.builder.workItemType')}>
        <select
          className="workbench-input min-h-10 px-3"
          value={target.workItemTypeId}
          onChange={(event) => onChange({
            ...target,
            workItemTypeId: event.target.value,
            workflowStatusId: '',
          })}
        >
          {workItemTypes
            .filter((type) => type.status === 'active' || type.id === target.workItemTypeId)
            .map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}{type.status === 'archived' ? ` (${t('tasks.create.archived')})` : ''}
              </option>
            ))}
        </select>
      </BuilderLabel>
      <BuilderLabel label={t('requests.builder.project')}>
        <select className="workbench-input min-h-10 px-3" value={target.projectId} onChange={(event) => onChange({ ...target, projectId: event.target.value })}>
          <option value="">—</option>
          {team?.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </BuilderLabel>
      <BuilderLabel label={t('requests.builder.workflow')}>
        {workflowStatuses.length > 0 ? (
          <select className="workbench-input min-h-10 px-3" value={target.workflowStatusId} onChange={(event) => onChange({ ...target, workflowStatusId: event.target.value })}>
            <option value="">—</option>
            {workflowStatuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}
          </select>
        ) : (
          <input className="workbench-input min-h-10 px-3" value={target.workflowStatusId} onChange={(event) => onChange({ ...target, workflowStatusId: event.target.value })} />
        )}
      </BuilderLabel>
      <BuilderLabel label={t('requests.builder.assignee')}>
        <input className="workbench-input min-h-10 px-3" required value={target.assigneeUserId} onChange={(event) => onChange({ ...target, assigneeUserId: event.target.value })} />
      </BuilderLabel>
      <BuilderLabel label={t('requests.builder.priority')}>
        <select className="workbench-input min-h-10 px-3" value={target.priority} onChange={(event) => onChange({ ...target, priority: event.target.value as WorkItemPriority })}>
          {priorities.map((priority) => <option key={priority} value={priority}>{t(`requests.priority.${priority}`)}</option>)}
        </select>
      </BuilderLabel>
      <BuilderLabel label={t('requests.builder.dueOffset')}>
        <input className="workbench-input min-h-10 px-3" min={0} type="number" value={target.dueDateOffsetDays} onChange={(event) => onChange({ ...target, dueDateOffsetDays: readNumberInput(event.target.value, 0) })} />
      </BuilderLabel>
    </div>
  )
}

function CustomFieldMappingsEditor({
  disabled,
  editingLocale,
  fields,
  mappings,
  onChange,
  t,
}: {
  disabled: boolean
  editingLocale: RequestLocale
  fields: RequestBuilderField[]
  mappings: Record<string, string>
  onChange: (mappings: Record<string, string>) => void
  t: ReturnType<typeof createTranslator>
}) {
  const entries = Object.entries(mappings)
  const availableField = fields.find((field) => !(field.id in mappings))

  return (
    <fieldset className="workbench-panel grid gap-4 border-0 p-5" disabled={disabled}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-[var(--workbench-text)]">{t('requests.builder.customMappings')}</h3>
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">{t('requests.builder.customMappingsDescription')}</p>
        </div>
        <button className="workbench-button-secondary min-h-10 px-4" disabled={!availableField} onClick={() => {
          if (availableField) onChange({ ...mappings, [availableField.id]: '' })
        }} type="button">+ {t('requests.builder.addCustomMapping')}</button>
      </div>
      {entries.map(([fieldId, customFieldId]) => {
        const currentField = fields.find((field) => field.id === fieldId)
        return (
          <div className="grid grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_auto] items-end gap-3 max-[680px]:grid-cols-1" key={fieldId}>
            <BuilderLabel label={t('requests.builder.mappingSource')}>
              <select className="workbench-input min-h-10 px-3" value={fieldId} onChange={(event) => {
                const next = { ...mappings }
                delete next[fieldId]
                next[event.target.value] = customFieldId
                onChange(next)
              }}>
                {!currentField ? <option value={fieldId}>{fieldId}</option> : null}
                {fields.map((field) => (
                  <option disabled={field.id !== fieldId && field.id in mappings} key={field.id} value={field.id}>{field.label[editingLocale] || field.id}</option>
                ))}
              </select>
            </BuilderLabel>
            <BuilderLabel label={t('requests.builder.mappingTarget')}>
              <input className="workbench-input min-h-10 px-3" required value={customFieldId} onChange={(event) => onChange({ ...mappings, [fieldId]: event.target.value })} />
            </BuilderLabel>
            <button aria-label={t('requests.builder.remove')} className="workbench-button-secondary h-10 w-10" onClick={() => {
              const next = { ...mappings }
              delete next[fieldId]
              onChange(next)
            }} type="button">×</button>
          </div>
        )
      })}
    </fieldset>
  )
}

function FieldEditor({
  editingLocale,
  field,
  index,
  isDefaultLocale,
  isFirst,
  isLast,
  onChange,
  onMove,
  onRemove,
  referenceFields,
  t,
}: {
  editingLocale: RequestLocale
  field: RequestBuilderField
  index: number
  isDefaultLocale: boolean
  isFirst: boolean
  isLast: boolean
  onChange: (field: RequestBuilderField) => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
  referenceFields: RequestBuilderField[]
  t: ReturnType<typeof createTranslator>
}) {
  const supportsOptions = field.type === 'select' || field.type === 'multi-select'
  const supportsLength = ['text', 'textarea', 'email', 'url', 'date'].includes(field.type)
  const supportsPattern = supportsLength

  return (
    <article className="rounded-lg border border-[var(--workbench-border)] bg-white" data-testid={`request-field-${field.id}`}>
      <div className="grid grid-cols-[40px_minmax(180px,1fr)_minmax(150px,0.7fr)_auto] items-end gap-3 border-b border-[var(--workbench-border)] p-3 max-[760px]:grid-cols-[40px_minmax(0,1fr)_auto]">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--workbench-surface-muted)] text-xs font-bold text-[var(--workbench-muted)]">
          {index + 1}
        </span>
        <BuilderLabel label={t('requests.builder.fieldLabel')}>
          <input
            className="workbench-input min-h-10 px-3"
            required={isDefaultLocale}
            value={field.label[editingLocale] ?? ''}
            onChange={(event) => onChange({
              ...field,
              label: updateLocalized(field.label, editingLocale, event.target.value),
            })}
          />
        </BuilderLabel>
        <BuilderLabel label={t('requests.builder.fieldType')} span="max-[760px]:col-start-2">
          <select
            className="workbench-input min-h-10 px-3"
            value={field.type}
            onChange={(event) => onChange(normalizeRequestBuilderFieldForType(
              field,
              event.target.value as RequestBuilderFieldType,
            ))}
          >
            {fieldTypes.map((type) => (
              <option key={type} value={type}>{t(`requests.fieldType.${type}`)}</option>
            ))}
          </select>
        </BuilderLabel>
        <ReorderButtons
          disableDown={isLast}
          disableUp={isFirst}
          removeDisabled={false}
          t={t}
          onMove={onMove}
          onRemove={onRemove}
        />
      </div>
      <div className="grid grid-cols-3 gap-3 p-3 max-[840px]:grid-cols-1">
        <BuilderLabel label={t('requests.builder.fieldDescription')}>
          <input
            className="workbench-input min-h-10 px-3"
            value={field.description[editingLocale] ?? ''}
            onChange={(event) => onChange({
              ...field,
              description: updateLocalized(field.description, editingLocale, event.target.value),
            })}
          />
        </BuilderLabel>
        <BuilderLabel label={t('requests.builder.fieldPlaceholder')}>
          <input
            className="workbench-input min-h-10 px-3"
            value={field.placeholder[editingLocale] ?? ''}
            onChange={(event) => onChange({
              ...field,
              placeholder: updateLocalized(field.placeholder, editingLocale, event.target.value),
            })}
          />
        </BuilderLabel>
        <label className="flex min-h-10 items-center gap-3 self-end rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 text-sm font-semibold text-[var(--workbench-text)]">
          <input
            checked={field.required}
            className="h-4 w-4 accent-[var(--workbench-primary)]"
            onChange={(event) => onChange({ ...field, required: event.target.checked })}
            type="checkbox"
          />
          {t('requests.builder.required')}
        </label>
      </div>
      {supportsOptions ? (
        <div className="grid gap-3 border-t border-[var(--workbench-border)] p-3">
          <p className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('requests.builder.options')}
          </p>
          {field.options.map((option, optionIndex) => (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3" key={option.id}>
              <BuilderLabel label={`${t('requests.builder.optionLabel')} · ${option.id}`}>
                <input
                  className="workbench-input min-h-10 px-3"
                  required={isDefaultLocale}
                  value={option.label[editingLocale] ?? ''}
                  onChange={(event) => onChange({
                    ...field,
                    options: field.options.map((candidate, candidateIndex) =>
                      candidateIndex === optionIndex
                        ? {
                            ...candidate,
                            label: updateLocalized(
                              candidate.label,
                              editingLocale,
                              event.target.value,
                            ),
                          }
                        : candidate
                    ),
                  })}
                />
              </BuilderLabel>
              <ReorderButtons
                disableDown={optionIndex === field.options.length - 1}
                disableUp={optionIndex === 0}
                removeDisabled={false}
                t={t}
                onMove={(direction) => onChange({
                  ...field,
                  options: moveItem(field.options, optionIndex, direction),
                })}
                onRemove={() => onChange({
                  ...field,
                  options: field.options.filter((_, candidateIndex) =>
                    candidateIndex !== optionIndex
                  ),
                })}
              />
            </div>
          ))}
          <button
            className="workbench-button-secondary min-h-9 justify-self-start px-3"
            onClick={() => onChange({
              ...field,
              options: [
                ...field.options,
                {
                  id: createUniqueId('option', field.options.map((option) => option.id)),
                  label: { en: '', ja: '' },
                },
              ],
            })}
            type="button"
          >
            + {t('requests.builder.addOption')}
          </button>
        </div>
      ) : null}
      <details className="border-t border-[var(--workbench-border)] p-3">
        <summary className="cursor-pointer text-sm font-semibold text-[var(--workbench-text)]">
          {t('requests.builder.validation')} / {t('requests.builder.condition')}
        </summary>
        <div className="mt-3 grid gap-3">
          <div className="grid grid-cols-4 gap-3 max-[760px]:grid-cols-2">
            {supportsLength ? (
              <>
                <NumberValidationInput
                  label={t('requests.builder.minLength')}
                  value={field.validation?.minLength}
                  onChange={(value) => onChange({ ...field, validation: { ...field.validation, minLength: value } })}
                />
                <NumberValidationInput
                  label={t('requests.builder.maxLength')}
                  value={field.validation?.maxLength}
                  onChange={(value) => onChange({ ...field, validation: { ...field.validation, maxLength: value } })}
                />
              </>
            ) : null}
            {field.type === 'number' ? (
              <>
                <NumberValidationInput
                  label={t('requests.builder.min')}
                  value={field.validation?.min}
                  onChange={(value) => onChange({ ...field, validation: { ...field.validation, min: value } })}
                />
                <NumberValidationInput
                  label={t('requests.builder.max')}
                  value={field.validation?.max}
                  onChange={(value) => onChange({ ...field, validation: { ...field.validation, max: value } })}
                />
              </>
            ) : null}
            {supportsPattern ? (
              <BuilderLabel label={t('requests.builder.pattern')} span="col-span-2">
                <input
                  className="workbench-input min-h-10 px-3"
                  value={field.validation?.pattern ?? ''}
                  onChange={(event) => onChange({
                    ...field,
                    validation: { ...field.validation, pattern: event.target.value || undefined },
                  })}
                />
              </BuilderLabel>
            ) : null}
          </div>
          <ConditionEditor
            condition={field.condition}
            editingLocale={editingLocale}
            referenceFields={referenceFields}
            t={t}
            onChange={(condition) => onChange({ ...field, condition })}
          />
        </div>
      </details>
    </article>
  )
}

function ConditionEditor({
  condition,
  editingLocale,
  onChange,
  referenceFields,
  required = false,
  t,
}: {
  condition?: RequestVisibilityCondition
  editingLocale: RequestLocale
  onChange: (condition: RequestVisibilityCondition | undefined) => void
  referenceFields: RequestBuilderField[]
  required?: boolean
  t: ReturnType<typeof createTranslator>
}) {
  const enabled = required || Boolean(condition)

  return (
    <div className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {required ? (
          <span className="text-sm font-semibold text-[var(--workbench-text)]">{t('requests.builder.condition')}</span>
        ) : (
          <label className="flex items-center gap-3 text-sm font-semibold text-[var(--workbench-text)]">
            <input
              checked={enabled}
              className="h-4 w-4 accent-[var(--workbench-primary)]"
              disabled={referenceFields.length === 0}
              onChange={(event) => onChange(event.target.checked
                ? {
                    match: 'all',
                    rules: [{
                      fieldId: referenceFields[0]?.id ?? '',
                      operator: 'equals',
                      value: defaultConditionValue(referenceFields[0]),
                    }],
                  }
                : undefined)}
              type="checkbox"
            />
            {t('requests.builder.conditionEnable')}
          </label>
        )}
        {enabled ? (
          <select
            className="workbench-input min-h-9 px-3 text-sm"
            value={condition?.match ?? 'all'}
            onChange={(event) => onChange({
              match: event.target.value === 'any' ? 'any' : 'all',
              rules: condition?.rules ?? [],
            })}
          >
            <option value="all">{t('requests.builder.conditionAll')}</option>
            <option value="any">{t('requests.builder.conditionAny')}</option>
          </select>
        ) : null}
      </div>
      {condition?.rules.map((rule, index) => {
        const referenceField = referenceFields.find((field) => field.id === rule.fieldId)

        return (
          <div className="grid grid-cols-[1fr_180px_1fr_auto] gap-2 max-[760px]:grid-cols-1" key={`${rule.fieldId}-${index}`}>
            <select
              aria-label={t('requests.builder.conditionField')}
              className="workbench-input min-h-9 px-3"
              value={rule.fieldId}
              onChange={(event) => {
                const nextField = referenceFields.find((field) => field.id === event.target.value)
                onChange({ ...condition, rules: condition.rules.map((candidate, candidateIndex) =>
                  candidateIndex === index
                    ? {
                        ...candidate,
                        fieldId: event.target.value,
                        value: conditionOperatorNeedsValue(candidate.operator)
                          ? defaultConditionValue(nextField)
                          : undefined,
                      }
                    : candidate,
                ) })
              }}
            >
              {referenceFields.map((field) => <option key={field.id} value={field.id}>{field.label[editingLocale] || field.id}</option>)}
            </select>
            <select
              aria-label={t('requests.builder.conditionOperator')}
              className="workbench-input min-h-9 px-3"
              value={rule.operator}
              onChange={(event) => {
                const operator = event.target.value as RequestConditionOperator
                onChange({ ...condition, rules: condition.rules.map((candidate, candidateIndex) =>
                  candidateIndex === index
                    ? {
                        ...candidate,
                        operator,
                        value: conditionOperatorNeedsValue(operator)
                          ? defaultConditionValue(referenceField, candidate.value)
                          : undefined,
                      }
                    : candidate,
                ) })
              }}
            >
              {conditionOperators.map((operator) => <option key={operator} value={operator}>{t(`requests.conditionOperator.${operator}`)}</option>)}
            </select>
            <ConditionValueInput
              editingLocale={editingLocale}
              field={referenceField}
              operator={rule.operator}
              t={t}
              value={rule.value}
              onChange={(value) => onChange({ ...condition, rules: condition.rules.map((candidate, candidateIndex) =>
                candidateIndex === index ? { ...candidate, value } : candidate,
              ) })}
            />
            <button
              aria-label={t('requests.builder.remove')}
              className="workbench-button-secondary min-h-9 px-3"
              disabled={required && condition.rules.length === 1}
              onClick={() => {
                const rules = condition.rules.filter((_, candidateIndex) => candidateIndex !== index)
                onChange(rules.length === 0 ? undefined : { ...condition, rules })
              }}
              type="button"
            >
              ×
            </button>
          </div>
        )
      })}
      {condition ? (
        <button
          className="workbench-button-secondary min-h-9 justify-self-start px-3"
          disabled={referenceFields.length === 0}
          onClick={() => onChange({
            ...condition,
            rules: [
              ...condition.rules,
              {
                fieldId: referenceFields[0]?.id ?? '',
                operator: 'equals',
                value: defaultConditionValue(referenceFields[0]),
              },
            ],
          })}
          type="button"
        >
          + {t('requests.builder.addCondition')}
        </button>
      ) : null}
    </div>
  )
}

function ConditionValueInput({
  editingLocale,
  field,
  onChange,
  operator,
  t,
  value,
}: {
  editingLocale: RequestLocale
  field?: RequestBuilderField
  onChange: (value: string | number | boolean | undefined) => void
  operator: RequestConditionOperator
  t: ReturnType<typeof createTranslator>
  value: RequestVisibilityCondition['rules'][number]['value']
}) {
  const ariaLabel = t('requests.builder.conditionValue')

  if (!conditionOperatorNeedsValue(operator)) {
    return <input aria-label={ariaLabel} className="workbench-input min-h-9 px-3" disabled value="" />
  }

  if (field?.type === 'checkbox') {
    return (
      <select aria-label={ariaLabel} className="workbench-input min-h-9 px-3" value={value === false ? 'false' : 'true'} onChange={(event) => onChange(event.target.value === 'true')}>
        <option value="true">{t('requests.boolean.true')}</option>
        <option value="false">{t('requests.boolean.false')}</option>
      </select>
    )
  }

  if (field?.type === 'select' || field?.type === 'multi-select') {
    return (
      <select aria-label={ariaLabel} className="workbench-input min-h-9 px-3" value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)}>
        <option value="">—</option>
        {field.options.map((option) => (
          <option key={option.id} value={option.id}>{option.label[editingLocale] || option.id}</option>
        ))}
      </select>
    )
  }

  return (
    <input
      aria-label={ariaLabel}
      className="workbench-input min-h-9 px-3"
      type={field?.type === 'number' ? 'number' : 'text'}
      value={typeof value === 'string' || typeof value === 'number' ? value : ''}
      onChange={(event) => onChange(
        field?.type === 'number' && event.target.value !== ''
          ? Number(event.target.value)
          : event.target.value,
      )}
    />
  )
}

function ReorderButtons({
  disableDown,
  disableUp,
  onMove,
  onRemove,
  removeDisabled,
  t,
}: {
  disableDown: boolean
  disableUp: boolean
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
  removeDisabled: boolean
  t: ReturnType<typeof createTranslator>
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <button aria-label={t('requests.builder.moveUp')} className="workbench-button-secondary h-9 w-9" disabled={disableUp} onClick={() => onMove(-1)} type="button">↑</button>
      <button aria-label={t('requests.builder.moveDown')} className="workbench-button-secondary h-9 w-9" disabled={disableDown} onClick={() => onMove(1)} type="button">↓</button>
      <button aria-label={t('requests.builder.remove')} className="workbench-button-secondary h-9 w-9" disabled={removeDisabled} onClick={onRemove} type="button">×</button>
    </div>
  )
}

function NumberValidationInput({
  label,
  onChange,
  value,
}: {
  label: string
  onChange: (value: number | undefined) => void
  value?: number
}) {
  return (
    <BuilderLabel label={label}>
      <input
        className="workbench-input min-h-10 px-3"
        type="number"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : undefined)}
      />
    </BuilderLabel>
  )
}

function BuilderLabel({
  children,
  label,
  span = '',
}: {
  children: ReactNode
  label: string
  span?: string
}) {
  return (
    <label className={`grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)] ${span}`}>
      {label}
      {children}
    </label>
  )
}

function updateLocalized(
  text: RequestLocalizedText,
  locale: RequestLocale,
  value: string,
): RequestLocalizedText {
  return { ...text, [locale]: value }
}

function conditionOperatorNeedsValue(operator: RequestConditionOperator) {
  return operator !== 'is-empty' && operator !== 'is-not-empty'
}

function defaultConditionValue(
  field: RequestBuilderField | undefined,
  currentValue?: RequestVisibilityCondition['rules'][number]['value'],
): string | number | boolean {
  if (field?.type === 'checkbox') {
    return typeof currentValue === 'boolean' ? currentValue : true
  }
  if (field?.type === 'number') {
    return typeof currentValue === 'number' ? currentValue : 0
  }
  if (field?.type === 'select' || field?.type === 'multi-select') {
    return typeof currentValue === 'string' && field.options.some((option) => option.id === currentValue)
      ? currentValue
      : field.options[0]?.id ?? ''
  }
  return typeof currentValue === 'string' ? currentValue : ''
}

function copyRoutingTarget(target: RequestRoutingTargetDraft): RequestRoutingTargetDraft {
  return {
    assigneeUserId: target.assigneeUserId,
    dueDateOffsetDays: target.dueDateOffsetDays,
    priority: target.priority,
    projectId: target.projectId,
    teamId: target.teamId,
    workItemTypeId: target.workItemTypeId,
    workflowStatusId: target.workflowStatusId,
  }
}

/** Resolves the workflow status options for one Request routing target. */
function resolveRoutingWorkflowStatuses(
  target: Pick<RequestRoutingTargetDraft, 'workItemTypeId'>,
  configuration: WorkItemConfiguration | undefined,
  fallback: readonly WorkflowStatusDefinition[] = [],
): readonly WorkflowStatusDefinition[] {
  return resolveWorkItemTypeWorkflow(configuration, target.workItemTypeId)?.statuses ?? fallback
}

function moveItem<T>(items: T[], index: number, direction: -1 | 1) {
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= items.length) return items

  const nextItems = [...items]
  const [item] = nextItems.splice(index, 1)
  if (item === undefined) return items
  nextItems.splice(targetIndex, 0, item)
  return nextItems
}

function createUniqueId(prefix: string, existingIds: string[]) {
  const existing = new Set(existingIds)
  let index = existingIds.length + 1
  let candidate = `${prefix}-${index}`

  while (existing.has(candidate)) {
    index += 1
    candidate = `${prefix}-${index}`
  }

  return candidate
}

function parseCommaList(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function readNumberInput(value: string, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function toLocalDateTimeValue(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return offsetDate.toISOString().slice(0, 16)
}

function toIsoDateTime(value: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
  }
}

function runBuilderAction(action: (() => void | Promise<void>) | undefined) {
  if (!action) return
  void Promise.resolve().then(action).catch(() => undefined)
}
