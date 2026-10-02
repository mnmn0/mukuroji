import { useId, useRef, useState } from 'react'
import { CopyIcon } from '../../shared/ui/icons'
import { createTaskHandoffBrief, type TaskHandoffInput } from '../model/taskHandoff'

/** Inputs for the saved-task handoff disclosure. */
export type TaskHandoffPanelProps = TaskHandoffInput

/**
 * Scopes clipboard feedback and preview state to the exact saved task snapshot.
 * @param props - Visible saved task and localized handoff labels.
 * @returns A revision-keyed preview and copy control with manual clipboard fallback.
 */
export function TaskHandoffPanel(props: TaskHandoffPanelProps) {
  const brief = createTaskHandoffBrief(props)
  return <TaskHandoffSnapshot brief={brief} key={brief} revision={props.task.revision} t={props.t} />
}

/** Inputs for an immutable preview with local clipboard feedback. */
type TaskHandoffSnapshotProps = {
  /** Exact preview content also passed to the clipboard. */
  brief: string
  /** Saved task revision represented by this preview. */
  revision: number
  /** Resolves localized UI labels. */
  t: TaskHandoffInput['t']
}

/**
 * Renders a native disclosure; selecting or copying the brief never starts work.
 * @param props - Exact saved snapshot and localized labels.
 * @returns An accessible preview, copy action, and selectable fallback.
 */
function TaskHandoffSnapshot({ brief, revision, t }: TaskHandoffSnapshotProps) {
  const previewId = useId()
  const feedbackId = useId()
  const previewRef = useRef<HTMLTextAreaElement>(null)
  const copyPendingRef = useRef(false)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')

  /** Selects the exact visible brief for manual copying. */
  function selectBrief() {
    previewRef.current?.focus()
    previewRef.current?.select()
  }

  /** Copies only the displayed saved snapshot and exposes browser failures. */
  async function copyBrief() {
    if (copyPendingRef.current) return
    copyPendingRef.current = true
    setCopyState('copying')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(brief)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
      selectBrief()
    } finally {
      copyPendingRef.current = false
    }
  }

  return (
    <details className="min-w-0 border-y border-[var(--workbench-border)]" data-testid="task-handoff-panel">
      <summary className="min-h-[44px] cursor-pointer py-3 text-sm font-semibold text-[var(--workbench-primary)]">
        {t('agents.handoff.title')}
      </summary>
      <div className="grid min-w-0 gap-3 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-xs font-semibold text-[var(--workbench-text)]" htmlFor={previewId}>
            {t('agents.handoff.preview')}
          </label>
          <span className="text-xs text-[var(--workbench-muted)]">
            {t('agents.handoff.snapshot').replace('{revision}', String(revision))}
          </span>
        </div>
        <textarea
          aria-describedby={feedbackId}
          className="workbench-input min-h-52 w-full min-w-0 resize-y px-3 py-2 font-mono text-xs leading-6"
          id={previewId}
          readOnly
          ref={previewRef}
          rows={9}
          spellCheck={false}
          value={brief}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="workbench-button-primary inline-flex min-h-[44px] items-center justify-center gap-2 px-3"
            disabled={copyState === 'copying'}
            onClick={() => void copyBrief()}
            type="button"
          >
            <CopyIcon className="size-4 shrink-0 fill-none stroke-current stroke-2" />
            {t(copyState === 'copying' ? 'agents.handoff.copying' : 'agents.handoff.copy')}
          </button>
          <button className="workbench-button-secondary min-h-[44px] px-3" onClick={selectBrief} type="button">
            {t('agents.handoff.select')}
          </button>
        </div>
        <p className="text-xs leading-5 text-[var(--workbench-muted)]" id={feedbackId}>{t('agents.handoff.note')}</p>
        {copyState === 'copied' ? <p className="text-xs font-medium text-[var(--workbench-primary)]" role="status">{t('agents.handoff.copied')}</p> : null}
        {copyState === 'failed' ? <p className="text-xs leading-5 text-red-700" role="alert">{t('agents.handoff.copyFailed')}</p> : null}
      </div>
    </details>
  )
}
