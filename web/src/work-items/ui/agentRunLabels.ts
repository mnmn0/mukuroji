import type { AgentRunRuntime } from '@mukuroji/contracts'
import type { Locale } from '../../shared/i18n/i18n'
import type { AgentRunDisplayState } from '../model/agentRunDisplay'

/** Locale-aware text of the Agent Run panel. */
export type WorkItemAgentRunsLabels = {
  /** Section heading. */
  title: string
  /** Section description. */
  description: string
  /** Initial loading text. */
  loading: string
  /** Loading failure text. */
  loadError: string
  /** Retry action. */
  retry: string
  /** Empty state text. */
  empty: string
  /** Heading of the finished-run history. */
  history: string
  /** Label of the start time. */
  startedAt: string
  /** Label of the latest activity time. */
  lastActivity: string
  /** Label of the lease expiry time. */
  leaseExpiresAt: string
  /** Label of the finish time. */
  finishedAt: string
  /** Release action. */
  release: string
  /** Release confirmation text. */
  releaseConfirm: string
  /** Release failure text. */
  releaseError: string
  /** Guidance shown for a stalled run. */
  stalledHint: string
  /** Display names of runtimes. */
  runtimes: Record<AgentRunRuntime, string>
  /** Display names of states. */
  states: Record<AgentRunDisplayState, string>
}

/**
 * Creates the Agent Run panel text for a locale.
 *
 * @param locale - Display locale.
 * @returns Panel text.
 */
export function createWorkItemAgentRunsLabels(locale: Locale): WorkItemAgentRunsLabels {
  const runtimes = { 'claude-code': 'Claude Code', codex: 'Codex', kiro: 'Kiro', other: locale === 'ja' ? 'その他' : 'Other' }
  if (locale === 'ja') {
    return {
      title: 'エージェント実行',
      description: 'コーディングエージェントによるこのタスクの担当記録です。同時に担当できるエージェントは 1 つだけです。',
      loading: '実行記録を読み込んでいます。',
      loadError: '実行記録を読み込めませんでした。',
      retry: '再読み込み',
      empty: 'まだエージェントは担当していません。',
      history: '過去の実行',
      startedAt: '開始',
      lastActivity: '最終操作',
      leaseExpiresAt: '期限',
      finishedAt: '終了',
      release: '解放',
      releaseConfirm: 'この実行を解放しますか。エージェントは以後このタスクを更新できなくなります。',
      releaseError: '実行を解放できませんでした。権限と最新の状態を確認してください。',
      stalledHint: '期限内に操作がありません。エージェントの状況を確認し、必要なら解放してください。',
      runtimes,
      states: {
        running: '処理中',
        stalled: '停滞',
        completed: '完了',
        paused: '中断',
        failed: '失敗',
        released: '解放済み',
        superseded: '引き継ぎ済み',
      },
    }
  }
  return {
    title: 'Agent runs',
    description: 'Coding agents that claimed this task. Only one agent can hold it at a time.',
    loading: 'Loading agent runs.',
    loadError: 'Agent runs could not be loaded.',
    retry: 'Retry',
    empty: 'No agent has claimed this task yet.',
    history: 'Earlier runs',
    startedAt: 'Started',
    lastActivity: 'Last activity',
    leaseExpiresAt: 'Lease ends',
    finishedAt: 'Finished',
    release: 'Release',
    releaseConfirm: 'Release this run? The agent can no longer update this task.',
    releaseError: 'The run could not be released. Check your permissions and the latest state.',
    stalledHint: 'No activity within the lease. Check on the agent and release the run if needed.',
    runtimes,
    states: {
      running: 'Running',
      stalled: 'Stalled',
      completed: 'Completed',
      paused: 'Paused',
      failed: 'Failed',
      released: 'Released',
      superseded: 'Taken over',
    },
  }
}
