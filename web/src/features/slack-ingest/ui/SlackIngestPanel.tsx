import {
  SLACK_INGEST_MAX_RETENTION_DAYS,
  SLACK_INGEST_MIN_RETENTION_DAYS,
  isSlackIngestRetentionDays,
  type SlackChannelSummary,
  type SlackChannelTarget,
  type SlackIngestStatusResponse,
} from '@mukuroji/contracts'
import { useState } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { SectionHeader } from '../../../shared/ui/WorkbenchPrimitives'

/** Team and its Projects an administrator can map a channel to. */
export type SlackIngestTeamOption = {
  /** Team ID. */
  id: string
  /** Team name. */
  name: string
  /** Projects of the Team. */
  projects: readonly {
    /** Project ID. */
    id: string
    /** Project name. */
    name: string
  }[]
}

/** Inputs of the Slack ingest settings panel. */
export type SlackIngestPanelProps = {
  /** Status, or `undefined` while loading. */
  status?: SlackIngestStatusResponse
  /** Whether the status failed to load. */
  hasLoadError: boolean
  /** Whether the last change failed. */
  hasOperationError: boolean
  /** Key of the running change, such as `retention` or `channel:<id>`. */
  busyOperation?: string
  /** Teams and Projects offered as targets. */
  teams: readonly SlackIngestTeamOption[]
  /** Translator. */
  t: (key: MessageKey) => string
  /** Loads the status again. */
  onReload: () => void
  /** Saves the retention, resolving to whether the change succeeded. */
  onSaveRetention: (retentionDays: number) => Promise<boolean>
  /** Maps or unmaps a channel, resolving to whether the change succeeded. */
  onSetTarget: (channel: SlackChannelSummary, target: SlackChannelTarget | null) => Promise<boolean>
}

/** Separator of the parts of a target select value. */
const SEPARATOR = '\u0000'

/**
 * Encodes a target as a select value.
 *
 * @param target - Target.
 * @returns `''` for none, `team<sep>id`, or `project<sep>team<sep>project`.
 */
function encodeTarget(target: SlackChannelTarget | undefined): string {
  if (!target) return ''
  return target.kind === 'team'
    ? `team${SEPARATOR}${target.teamId}`
    : `project${SEPARATOR}${target.teamId}${SEPARATOR}${target.projectId}`
}

/**
 * Decodes a select value.
 *
 * @param value - Select value.
 * @returns The target, or `null` for none.
 */
function decodeTarget(value: string): SlackChannelTarget | null {
  const [kind, teamId, projectId] = value.split(SEPARATOR)
  if (kind === 'team' && teamId) return { kind: 'team', teamId }
  if (kind === 'project' && teamId && projectId) return { kind: 'project', teamId, projectId }
  return null
}

/**
 * Renders the Slack ingest settings: whether the app is set up, the retention, and the
 * mapping of each channel the bot has joined.
 *
 * @param props - Status, state, options, and actions.
 * @returns The settings section.
 */
