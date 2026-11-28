import type { TeamDecisionLogItem, WorkspaceSearchResult } from '@mukuroji/contracts'
import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import type { ProjectDirectoryTeam } from '../api'
import { useTeamDecisionLog } from '../queries/useProjectDecisionLog'
import { useActiveDirectoryMembers } from '../queries/useProjectMembers'
import { useTeamDecisionNotes } from '../queries/useTeamDecisionNotes'
import { createDecisionDateTimeFormatter } from '../model/projectDecisionMessages'
import { ProjectDecisionCard } from './ProjectDecisionLogPanel'

/** Props of the Team decision log view. */
export type TeamDecisionLogViewProps = {
  /** Cognito access token; nothing loads without it. */
  accessToken?: string
  /** Display locale. */
  locale: Locale
  /** Team whose Projects are listed. */
  team: ProjectDirectoryTeam
}

const inputClassName =
  'h-10 rounded-md border border-tone-d3d8df bg-surface px-3 text-sm font-medium text-fg-1c1d1f outline-none transition focus:border-tone-2563eb focus:ring-4 focus:ring-tone-2563eb/10'

/**
 * Lists decisions and decided change requests across a Team's Projects, newest first, with the
 * decision notes kept on the Team's Work Items.
 *
 * @param props - Session, locale, and Team.
 * @returns The view.
 */
export function TeamDecisionLogView({ accessToken, locale, team }: TeamDecisionLogViewProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [projectId, setProjectId] = useState('')
  const projects = useMemo(() => team.projects ?? [], [team.projects])
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects])
  const log = useTeamDecisionLog(accessToken, team.id, { keyword, projectId }, true)
  const teams = useMemo(() => [team], [team])
  // Team-qualified lookups resolve a Project ID that several Teams share.
  const members = useActiveDirectoryMembers(accessToken, teams, projects.length > 0)
  const memberNames = useMemo(
    () => new Map((members.data?.members ?? []).map((member) => [member.id, member.name || member.email])),
    [members.data],
  )
  const notes = useTeamDecisionNotes(accessToken, team.id, { keyword, projectId })
  const formatDateTime = useMemo(() => createDecisionDateTimeFormatter(locale), [locale])

  /**
   * Applies the typed keyword.
   *
   * @param event - Form submission.
   */
  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setKeyword(keywordInput.trim())
  }

  return (
    <div className="grid gap-5" data-testid="team-decision-log">
      <form className="flex flex-wrap items-end gap-3" role="search" onSubmit={handleSearch}>
        <label className="grid gap-1.5 text-sm font-semibold text-fg-505967">
          {t('projects.decisionLog.team.search')}
          <input
            className={inputClassName}
            data-testid="team-decision-log-keyword"
            maxLength={100}
            type="search"
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-semibold text-fg-505967">
          {t('projects.decisionLog.team.project')}
          <select
            className={inputClassName}
            data-testid="team-decision-log-project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">{t('projects.decisionLog.team.allProjects')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
      </form>

      <section aria-labelledby="team-decision-log-title" className="grid gap-3">
        <h2 className="text-base font-semibold text-fg-1c1d1f" id="team-decision-log-title">{t('projects.decisionLog.team.title')}</h2>
        {log.error ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('projects.decisionLog.error.loading')}</p>
            <button className="workbench-button-secondary min-h-10 px-4" type="button" onClick={() => void log.mutate()}>
              {t('projects.decisionLog.reload')}
            </button>
          </div>
        ) : null}
        {log.isLoading && !log.data ? (
          <p className="text-sm font-medium text-fg-505967" role="status">{t('projects.decisionLog.loading')}</p>
        ) : null}
        {log.data && log.data.items.length === 0 ? (
          <p className="text-sm font-medium text-fg-505967">{t('projects.decisionLog.team.empty')}</p>
        ) : null}
        {log.data && log.data.items.length > 0 ? (
          <ul className="grid gap-2">
            {log.data.items.map((item) => (
              <TeamDecisionLogRow
                formatDateTime={formatDateTime}
                item={item}
                key={`${item.kind}:${item.projectId}:${item.entry.id}`}
                memberLabel={(id) => memberNames.get(id) ?? id}
                projectName={projectNames.get(item.projectId) ?? item.projectId}
                t={t}
              />
            ))}
          </ul>
        ) : null}
        {log.data?.truncated ? (
          <p className="text-sm font-medium text-fg-505967" role="status">{t('projects.decisionLog.team.truncated')}</p>
        ) : null}
      </section>

      <section aria-labelledby="team-decision-notes-title" className="grid gap-3">
        <div>
          <h2 className="text-base font-semibold text-fg-1c1d1f" id="team-decision-notes-title">{t('projects.decisionLog.team.memos.title')}</h2>
          <p className="mt-1 text-sm font-medium text-fg-505967">{t('projects.decisionLog.team.memos.description')}</p>
        </div>
        {notes.error ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('projects.decisionLog.team.memos.error')}</p>
            <button className="workbench-button-secondary min-h-10 px-4" type="button" onClick={() => void notes.mutate()}>
              {t('projects.decisionLog.reload')}
            </button>
          </div>
        ) : null}
        {notes.isLoading && !notes.data ? (
          <p className="text-sm font-medium text-fg-505967" role="status">{t('projects.decisionLog.loading')}</p>
        ) : null}
        {notes.data && notes.data.notes.length === 0 ? (
          <p className="text-sm font-medium text-fg-505967">{t('projects.decisionLog.team.memos.empty')}</p>
        ) : null}
        {notes.data && notes.data.notes.length > 0 ? (
          <ul className="grid gap-2" data-testid="team-decision-notes">
            {notes.data.notes.map((note) => (
              <DecisionNoteRow formatDateTime={formatDateTime} key={note.id} note={note} projectNames={projectNames} />
            ))}
          </ul>
        ) : null}
        {notes.data?.truncated ? (
          <p className="text-sm font-medium text-fg-505967" role="status">{t('projects.decisionLog.team.memos.truncated')}</p>
        ) : null}
      </section>
    </div>
  )
}

