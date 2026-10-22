import type { AgentRunRuntime } from '@mukuroji/contracts'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
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
  /** Note shown when older runs exist beyond the listed ones. */
  historyTruncated: string
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
  const t = createTranslator(locale)
  return {
    title: t('workItems.agentRuns.title'),
    description: t('workItems.agentRuns.description'),
    loading: t('workItems.agentRuns.loading'),
    loadError: t('workItems.agentRuns.loadError'),
    retry: t('workItems.agentRuns.retry'),
    empty: t('workItems.agentRuns.empty'),
    history: t('workItems.agentRuns.history'),
    historyTruncated: t('workItems.agentRuns.historyTruncated'),
    startedAt: t('workItems.agentRuns.startedAt'),
    lastActivity: t('workItems.agentRuns.lastActivity'),
    leaseExpiresAt: t('workItems.agentRuns.leaseExpiresAt'),
    finishedAt: t('workItems.agentRuns.finishedAt'),
    release: t('workItems.agentRuns.release'),
    releaseConfirm: t('workItems.agentRuns.releaseConfirm'),
    releaseError: t('workItems.agentRuns.releaseError'),
    stalledHint: t('workItems.agentRuns.stalledHint'),
    // Product names stay untranslated.
    runtimes: { 'claude-code': 'Claude Code', codex: 'Codex', kiro: 'Kiro', other: t('workItems.agentRuns.runtime.other') },
    states: {
      running: t('workItems.agentRuns.state.running'),
      stalled: t('workItems.agentRuns.state.stalled'),
      completed: t('workItems.agentRuns.state.completed'),
      paused: t('workItems.agentRuns.state.paused'),
      failed: t('workItems.agentRuns.state.failed'),
      released: t('workItems.agentRuns.state.released'),
      superseded: t('workItems.agentRuns.state.superseded'),
    },
  }
}
