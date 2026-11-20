import { useId, useState } from 'react'
import type { DocumentKind, DocumentScope } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { DocumentSummary } from '../api'
import {
  builtInDocumentTemplateKeys,
  parseTemplateParticipants,
  type BuiltInDocumentTemplateKey,
  type BuiltInTemplateCreateOptions,
} from '../model/builtInTemplates'
import type { MarkdownImportErrorCode } from '../model/markdownImport'
import type { MarkdownDocumentImportRequest } from '../mutations/useMarkdownDocumentImport'
import { MarkdownImportSection } from './MarkdownImportSection'

/**
 * Documents home の props です。
 */
export type DocumentHomeProps = {
  /**
   * Home section を構成する Document 一覧です。
   */
  documents: DocumentSummary[]
  /**
   * Project space label に使う directory です。
   */
  teams: ProjectDirectoryTeam[]
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Document を選択する callback です。
   */
  onSelectDocument: (documentId: string) => void
  /**
   * Blank node を作成する callback です。
   */
  onCreateDocument?: (kind: DocumentKind, scope: DocumentScope) => void
  /**
   * Template を instantiate する callback です。
   */
  onInstantiateTemplate?: (templateId: string) => void
  /**
   * Creates a page from a template bundled with every Workspace.
   */
  onCreateFromBuiltInTemplate?: (
    key: BuiltInDocumentTemplateKey,
    options: BuiltInTemplateCreateOptions,
  ) => void
  /**
   * Whether a page is being created from a bundled template.
   */
  isCreatingFromBuiltInTemplate?: boolean
  /**
   * Creates a page from pasted or uploaded Markdown and resolves with why the
   * Markdown cannot become a page, if it cannot.
   */
  onImportMarkdown?: (
    request: MarkdownDocumentImportRequest,
  ) => Promise<MarkdownImportErrorCode | undefined>
  /**
   * Whether a page is being created from Markdown.
   */
  isImportingMarkdown?: boolean
}

/**
 * Documents の favorite、recent、template、Project space を一覧する home です。
 */