/** Props of one Team log row. */
type TeamDecisionLogRowProps = {
  /** The decision or decided change request. */
  item: TeamDecisionLogItem
  /** Name of the item's Project. */
  projectName: string
  /** Names members by member key. */
  memberLabel: (memberId: string) => string
  /** Formats a timestamp. */
  formatDateTime: (value: string) => string
  /** Translator. */
  t: (key: MessageKey) => string
}

/**
 * Renders one decision, or one approved or rejected change request, of the Team log.
 *
 * @param props - Item and label helpers.
 * @returns The list item.
 */
function TeamDecisionLogRow({ item, projectName, memberLabel, formatDateTime, t }: TeamDecisionLogRowProps) {
  if (item.kind === 'decision') {
    return (
      <ProjectDecisionCard
        entry={item.entry}
        formatDateTime={formatDateTime}
        memberLabel={memberLabel}
        projectName={projectName}
        t={t}
        workItemLabel={(id) => id}
      />
    )
  }
  const { entry } = item
  const outcome = entry.decision?.outcome === 'approved'
    ? t('projects.decisionLog.team.changeRequest.approved')
    : t('projects.decisionLog.team.changeRequest.rejected')
  return (
    <li className="grid gap-2 rounded-md border border-tone-d3d8df p-3" data-testid="team-decision-change-request">
      <p className="text-sm font-semibold text-fg-1c1d1f">{entry.title}</p>
      <p className="text-xs font-medium text-fg-505967">
        {[
          projectName,
          `${t('projects.decisionLog.team.changeRequest')}: ${outcome}`,
          t('projects.decisionLog.decidedOn').replace('{date}', formatDateTime(item.decidedAt)),
          entry.decision ? t('projects.decisionLog.decidersLabel').replace('{names}', memberLabel(entry.decision.decidedByMemberId)) : '',
        ].filter(Boolean).join(' · ')}
      </p>
      {entry.response ? <p className="whitespace-pre-wrap text-sm font-medium text-fg-1c1d1f">{entry.response}</p> : null}
    </li>
  )
}

/** Props of one decision note row. */
type DecisionNoteRowProps = {
  /** Search result of the note. */
  note: WorkspaceSearchResult
  /** Project names by ID. */
  projectNames: ReadonlyMap<string, string>
  /** Formats a timestamp. */
  formatDateTime: (value: string) => string
}

/**
 * Renders one decision note kept on a Work Item, linking to it.
 *
 * @param props - Note and helpers.
 * @returns The list item.
 */
function DecisionNoteRow({ note, projectNames, formatDateTime }: DecisionNoteRowProps) {
  const details = [
    note.projectId ? projectNames.get(note.projectId) ?? note.projectId : undefined,
    note.updatedAt ? formatDateTime(note.updatedAt) : undefined,
  ].filter(Boolean).join(' · ')
  return (
    <li className="grid gap-1 rounded-md border border-tone-d3d8df p-3">
      {/* Search returns application-relative URLs, so the link stays inside the app. */}
      <Link className="text-sm font-semibold text-[var(--workbench-primary-text)] underline-offset-2 hover:underline" to={note.url}>
        {note.title}
      </Link>
      {details ? <p className="text-xs font-medium text-fg-505967">{details}</p> : null}
      {note.body ? <p className="line-clamp-3 whitespace-pre-wrap text-sm font-medium text-fg-505967">{note.body}</p> : null}
    </li>
  )
}
