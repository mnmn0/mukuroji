import { useId, useState } from 'react'
import { Link } from 'react-router'
import type { FocusQueueResponse, ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../../../projects/api/directory'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { createFocusPath, workspaceNavPaths } from '../../../shared/routing/paths'
import { ChevronIcon } from '../../../shared/ui/icons'
import type { CanonicalWorkItem } from '../../../tasks/api'
import { isOpenableWorkspaceTask, resolveWorkspaceTaskConfiguration } from '../../../work-items/model/workspaceWorkItems'
import { resolveWorkItemAssignee, resolveWorkItemTitle, resolveWorkItemWorkflowStatusLabel } from '../../../work-items/model/workItemDisplay'
import { collaborationStages, createCollaborationQueue, filterCollaborationQueue, type CollaborationStage } from '../model/collaborationQueue'
import { getFocusActionabilityMessageKey, getFocusSignalMessageKey } from '../model/focusQueue'

/** Read-only workspace queue inputs. */
export type CollaborationQueueProps = {
  /** Authorized Focus snapshot; never a synthetic agent session list. */
  response?: FocusQueueResponse
  /** Whether no safe Focus data is available after a load failure. */
  unavailable?: boolean
  /** Opens the current task detail and its handoff action. */
  onOpenTask?: (task: CanonicalWorkItem) => void
  /** Readable Team and Project directory. */
  teams: readonly ProjectDirectoryTeam[]
  /** Team-qualified workflow labels. */
  configurations: Readonly<Record<string, ResolvedWorkItemConfiguration>>
  /** Current workspace translator. */
  t: (key: MessageKey) => string
}

const stageStyles: Record<CollaborationStage, string> = {
  attention: 'bg-amber-50 text-amber-900',
  active: 'bg-sky-50 text-sky-800',
  ready: 'bg-teal-50 text-teal-800',
  waiting: 'bg-slate-100 text-slate-700',
}

/**
 * Renders searchable work and decision queues shared by human and agent workflows.
 * @param props - Existing Focus evidence, directory and task navigation.
 * @returns An accessible queue with explicit empty and unavailable states.
 */
export function CollaborationQueue({ response, unavailable = false, onOpenTask, teams, configurations, t }: CollaborationQueueProps) {
  const titleId = useId()
  const [stage, setStage] = useState<CollaborationStage | 'all'>('all')
  const [teamId, setTeamId] = useState('')
  const [query, setQuery] = useState('')
  const entries = createCollaborationQueue(unavailable ? undefined : response)
  const scoped = filterCollaborationQueue(entries, { stage: 'all', teamId, query }, teams)
  const visible = scoped.filter((entry) => stage === 'all' || entry.stage === stage)
  const hasFilters = stage !== 'all' || Boolean(teamId || query)
  const firstSection = response?.sections.find((group) => group.section === 'now' && group.items.length > 0) ? 'now' :
    response?.sections.find((group) => group.section === 'next' && group.items.length > 0) ? 'next' : 'now'

  return (
    <section aria-labelledby={titleId} className="min-w-0 overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
      <header className="flex flex-wrap items-center justify-between gap-4 px-5 py-5">
        <div>
          <h2 className="text-base font-semibold text-[var(--workbench-text)]" id={titleId}>{t('workspace.collaboration.title')}</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--workbench-muted)]">{t('workspace.collaboration.scope')}</p>
        </div>
        <Link className="workbench-button-primary inline-flex min-h-[44px] items-center gap-2 px-3.5 no-underline" data-testid="workspace-home-focus-now" to={`${workspaceNavPaths.focus}?section=${firstSection}`}>
          {t('workspace.home.openFocus')}<ChevronIcon className="size-4 -rotate-90 fill-none stroke-current stroke-2" />
        </Link>
      </header>

      <div className="flex flex-wrap items-center gap-3 border-y border-[var(--workbench-border)] px-5 py-3">
        <label className="flex min-h-[44px] min-w-0 flex-[1_1_240px] items-center gap-2 rounded-md border border-[var(--workbench-border)] px-3">
          <span className="sr-only">{t('workspace.collaboration.search')}</span>
          <input className="min-w-0 flex-1 bg-transparent py-2 text-sm" onChange={(event) => setQuery(event.target.value)} placeholder={t('workspace.collaboration.search')} type="search" value={query} />
        </label>
        <label className="min-w-0 max-[600px]:w-full">
          <span className="sr-only">{t('workspace.collaboration.team')}</span>
          <select className="min-h-[44px] w-full max-w-full rounded-md border border-[var(--workbench-border)] bg-white px-3 text-sm" onChange={(event) => setTeamId(event.target.value)} value={teamId}>
            <option value="">{t('workspace.collaboration.allTeams')}</option>
            {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
        </label>
      </div>

      <div aria-label={t('workspace.collaboration.filter')} className="flex flex-wrap gap-1 border-b border-[var(--workbench-border)] px-3 py-2" role="group">
        {(['all', ...collaborationStages] satisfies Array<CollaborationStage | 'all'>).map((value) => (
          <button aria-pressed={stage === value} className={`inline-flex min-h-[44px] items-center gap-2 rounded-md px-3 text-sm font-medium ${stage === value ? 'bg-teal-50 text-teal-800' : 'text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'}`} key={value} onClick={() => setStage(value)} type="button">
            {t(`workspace.collaboration.stage.${value}`)}
            <span className="text-xs tabular-nums">{unavailable ? '—' : value === 'all' ? scoped.length : scoped.filter((entry) => entry.stage === value).length}</span>
          </button>
        ))}
      </div>

      {unavailable ? <p className="px-5 py-10 text-sm text-[var(--workbench-muted)]" data-testid="workspace-focus-preview-unavailable">{t('workspace.focus.previewUnavailable')}</p> : (
        <>
          <p className="sr-only" role="status">{t('workspace.collaboration.results').replace('{count}', String(visible.length))}</p>
          {visible.length === 0 ? <div className="grid gap-3 px-5 py-10 text-sm text-[var(--workbench-muted)]">
            <p>{t(hasFilters ? 'workspace.collaboration.noMatches' : 'workspace.collaboration.empty')}</p>
            {hasFilters ? <button className="workbench-button-secondary min-h-[44px] w-fit px-3" onClick={() => { setStage('all'); setTeamId(''); setQuery('') }} type="button">{t('workspace.collaboration.reset')}</button> : null}
          </div> : <ul className="divide-y divide-[var(--workbench-border)]">
            {visible.map(({ item, stage: itemStage }) => {
              const task = item.workItem
              const team = teams.find((candidate) => candidate.id === task.teamId)
              const project = team?.projects.find((candidate) => candidate.id === task.assignedProjectId)
              const reasons = item.actionability.reasons.length ? item.actionability.reasons.map((reason) => t(getFocusActionabilityMessageKey(reason))) :
                item.signals.filter((signal) => signal.resolution.status === 'open').map((signal) => t(getFocusSignalMessageKey(signal.type)))
              const attentionSignal = item.signals.find((signal) => signal.resolution.status === 'open' && ['approval', 'review-request', 'mention'].includes(signal.type))
              return <li className="flex min-w-0 flex-wrap items-center gap-3 px-5 py-4 hover:bg-[var(--workbench-surface-muted)]" key={JSON.stringify([task.teamId, task.id])}>
                <div className="min-w-0 flex-[1_1_300px]">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className={`rounded px-2 py-1 font-medium ${stageStyles[itemStage]}`}>{t(`workspace.collaboration.stage.${itemStage}`)}</span>
                    <span className="break-all text-[var(--workbench-muted)]">{task.id}</span>
                    <span className="text-[var(--workbench-muted)]">{team?.name ?? task.teamId}{project ? ` / ${project.name}` : ''}</span>
                  </div>
                  <button className="min-h-[32px] max-w-full break-words text-left text-sm font-semibold leading-6 text-[var(--workbench-text)] underline-offset-4 enabled:hover:underline disabled:cursor-default" disabled={!onOpenTask || !isOpenableWorkspaceTask(task)} onClick={() => onOpenTask?.(task)} type="button">{resolveWorkItemTitle(task)}</button>
                  <p className="mt-1 break-words text-xs leading-6 text-[var(--workbench-muted)]">{resolveWorkItemAssignee(task)} · {resolveWorkItemWorkflowStatusLabel(task, resolveWorkspaceTaskConfiguration(task, configurations))}{task.dueDate ? ` · ${t('workspace.collaboration.due')} ${task.dueDate}` : ''}</p>
                  {reasons.length ? <p className="mt-1 break-words text-xs leading-5 text-[var(--workbench-muted)]">{[...new Set(reasons)].join(' · ')}</p> : null}
                </div>
                <Link className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-md px-3 text-sm font-medium text-[var(--workbench-primary)] no-underline hover:bg-teal-50" to={createFocusPath(task.teamId, task.id, itemStage === 'attention' ? attentionSignal?.source.eventId : undefined)}>
                  {t(itemStage === 'attention' ? 'workspace.collaboration.review' : 'workspace.collaboration.details')}<ChevronIcon className="size-4 -rotate-90 fill-none stroke-current stroke-2" />
                </Link>
              </li>
            })}
          </ul>}
        </>
      )}
      <footer className="flex flex-wrap gap-x-6 gap-y-1 border-t border-[var(--workbench-border)] px-5 py-2 text-xs font-medium text-[var(--workbench-primary)]">
        <Link className="inline-flex min-h-[44px] items-center underline-offset-4 hover:underline" data-testid="workspace-home-my-tasks" to={workspaceNavPaths['my-tasks']}>{t('workspace.home.openMyTasks')}</Link>
        <Link className="inline-flex min-h-[44px] items-center underline-offset-4 hover:underline" data-testid="workspace-home-focus-waiting" to={`${workspaceNavPaths.focus}?section=waiting`}>{t('workspace.home.openFocusWaiting')}</Link>
      </footer>
    </section>
  )
}
