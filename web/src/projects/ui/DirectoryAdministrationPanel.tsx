import { useMemo, useState, type FormEvent } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import {
  DIRECTORY_PROJECT_TONES,
  isDirectoryProjectTone,
  type DirectoryAdministrationTeam,
  type DirectoryProjectTone,
} from '@mukuroji/contracts'
import { createMutationRequestContext } from '../../shared/api/mutationHeaders'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { SectionHeader } from '../../shared/ui/WorkbenchPrimitives'
import {
  getDirectoryAdministration,
  renameDirectoryProject,
  renameDirectoryTeam,
  reorderDirectoryProjects,
  reorderDirectoryTeams,
  restoreDirectoryProject,
  restoreDirectoryTeam,
} from '../api/directoryAdministration'
import { ProjectDirectoryApiError } from '../api/errors'
import {
  listActiveDirectoryTeams,
  listArchivedDirectoryEntries,
  moveDirectoryId,
  type DirectoryMoveDirection,
} from '../model/directoryAdministration'
import { isProjectDirectoryKey } from '../queries/useProjectDirectory'

/** Props of the directory administration container. */
type DirectoryAdministrationPanelContainerProps = {
  /** Bearer token of the Workspace administrator. */
  accessToken: string
  /** Locale of labels. */
  locale: Locale
}

/**
 * Loads every Team and Project and connects rename, restore, and reorder to the API.
 *
 * @param props - Authenticated settings inputs.
 * @returns The directory administration panel.
 */
export function DirectoryAdministrationPanelContainer({
  accessToken,
  locale,
}: DirectoryAdministrationPanelContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const { mutate: mutateGlobal } = useSWRConfig()
  const query = useSWR(
    ['directory-administration', accessToken] as const,
    ([, token]) => getDirectoryAdministration(token),
    { shouldRetryOnError: false },
  )
  const [pendingKey, setPendingKey] = useState<string>()
  const [errorMessage, setErrorMessage] = useState<string>()

  /** Runs one mutation, then refreshes this panel and the sidebar directory. */
  const runAction = async (key: string, action: () => Promise<void>) => {
    if (pendingKey) return false
    setPendingKey(key)
    setErrorMessage(undefined)
    try {
      await action()
      await Promise.all([query.mutate(), mutateGlobal(isProjectDirectoryKey)])
      return true
    } catch (error) {
      setErrorMessage(
        error instanceof ProjectDirectoryApiError && error.status === 409
          ? t('projects.administration.error.conflict')
          : t('projects.administration.error.action'),
      )
      await query.mutate()
      return false
    } finally {
      setPendingKey(undefined)
    }
  }

  if (query.isLoading) {
    return (
      <section className="workbench-panel p-5" data-testid="directory-administration-loading">
        {t('projects.administration.loading')}
      </section>
    )
  }

  if (query.error || !query.data) {
    return (
      <section className="workbench-panel p-5" data-testid="directory-administration-error">
        <SectionHeader
          meta={t('projects.administration.loadError')}
          title={t('projects.administration.title')}
        />
        <button
          className="workbench-button-secondary mt-4 min-h-10 px-4"
          onClick={() => void query.mutate()}
          type="button"
        >
          {t('projects.administration.retry')}
        </button>
      </section>
    )
  }

  return (
    <DirectoryAdministrationPanel
      errorMessage={errorMessage}
      pendingKey={pendingKey}
      t={t}
      teams={query.data}
      onMoveProject={(teamId, projectIds) => runAction(
        `project-order:${teamId}`,
        () => reorderDirectoryProjects(accessToken, teamId, projectIds, createMutationRequestContext()),
      )}
      onMoveTeam={(teamIds) => runAction(
        'team-order',
        () => reorderDirectoryTeams(accessToken, teamIds, createMutationRequestContext()),
      )}
      onRenameProject={(teamId, projectId, input) => runAction(
        `project:${teamId}:${projectId}`,
        () => renameDirectoryProject(
          accessToken,
          teamId,
          projectId,
          input,
          createMutationRequestContext(),
        ),
      )}
      onRenameTeam={(teamId, input) => runAction(
        `team:${teamId}`,
        () => renameDirectoryTeam(accessToken, teamId, input, createMutationRequestContext()),
      )}
      onRestoreProject={(teamId, projectId) => runAction(
        `project:${teamId}:${projectId}`,
        () => restoreDirectoryProject(accessToken, teamId, projectId, createMutationRequestContext()),
      )}
      onRestoreTeam={(teamId) => runAction(
        `team:${teamId}`,
        () => restoreDirectoryTeam(accessToken, teamId, createMutationRequestContext()),
      )}
    />
  )
}