export function DocumentHome({
  documents,
  isCreatingFromBuiltInTemplate = false,
  isImportingMarkdown = false,
  onCreateDocument,
  onCreateFromBuiltInTemplate,
  onImportMarkdown,
  onInstantiateTemplate,
  onSelectDocument,
  t,
  teams,
}: DocumentHomeProps) {
  const activeDocuments = documents.filter((document) => !document.archivedAt)
  const favorites = activeDocuments
    .filter((document) => document.favorite && document.kind !== 'folder')
    .slice(0, 6)
  const recent = [...activeDocuments]
    .filter(
      (document) => document.lastOpenedAt && document.kind !== 'folder',
    )
    .sort((left, right) =>
      (right.lastOpenedAt ?? '').localeCompare(left.lastOpenedAt ?? ''),
    )
    .slice(0, 6)
  const templates = activeDocuments
    .filter((document) => document.kind === 'template')
    .slice(0, 6)
  const projectSpaces = deduplicateProjectSpaces(teams).map((project) => ({
    ...project,
    documentCount: activeDocuments.filter(
      (document) =>
        document.scope.type === 'project' &&
        document.scope.projectId === project.id,
    ).length,
  }))

  return (
    <div className="mx-auto grid w-full max-w-[1180px] gap-9 px-[clamp(20px,4vw,48px)] py-9">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="workbench-eyebrow">{t('documents.home.eyebrow')}</p>
          <h1 className="workbench-title mt-3 text-page-title">
            {t('documents.home.title')}
          </h1>
          <p className="workbench-description mt-2 max-w-[700px]">
            {t('documents.home.description')}
          </p>
        </div>
        {onCreateDocument ? (
          <div className="flex flex-wrap gap-2">
            <button
              className="workbench-button-secondary min-h-10 px-4"
              onClick={() =>
                onCreateDocument('whiteboard', { type: 'workspace' })
              }
              type="button"
            >
              {t('documents.action.newWhiteboard')}
            </button>
            <button
              className="workbench-button-primary min-h-10 px-4"
              onClick={() => onCreateDocument('page', { type: 'workspace' })}
              type="button"
            >
              {t('documents.action.newPage')}
            </button>
          </div>
        ) : null}
      </header>

      <DocumentCardSection
        documents={favorites}
        emptyMessage={t('documents.home.favoritesEmpty')}
        title={t('documents.home.favorites')}
        onSelectDocument={onSelectDocument}
      />

      <DocumentCardSection
        documents={recent}
        emptyMessage={t('documents.home.recentEmpty')}
        title={t('documents.home.recent')}
        onSelectDocument={onSelectDocument}
      />

      {onCreateFromBuiltInTemplate ? (
        <BuiltInTemplateSection
          isCreating={isCreatingFromBuiltInTemplate}
          projects={projectSpaces}
          t={t}
          onCreate={onCreateFromBuiltInTemplate}
        />
      ) : null}

      {onImportMarkdown ? (
        <MarkdownImportSection
          isImporting={isImportingMarkdown}
          projects={projectSpaces}
          t={t}
          onImport={onImportMarkdown}
        />
      ) : null}

      <section>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="m-0 text-base font-semibold text-[var(--workbench-text)]">
            {t('documents.home.templates')}
          </h2>
          <span className="workbench-badge">{templates.length}</span>
        </div>
        {templates.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
            {templates.map((template) => (
              <button
                className="workbench-panel group min-h-[138px] p-5 text-left transition hover:border-tone-99d7cf hover:shadow-[0_8px_24px_rgba(23,32,29,0.08)]"
                key={template.id}
                onClick={() =>
                  onInstantiateTemplate
                    ? onInstantiateTemplate(template.id)
                    : onSelectDocument(template.id)
                }
                type="button"
              >
                <span className="text-2xl" aria-hidden="true">
                  ◇
                </span>
                <strong className="mt-4 block text-sm text-[var(--workbench-text)] group-hover:text-[var(--workbench-primary-text)]">
                  {template.title}
                </strong>
                <span className="mt-1 block text-xs font-medium text-[var(--workbench-muted)]">
                  {onInstantiateTemplate
                    ? t('documents.home.useTemplate')
                    : t('documents.home.openTemplate')}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <EmptySection message={t('documents.home.templatesEmpty')} />
        )}
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="m-0 text-base font-semibold text-[var(--workbench-text)]">
            {t('documents.home.projectSpaces')}
          </h2>
          <span className="workbench-badge">{projectSpaces.length}</span>
        </div>
        {projectSpaces.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
            {projectSpaces.map((project) => (
              <article className="workbench-panel p-5" key={project.id}>
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="grid h-9 w-9 place-items-center rounded-lg bg-tone-e5f7f4 font-bold text-[var(--workbench-primary-text)]"
                  >
                    ▦
                  </span>
                  <div className="min-w-0">
                    <h3 className="m-0 truncate text-sm font-semibold text-[var(--workbench-text)]">
                      {project.name}
                    </h3>
                    <p className="m-0 mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                      {t('documents.home.documentCount').replace(
                        '{count}',
                        String(project.documentCount),
                      )}
                    </p>
                  </div>
                </div>
                {onCreateDocument ? (
                  <button
                    className="workbench-button-secondary mt-5 min-h-9 w-full px-3"
                    onClick={() =>
                      onCreateDocument('page', {
                        projectId: project.id,
                        type: 'project',
                      })
                    }
                    type="button"
                  >
                    {t('documents.home.createInProject')}
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <EmptySection message={t('documents.home.projectSpacesEmpty')} />
        )}
      </section>
    </div>
  )
}

function DocumentCardSection({
  documents,
  emptyMessage,
  onSelectDocument,
  title,
}: {
  /**
   * Section に表示する Document 一覧です。
   */
  documents: DocumentSummary[]
  /**
   * Document がない場合の message です。
   */
  emptyMessage: string
  /**
   * Document 選択 callback です。
   */
  onSelectDocument: (documentId: string) => void
  /**
   * Section title です。
   */
  title: string
}) {
  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="m-0 text-base font-semibold text-[var(--workbench-text)]">
          {title}
        </h2>
        <span className="workbench-badge">{documents.length}</span>
      </div>
      {documents.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,235px),1fr))] gap-3">
          {documents.map((document) => (
            <button
              className="workbench-panel group min-h-[120px] p-5 text-left transition hover:border-tone-99d7cf hover:shadow-[0_8px_24px_rgba(23,32,29,0.08)]"
              key={document.id}
              onClick={() => onSelectDocument(document.id)}
              type="button"
            >
              <span className="text-xl" aria-hidden="true">
                {document.kind === 'whiteboard' ? '⌘' : '▤'}
              </span>
              <strong className="mt-3 block truncate text-sm text-[var(--workbench-text)] group-hover:text-[var(--workbench-primary-text)]">
                {document.title}
              </strong>
              <time className="mt-1 block text-xs font-medium text-[var(--workbench-muted)]">
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: 'medium',
                }).format(new Date(document.updatedAt))}
              </time>
            </button>
          ))}
        </div>
      ) : (
        <EmptySection message={emptyMessage} />
      )}
    </section>
  )
}

