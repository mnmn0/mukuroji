import type { ProjectDecisionEntry, ProjectDecisionEntryInput } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  isAdrSourceUrl,
  toProjectDecisionEntryInput,
  toProjectDecisionFormValues,
  type ProjectDecisionFormValues,
} from '../model/projectDecisionForm'
import { decisionStatusMessageKey, describeProjectDecisionSaveError } from '../model/projectDecisionMessages'
import { ProjectDecisionForm, type ProjectDecisionReferenceOption } from './ProjectDecisionForm'

/** Props of one decision shown in a list. */
export type ProjectDecisionCardProps = {
  /** The decision. */
  entry: ProjectDecisionEntry
  /** Names members by member key. */
  memberLabel: (memberId: string) => string
  /** Names Work Items by ID. */
  workItemLabel: (workItemId: string) => string
  /** Names the decision replacing this one. */
  replacementLabel?: (entryId: string) => string
  /** Formats a timestamp for the viewer. */
  formatDateTime: (value: string) => string
  /** Project name, shown in the Team log. */
  projectName?: string
  /** Translator. */
  t: (key: MessageKey) => string
  /** Opens the editor, when the viewer may edit. */
  onEdit?: () => void
}

/**
 * Renders one decision: what, why, who, when, status, related Work Items, and sources.
 *
 * @param props - Decision and label helpers.
 * @returns The list item.
 */
