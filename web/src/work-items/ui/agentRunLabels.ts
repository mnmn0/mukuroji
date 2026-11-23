import type { AgentRunRuntime, AgentRunUsage } from '@mukuroji/contracts'
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
  /** Badge of a run that resumed an earlier run. */
  resumed: string
  /** Explanation of the resumed badge. */
  resumedHint: string
  /** Heading of the Work Item's token total. */
  usageTotal: string
  /** Note shown when the usage read stopped at its limit. */
  usagePartial: string
  /** Explanation of where usage comes from and who sees the cost. */
  usageHint: string
  /**
   * Describes token counts by kind.
   * @param usage - Usage to describe.
   * @returns Text such as "Input 1,200 · output 300 · …".
   */
  formatUsageTokens: (usage: AgentRunUsage) => string
  /**
   * Describes usage in a few words for one run.
   * @param usage - Usage to describe.
   * @returns Text such as "1,500 tokens · Est. $0.12".
   */
  formatUsageCompact: (usage: AgentRunUsage) => string
  /**
   * Describes the request count and, for managers, the estimated cost.
   * @param usage - Usage to describe.
   * @returns Text such as "3 requests · Est. $0.12".
   */
  formatUsageDetail: (usage: AgentRunUsage) => string
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
  const integer = new Intl.NumberFormat(locale === 'ja' ? 'ja-JP' : 'en-US')
  const dollars = new Intl.NumberFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: 2 })
  /**
   * Formats the estimated cost, when the viewer may see it.
   * @param usage - Usage to describe.
   * @returns Cost text, or undefined.
   */
  const cost = (usage: AgentRunUsage) => usage.estimatedCostMicroUsd === undefined
    ? undefined
    : t('workItems.agentRuns.usageCost').replace('{cost}', dollars.format(usage.estimatedCostMicroUsd / 1_000_000))
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
    resumed: t('workItems.agentRuns.resumed'),
    resumedHint: t('workItems.agentRuns.resumedHint'),
    usageTotal: t('workItems.agentRuns.usageTotal'),
    usagePartial: t('workItems.agentRuns.usagePartial'),
    usageHint: t('workItems.agentRuns.usageHint'),
    formatUsageTokens: (usage) => t('workItems.agentRuns.usageTokens')
      .replace('{input}', integer.format(usage.inputTokens))
      .replace('{output}', integer.format(usage.outputTokens))
      .replace('{cacheRead}', integer.format(usage.cacheReadTokens))
      .replace('{cacheCreation}', integer.format(usage.cacheCreationTokens)),
    formatUsageCompact: (usage) => [
      t('workItems.agentRuns.usageCompact').replace(
        '{tokens}',
        integer.format(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens),
      ),
      cost(usage),
    ].filter((part) => part !== undefined).join(' · '),
    formatUsageDetail: (usage) => [
      t('workItems.agentRuns.usageRequests').replace('{count}', integer.format(usage.requestCount)),
      cost(usage),
    ].filter((part) => part !== undefined).join(' · '),
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
