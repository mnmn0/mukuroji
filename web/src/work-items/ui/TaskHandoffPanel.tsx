import { useId, useRef, useState } from 'react'
import { useDocumentBacklinks } from '../../documents/queries/useDocumentQueries'
import { useTeamAgentSettings } from '../../features/agent-settings/queries/useTeamAgentSettings'
import { CopyIcon } from '../../shared/ui/icons'
import { splitAgentRuns } from '../model/agentRunDisplay'
import {
  createTaskHandoffBrief,
  type TaskHandoffAgentRuns,
  type TaskHandoffDocuments,
  type TaskHandoffInput,
  type TaskHandoffLoadState,
} from '../model/taskHandoff'
import { useWorkItemAgentRuns } from '../queries/useWorkItemAgentRuns'
import type { AgentReadySettings } from '../model/agentReadyTransition'
import { AgentReadyAction } from './AgentReadyAction'

/** Inputs for the saved-task handoff disclosure. */
export type TaskHandoffPanelProps = Omit<TaskHandoffInput, 'agentRuns' | 'documents'> & {
  /** Session access token used to read Agent Runs and linked Documents; without it the brief says they were not read. */
  accessToken?: string
  /** Saves a new workflow status for the one-step Ready action; omitted when the viewer cannot edit the task. */
  onMoveToStatus?: (workflowStatusId: string) => Promise<void>
}

/**
 * Builds the load state of supplementary context from an SWR read.
 * @param enabled - Whether the read was requested.
 * @param data - Loaded data, if any.
 * @param error - Read failure, if any.
 * @param select - Converts the loaded data to the brief's value.
 * @returns Load state for the brief.
 */
function toLoadState<Data, Value>(
  enabled: boolean,
  data: Data | undefined,
  error: unknown,
  select: (data: Data) => Value,
): TaskHandoffLoadState<Value> {
  if (data !== undefined) return { status: 'loaded', value: select(data) }
  if (!enabled || error) return { status: 'unavailable' }
  return { status: 'loading' }
}

/**
 * Scopes clipboard feedback and preview state to the exact saved task snapshot.
 * Agent Runs and linked Documents are read with the same requests as their detail panels.
 * @param props - Visible saved task, access token, and localized handoff labels.
 * @returns A revision-keyed preview and copy control with manual clipboard fallback.
 */
export function TaskHandoffPanel({ accessToken, onMoveToStatus, ...props }: TaskHandoffPanelProps) {
  const { task } = props
  const canRead = Boolean(accessToken && task.teamId)
  const runs = useWorkItemAgentRuns(canRead ? accessToken : undefined, task.teamId, task.id)
  const backlinks = useDocumentBacklinks(
    canRead ? accessToken : undefined,
    'work-item',
    `team/${task.teamId}/issue/${task.id}`,
  )
  const agentRuns = toLoadState(canRead, runs.data, runs.error, (data): TaskHandoffAgentRuns => {
    const { active } = splitAgentRuns(data.items)
    return active
      ? { active: { runId: active.runId, agentName: active.agentName, runtime: active.runtime, startedAt: active.startedAt, stalled: active.stalled } }
      : {}
  })
  const documents = toLoadState(canRead, backlinks.data, backlinks.error, (data): TaskHandoffDocuments => ({
    items: uniqueDocuments(data.backlinks),
    hasMore: Boolean(data.nextCursor),
  }))
  const settings = useTeamAgentSettings(canRead ? accessToken : undefined, task.teamId)
  const readySettings = toLoadState(canRead, settings.data, settings.error, (data): AgentReadySettings => data)
  const brief = createTaskHandoffBrief({ ...props, agentRuns, documents })
  // The disclosure stays outside the keyed snapshot so a background run or Document refresh does not close it.
  return (
    <details className="min-w-0 border-y border-[var(--workbench-border)]" data-testid="task-handoff-panel">
      <summary className="min-h-[44px] cursor-pointer py-3 text-sm font-semibold text-[var(--workbench-primary-text)]">
        {props.t('agents.handoff.title')}
      </summary>
      <AgentReadyAction
        configuration={props.configuration}
        activeRun={agentRuns.status === 'loaded' ? { status: 'loaded', value: agentRuns.value.active !== undefined } : agentRuns}
        key={`${task.teamId}:${task.id}`}
        onMoveToStatus={onMoveToStatus}
        settings={readySettings}
        t={props.t}
        task={task}
      />
      <TaskHandoffSnapshot brief={brief} key={brief} revision={task.revision} t={props.t} />
    </details>
  )
}