/** Names and color edited in a rename form. */
type DirectoryNameDraft = {
  /** Japanese display name. */
  nameJa: string
  /** English display name. */
  nameEn: string
  /** Project color, for a Project. */
  tone?: DirectoryProjectTone
}

/** Props of the directory administration panel. */
export type DirectoryAdministrationPanelProps = {
  /** Every Team in display order, archived ones included. */
  teams: readonly DirectoryAdministrationTeam[]
  /** Key of the row whose change is in flight. */
  pendingKey?: string
  /** Message of the last failed change. */
  errorMessage?: string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Renames a Team; resolves to whether it succeeded. */
  onRenameTeam: (teamId: string, input: { nameJa: string; nameEn: string }) => Promise<boolean>
  /** Renames a Project; resolves to whether it succeeded. */
  onRenameProject: (
    teamId: string,
    projectId: string,
    input: { nameJa: string; nameEn: string; tone: DirectoryProjectTone },
  ) => Promise<boolean>
  /** Stores a new order of every active Team. */
  onMoveTeam: (teamIds: string[]) => Promise<boolean>
  /** Stores a new order of every active Project of a Team. */
  onMoveProject: (teamId: string, projectIds: string[]) => Promise<boolean>
  /** Restores an archived Team. */
  onRestoreTeam: (teamId: string) => Promise<boolean>
  /** Restores an archived Project. */
  onRestoreProject: (teamId: string, projectId: string) => Promise<boolean>
}

/**
 * Lets a Workspace administrator rename, reorder, and restore Teams and Projects.
 *
 * @param props - Directory rows and actions.
 * @returns The administration panel.
 */
