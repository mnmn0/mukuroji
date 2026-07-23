import type { DeveloperPlatformLabels } from './DeveloperPlatformView'

/**
 * Renders a Developer Platform section heading and its optional primary action.
 *
 * @param props - Section title, description, and optional action.
 * @returns The section heading UI.
 */
export function SectionHeader(props: {
  action?: { label: string; onClick: () => void }
  description: string
  title: string
}) {
  const { action, description, title } = props

  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-[680px]">
        <h3 className="text-lg font-semibold text-[var(--workbench-text)]">
          {title}
        </h3>
        <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {description}
        </p>
      </div>
      {action ? (
        <button
          className="workbench-button-primary min-h-10 px-4"
          onClick={action.onClick}
          type="button"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Renders a titled empty state for a Developer Platform section.
 *
 * @param props - Empty-state title and supporting description.
 * @returns The empty-state UI.
 */
export function EmptyState(props: { description: string; title: string }) {
  const { description, title } = props

  return (
    <div className="mt-4 rounded-lg border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] px-5 py-8 text-center">
      <h4 className="font-semibold text-[var(--workbench-text)]">{title}</h4>
      <p className="mx-auto mt-2 max-w-[540px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
        {description}
      </p>
    </div>
  )
}

/**
 * Renders optional rotate and revoke actions for a managed credential.
 *
 * @param props - Busy state, localized labels, and available actions.
 * @returns The credential action buttons.
 */
export function ActionButtons(props: {
  busy?: boolean
  labels: DeveloperPlatformLabels
  onRevoke?: () => void
  onRotate?: () => void
}) {
  const { busy, labels, onRevoke, onRotate } = props

  return (
    <div className="flex flex-wrap gap-2">
      {onRotate ? (
        <button
          className="workbench-button-secondary min-h-9 px-3 disabled:opacity-50"
          disabled={busy}
          onClick={onRotate}
          type="button"
        >
          {labels.actions.rotate}
        </button>
      ) : null}
      {onRevoke ? (
        <button
          className="min-h-9 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            if (window.confirm(labels.helpText.revokeConfirm)) {
              onRevoke()
            }
          }}
          type="button"
        >
          {labels.actions.revoke}
        </button>
      ) : null}
    </div>
  )
}