/**
 * Keeps one entry per Document, since a Document can link the same Work Item more than once.
 * @param backlinks - Backlinks in API order.
 * @returns Documents in first-seen order.
 */
function uniqueDocuments(backlinks: ReadonlyArray<TaskHandoffDocuments['items'][number]>): TaskHandoffDocuments['items'] {
  const documents = new Map<string, string>()
  for (const { documentId, documentTitle } of backlinks) {
    if (!documents.has(documentId)) documents.set(documentId, documentTitle)
  }
  return [...documents].map(([documentId, documentTitle]) => ({ documentId, documentTitle }))
}

/** Inputs for an immutable preview with local clipboard feedback. */
type TaskHandoffSnapshotProps = {
  /** Exact preview content also passed to the clipboard. */
  brief: string
  /** Saved task revision represented by this preview. */
  revision: number
  /** Resolves localized UI labels. */
  t: TaskHandoffInput['t']
}

/**
 * Renders the brief preview and copy controls; selecting or copying the brief never starts work.
 * @param props - Exact saved snapshot and localized labels.
 * @returns An accessible preview, copy action, and selectable fallback.
 */
function TaskHandoffSnapshot({ brief, revision, t }: TaskHandoffSnapshotProps) {
  const previewId = useId()
  const feedbackId = useId()
  const previewRef = useRef<HTMLTextAreaElement>(null)
  const copyPendingRef = useRef(false)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')

  /** Selects the exact visible brief for manual copying. */
  function selectBrief() {
    previewRef.current?.focus()
    previewRef.current?.select()
  }

  /** Copies only the displayed saved snapshot and exposes browser failures. */
  async function copyBrief() {
    if (copyPendingRef.current) return
    copyPendingRef.current = true
    setCopyState('copying')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(brief)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
      selectBrief()
    } finally {
      copyPendingRef.current = false
    }
  }

  return (
    <div className="grid min-w-0 gap-3 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-xs font-semibold text-[var(--workbench-text)]" htmlFor={previewId}>
            {t('agents.handoff.preview')}
          </label>
          <span className="text-xs text-[var(--workbench-muted)]">
            {t('agents.handoff.snapshot').replace('{revision}', String(revision))}
          </span>
        </div>
        <textarea
          aria-describedby={feedbackId}
          className="workbench-input min-h-52 w-full min-w-0 resize-y px-3 py-2 font-mono text-xs leading-6"
          id={previewId}
          readOnly
          ref={previewRef}
          rows={9}
          spellCheck={false}
          value={brief}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="workbench-button-primary inline-flex min-h-[44px] items-center justify-center gap-2 px-3"
            disabled={copyState === 'copying'}
            onClick={() => void copyBrief()}
            type="button"
          >
            <CopyIcon className="size-4 shrink-0 fill-none stroke-current stroke-2" />
            {t(copyState === 'copying' ? 'agents.handoff.copying' : 'agents.handoff.copy')}
          </button>
          <button className="workbench-button-secondary min-h-[44px] px-3" onClick={selectBrief} type="button">
            {t('agents.handoff.select')}
          </button>
        </div>
        <p className="text-xs leading-5 text-[var(--workbench-muted)]" id={feedbackId}>{t('agents.handoff.note')}</p>
        {copyState === 'copied' ? <p className="text-xs font-medium text-[var(--workbench-primary-text)]" role="status">{t('agents.handoff.copied')}</p> : null}
        {copyState === 'failed' ? <p className="text-xs leading-5 text-fg-red-700" role="alert">{t('agents.handoff.copyFailed')}</p> : null}
    </div>
  )
}
