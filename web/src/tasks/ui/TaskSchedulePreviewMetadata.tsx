import type { WorkItemScheduleChangePreview } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Props for dependency-specific metadata in a schedule preview dialog. */
export type TaskSchedulePreviewMetadataProps = {
  /** Server-owned schedule preview whose ripple metadata is displayed. */
  preview: WorkItemScheduleChangePreview
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Displays signed date movement, dependency causes, affected scopes, and blocking conflicts.
 *
 * @param props - Authoritative preview and localized labels.
 * @returns Metadata shared by table/detail, Gantt, and Calendar dialogs.
 */
export function TaskSchedulePreviewMetadata({
  preview,
  t,
}: TaskSchedulePreviewMetadataProps) {
  const affectedProjectCount = preview.affectedProjects.length > 0
    ? preview.affectedProjects.length
    : preview.affectedProjectIds.length

  return (
    <div className="mt-4 grid gap-3" data-testid="task-schedule-preview-metadata">
      <ul className="grid gap-1 text-xs font-semibold text-[#475467]">
        {preview.impacts.map((impact) => (
          <li key={`${impact.teamId}:${impact.workItemId}:${impact.kind}:delta`}>
            {impact.teamId} / {impact.workItemId}: {' '}
            {t('tasks.schedule.dateDelta').replace('{count}', formatSignedNumber(impact.dateDeltaDays))}
            {impact.dependencyId
              ? ` · ${t('tasks.schedule.dependencyCause').replace('{id}', impact.dependencyId)}`
              : ''}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <span className="workbench-badge">
          {t('workItems.dependencies.affectedProjects').replace(
            '{count}',
            String(affectedProjectCount),
          )}
        </span>
        <span className="workbench-badge">
          {t('workItems.dependencies.affectedMilestones').replace(
            '{count}',
            String(preview.affectedMilestoneIds.length),
          )}
        </span>
      </div>
      {preview.affectedProjects.length > 0 ? (
        <ul
          aria-label={t('workItems.dependencies.affectedProjects').replace(
            '{count}',
            String(preview.affectedProjects.length),
          )}
          className="flex flex-wrap gap-1 font-mono text-[11px] text-[#475467]"
        >
          {preview.affectedProjects.map((project) => (
            <li className="workbench-badge" key={`${project.teamId}:${project.projectId}`}>
              {project.teamId} / {project.projectId}
            </li>
          ))}
        </ul>
      ) : preview.affectedProjectIds.length > 0 ? (
        <ul
          aria-label={t('workItems.dependencies.affectedProjects').replace(
            '{count}',
            String(affectedProjectCount),
          )}
          className="flex flex-wrap gap-1 font-mono text-[11px] text-[#475467]"
        >
          {preview.affectedProjectIds.map((projectId) => (
            <li className="workbench-badge" key={projectId}>{projectId}</li>
          ))}
        </ul>
      ) : null}
      {preview.affectedMilestoneIds.length > 0 ? (
        <ul
          aria-label={t('workItems.dependencies.affectedMilestones').replace(
            '{count}',
            String(preview.affectedMilestoneIds.length),
          )}
          className="flex flex-wrap gap-1 font-mono text-[11px] text-[#475467]"
        >
          {preview.affectedMilestoneIds.map((milestoneId) => (
            <li className="workbench-badge" key={milestoneId}>{milestoneId}</li>
          ))}
        </ul>
      ) : null}
      {preview.conflicts.length > 0 ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-red-800" role="alert">
          <p className="text-xs font-bold uppercase tracking-wide">
            {t('tasks.schedule.conflicts')}
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {preview.conflicts.map((conflict, index) => (
              <li key={`${conflict.dependencyId}:${conflict.workItem.teamId}:${conflict.workItem.workItemId}:${index}`}>
                {t(`tasks.schedule.conflict.${conflict.code}`)} {' '}
                ({conflict.workItem.teamId} / {conflict.workItem.workItemId}
                {conflict.requiredDate ? ` · ${conflict.requiredDate}` : ''}
                {conflict.actualDate ? ` → ${conflict.actualDate}` : ''})
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm font-semibold">{t('tasks.schedule.confirmBlocked')}</p>
        </div>
      ) : null}
    </div>
  )
}

/** Formats a signed numeric delta for localized sentence interpolation. */
function formatSignedNumber(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}
