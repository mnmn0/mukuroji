import { useState } from 'react'
import type { DocumentRelationTarget } from '@mukuroji/contracts'
import { useProjectDirectory } from '../../projects/queries/useProjectDirectory'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import {
  createDocumentRelationTargetKey,
  parseDocumentLinkTargetQuery,
  toDocumentLinkTargetOptions,
  type DocumentLinkTargetKind,
  type DocumentLinkTargetOption,
} from '../model/linkTargets'
import { useDocumentLinkSearch } from '../queries/useDocumentLinkSearch'
import { useLinkedWorkItem } from '../queries/useLinkedWorkItem'

/**
 * Props for the relation target picker shown on a Document.
 */
export type DocumentRelationTargetPickerProps = {
  /** Workspace API token used for search; omission leaves only ID entry. */
  accessToken?: string
  /** Keys of targets this Document already links to. */
  linkedTargetKeys?: ReadonlySet<string>
  /** Saves the chosen target as a relation. */
  onSelect: (target: DocumentRelationTarget) => Promise<void>
  /** Target kinds the editor may choose; defaults to every kind. */
  kinds?: readonly DocumentLinkTargetKind[]
  /** Focuses the search input when the picker opens. */
  autoFocus?: boolean
  /** Translates UI text. */
  t: (key: MessageKey) => string
}

/** Every relation target kind, in picker order. */
const allLinkTargetKinds: readonly DocumentLinkTargetKind[] = [
  'work-item',
  'project',
  'goal',
]

/**
 * Lets an editor find a Work Item, Project, or Goal by name and link it.
 *
 * Work Items and Projects come from permission-filtered Workspace search, so
 * targets the editor cannot see are never offered. A canonical ID can still be
 * entered for targets that search does not index, such as Goals.
 */
