import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createWorkItemKeyPath } from '../../shared/routing/paths'

/** Props for {@link WorkItemKeyActions}. */
export type WorkItemKeyActionsProps = {
  /** Canonical Work Item key, such as `PT-12`. */
  workItemKey: string
  /** Translator for the visible labels. */
  t: (key: MessageKey) => string
  /** Writes text to the clipboard. Tests and stories pass their own. */
  writeText?: (text: string) => Promise<void>
}

/** Result of the last copy, shown next to the buttons. */
type CopyFeedback = 'key' | 'link' | 'failed'

/**
 * Shows a Work Item key with buttons that copy the key or its lasting link.
 *
 * @returns The key and copy buttons.
 */
export function WorkItemKeyActions({ workItemKey, t, writeText = writeToClipboard }: WorkItemKeyActionsProps) {
  const [feedback, setFeedback] = useState<CopyFeedback>()
  const copy = (text: string, done: CopyFeedback) => {
    writeText(text).then(() => setFeedback(done), () => setFeedback('failed'))
  }
  const feedbackMessage = feedback === 'key'
    ? t('issues.key.copied')
    : feedback === 'link'
      ? t('issues.key.linkCopied')
      : feedback === 'failed'
        ? t('issues.key.copyFailed')
        : ''

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="work-item-key-actions">
      <span className="sr-only">{t('issues.key.label')}</span>
      <span className="font-mono text-sm font-semibold text-[var(--workbench-muted)]" data-testid="work-item-key">
        {workItemKey}
      </span>
      <button
        className="workbench-button-secondary min-h-7 px-2 text-xs"
        onClick={() => copy(workItemKey, 'key')}
        type="button"
      >
        {t('issues.key.copy')}
      </button>
      <button
        className="workbench-button-secondary min-h-7 px-2 text-xs"
        onClick={() => copy(new URL(createWorkItemKeyPath(workItemKey), window.location.origin).toString(), 'link')}
        type="button"
      >
        {t('issues.key.copyLink')}
      </button>
      <span aria-live="polite" className="text-xs font-medium text-[var(--workbench-muted)]" role="status">
        {feedbackMessage}
      </span>
    </div>
  )
}

/**
 * Writes text with the browser clipboard API.
 *
 * @param text - Text to copy.
 */
async function writeToClipboard(text: string) {
  await navigator.clipboard.writeText(text)
}
