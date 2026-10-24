import type { AgentRunReport, AgentRunVerificationStatus } from '@mukuroji/contracts'
import { isAgentRunReportAwaitingDecision, readAgentRunArtifactText } from '../model/agentRunReportDisplay'
import type { AgentRunReportChipsLabels, AgentRunReportsNoticeLabels } from './agentRunReportLabels'

/** Props of the report chips shown under one comment. */
export type AgentRunReportChipsProps = {
  /** Report saved with the comment. */
  report: AgentRunReport
  /** Locale-aware text. */
  labels: AgentRunReportChipsLabels
}

/** Badge class of each verification result. */
const verificationBadgeClasses: Record<AgentRunVerificationStatus, string> = {
  passed: 'workbench-badge-success',
  failed: 'workbench-badge-danger',
  skipped: 'workbench-badge',
}

/**
 * Shows the structured parts of an agent report under its comment: the kind, each verification
 * result, artifact links, and the changed file count. Links open in a new tab without a referrer,
 * like links in comment bodies.
 *
 * @param props - Report and text.
 * @returns Chip group.
 */
export function AgentRunReportChips({ labels, report }: AgentRunReportChipsProps) {
  const awaitingDecision = isAgentRunReportAwaitingDecision(report.kind)
  return (
    <div
      aria-label={labels.label}
      className="mt-2 flex flex-wrap items-center gap-1"
      data-testid="agent-run-report-chips"
      role="group"
    >
      <span
        className={awaitingDecision ? 'workbench-badge-warning' : 'workbench-badge-primary'}
        title={awaitingDecision ? labels.decisionNeeded : undefined}
      >
        {labels.kinds[report.kind]}
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
      {report.artifacts.map((artifact, index) => (
        <a
          className="workbench-badge max-w-full underline-offset-2 hover:underline"
          href={artifact.url}
          key={`artifact-${index}`}
          rel="noreferrer noopener"
          target="_blank"
          title={artifact.url}
        >
          <span className="shrink-0 font-semibold">{labels.artifactTypes[artifact.type]}</span>
          <span className="min-w-0 truncate">{readAgentRunArtifactText(artifact)}</span>
        </a>
      ))}
      {report.changedFileCount === undefined ? null : (
        <span className="workbench-badge">
          {labels.changedFiles.replace('{count}', String(report.changedFileCount))}
        </span>
      )}
    </div>
  )
}

/** Props of the notice shown when a Work Item's reports could not be read. */
export type AgentRunReportsLoadNoticeProps = {
  /** Locale-aware text. */
  labels: AgentRunReportsNoticeLabels
  /** Reads the reports again. */
  onRetry: () => void
}

/**
 * Tells the viewer that report chips are missing because the reports could not be read, and offers
 * to read them again. The conversation stays usable below it.
 *
 * @param props - Text and retry action.
 * @returns Notice with a retry button.
 */
export function AgentRunReportsLoadNotice({ labels, onRetry }: AgentRunReportsLoadNoticeProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2 text-sm text-[var(--workbench-muted)]"
      data-testid="agent-run-reports-load-notice"
      role="status"
    >
      <span>{labels.loadError}</span>
      <button className="workbench-button-secondary h-8 px-3" onClick={onRetry} type="button">
        {labels.retry}
      </button>
    </div>
  )
}
