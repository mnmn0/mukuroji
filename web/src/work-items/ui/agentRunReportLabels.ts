import type {
  AgentRunArtifactType,
  AgentRunArtifactUnverifiedReason,
  AgentRunPullRequestCheckState,
  AgentRunPullRequestReviewState,
  AgentRunPullRequestState,
  AgentRunReportKind,
  AgentRunVerificationStatus,
} from '@mukuroji/contracts'
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
  /** Text of the answer to a blocker or hand-off. */
  answer: AgentRunReportAnswerLabels
  /** Text of a reported pull request's provider status. */
  artifactStatus: AgentRunArtifactStatusLabels
}

/** Locale-aware text of a reported pull request's provider status (ADR 0103). */
export type AgentRunArtifactStatusLabels = {
  /** Display names of pull request states. */
  states: Record<AgentRunPullRequestState, string>
  /** Badge of a draft pull request. */
  draft: string
  /** Display names of check states; `none` shows nothing. */
  checks: Record<Exclude<AgentRunPullRequestCheckState, 'none'>, string>
  /** Display names of review states; `none` shows nothing. */
  reviews: Record<Exclude<AgentRunPullRequestReviewState, 'none'>, string>
  /** Badge of a pull request that could not be checked. */
  unverified: string
  /** Why a pull request could not be checked. */
  unverifiedReasons: Record<AgentRunArtifactUnverifiedReason, string>
}

/** Locale-aware text of the answer to a blocker or hand-off. */
export type AgentRunReportAnswerLabels = {
  /** Button that opens the answer form. */
  open: string
  /** Accessible name of the answer form and field. */
  label: string
  /** Placeholder of the answer field. */
  placeholder: string
  /** Button that sends the answer. */
  submit: string
  /** Button that closes the form without sending. */
  cancel: string
  /** Badge shown once a person answered. */
  answered: string
  /** Error shown when the answer could not be saved. */
  failed: string
  /** Error shown when another answer was saved first. */
  conflict: string
  /** Error shown for an answer over the limit, with a `{max}` placeholder. */
  tooLong: string
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
    answer: {
      open: t('workItems.agentRunReports.answer.open'),
      label: t('workItems.agentRunReports.answer.label'),
      placeholder: t('workItems.agentRunReports.answer.placeholder'),
      submit: t('workItems.agentRunReports.answer.submit'),
      cancel: t('workItems.agentRunReports.answer.cancel'),
      answered: t('workItems.agentRunReports.answer.answered'),
      failed: t('workItems.agentRunReports.answer.failed'),
      conflict: t('workItems.agentRunReports.answer.conflict'),
      tooLong: t('workItems.agentRunReports.answer.tooLong'),
    },
    artifactStatus: {
      states: {
        open: t('workItems.agentRunReports.artifactStatus.state.open'),
        closed: t('workItems.agentRunReports.artifactStatus.state.closed'),
        merged: t('workItems.agentRunReports.artifactStatus.state.merged'),
      },
      draft: t('workItems.agentRunReports.artifactStatus.draft'),
      checks: {
        success: t('workItems.agentRunReports.artifactStatus.checks.success'),
        failure: t('workItems.agentRunReports.artifactStatus.checks.failure'),
        pending: t('workItems.agentRunReports.artifactStatus.checks.pending'),
      },
      reviews: {
        approved: t('workItems.agentRunReports.artifactStatus.review.approved'),
        'changes-requested': t('workItems.agentRunReports.artifactStatus.review.changes-requested'),
      },
      unverified: t('workItems.agentRunReports.artifactStatus.unverified'),
      unverifiedReasons: {
        'repository-not-allowed': t('workItems.agentRunReports.artifactStatus.reason.repository-not-allowed'),
        'no-connector': t('workItems.agentRunReports.artifactStatus.reason.no-connector'),
        'not-accessible': t('workItems.agentRunReports.artifactStatus.reason.not-accessible'),
        'unsupported-provider': t('workItems.agentRunReports.artifactStatus.reason.unsupported-provider'),
        unavailable: t('workItems.agentRunReports.artifactStatus.reason.unavailable'),
      },
    },
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

/**
 * Builds the text of the notice shown when the pull request statuses could not be read.
 *
 * @param locale - Display locale.
 * @returns Notice text.
 */
export function createAgentRunArtifactStatusNoticeLabels(locale: Locale): AgentRunReportsNoticeLabels {
  const t = createTranslator(locale)
  return {
    loadError: t('workItems.agentRunReports.artifactStatus.loadError'),
    retry: t('workItems.agentRunReports.retry'),
  }
}
