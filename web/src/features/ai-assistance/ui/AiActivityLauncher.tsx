import type { MessageKey } from '../../../shared/i18n/i18n'
import { ChevronIcon } from '../../../shared/ui/icons'
import { getAiActivityPhase, getAiActivityStatus } from '../model/aiActivity'
import { useAiActivity } from '../queries/aiActivityContext'
import { useAiActivityClock } from '../queries/useAiActivityClock'

/** Inputs for the persistent workspace activity entry. */
export type AiActivityLauncherProps = {
  /** Whether saved settings and deployment policy allow any AI workflow. */
  enabled: boolean
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Keeps actual AI processing and review counts visible throughout the workspace.
 * @param props - Workspace translator.
 * @returns A compact bar opening the activity board without navigating away.
 */
export function AiActivityLauncher({ enabled, t }: AiActivityLauncherProps) {
  const { context, activities } = useAiActivity()
  const now = useAiActivityClock(activities)
  if (!context || (!enabled && activities.length === 0)) return null
  const running = activities.filter((activity) => getAiActivityStatus(getAiActivityPhase(activity, now)) === 'running').length
  const review = activities.filter((activity) => getAiActivityPhase(activity, now) === 'review').length
  return (
    <div className="flex flex-none items-center justify-between gap-2 border-b border-[var(--workbench-border)] bg-white px-[clamp(16px,2.5vw,30px)]">
      <button aria-haspopup="dialog" className="flex min-h-[44px] min-w-0 items-center gap-2 text-xs font-semibold text-[var(--workbench-text)]" onClick={context.openBoard} type="button">
        <span aria-hidden="true" className="rounded bg-teal-50 px-1.5 py-0.5 text-[11px] font-bold text-teal-800">AI</span>
        {t('ai.activity.title')}
        <ChevronIcon className="size-3.5 -rotate-90 fill-none stroke-current stroke-2" />
      </button>
      <p aria-label={t('ai.activity.title')} className="flex flex-wrap justify-end gap-x-3 text-xs text-[var(--workbench-muted)]" role="status">
        {running > 0 ? <span className="text-blue-700">{t('ai.activity.filter.running')} {running}</span> : null}
        {review > 0 ? <span className="font-medium text-amber-800">{t('ai.activity.phase.review')} {review}</span> : null}
        {running === 0 && review === 0 ? t('ai.activity.idle') : null}
      </p>
    </div>
  )
}
