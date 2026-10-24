import type { AgentRunArtifactType, AgentRunReportKind, AgentRunVerificationStatus } from '@mukuroji/contracts'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'

/** Locale-aware text of report chips. */
export type AgentRunReportChipsLabels = {
  /** Accessible name of the chip group. */
  label: string
  /** Display names of report kinds. */
  kinds: Record<AgentRunReportKind, string>
  /** Display names of verification results. */
  verificationStatuses: Record<AgentRunVerificationStatus, string>
  /** Display names of artifact types. */
  artifactTypes: Record<AgentRunArtifactType, string>
  /** Changed file count text with a `{count}` placeholder. */
  changedFiles: string
  /** Hint shown for a blocker or hand-off. */
  decisionNeeded: string
}

/**
 * Creates the report chip text for a locale.
 *
 * @param locale - Display locale.
 * @returns Chip text.
 */
export function createAgentRunReportChipsLabels(locale: Locale): AgentRunReportChipsLabels {
  const t = createTranslator(locale)
  return {
    label: t('workItems.agentRunReports.label'),
    kinds: {
      progress: t('workItems.agentRunReports.kind.progress'),
      blocker: t('workItems.agentRunReports.kind.blocker'),
      verification: t('workItems.agentRunReports.kind.verification'),
      artifact: t('workItems.agentRunReports.kind.artifact'),
      handoff: t('workItems.agentRunReports.kind.handoff'),
    },
    verificationStatuses: {
      passed: t('workItems.agentRunReports.verification.passed'),
      failed: t('workItems.agentRunReports.verification.failed'),
      skipped: t('workItems.agentRunReports.verification.skipped'),
    },
    artifactTypes: {
      'pull-request': t('workItems.agentRunReports.artifact.pull-request'),
      branch: t('workItems.agentRunReports.artifact.branch'),
      commit: t('workItems.agentRunReports.artifact.commit'),
      url: t('workItems.agentRunReports.artifact.url'),
    },
    changedFiles: t('workItems.agentRunReports.changedFiles'),
    decisionNeeded: t('workItems.agentRunReports.decisionNeeded'),
  }
}

/** Locale-aware text of the notice shown when reports could not be read. */
export type AgentRunReportsNoticeLabels = {
  /** Loading failure text. */
  loadError: string
  /** Retry action. */
  retry: string
}

/**
 * Creates the report loading notice text for a locale.
 *
 * @param locale - Display locale.
 * @returns Notice text.
 */
export function createAgentRunReportsNoticeLabels(locale: Locale): AgentRunReportsNoticeLabels {
  const t = createTranslator(locale)
  return {
    loadError: t('workItems.agentRunReports.loadError'),
    retry: t('workItems.agentRunReports.retry'),
  }
}
