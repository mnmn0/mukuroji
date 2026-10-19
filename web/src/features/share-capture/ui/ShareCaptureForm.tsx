import { useId, useState } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import {
  sharedBodyMaxLength,
  sharedTitleMaxLength,
  type ShareHandoffDraft,
  type SharedContent,
} from '../model/sharedContent'

/** Team the shared content can be sent to. */
export type ShareCaptureTeam = {
  /** Team ID. */
  readonly id: string
  /** Team display name. */
  readonly name: string
}

/** A send whose outcome is unknown; the form shows it read-only and resends it unchanged. */
export type ShareCaptureLockedSend = {
  /** Destination Team. */
  readonly teamId: string
  /** Title and body as sent. */
  readonly draft: ShareHandoffDraft
}

/** Props accepted by the share capture form. */
export type ShareCaptureFormProps = {
  /** Content received from the share target, used as the initial values. */
  readonly initialContent: SharedContent
  /** Teams offered as destinations. */
  readonly teams: readonly ShareCaptureTeam[]
  /** Explains why sending is unavailable, replacing the form; for example, a guest account. */
  readonly unavailableMessage?: string
  /** Error shown after a failed send. */
  readonly errorMessage?: string
  /** Send to retry unchanged after an uncertain failure. */
  readonly lockedSend?: ShareCaptureLockedSend
  /** Whether a send is in progress. */
  readonly isSubmitting: boolean
  /** Leaves the form without sending. */
  readonly onCancel: () => void
  /** Sends the confirmed content to the selected Team. */
  readonly onSubmit: (teamId: string, draft: ShareHandoffDraft) => void
  /** Resolves localized labels. */
  readonly t: (key: MessageKey) => string
}

/**
 * Lets the person confirm shared content and choose the Team Triage queue that receives it.
 *
 * @param props - Initial content, destinations, send state, and callbacks.
 * @returns The share capture form.
 */
export function ShareCaptureForm({
  initialContent,
  teams,
  unavailableMessage,
  errorMessage,
  lockedSend,
  isSubmitting,
  onCancel,
  onSubmit,
  t,
}: ShareCaptureFormProps) {
  const id = useId()
  const [teamId, setTeamId] = useState(() => (teams.length === 1 ? teams[0]?.id ?? '' : ''))
  const [title, setTitle] = useState(initialContent.title)
  const [body, setBody] = useState(initialContent.body)
  const errorId = `${id}-error`
  const shownTeamId = lockedSend?.teamId ?? teamId
  const shownTitle = lockedSend?.draft.title ?? title
  const shownBody = lockedSend?.draft.body ?? body
  const isEditable = !isSubmitting && !lockedSend
  const message = unavailableMessage ?? (teams.length === 0 ? t('triage.share.noTeams') : undefined)
  const cancelButton = (
    <button
      aria-disabled={isSubmitting}
      className="workbench-button-secondary min-h-11 px-4 aria-disabled:opacity-60"
      onClick={() => {
        // Leaving mid-send would let the finished request navigate back here.
        if (!isSubmitting) onCancel()
      }}
      type="button"
    >
      {t('triage.share.cancel')}
    </button>
  )

  if (message) {
    return (
      <section aria-label={t('triage.share.title')} className="workbench-panel grid gap-4 p-5" data-testid="share-capture">
        <p className="text-sm text-[var(--workbench-text)]" role="status">{message}</p>
        <div className="flex flex-wrap justify-end gap-2">{cancelButton}</div>
      </section>
    )
  }

  return (
    <section aria-label={t('triage.share.title')} className="workbench-panel grid gap-4 p-5" data-testid="share-capture">
      <form
        aria-describedby={errorMessage ? errorId : undefined}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (isSubmitting) return
          if (!lockedSend && (!teamId || !title.trim())) return
          onSubmit(shownTeamId, { title: shownTitle, body: shownBody })
        }}
      >
        <fieldset className="contents" disabled={!isEditable}>
          <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('triage.share.team')}
            <select
              className="workbench-input min-h-11"
              onChange={(event) => { setTeamId(event.currentTarget.value) }}
              required
              value={shownTeamId}
            >
              <option disabled value="">{t('triage.share.teamPlaceholder')}</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('triage.share.entryTitle')}
            <input
              className="workbench-input min-h-11"
              maxLength={sharedTitleMaxLength}
              onChange={(event) => {
                const { value } = event.currentTarget
                // `required` accepts spaces, so report a blank title through native validation too.
                event.currentTarget.setCustomValidity(value.trim() ? '' : t('triage.share.titleRequired'))
                setTitle(value)
              }}
              required
              type="text"
              value={shownTitle}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('triage.share.body')}
            <textarea
              className="workbench-input min-h-40"
              maxLength={sharedBodyMaxLength}
              onChange={(event) => { setBody(event.currentTarget.value) }}
              value={shownBody}
            />
          </label>
        </fieldset>
        {errorMessage ? (
          <p className="rounded-lg border border-[var(--workbench-danger-border)] bg-[var(--workbench-danger-surface)] px-3 py-2 text-sm font-semibold text-[var(--workbench-danger)]" id={errorId} role="alert">{errorMessage}</p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {cancelButton}
          <button
            aria-disabled={isSubmitting}
            className="workbench-button-primary min-h-11 px-4 aria-disabled:opacity-60"
            type="submit"
          >
            {isSubmitting
              ? t('triage.share.submitting')
              : t(lockedSend ? 'triage.share.retry' : 'triage.share.submit')}
          </button>
        </div>
      </form>
    </section>
  )
}