export function ProjectDecisionCard({
  entry,
  memberLabel,
  workItemLabel,
  replacementLabel,
  formatDateTime,
  projectName,
  t,
  onEdit,
}: ProjectDecisionCardProps) {
  const deciders = [
    ...(entry.deciderMemberIds ?? []).map(memberLabel),
    ...(entry.deciderNote ? [entry.deciderNote] : []),
  ]
  return (
    <li className="grid gap-2 rounded-md border border-tone-d3d8df p-3" data-testid="project-decision-entry">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-fg-1c1d1f">{entry.title}</p>
          <p className="text-xs font-medium text-fg-505967">
            {[
              projectName,
              t('projects.decisionLog.decidedOn').replace('{date}', formatDateTime(entry.decidedAt)),
              t(decisionStatusMessageKey(entry.status)),
            ].filter(Boolean).join(' · ')}
          </p>
        </div>
        {onEdit ? (
          <button className="workbench-button-secondary min-h-9 px-3" data-testid="project-decision-edit" type="button" onClick={onEdit}>
            {t('projects.decisionLog.edit')}
          </button>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap text-sm font-medium text-fg-1c1d1f">{entry.content}</p>
      {entry.rationale ? (
        <p className="whitespace-pre-wrap text-sm font-medium text-fg-505967">
          <span className="font-semibold">{t('projects.decisionLog.field.rationale')}: </span>
          {entry.rationale}
        </p>
      ) : null}
      {deciders.length > 0 ? (
        <p className="text-xs font-medium text-fg-505967">
          {t('projects.decisionLog.decidersLabel').replace('{names}', deciders.join(', '))}
        </p>
      ) : null}
      {entry.relatedWorkItemIds && entry.relatedWorkItemIds.length > 0 ? (
        <p className="text-xs font-medium text-fg-505967">
          {t('projects.decisionLog.relatedLabel').replace('{items}', entry.relatedWorkItemIds.map(workItemLabel).join(', '))}
        </p>
      ) : null}
      {entry.status === 'superseded' && entry.supersededByEntryId && replacementLabel ? (
        <p className="text-xs font-medium text-fg-505967">
          {t('projects.decisionLog.supersededByLabel').replace('{title}', replacementLabel(entry.supersededByEntryId))}
        </p>
      ) : null}
      {entry.sources && entry.sources.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {entry.sources.map((source) => (
            <li key={source.url}>
              <a
                className="text-xs font-semibold text-[var(--workbench-primary-text)] underline-offset-2 hover:underline"
                href={source.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                {isAdrSourceUrl(source.url) ? `${t('projects.decisionLog.sources.adr')}: ` : ''}
                {source.label ?? source.url}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/** Props of the Project decision log panel. */
export type ProjectDecisionLogPanelProps = {
  /** Decisions, newest decision first; absent while loading. */
  entries?: readonly ProjectDecisionEntry[]
  /** Whether the first load is still running. */
  isLoading: boolean
  /** Whether the last load failed. */
  hasLoadError: boolean
  /** Whether the viewer may record and edit decisions. */
  canEdit: boolean
  /** Project members who may be named as deciders. */
  memberOptions: readonly ProjectDecisionReferenceOption[]
  /** Work Items of the Project that may be named as related. */
  workItemOptions?: readonly ProjectDecisionReferenceOption[]
  /** Formats a timestamp for the viewer. */
  formatDateTime: (value: string) => string
  /** Translator. */
  t: (key: MessageKey) => string
  /**
   * Records a new decision or saves a change.
   *
   * @param entry - Decision being changed, or `undefined` for a new one.
   * @param input - Values to save.
   */
  onSave: (entry: ProjectDecisionEntry | undefined, input: ProjectDecisionEntryInput) => Promise<unknown>
  /** Loads the log again. */
  onReload: () => void
}

/** Open editor of the panel. */
type EditorState =
  | { mode: 'closed' }
  | { mode: 'create'; values: ProjectDecisionFormValues }
  | { mode: 'edit'; entry: ProjectDecisionEntry; values: ProjectDecisionFormValues }

/**
 * Renders a Project's decision log with its editor.
 *
 * @param props - Decisions, options, and handlers.
 * @returns The panel.
 */
export function ProjectDecisionLogPanel({
  entries,
  isLoading,
  hasLoadError,
  canEdit,
  memberOptions,
  workItemOptions,
  formatDateTime,
  t,
  onSave,
  onReload,
}: ProjectDecisionLogPanelProps) {
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [showInactive, setShowInactive] = useState(false)
  const titles = useMemo(() => new Map((entries ?? []).map((entry) => [entry.id, entry.title])), [entries])
  const visible = (entries ?? []).filter((entry) => showInactive || entry.status === 'active')
  const editingId = editor.mode === 'edit' ? editor.entry.id : undefined
  const replacementOptions = (entries ?? [])
    .filter((entry) => entry.id !== editingId)
    .map((entry) => ({ id: entry.id, label: entry.title }))
  const memberLabel = (id: string) => memberOptions.find((option) => option.id === id)?.label ?? id
  const workItemLabel = (id: string) => workItemOptions?.find((option) => option.id === id)?.label ?? id

  /** Saves the open editor. */
  async function handleSubmit() {
    if (editor.mode === 'closed' || isSaving) return
    setIsSaving(true)
    setSaveError(undefined)
    const base = editor.mode === 'edit' ? (entries?.find((entry) => entry.id === editor.entry.id) ?? editor.entry) : undefined
    try {
      await onSave(base, toProjectDecisionEntryInput(editor.values, base?.origin ?? 'project'))
      setEditor({ mode: 'closed' })
    } catch (error) {
      setSaveError(describeProjectDecisionSaveError(error, t))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section
      aria-labelledby="project-decision-log-title"
      className="grid content-start gap-4 rounded-md border border-tone-d3d8df bg-surface p-4"
      data-testid="project-decision-log"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg-1c1d1f" id="project-decision-log-title">{t('projects.decisionLog.title')}</h2>
          <p className="mt-1 text-sm font-medium text-fg-505967">{t('projects.decisionLog.description')}</p>
        </div>
        {canEdit && editor.mode === 'closed' && entries ? (
          <button
            className="workbench-button-primary min-h-10 px-4"
            data-testid="project-decision-log-add"
            type="button"
            onClick={() => {
              setSaveError(undefined)
              setEditor({ mode: 'create', values: toProjectDecisionFormValues(undefined) })
            }}
          >
            {t('projects.decisionLog.add')}
          </button>
        ) : null}
      </div>

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('projects.decisionLog.error.loading')}</p>
          <button className="workbench-button-secondary min-h-10 px-4" type="button" onClick={onReload}>
            {t('projects.decisionLog.reload')}
          </button>
        </div>
      ) : null}
      {isLoading && !entries ? (
        <p className="text-sm font-medium text-fg-505967" role="status">{t('projects.decisionLog.loading')}</p>
      ) : null}

      {editor.mode !== 'closed' ? (
        <ProjectDecisionForm
          isSaving={isSaving}
          memberOptions={memberOptions}
          replacementOptions={replacementOptions}
          saveError={saveError}
          t={t}
          values={editor.values}
          workItemOptions={workItemOptions}
          onCancel={() => setEditor({ mode: 'closed' })}
          onChange={(values) => setEditor((current) => current.mode === 'closed' ? current : { ...current, values })}
          onSubmit={() => void handleSubmit()}
        />
      ) : null}

      {entries ? (
        <>
          <label className="flex w-fit items-center gap-2 text-sm font-medium text-fg-505967">
            <input checked={showInactive} type="checkbox" onChange={(event) => setShowInactive(event.target.checked)} />
            {t('projects.decisionLog.showInactive')}
          </label>
          {visible.length === 0 ? (
            <p className="text-sm font-medium text-fg-505967">{t('projects.decisionLog.empty')}</p>
          ) : (
            <ul aria-label={t('projects.decisionLog.title')} className="grid gap-2">
              {visible.map((entry) => (
                <ProjectDecisionCard
                  entry={entry}
                  formatDateTime={formatDateTime}
                  key={entry.id}
                  memberLabel={memberLabel}
                  replacementLabel={(id) => titles.get(id) ?? id}
                  t={t}
                  workItemLabel={workItemLabel}
                  {...(canEdit && editor.mode === 'closed'
                    ? {
                        onEdit: () => {
                          setSaveError(undefined)
                          setEditor({ mode: 'edit', entry, values: toProjectDecisionFormValues(entry) })
                        },
                      }
                    : {})}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  )
}
