import { AGENT_RUN_REPORT_ANSWER_MAX_LENGTH } from '@mukuroji/contracts'
import { useEffect, useId, useState, type FormEvent } from 'react'
import type { AgentRunReportAnswerResult } from '../mutations/useAnswerAgentRunReport'
import type { AgentRunReportAnswerLabels } from './agentRunReportLabels'

/** Unsent state of an answer form, kept outside the form so it survives the form unmounting. */
export type AgentRunReportAnswerDraft = {
  /** Whether the form was open. */
  open: boolean
  /** Text typed and not yet saved. */
  body: string
}

/** Props of the answer form under a blocker or hand-off. */
export type AgentRunReportAnswerFormProps = {
  /** Locale-aware text. */
  labels: AgentRunReportAnswerLabels
  /** Sends the answer and tells how it ended. */
  onAnswer: (body: string) => Promise<AgentRunReportAnswerResult>
  /** Draft kept from an earlier mount of the form, restored when it mounts again. */
  draft?: AgentRunReportAnswerDraft
  /** Receives the draft as it changes, or undefined once nothing is left to keep. */
  onDraftChange?: (draft: AgentRunReportAnswerDraft | undefined) => void
}

/**
 * Lets a member answer a blocker or hand-off that an agent reported. The form stays closed behind a
 * button so the conversation keeps its layout, keeps the text after a failure so it can be sent again,
 * and closes once the answer is saved. The unsent text is handed to `onDraftChange`, so a form that
 * unmounts, such as while the reports cannot be read, gets it back from `draft` when it returns.
 *
 * @param props - Text, send action, and draft.
 * @returns Answer button or form.
 */
export function AgentRunReportAnswerForm({ draft, labels, onAnswer, onDraftChange }: AgentRunReportAnswerFormProps) {
  const fieldId = useId()
  const errorId = useId()
  const [open, setOpen] = useState(draft?.open ?? false)
  const [body, setBody] = useState(draft?.body ?? '')
  useEffect(() => {
    onDraftChange?.(open || body !== '' ? { open, body } : undefined)
  }, [body, onDraftChange, open])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const trimmed = body.trim()
  const tooLong = trimmed.length > AGENT_RUN_REPORT_ANSWER_MAX_LENGTH
  const message = tooLong ? labels.tooLong.replace('{max}', String(AGENT_RUN_REPORT_ANSWER_MAX_LENGTH)) : error

  if (!open) {
    return (
      <button className="workbench-button-secondary h-7 px-2 text-xs" onClick={() => setOpen(true)} type="button">
        {labels.open}
      </button>
    )
  }

  /**
   * Sends the answer once and reports a failure next to the field.
   *
   * @param event - Form submission.
   */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (sending || trimmed === '' || tooLong) return
    setSending(true)
    setError(undefined)
    const result = await onAnswer(trimmed).catch((): AgentRunReportAnswerResult => 'failed')
    setSending(false)
    if (result === 'saved') {
      setBody('')
      setOpen(false)
      return
    }
    setError(result === 'conflict' ? labels.conflict : labels.failed)
  }

  return (
    <form
      aria-label={labels.label}
      className="mt-2 flex w-full flex-col gap-2"
      data-testid="agent-run-report-answer-form"
      onSubmit={(event) => { void submit(event) }}
    >
      <label className="sr-only" htmlFor={fieldId}>{labels.label}</label>
      <textarea
        aria-describedby={message ? errorId : undefined}
        aria-invalid={tooLong || undefined}
        className="workbench-input min-h-20 w-full p-2 text-sm"
        disabled={sending}
        id={fieldId}
        onChange={(event) => setBody(event.target.value)}
        placeholder={labels.placeholder}
        value={body}
      />
      {message ? <p className="text-sm text-[var(--workbench-danger)]" id={errorId} role="alert">{message}</p> : null}
      <div className="flex gap-2">
        <button className="workbench-button-primary h-8 px-3" disabled={sending || trimmed === '' || tooLong} type="submit">
          {labels.submit}
        </button>
        <button
          className="workbench-button-secondary h-8 px-3"
          disabled={sending}
          onClick={() => {
            setOpen(false)
            setError(undefined)
          }}
          type="button"
        >
          {labels.cancel}
        </button>
      </div>
    </form>
  )
}