export function DocumentRelationTargetPicker({
  accessToken,
  autoFocus = false,
  kinds = allLinkTargetKinds,
  linkedTargetKeys,
  onSelect,
  t,
}: DocumentRelationTargetPickerProps) {
  const [kind, setKind] = useState<DocumentLinkTargetKind>(
    kinds[0] ?? 'work-item',
  )
  const [query, setQuery] = useState('')
  const [savingKey, setSavingKey] = useState<string>()
  const [hasSaveError, setHasSaveError] = useState(false)
  const search = useDocumentLinkSearch(
    accessToken,
    kind === 'goal' ? undefined : kind,
    query,
  )
  const options = toDocumentLinkTargetOptions(kind, search.results)
  const idTarget = parseDocumentLinkTargetQuery(kind, query)
  const idTargetKey = idTarget
    ? createDocumentRelationTargetKey(idTarget)
    : undefined
  const showIdOption =
    idTarget !== undefined &&
    !options.some(
      (option) =>
        createDocumentRelationTargetKey(option.target) === idTargetKey,
    )

  /**
   * Saves one target and clears the query once it is linked.
   *
   * @param target - Relation target chosen by the editor.
   */
  const select = async (target: DocumentRelationTarget) => {
    if (savingKey) return
    const targetKey = createDocumentRelationTargetKey(target)
    setSavingKey(targetKey)
    setHasSaveError(false)
    try {
      await onSelect(target)
      setQuery('')
    } catch {
      setHasSaveError(true)
    } finally {
      setSavingKey(undefined)
    }
  }

  /**
   * Renders one selectable candidate row.
   *
   * @param option - Candidate to render.
   * @returns The candidate button.
   */
  const renderOption = (option: DocumentLinkTargetOption) => {
    const targetKey = createDocumentRelationTargetKey(option.target)
    const isLinked = linkedTargetKeys?.has(targetKey) ?? false
    return (
      <li key={targetKey}>
        <button
          className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-tone-f2fbf9 disabled:cursor-default disabled:opacity-60"
          disabled={Boolean(savingKey) || isLinked}
          onClick={() => void select(option.target)}
          type="button"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-[var(--workbench-text)]">
              {option.title}
            </span>
            {option.subtitle ? (
              <span className="block truncate text-[11px] text-[var(--workbench-muted)]">
                {option.subtitle}
              </span>
            ) : null}
          </span>
          {option.status ? (
            <span className="flex-none rounded bg-[var(--workbench-surface-muted)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--workbench-muted)]">
              {option.status}
            </span>
          ) : null}
          <span className="flex-none text-[11px] font-semibold text-[var(--workbench-primary-text)]">
            {isLinked
              ? t('documents.links.linked')
              : savingKey === targetKey
                ? t('documents.links.linking')
                : t('documents.backlinks.add')}
          </span>
        </button>
      </li>
    )
  }

  return (
    <div className="grid gap-2 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3">
      <div
        className={
          kinds.length > 1
            ? 'grid grid-cols-[110px_minmax(0,1fr)] gap-2'
            : 'grid gap-2'
        }
      >
        {kinds.length > 1 ? (
        <select
          aria-label={t('documents.backlinks.targetType')}
          className="workbench-input h-10 px-2 text-xs"
          onChange={(event) => {
            setKind(
              event.target.value === 'project'
                ? 'project'
                : event.target.value === 'goal'
                  ? 'goal'
                  : 'work-item',
            )
            setQuery('')
          }}
          value={kind}
        >
          {kinds.map((option) => (
            <option key={option} value={option}>
              {t(`documents.backlinks.${option}`)}
            </option>
          ))}
        </select>
        ) : null}
        <input
          aria-label={
            kind === 'goal'
              ? t('documents.links.goalIdLabel')
              : t('documents.links.searchLabel')
          }
          autoComplete="off"
          autoFocus={autoFocus}
          className="workbench-input h-10 px-3 text-xs"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            kind === 'goal'
              ? t('documents.links.goalIdPlaceholder')
              : t('documents.links.searchPlaceholder')
          }
          type="search"
          value={query}
        />
      </div>
      {search.isLoading ? (
        <p className="m-0 text-[11px] font-medium text-[var(--workbench-muted)]">
          {t('documents.links.searching')}
        </p>
      ) : null}
      {search.hasError ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <p className="m-0 text-[11px] font-semibold text-fg-red-700">
            {t('documents.links.searchError')}
          </p>
          <button
            className="workbench-button-secondary min-h-8 px-2 text-xs"
            onClick={search.retry}
            type="button"
          >
            {t('documents.related.retry')}
          </button>
        </div>
      ) : null}
      {options.length > 0 || showIdOption ? (
        <ul aria-label={t('documents.links.results')} className="m-0 grid list-none gap-1 p-0">
          {options.map(renderOption)}
          {showIdOption && idTarget
            ? renderOption({
                target: idTarget,
                title: query.trim(),
                subtitle: t('documents.links.byId'),
              })
            : null}
        </ul>
      ) : null}
      {query.trim() &&
      kind !== 'goal' &&
      !search.isLoading &&
      !search.hasError &&
      options.length === 0 &&
      !showIdOption ? (
        <p className="m-0 text-[11px] font-medium text-[var(--workbench-muted)]">
          {t('documents.links.noResults')}
        </p>
      ) : null}
      {hasSaveError ? (
        <p className="m-0 text-[11px] font-semibold text-fg-red-700" role="alert">
          {t('documents.links.saveError')}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Props for the label of one linked target.
 */
export type DocumentRelationTargetLabelProps = {
  /** Workspace API token; omission shows only the target kind. */
  accessToken?: string
  /** Locale used to read the Project directory. */
  locale: Locale
  /** Linked target to describe. */
  target: DocumentRelationTarget
  /** Translates UI text. */
  t: (key: MessageKey) => string
}

/**
 * Shows the title, status, and owner of a linked Work Item, or a Project name.
 *
 * Titles are read from the source of truth with the viewer's token, so a target
 * the viewer cannot see is shown as unavailable instead of by name.
 */
export function DocumentRelationTargetLabel({
  accessToken,
  locale,
  target,
  t,
}: DocumentRelationTargetLabelProps) {
  if (target.kind === 'work-item') {
    return (
      <WorkItemTargetLabel
        accessToken={accessToken}
        t={t}
        workItemId={target.workItemId}
      />
    )
  }
  if (target.kind === 'project') {
    return (
      <ProjectTargetLabel
        accessToken={accessToken}
        locale={locale}
        projectId={target.projectId}
        t={t}
      />
    )
  }
  return (
    <TargetLabelText
      subtitle={t('documents.backlinks.goal')}
      title={target.goalId}
    />
  )
}

/**
 * Renders a Work Item link label from the Work Item detail API.
 *
 * @param props - Token, translator, and canonical Work Item ID.
 * @returns The label, or an unavailable notice when the Work Item cannot be read.
 */
function WorkItemTargetLabel({
  accessToken,
  t,
  workItemId,
}: {
  /** Workspace API token. */
  accessToken?: string
  /** Translates UI text. */
  t: (key: MessageKey) => string
  /** Canonical `team/<teamId>/issue/<issueId>` ID. */
  workItemId: string
}) {
  const { issue, isUnavailable } = useLinkedWorkItem(
    accessToken,
    workItemId,
  )
  if (isUnavailable) {
    return (
      <TargetLabelText
        subtitle={t('documents.backlinks.work-item')}
        title={t('documents.links.unavailable')}
      />
    )
  }
  if (!issue) {
    return (
      <TargetLabelText
        subtitle={t('documents.backlinks.work-item')}
        title={t('documents.context.loading')}
      />
    )
  }
  const details = [
    t(`workItems.statusCategory.${issue.statusCategory}`),
    issue.assigneeName,
  ].filter((value): value is string => Boolean(value))
  return (
    <TargetLabelText
      subtitle={[t('documents.backlinks.work-item'), ...details].join(' · ')}
      title={issue.key ? `${issue.key} ${issue.title}` : issue.title}
    />
  )
}

/**
 * Renders a Project link label from the viewer's Project directory.
 *
 * @param props - Token, locale, translator, and Project ID.
 * @returns The Project name, or an unavailable notice when it is not visible.
 */
function ProjectTargetLabel({
  accessToken,
  locale,
  projectId,
  t,
}: {
  /** Workspace API token. */
  accessToken?: string
  /** Locale used to read the Project directory. */
  locale: Locale
  /** Linked Project ID. */
  projectId: string
  /** Translates UI text. */
  t: (key: MessageKey) => string
}) {
  const { data, error } = useProjectDirectory({
    accessToken,
    enabled: Boolean(accessToken),
    locale,
  })
  const project = data
    ?.flatMap((team) => team.projects)
    .find((candidate) => candidate.id === projectId)
  return (
    <TargetLabelText
      subtitle={t('documents.backlinks.project')}
      title={
        project?.name ??
        (data || error
          ? t('documents.links.unavailable')
          : t('documents.context.loading'))
      }
    />
  )
}

/**
 * Renders the two-line text of a link label.
 *
 * @param props - Main title and secondary line.
 * @returns The label text.
 */
function TargetLabelText({
  subtitle,
  title,
}: {
  /** Secondary line, such as the target kind and status. */
  subtitle: string
  /** Main line, such as the Work Item title. */
  title: string
}) {
  return (
    <span className="min-w-0 flex-1">
      <strong className="block truncate text-sm text-[var(--workbench-text)]">
        {title}
      </strong>
      <span className="block truncate text-xs text-[var(--workbench-muted)]">
        {subtitle}
      </span>
    </span>
  )
}

/**
 * A Document offered by the existing-Document picker.
 */
export type LinkableDocumentOption = {
  /** Document ID. */
  documentId: string
  /** Document title. */
  title: string
  /** Secondary line from search, such as the Project name. */
  subtitle?: string
}

/**
 * Props for the existing-Document picker shown on a Work Item, Project, or Goal.
 */
export type LinkableDocumentPickerProps = {
  /** Workspace API token used for search. */
  accessToken: string
  /** IDs of Documents that already link to the target. */
  linkedDocumentIds: ReadonlySet<string>
  /** Links the chosen Document to the target. */
  onSelect: (document: LinkableDocumentOption) => Promise<void>
  /** Translates UI text. */
  t: (key: MessageKey) => string
}

/**
 * Lets a member find an existing Document by title and link it to the target.
 */
export function LinkableDocumentPicker({
  accessToken,
  linkedDocumentIds,
  onSelect,
  t,
}: LinkableDocumentPickerProps) {
  const [query, setQuery] = useState('')
  const [savingId, setSavingId] = useState<string>()
  const [hasSaveError, setHasSaveError] = useState(false)
  const search = useDocumentLinkSearch(accessToken, 'document', query)
  const options = search.results
    .filter((result) => result.entityType === 'document')
    .map((result): LinkableDocumentOption => ({
      documentId: result.id,
      title: result.title,
      ...(result.subtitle ? { subtitle: result.subtitle } : {}),
    }))

  /**
   * Links one Document and clears the query once it is linked.
   *
   * @param option - Document chosen by the member.
   */
  const select = async (option: LinkableDocumentOption) => {
    if (savingId) return
    setSavingId(option.documentId)
    setHasSaveError(false)
    try {
      await onSelect(option)
      setQuery('')
    } catch {
      setHasSaveError(true)
    } finally {
      setSavingId(undefined)
    }
  }

  return (
    <div className="grid gap-2">
      <input
        aria-label={t('documents.links.documentSearchLabel')}
        autoComplete="off"
        className="workbench-input h-10 px-3 text-sm"
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('documents.links.documentSearchPlaceholder')}
        type="search"
        value={query}
      />
      {search.isLoading ? (
        <p className="m-0 text-xs font-medium text-[var(--workbench-muted)]">
          {t('documents.links.searching')}
        </p>
      ) : null}
      {search.hasError ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <p className="m-0 text-xs font-semibold text-fg-red-700">
            {t('documents.links.searchError')}
          </p>
          <button
            className="workbench-button-secondary min-h-8 px-2 text-xs"
            onClick={search.retry}
            type="button"
          >
            {t('documents.related.retry')}
          </button>
        </div>
      ) : null}
      {options.length > 0 ? (
        <ul aria-label={t('documents.links.results')} className="m-0 grid list-none gap-1 p-0">
          {options.map((option) => {
            const isLinked = linkedDocumentIds.has(option.documentId)
            return (
              <li key={option.documentId}>
                <button
                  className="flex min-h-10 w-full items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-surface px-3 py-2 text-left hover:bg-tone-f2fbf9 disabled:cursor-default disabled:opacity-60"
                  disabled={Boolean(savingId) || isLinked}
                  onClick={() => void select(option)}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-[var(--workbench-text)]">
                      {option.title}
                    </span>
                    {option.subtitle ? (
                      <span className="block truncate text-xs text-[var(--workbench-muted)]">
                        {option.subtitle}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex-none text-xs font-semibold text-[var(--workbench-primary-text)]">
                    {isLinked
                      ? t('documents.links.linked')
                      : savingId === option.documentId
                        ? t('documents.links.linking')
                        : t('documents.backlinks.add')}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      {query.trim() &&
      !search.isLoading &&
      !search.hasError &&
      options.length === 0 ? (
        <p className="m-0 text-xs font-medium text-[var(--workbench-muted)]">
          {t('documents.links.noResults')}
        </p>
      ) : null}
      {hasSaveError ? (
        <p className="m-0 text-xs font-semibold text-fg-red-700" role="alert">
          {t('documents.links.saveError')}
        </p>
      ) : null}
    </div>
  )
}
