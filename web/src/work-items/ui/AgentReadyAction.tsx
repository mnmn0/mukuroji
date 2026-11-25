import { useState, type ReactNode } from 'react'
import type { CanonicalWorkItem, WorkItemConfiguration } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { TaskHandoffLoadState } from '../model/taskHandoff'
import {
  resolveAgentReadyTransition,
  type AgentReadyBlockReason,
  type AgentReadySettings,
} from '../model/agentReadyTransition'

/** Inputs for the agent candidate state and its one-step Ready action. */
export type AgentReadyActionProps = {
  /** Saved Work Item snapshot. */
  task: CanonicalWorkItem
  /** Work Item configuration that defines the workflow of the Work Item Type. */
  configuration?: WorkItemConfiguration
  /** Read state of the Team Agent settings. */
  settings: TaskHandoffLoadState<AgentReadySettings>
  /** Read state of whether an Agent Run claims the Work Item. */
  activeRun: TaskHandoffLoadState<boolean>
  /** Saves the new workflow status; omitted when the viewer cannot edit the Work Item. */
  onMoveToStatus?: (workflowStatusId: string) => Promise<void>
  /** Resolves localized UI labels. */
  t: (key: MessageKey) => string
}

const blockReasonKeys: Record<AgentReadyBlockReason, MessageKey> = {
  closed: 'agents.handoff.ready.blocked.closed',
  started: 'agents.handoff.ready.blocked.started',
  activeRun: 'agents.handoff.ready.blocked.activeRun',
  noAcceptanceCriteria: 'agents.handoff.ready.blocked.noAcceptanceCriteria',
  noTransition: 'agents.handoff.ready.blocked.noTransition',
}

/**
 * Shows whether agents can start the Work Item and offers one action that moves it to the first
 * reachable Ready status of the Team Agent settings. The server still checks the workflow and revision.
 * @param props - Saved task, settings read state, Agent Run state, and the status save callback.
 * @returns The candidate state, its reasons, and the action when it applies.
 */
export function AgentReadyAction({ task, configuration, settings, activeRun, onMoveToStatus, t }: AgentReadyActionProps) {
  const [moveState, setMoveState] = useState<
    { status: 'idle' | 'moving' | 'failed' } | { status: 'moved'; statusId: string; statusName: string }
  >({ status: 'idle' })
  if (settings.status !== 'loaded' || activeRun.status !== 'loaded') {
    const loading = settings.status !== 'unavailable' && activeRun.status !== 'unavailable'
    return (
      <AgentReadySection t={t}>
        <p className="text-xs text-[var(--workbench-muted)]">{t(loading ? 'agents.handoff.ready.loading' : 'agents.handoff.ready.unavailable')}</p>
      </AgentReadySection>
    )
  }
  const transition = resolveAgentReadyTransition({ task, settings: settings.value, configuration, hasActiveRun: activeRun.value })
  const blockedByCount = task.relationIds.filter((relationId) => relationId.startsWith('blockedBy:')).length

  /**
   * Saves the target status once and reports the result next to the action. Some screens report a
   * failed update themselves without rejecting, so success is shown only once the saved Work Item
   * has the target status.
   * @param statusId - Target workflow status ID.
   * @param statusName - Target status name shown after the save.
   */
  async function move(statusId: string, statusName: string) {
    if (!onMoveToStatus || moveState.status === 'moving') return
    setMoveState({ status: 'moving' })
    try {
      await onMoveToStatus(statusId)
      setMoveState({ status: 'moved', statusId, statusName })
    } catch {
      setMoveState({ status: 'failed' })
    }
  }

  return (
    <AgentReadySection t={t}>
      {transition.kind === 'alreadyReady' ? (
        <p className="text-xs leading-5 text-[var(--workbench-text)]">{t('agents.handoff.ready.already')}</p>
      ) : null}
      {transition.kind === 'canMove' ? (
        <div className="grid gap-2">
          <p className="text-xs leading-5 text-[var(--workbench-text)]">{t('agents.handoff.ready.canMove').replace('{status}', transition.status.name)}</p>
          {onMoveToStatus ? (
            <div>
              <button
                className="workbench-button-secondary min-h-[44px] px-3"
                data-testid="agent-ready-action"
                disabled={moveState.status === 'moving'}
                onClick={() => void move(transition.status.id, transition.status.name)}
                type="button"
              >
                {t(moveState.status === 'moving' ? 'agents.handoff.ready.moving' : 'agents.handoff.ready.action')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {transition.kind === 'blocked' ? (
        <div className="grid gap-1">
          <p className="text-xs leading-5 text-[var(--workbench-text)]">{t('agents.handoff.ready.blocked')}</p>
          <ul className="list-disc pl-5 text-xs leading-5 text-[var(--workbench-muted)]">
            {transition.reasons.map((reason) => <li key={reason}>{t(blockReasonKeys[reason])}</li>)}
          </ul>
        </div>
      ) : null}
      {blockedByCount > 0 && transition.kind !== 'blocked' ? (
        <p className="text-xs leading-5 text-[var(--workbench-muted)]">{t('agents.handoff.ready.blockedByNote').replace('{count}', String(blockedByCount))}</p>
      ) : null}
      {moveState.status === 'moved' && task.workflowStatusId === moveState.statusId ? (
        <p className="text-xs font-medium text-[var(--workbench-primary-text)]" role="status">{t('agents.handoff.ready.moved').replace('{status}', moveState.statusName)}</p>
      ) : null}
      {moveState.status === 'failed' ? (
        <p className="text-xs leading-5 text-fg-red-700" role="alert">{t('agents.handoff.ready.failed')}</p>
      ) : null}
    </AgentReadySection>
  )
}

/** Inputs for the titled candidate section. */
type AgentReadySectionProps = {
  /** Section content. */
  children: ReactNode
  /** Resolves localized UI labels. */
  t: (key: MessageKey) => string
}

/**
 * Wraps the candidate state in a labelled group.
 * @param props - Child content and translator.
 * @returns A titled section.
 */
function AgentReadySection({ children, t }: AgentReadySectionProps) {
  return (
    <section aria-label={t('agents.handoff.ready.title')} className="grid gap-2 border-b border-[var(--workbench-border)] pb-3" data-testid="agent-ready-state">
      <h3 className="text-xs font-semibold text-[var(--workbench-text)]">{t('agents.handoff.ready.title')}</h3>
      {children}
    </section>
  )
}
