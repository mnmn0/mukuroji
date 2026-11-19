import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Props of the single Work Item archive and restore button. */
export type WorkItemArchiveButtonProps = {
  /** Whether the Work Item is archived now; the button then restores it. */
  archived: boolean
  /** Whether another change of the Work Item is running, so this one must wait. */
  disabled?: boolean
  /** Archives (true) or restores (false) the Work Item; rejects with a safe message. */
  onArchiveChange: (archived: boolean) => Promise<void>
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Archives an active Work Item or restores an archived one, and shows why a change failed.
 *
 * @param props - Current archive state, the change callback, and the translator.
 * @returns The button with its error message.
 */
export function WorkItemArchiveButton({
  archived,
  disabled = false,
  onArchiveChange,
  t,
}: WorkItemArchiveButtonProps) {
  const [isPending, setIsPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()

  /** Runs the archive or restore and keeps the button disabled until it settles. */
  const handleClick = async () => {
    setIsPending(true)
    setErrorMessage(undefined)
    try {
      await onArchiveChange(!archived)
    } catch (error) {
      setErrorMessage(error instanceof Error && error.message
        ? error.message
        : t(archived ? 'issues.archive.restoreError' : 'issues.archive.archiveError'))
    } finally {
      setIsPending(false)
    }
  }

  return (
    <span className="inline-grid justify-items-end gap-1">
      <button
        className="workbench-button-secondary h-8 px-3 text-xs"
        data-testid="work-item-archive-toggle"
        disabled={disabled || isPending}
        onClick={() => void handleClick()}
        type="button"
      >
        {isPending
          ? t(archived ? 'issues.archive.restoring' : 'issues.archive.archiving')
          : t(archived ? 'issues.archive.restore' : 'issues.archive.archive')}
      </button>
      {errorMessage ? (
        <span className="max-w-[240px] text-right text-xs font-semibold text-fg-red-700" role="alert">
          {errorMessage}
        </span>
      ) : null}
    </span>
  )
}
