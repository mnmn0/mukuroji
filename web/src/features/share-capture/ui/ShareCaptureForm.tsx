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

/** Props accepted by the share capture form. */
export type ShareCaptureFormProps = {
  /** Content received from the share target, used as the initial values. */
  readonly initialContent: SharedContent
  /** Teams offered as destinations. */
  readonly teams: readonly ShareCaptureTeam[]
  /** Error shown after a failed send. */
  readonly errorMessage?: string
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
  errorMessage,
  isSubmitting,
  onCancel,
  onSubmit,
  t,
}: ShareCaptureFormProps) {
  const id = useId()
  const [teamId, setTeamId] = useState(() => (teams.length === 1 ? teams[0]?.id ?? '' : ''))
  const [title, setTitle] = useState(initialContent.title)
  const [body, setBody] = useState(initialContent.body)
  const titleId = `${id}-title`
  const errorId = `${id}-error`

  return (
    <section aria-labelledby={titleId} className="workbench-panel grid gap-4 p-5" data-testid="share-capture">
      <div>
        <h1 className="text-lg font-semibold text-[var(--workbench-text)]" id={titleId}>{t('triage.share.title')}</h1>
        <p className="mt-1 text-sm text-[var(--workbench-muted)]">{t('triage.share.description')}</p>
      </div>
      {teams.length === 0 ? (
        <p className="text-sm text-[var(--workbench-text)]" role="status">{t('triage.share.noTeams')}</p>
      ) : (
        <form
          aria-describedby={errorMessage ? errorId : undefined}
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (isSubmitting || !teamId || !title.trim()) return
            onSubmit(teamId, { title, body })
          }}
        >
          <fieldset className="contents" disabled={isSubmitting}>
            <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('triage.share.team')}
              <select
                className="workbench-input min-h-11"
                onChange={(event) => { setTeamId(event.currentTarget.value) }}
                required
                value={teamId}
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
                onChange={(event) => { setTitle(event.currentTarget.value) }}
                required
                type="text"
                value={title}
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('triage.share.body')}
              <textarea
                className="workbench-input min-h-40"
                maxLength={sharedBodyMaxLength}
                onChange={(event) => { setBody(event.currentTarget.value) }}
                value={body}
              />
            </label>
          </fieldset>
          {errorMessage ? (
            <p className="rounded-lg border border-[var(--workbench-danger-border)] bg-[var(--workbench-danger-surface)] px-3 py-2 text-sm font-semibold text-[var(--workbench-danger)]" id={errorId} role="alert">{errorMessage}</p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <button className="workbench-button-secondary min-h-11 px-4" onClick={onCancel} type="button">
              {t('triage.share.cancel')}
            </button>
            <button
              aria-disabled={isSubmitting}
              className="workbench-button-primary min-h-11 px-4 aria-disabled:opacity-60"
              type="submit"
            >
              {isSubmitting ? t('triage.share.submitting') : t('triage.share.submit')}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