/**
 * Lists the templates bundled with every Workspace and the values substituted into them.
 *
 * @param props - Projects to choose from, translator, and create callback.
 * @returns The bundled template section.
 */
function BuiltInTemplateSection({
  isCreating,
  onCreate,
  projects,
  t,
}: {
  /** Whether a page is being created, which disables the template buttons. */
  isCreating: boolean
  /** Creates a page from the chosen bundled template. */
  onCreate: (
    key: BuiltInDocumentTemplateKey,
    options: BuiltInTemplateCreateOptions,
  ) => void
  /** Projects the new page can belong to. */
  projects: { id: string; name: string }[]
  /** Resolves display text. */
  t: (key: MessageKey) => string
}) {
  const [projectId, setProjectId] = useState('')
  const [participants, setParticipants] = useState('')
  const fieldId = useId()
  const project = projects.find((candidate) => candidate.id === projectId)

  return (
    <section aria-labelledby={`${fieldId}-title`}>
      <div className="mb-4">
        <h2
          className="m-0 text-base font-semibold text-[var(--workbench-text)]"
          id={`${fieldId}-title`}
        >
          {t('documents.home.builtInTemplates')}
        </h2>
        <p className="m-0 mt-1 text-xs font-medium text-[var(--workbench-muted)]">
          {t('documents.home.builtInTemplatesDescription')}
        </p>
      </div>
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('documents.home.builtInTemplateProject')}
          <select
            className="workbench-input min-h-10 px-3"
            onChange={(event) => setProjectId(event.target.value)}
            value={projectId}
          >
            <option value="">{t('documents.home.builtInTemplateNoProject')}</option>
            {projects.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('documents.home.builtInTemplateParticipants')}
          <input
            className="workbench-input min-h-10 px-3"
            onChange={(event) => setParticipants(event.target.value)}
            placeholder={t('documents.home.builtInTemplateParticipantsPlaceholder')}
            value={participants}
          />
        </label>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3">
        {builtInDocumentTemplateKeys.map((key) => (
          <button
            className="workbench-panel group min-h-[110px] p-5 text-left transition hover:border-tone-99d7cf hover:shadow-[0_8px_24px_rgba(23,32,29,0.08)] disabled:cursor-wait disabled:opacity-60"
            disabled={isCreating}
            key={key}
            onClick={() =>
              onCreate(key, {
                participants: parseTemplateParticipants(participants),
                ...(project
                  ? { projectId: project.id, projectName: project.name }
                  : {}),
              })
            }
            type="button"
          >
            <strong className="block text-sm text-[var(--workbench-text)] group-hover:text-[var(--workbench-primary-text)]">
              {t(`documents.builtInTemplate.${key}`)}
            </strong>
            <span className="mt-1 block text-xs font-medium text-[var(--workbench-muted)]">
              {t('documents.home.useTemplate')}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

function EmptySection({ message }: { message: string }) {
  return (
    <div className="workbench-panel-muted px-5 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
      {message}
    </div>
  )
}

function deduplicateProjectSpaces(teams: readonly ProjectDirectoryTeam[]) {
  const projects = new Map<string, { id: string; name: string }>()

  for (const team of teams) {
    for (const project of team.projects) {
      if (!projects.has(project.id)) {
        projects.set(project.id, { id: project.id, name: project.name })
      }
    }
  }

  return [...projects.values()]
}