export function DirectoryAdministrationPanel({
  teams,
  pendingKey,
  errorMessage,
  t,
  onRenameTeam,
  onRenameProject,
  onMoveTeam,
  onMoveProject,
  onRestoreTeam,
  onRestoreProject,
}: DirectoryAdministrationPanelProps) {
  const activeTeams = listActiveDirectoryTeams(teams)
  const archivedEntries = listArchivedDirectoryEntries(teams)
  const activeTeamIds = activeTeams.map((team) => team.id)
  const [editingKey, setEditingKey] = useState<string>()
  const [draft, setDraft] = useState<DirectoryNameDraft>({ nameJa: '', nameEn: '' })
  const isBusy = pendingKey !== undefined

  /** Opens the rename form of one row with its current values. */
  const startEditing = (key: string, value: DirectoryNameDraft) => {
    setEditingKey(key)
    setDraft(value)
  }

  /** Submits the open rename form. */
  const submitRename = async (
    event: FormEvent<HTMLFormElement>,
    teamId: string,
    projectId?: string,
  ) => {
    event.preventDefault()
    const input = { nameJa: draft.nameJa.trim(), nameEn: draft.nameEn.trim() }
    if (!input.nameJa) return
    const succeeded = projectId === undefined
      ? await onRenameTeam(teamId, input)
      : await onRenameProject(teamId, projectId, { ...input, tone: draft.tone ?? 'blue' })
    if (succeeded) setEditingKey(undefined)
  }

  /** Renders the rename form for the row being edited. */
  const renderRenameForm = (teamId: string, projectId?: string) => (
    <form
      className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
      data-testid="directory-administration-rename-form"
      onSubmit={(event) => void submitRename(event, teamId, projectId)}
    >
      <label className="grid gap-1 text-xs font-semibold">
        {t('projects.administration.nameJa')}
        <input
          className="workbench-input min-h-10 px-3 text-sm font-normal"
          maxLength={500}
          onChange={(event) => setDraft({ ...draft, nameJa: event.target.value })}
          required
          value={draft.nameJa}
        />
      </label>
      <label className="grid gap-1 text-xs font-semibold">
        {t('projects.administration.nameEn')}
        <input
          className="workbench-input min-h-10 px-3 text-sm font-normal"
          maxLength={500}
          onChange={(event) => setDraft({ ...draft, nameEn: event.target.value })}
          value={draft.nameEn}
        />
      </label>
      {projectId !== undefined ? (
        <label className="grid gap-1 text-xs font-semibold">
          {t('workspace.registration.tone')}
          <select
            className="workbench-input min-h-10 px-3 text-sm font-normal"
            onChange={(event) => {
              const tone = event.target.value
              if (isDirectoryProjectTone(tone)) setDraft({ ...draft, tone })
            }}
            value={draft.tone ?? 'blue'}
          >
            {DIRECTORY_PROJECT_TONES.map((tone) => (
              <option key={tone} value={tone}>{t(`workspace.registration.tone.${tone}`)}</option>
            ))}
          </select>
        </label>
      ) : (
        <span aria-hidden="true" />
      )}
      <div className="flex gap-2">
        <button
          className="workbench-button-primary min-h-10 px-4"
          disabled={isBusy || !draft.nameJa.trim()}
          type="submit"
        >
          {t('projects.administration.save')}
        </button>
        <button
          className="workbench-button-secondary min-h-10 px-4"
          onClick={() => setEditingKey(undefined)}
          type="button"
        >
          {t('projects.administration.cancel')}
        </button>
      </div>
    </form>
  )

  /** Renders the move and rename buttons of one row. */
  const renderRowActions = (input: {
    name: string
    canMoveUp: boolean
    canMoveDown: boolean
    onMove: (direction: DirectoryMoveDirection) => void
    onEdit: () => void
  }) => (
    <div className="flex flex-none gap-1">
      <button
        aria-label={t('projects.administration.moveUp').replace('{name}', input.name)}
        className="workbench-button-secondary min-h-9 min-w-9 px-2"
        disabled={isBusy || !input.canMoveUp}
        onClick={() => input.onMove('up')}
        type="button"
      >
        ↑
      </button>
      <button
        aria-label={t('projects.administration.moveDown').replace('{name}', input.name)}
        className="workbench-button-secondary min-h-9 min-w-9 px-2"
        disabled={isBusy || !input.canMoveDown}
        onClick={() => input.onMove('down')}
        type="button"
      >
        ↓
      </button>
      <button
        aria-label={t('projects.administration.rename').replace('{name}', input.name)}
        className="workbench-button-secondary min-h-9 px-3"
        disabled={isBusy}
        onClick={input.onEdit}
        type="button"
      >
        {t('projects.administration.renameShort')}
      </button>
    </div>
  )

  return (
    <section className="workbench-panel" data-testid="directory-administration-panel">
      <SectionHeader
        meta={t('projects.administration.description')}
        title={t('projects.administration.title')}
      />
      <div className="grid gap-4 px-5 pb-5">
        {errorMessage ? (
          <p
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-fg-red-700"
            role="alert"
          >
            {errorMessage}
          </p>
        ) : null}
        {activeTeams.length === 0 ? (
          <p className="text-sm text-[var(--workbench-muted)]">{t('projects.administration.empty')}</p>
        ) : (
          <ol className="grid gap-3">
            {activeTeams.map((team, teamIndex) => {
              const teamKey = `team:${team.id}`
              const projectIds = team.projects.map((project) => project.id)
              return (
                <li
                  className="rounded-lg border border-[var(--workbench-border)] p-3"
                  data-testid="directory-administration-team"
                  key={team.id}
                >
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{team.nameJa}</p>
                      <p className="truncate text-xs text-[var(--workbench-muted)]">
                        {team.nameEn} · {team.id}
                      </p>
                    </div>
                    {renderRowActions({
                      name: team.nameJa,
                      canMoveUp: teamIndex > 0,
                      canMoveDown: teamIndex < activeTeams.length - 1,
                      onMove: (direction) => {
                        const next = moveDirectoryId(activeTeamIds, team.id, direction)
                        if (next) void onMoveTeam(next)
                      },
                      onEdit: () => startEditing(teamKey, { nameJa: team.nameJa, nameEn: team.nameEn }),
                    })}
                  </div>
                  {editingKey === teamKey ? renderRenameForm(team.id) : null}
                  {team.projects.length > 0 ? (
                    <ol className="mt-3 grid gap-2 border-l border-[var(--workbench-border)] pl-3">
                      {team.projects.map((project, projectIndex) => {
                        const projectKey = `project:${team.id}:${project.id}`
                        return (
                          <li data-testid="directory-administration-project" key={project.id}>
                            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-sm">{project.nameJa}</p>
                                <p className="truncate text-xs text-[var(--workbench-muted)]">
                                  {project.nameEn} · {project.id} · {t(`workspace.registration.tone.${project.tone}`)}
                                </p>
                              </div>
                              {renderRowActions({
                                name: project.nameJa,
                                canMoveUp: projectIndex > 0,
                                canMoveDown: projectIndex < team.projects.length - 1,
                                onMove: (direction) => {
                                  const next = moveDirectoryId(projectIds, project.id, direction)
                                  if (next) void onMoveProject(team.id, next)
                                },
                                onEdit: () => startEditing(projectKey, {
                                  nameJa: project.nameJa,
                                  nameEn: project.nameEn,
                                  tone: project.tone,
                                }),
                              })}
                            </div>
                            {editingKey === projectKey ? renderRenameForm(team.id, project.id) : null}
                          </li>
                        )
                      })}
                    </ol>
                  ) : null}
                </li>
              )
            })}
          </ol>
        )}
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold">{t('projects.administration.archived')}</h3>
          {archivedEntries.length === 0 ? (
            <p className="text-sm text-[var(--workbench-muted)]">
              {t('projects.administration.archivedEmpty')}
            </p>
          ) : (
            <ul className="grid gap-2">
              {archivedEntries.map((entry) => {
                const name = entry.kind === 'team' ? entry.team.nameJa : entry.project.nameJa
                const key = entry.kind === 'team'
                  ? `team:${entry.team.id}`
                  : `project:${entry.team.id}:${entry.project.id}`
                return (
                  <li
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--workbench-border)] px-3 py-2"
                    data-testid="directory-administration-archived"
                    key={key}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm">{name}</p>
                      <p className="truncate text-xs text-[var(--workbench-muted)]">
                        {entry.kind === 'team'
                          ? t('projects.administration.archivedTeam')
                          : t('projects.administration.archivedProject').replace(
                            '{team}',
                            entry.team.nameJa,
                          )}
                      </p>
                    </div>
                    <button
                      aria-label={t('projects.administration.restore').replace('{name}', name)}
                      className="workbench-button-secondary min-h-9 px-3"
                      disabled={isBusy}
                      onClick={() => void (entry.kind === 'team'
                        ? onRestoreTeam(entry.team.id)
                        : onRestoreProject(entry.team.id, entry.project.id))}
                      type="button"
                    >
                      {pendingKey === key
                        ? t('projects.administration.restoring')
                        : t('projects.administration.restoreShort')}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
