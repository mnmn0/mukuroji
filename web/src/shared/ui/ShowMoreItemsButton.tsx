/** Props of the button that renders the next step of a long list. */
export type ShowMoreItemsButtonProps = {
  /** Visible label, for example "Show 200 more (1,800 hidden)". */
  label: string
  /** Renders the next step of items. */
  onShowMore: () => void
  /** Stable test ID of the button. */
  testId?: string
}

/**
 * Button below a long list that renders the next step of its items.
 *
 * @param props - Label, click handler, and test ID.
 * @returns The button.
 */
export function ShowMoreItemsButton({ label, onShowMore, testId }: ShowMoreItemsButtonProps) {
  return (
    <button
      className="w-full rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2 text-sm font-semibold text-[var(--workbench-primary-text)] transition hover:bg-surface"
      data-testid={testId}
      onClick={onShowMore}
      type="button"
    >
      {label}
    </button>
  )
}