export function SlackIngestPanel({
  status,
  hasLoadError,
  hasOperationError,
  busyOperation,
  teams,
  t,
  onReload,
  onSaveRetention,
  onSetTarget,
}: SlackIngestPanelProps) {
  const [retentionDraft, setRetentionDraft] = useState<string>()
  const [targetDrafts, setTargetDrafts] = useState<Record<string, string>>({})
  const busy = busyOperation !== undefined
  const retentionText = retentionDraft ?? (status ? String(status.retentionDays) : '')
  const retentionValue = Number(retentionText)
  const targetOptions = teams.flatMap((team) => [
    { value: encodeTarget({ kind: 'team', teamId: team.id }), label: `${t('slackIngest.channels.team')}: ${team.name}` },
    ...team.projects.map((project) => ({
      value: encodeTarget({ kind: 'project', teamId: team.id, projectId: project.id }),
      label: `${t('slackIngest.channels.project')}: ${team.name} / ${project.name}`,
    })),
  ])

  /**
   * Describes the earlier-message load of a channel.
   *
   * @param channel - Channel.
   * @returns The label, or nothing for an unmapped channel.
   */
  const backfillLabel = (channel: SlackChannelSummary) => {
    if (!channel.backfill) return undefined
    const key: MessageKey = channel.backfill.status === 'completed'
      ? 'slackIngest.backfill.completed'
      : channel.backfill.status === 'failed'
        ? 'slackIngest.backfill.failed'
        : 'slackIngest.backfill.running'
    return `${t(key)} (${channel.backfill.importedCount})`
  }

  return (
    <section className="workbench-panel overflow-hidden" data-testid="slack-ingest-panel">
      <SectionHeader title={t('slackIngest.title')} />
      <p className="px-5 pb-4 text-sm font-medium leading-6 text-[var(--workbench-muted)]">{t('slackIngest.description')}</p>
      <div className="divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
        {hasOperationError ? (
          <p className="px-5 py-3 text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
            {t('slackIngest.operationError')}
          </p>
        ) : null}
        {hasLoadError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" role="alert">
            <span className="text-sm font-semibold text-[var(--workbench-danger)]">{t('slackIngest.loadError')}</span>
            <button className="workbench-button-secondary min-h-10 px-4" onClick={onReload} type="button">
              {t('slackIngest.retry')}
            </button>
          </div>
        ) : !status ? (
          <p className="px-5 py-4 text-sm font-medium text-[var(--workbench-muted)]">{t('slackIngest.loading')}</p>
        ) : (
          <>
            <div className="grid gap-2 px-5 py-4" data-testid="slack-ingest-connection">
              <strong className="text-sm font-semibold text-[var(--workbench-text)]">
                {t(status.configured ? 'slackIngest.connected' : 'slackIngest.notConfigured')}
              </strong>
              <p className="text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t(status.configured ? 'slackIngest.connectedDescription' : 'slackIngest.notConfiguredDescription')}
              </p>
              <p className="break-all text-xs font-medium text-[var(--workbench-muted)]">
                {`${t('slackIngest.workspaceId')}: `}
                <code className="font-mono">{status.workspaceId}</code>
                {status.slackTeamId ? ` · ${t('slackIngest.slackTeamId')}: ${status.slackTeamId}` : ''}
              </p>
            </div>

            <form
              className="flex min-w-0 flex-wrap items-end gap-3 px-5 py-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (isSlackIngestRetentionDays(retentionValue)) {
                  void onSaveRetention(retentionValue).then((succeeded) => {
                    if (succeeded) setRetentionDraft(undefined)
                  })
                }
              }}
            >
              <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                <span>{t('slackIngest.retention')}</span>
                <input
                  className="workbench-input h-10 w-32 px-3"
                  disabled={busy}
                  inputMode="numeric"
                  max={SLACK_INGEST_MAX_RETENTION_DAYS}
                  min={SLACK_INGEST_MIN_RETENTION_DAYS}
                  onChange={(event) => setRetentionDraft(event.target.value)}
                  type="number"
                  value={retentionText}
                />
              </label>
              <button
                className="workbench-button-primary min-h-10 px-4"
                disabled={
                  busy ||
                  !isSlackIngestRetentionDays(retentionValue) ||
                  // After a failed change, saving the same retention again retries the deletion.
                  (retentionValue === status.retentionDays && !hasOperationError)
                }
                type="submit"
              >
                {t('slackIngest.save')}
              </button>
              <p className="basis-full text-xs font-medium leading-5 text-[var(--workbench-muted)]">{t('slackIngest.retentionNote')}</p>
            </form>

            <div className="grid gap-3 px-5 py-5">
              <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('slackIngest.channels.title')}</h3>
              {status.channels.length === 0 ? (
                <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('slackIngest.channels.empty')}</p>
              ) : (
                <ul className="grid gap-2">
                  {status.channels.map((channel) => {
                    const current = encodeTarget(channel.target)
                    const draft = targetDrafts[channel.channelId] ?? current
                    const progress = backfillLabel(channel)
                    return (
                      <li
                        className="grid min-w-0 gap-2 rounded-lg border border-[var(--workbench-border)] px-4 py-3"
                        data-testid="slack-ingest-channel"
                        key={channel.channelId}
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <strong className="break-all text-sm font-semibold text-[var(--workbench-text)]">
                            #{channel.name ?? channel.channelId}
                          </strong>
                          {channel.isPrivate ? <span className="workbench-badge">{t('slackIngest.channels.private')}</span> : null}
                          {channel.membership === 'left' ? <span className="workbench-badge">{t('slackIngest.channels.left')}</span> : null}
                          {progress ? <span className="text-xs font-medium text-[var(--workbench-muted)]">{progress}</span> : null}
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <select
                            aria-label={`${t('slackIngest.channels.target')} #${channel.name ?? channel.channelId}`}
                            className="workbench-input min-h-10 min-w-0 max-w-full flex-1 px-3"
                            disabled={busy}
                            onChange={(event) => setTargetDrafts((drafts) => ({ ...drafts, [channel.channelId]: event.target.value }))}
                            value={draft}
                          >
                            <option value="">{t('slackIngest.channels.unmapped')}</option>
                            {targetOptions.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                          <button
                            className="workbench-button-primary min-h-10 px-4"
                            // After a failed change, saving the same target again retries the load or delete.
                            disabled={busy || (draft === current && !hasOperationError)}
                            onClick={() => {
                              // Keep the draft until the change succeeds so a failure can be retried.
                              void onSetTarget(channel, decodeTarget(draft)).then((succeeded) => {
                                if (!succeeded) return
                                setTargetDrafts((drafts) => Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== channel.channelId)))
                              })
                            }}
                            type="button"
                          >
                            {t('slackIngest.save')}
                          </button>
                        </div>
                        {draft === '' && current !== '' ? (
                          <p className="text-xs font-semibold text-[var(--workbench-danger)]">{t('slackIngest.channels.unmapWarning')}</p>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
