import type { AiAssistanceConfidence } from '@mukuroji/contracts'
import type { MessageKey } from '../../../shared/i18n/i18n'

/** Props for a confidence label that never relies on color alone. */
export type ConfidenceBadgeProps = {
  /** Confidence category returned by the server. */
  confidence: AiAssistanceConfidence
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Whether the badge is rendered beside a compact claim. */
  size?: 'default' | 'compact'
}

/** Renders an explicit confidence label with a semantic color accent. */
export function ConfidenceBadge({
  confidence,
  size = 'default',
  t,
}: ConfidenceBadgeProps) {
  const className = confidence === 'high'
    ? 'border-green-200 bg-green-50 text-green-800'
    : confidence === 'medium'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-red-200 bg-red-50 text-red-800'
  const sizeClassName = size === 'compact' ? 'text-[11px]' : 'text-app-caption'

  return (
    <span className={`rounded-md border px-2 py-1 font-semibold ${sizeClassName} ${className}`}>
      {t(`ai.review.confidence.${confidence}`)}
    </span>
  )
}
