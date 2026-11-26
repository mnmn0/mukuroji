import type { AgentRunArtifactStatus, AgentRunReport, AgentRunVerificationStatus } from '@mukuroji/contracts'
import { isAgentRunReportAwaitingDecision, readAgentRunArtifactText } from '../model/agentRunReportDisplay'
import type { AgentRunReportAnswerResult } from '../mutations/useAnswerAgentRunReport'
import { AgentRunReportAnswerForm } from './AgentRunReportAnswerForm'
import type { AgentRunArtifactStatusLabels, AgentRunReportChipsLabels, AgentRunReportsNoticeLabels } from './agentRunReportLabels'

/** Props of the report chips shown under one comment. */
export type AgentRunReportChipsProps = {
  /** Report saved with the comment. */
  report: AgentRunReport
  /** Locale-aware text. */
  labels: AgentRunReportChipsLabels
  /** Answers a blocker or hand-off; without it, the report shows no answer form. */
  onAnswer?: (body: string) => Promise<AgentRunReportAnswerResult>
  /** Provider status of reported pull requests by URL; a pull request without one shows only its link. */
  artifactStatuses?: ReadonlyMap<string, AgentRunArtifactStatus>
}

/** Badge class of each verification result. */
const verificationBadgeClasses: Record<AgentRunVerificationStatus, string> = {
  passed: 'workbench-badge-success',
  failed: 'workbench-badge-danger',
  skipped: 'workbench-badge',
}

/**
 * Shows the structured parts of an agent report under its comment: the kind, each verification
 * result, artifact links, and the changed file count. A blocker or hand-off shows whether a person
 * answered it, and offers the answer form while it waits when `onAnswer` is given. Links open in a new tab without a referrer,
 * like links in comment bodies.
 *
 * @param props - Report and text.
 * @returns Chip group.
 */
export function AgentRunReportChips({ artifactStatuses, labels, onAnswer, report }: AgentRunReportChipsProps) {
  const question = isAgentRunReportAwaitingDecision(report.kind)
  const awaitingDecision = question && report.answer === undefined
  return (
    <div
      aria-label={labels.label}
      className="mt-2 flex flex-wrap items-center gap-1"
      data-testid="agent-run-report-chips"
      role="group"
    >
      <span className={awaitingDecision ? 'workbench-badge-warning' : question ? 'workbench-badge-success' : 'workbench-badge-primary'}>
        <span className="font-semibold">{labels.kinds[report.kind]}</span>
        {awaitingDecision ? <span>{labels.decisionNeeded}</span> : null}
        {question && report.answer ? <span>{labels.answer.answered}</span> : null}
      </span>
      {report.verifications.map((verification, index) => (
        <span
          className={`${verificationBadgeClasses[verification.status]} max-w-full`}
          key={`verification-${index}`}
          title={verification.summary ?? verification.command}
        >
          <span className="shrink-0 font-semibold">{labels.verificationStatuses[verification.status]}</span>
          <code className="min-w-0 truncate">{verification.command}</code>
        </span>
      ))}
      {report.artifacts.map((artifact, index) => {
        const status = artifact.type === 'pull-request' ? artifactStatuses?.get(artifact.url) : undefined
        return (
          <span className="contents" key={`artifact-${index}`}>
            <a
              className="workbench-badge max-w-full underline-offset-2 hover:underline"
              href={artifact.url}
              rel="noreferrer noopener"
              target="_blank"
              title={artifact.url}
            >
              <span className="shrink-0 font-semibold">{labels.artifactTypes[artifact.type]}</span>
              <span className="min-w-0 truncate">{readAgentRunArtifactText(artifact)}</span>
            </a>
            {status ? <AgentRunArtifactStatusBadges labels={labels.artifactStatus} status={status} /> : null}
          </span>
        )
      })}
      {report.changedFileCount === undefined ? null : (
        <span className="workbench-badge">
          {labels.changedFiles.replace('{count}', String(report.changedFileCount))}
        </span>
      )}
      {awaitingDecision && onAnswer ? <AgentRunReportAnswerForm labels={labels.answer} onAnswer={onAnswer} /> : null}
    </div>
  )
}

/** Badge class of each check state that is shown. */
const checkBadgeClasses = {
  success: 'workbench-badge-success',
  failure: 'workbench-badge-danger',
  pending: 'workbench-badge-warning',
} as const

/** Props of the badges that describe one reported pull request. */
type AgentRunArtifactStatusBadgesProps = {
  /** Provider status of the pull request. */
  status: AgentRunArtifactStatus
  /** Locale-aware text. */
  labels: AgentRunArtifactStatusLabels
}

/**
 * Shows what the provider says about a reported pull request (ADR 0103): its state, draft flag,
 * checks, and review. A pull request that could not be checked says so, with the reason as its
 * title, so a link is never mistaken for a verified one.
 *
 * @param props - Status and text.
 * @returns Badges.
 */
function AgentRunArtifactStatusBadges({ labels, status }: AgentRunArtifactStatusBadgesProps) {
  const pullRequest = status.pullRequest
  if (status.verification === 'unverified' || pullRequest === undefined) {
    const reason = status.unverifiedReason === undefined ? undefined : labels.unverifiedReasons[status.unverifiedReason]
    return (
      <span className="workbench-badge" data-testid="agent-run-artifact-unverified" title={reason}>
        <span className="font-semibold">{labels.unverified}</span>
        {reason ? <span className="sr-only">{reason}</span> : null}
      </span>
    )
  }
  const stateClass = pullRequest.state === 'merged' ? 'workbench-badge-primary'
    : pullRequest.state === 'closed' ? 'workbench-badge' : 'workbench-badge-success'
  return (
    <>
      <span className={stateClass} data-testid="agent-run-artifact-state">
        <span className="font-semibold">{labels.states[pullRequest.state]}</span>
        {pullRequest.draft && pullRequest.state === 'open' ? <span>{labels.draft}</span> : null}
      </span>
      {pullRequest.state === 'merged' || pullRequest.checks === 'none' ? null : (
        <span className={checkBadgeClasses[pullRequest.checks]}>{labels.checks[pullRequest.checks]}</span>
      )}
      {pullRequest.review === 'none' ? null : (
        <span className={pullRequest.review === 'approved' ? 'workbench-badge-success' : 'workbench-badge-warning'}>
          {labels.reviews[pullRequest.review]}
        </span>
      )}
    </>
  )
}

/** Props of the notice shown when a Work Item's reports could not be read. */
export type AgentRunReportsLoadNoticeProps = {
  /** Locale-aware text. */
  labels: AgentRunReportsNoticeLabels
  /** Reads the reports again. */
  onRetry: () => void
  /** Test ID of the notice; the report notice's when omitted. */
  testId?: string
}

/**
 * Tells the viewer that report chips are missing because the reports could not be read, and offers
 * to read them again. The conversation stays usable below it.
 *
 * @param props - Text and retry action.
 * @returns Notice with a retry button.
 */
export function AgentRunReportsLoadNotice({ labels, onRetry, testId = 'agent-run-reports-load-notice' }: AgentRunReportsLoadNoticeProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2 text-sm text-[var(--workbench-muted)]"
      data-testid={testId}
      role="status"
    >
      <span>{labels.loadError}</span>
      <button className="workbench-button-secondary h-8 px-3" onClick={onRetry} type="button">
        {labels.retry}
      </button>
    </div>
  )
}
