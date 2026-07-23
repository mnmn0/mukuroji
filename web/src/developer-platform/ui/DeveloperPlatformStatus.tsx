import type { ApiScope } from '@mukuroji/contracts'
import type { DeveloperPlatformLabels } from './DeveloperPlatformView'

/**
 * Renders a localized status badge with semantic status coloring.
 *
 * @param props - Status value and localized status labels.
 * @returns The status badge UI.
 */
export function StatusBadge(props: {
  labels: DeveloperPlatformLabels
  status: string
}) {
  const { labels, status } = props
  const className =
    status === 'active' ||
    status === 'connected' ||
    status === 'delivered' ||
    status === 'completed' ||
    status === 'resolved'
      ? 'workbench-badge-success'
      : status === 'failed' || status === 'revoked' || status === 'error'
        ? 'workbench-badge-danger'
        : status === 'needs-reauth' ||
            status === 'conflict' ||
            status === 'open'
          ? 'workbench-badge-warning'
          : 'workbench-badge'

  return (
    <span className={className}>{labels.statusLabels[status] ?? status}</span>
  )
}

/**
 * Renders localized badges for a collection of API scopes.
 *
 * @param props - API scopes and localized scope options.
 * @returns The scope badge collection.
 */
export function ScopeBadges(props: {
  labels: DeveloperPlatformLabels
  scopes: ApiScope[]
}) {
  const { labels, scopes } = props

  return (
    <div className="flex flex-wrap gap-1.5">
      {scopes.map((scope) => (
        <span className="workbench-badge-primary" key={scope}>
          {labels.scopeOptions.find((option) => option.value === scope)
            ?.label ?? scope}
        </span>
      ))}
    </div>
  )
}
