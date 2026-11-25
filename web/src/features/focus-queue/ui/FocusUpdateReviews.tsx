import type { FocusUpdateReview } from '@mukuroji/contracts'
import { Link } from 'react-router'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { focusUpdateTargetLabelKey, formatFocusTimestamp } from '../model/focusQueue'

/** Props for the published health updates that wait for the viewer's acknowledgement. */
export type FocusUpdateReviewsProps = {
  /** Pending reviews in server order: oldest publish first. */
  reviews: readonly FocusUpdateReview[]
  /** Current application locale used for publish timestamps. */
  locale: Locale
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Lists the health updates that the viewer reviews and has not acknowledged yet.
 *
 * @param props - Pending reviews, locale, and localized copy.
 * @returns A compact panel, or null when nothing waits for review.
 */
export function FocusUpdateReviews({ reviews, locale, t }: FocusUpdateReviewsProps) {
  if (reviews.length === 0) return null
  return (
    <section
      aria-labelledby="focus-update-reviews-title"
      className="workbench-panel overflow-hidden"
      data-testid="focus-update-reviews"
    >
      <div className="flex items-center justify-between gap-3 bg-[var(--workbench-surface-muted)] px-4 py-2 text-xs font-bold uppercase tracking-[0.06em] text-[var(--workbench-muted)]">
        <h3 id="focus-update-reviews-title">{t('workspace.focus.updateReviews.title')}</h3>
        <span className="tabular-nums">{reviews.length}</span>
      </div>
      <ul className="divide-y divide-[var(--workbench-border)]">
        {reviews.map((review) => (
          <li className="grid gap-1 px-4 py-3" key={review.id}>
            <Link
              className="break-words text-app-body font-semibold text-[var(--workbench-text)] underline-offset-4 hover:underline"
              to={review.deepLink}
            >
              {review.title ?? t(focusUpdateTargetLabelKey(review.target))}
            </Link>
            <p className="line-clamp-2 break-words text-app-meta text-[var(--workbench-text)]">
              {review.summary}
            </p>
            <span className="text-app-caption text-[var(--workbench-muted)]">
              {t('workspace.focus.updateReviews.meta')
                .replace('{author}', review.authorMemberKey)
                .replace('{time}', formatFocusTimestamp(review.publishedAt, locale))}
              {' · '}
              {t('workspace.focus.updateReviews.resolves')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
