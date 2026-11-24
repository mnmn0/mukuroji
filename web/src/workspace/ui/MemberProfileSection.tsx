import { MEMBER_DISPLAY_NAME_MAX_LENGTH, readMemberDisplayName } from '@mukuroji/contracts'
import { useState, type FormEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import { WorkspaceAccessApiError } from '../api/errors'
import type { MemberProfile } from '../api/memberProfile'
import { useMemberProfileController } from '../mutations/useMemberProfileController'

/** Inputs for the signed-in member's profile section. */
export type MemberProfileSectionProps = {
  /** Loaded profile, or undefined while it loads or after a failed load. */
  profile?: MemberProfile
  /** Whether loading the profile failed. */
  loadFailed?: boolean
  /** Loads the profile again after a failure. */
  onRetry?: () => void
  /** Saves a new display name; undefined removes it. Rejects with the API error on failure. */
  onSave?: (name: string | undefined, expectedVersion: number) => Promise<void>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Signed-in account label shown until the profile loads. */
  userLabel: string
}

/**
 * Maps a failed name change to the message shown under the field.
 *
 * @param error - Error the save rejected with.
 * @returns Message key for the failure.
 */
function resolveSaveErrorKey(error: unknown): MessageKey {
  if (error instanceof WorkspaceAccessApiError) {
    if (error.code === 'WorkspaceVersionConflict' || error.code === 'WorkspaceTransactionConflict') {
      return 'workspace.settings.profile.conflict'
    }
    if (error.code === 'WorkspaceMemberNameDirectoryManaged') {
      return 'workspace.settings.profile.directoryManaged'
    }
    if (error.code === 'InvalidWorkspaceMemberName') {
      return 'workspace.settings.profile.invalid'
    }
  }
  return 'workspace.settings.profile.saveFailed'
}

/**
 * Renders the signed-in member's profile: the display name others see, and the email address.
 *
 * The name form starts again from the saved name whenever the saved profile changes (a save, or a
 * reload after a conflict), because it is keyed by the member version.
 *
 * @param props - Profile state, save action, and message resolver.
 * @returns The profile section.
 */
export function MemberProfileSection({
  loadFailed = false,
  onRetry,
  onSave,
  profile,
  t,
  userLabel,
}: MemberProfileSectionProps) {
  const [notice, setNotice] = useState<{ kind: 'saved' } | { kind: 'error'; key: MessageKey }>()

  return (
    <section className="workbench-panel p-5" data-testid="settings-profile">
      <p className="workbench-eyebrow">{t('workspace.user.label')}</p>
      <h2 className="mt-2 text-lg font-semibold text-[var(--workbench-text)]">
        {t('workspace.settings.profileTitle')}
      </h2>
      <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
        {t('workspace.settings.profileDescription')}
      </p>
      <p className="mt-3 break-all text-sm font-medium text-[var(--workbench-muted)]" data-testid="settings-profile-email">
        {profile?.email ?? userLabel}
      </p>
      {loadFailed ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
            {t('workspace.settings.profile.loadFailed')}
          </p>
          {onRetry ? (
            <button className="workbench-button-secondary min-h-10 px-4" onClick={onRetry} type="button">
              {t('workspace.settings.profile.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
      {profile ? (
        <MemberProfileNameForm
          key={`${profile.version}:${profile.name ?? ''}`}
          notice={notice}
          profile={profile}
          t={t}
          onEdit={() => setNotice(undefined)}
          onSave={onSave === undefined ? undefined : async (name) => {
            setNotice(undefined)
            try {
              await onSave(name, profile.version)
              setNotice({ kind: 'saved' })
            } catch (error) {
              setNotice({ kind: 'error', key: resolveSaveErrorKey(error) })
            }
          }}
        />
      ) : null}
    </section>
  )
}

/** Inputs for the display name form of one saved profile. */
type MemberProfileNameFormProps = {
  /** Saved profile the form starts from. */
  profile: MemberProfile
  /** Result of the last save, shown under the field. */
  notice?: { kind: 'saved' } | { kind: 'error'; key: MessageKey }
  /** Clears the last result when the member edits the name. */
  onEdit: () => void
  /** Saves the name; undefined removes it. Resolves after the result is recorded. */
  onSave?: (name: string | undefined) => Promise<void>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders the editable display name of one saved profile.
 *
 * @param props - Saved profile, last result, and save action.
 * @returns The name form.
 */
function MemberProfileNameForm({ notice, onEdit, onSave, profile, t }: MemberProfileNameFormProps) {
  const savedName = profile.name ?? ''
  const [draft, setDraft] = useState(savedName)
  const [saving, setSaving] = useState(false)
  const parsed = readMemberDisplayName(draft)
  const changed = parsed.ok && (parsed.name ?? '') !== savedName
  const editable = profile.nameEditable && onSave !== undefined

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!onSave || !parsed.ok || !changed) return
    setSaving(true)
    try {
      await onSave(parsed.name)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="mt-4 grid max-w-[560px] gap-2" onSubmit={(event) => void submit(event)}>
      <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
        {t('workspace.settings.profile.nameLabel')}
        <input
          aria-describedby="settings-profile-name-help"
          aria-invalid={!parsed.ok}
          className="workbench-input min-h-10 px-3 text-sm disabled:cursor-not-allowed disabled:bg-[var(--workbench-surface-muted)]"
          data-testid="settings-profile-name"
          disabled={!editable || saving}
          maxLength={MEMBER_DISPLAY_NAME_MAX_LENGTH}
          placeholder={profile.email}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            onEdit()
          }}
        />
      </label>
      <p
        className="text-sm font-medium leading-6 text-[var(--workbench-muted)]"
        id="settings-profile-name-help"
      >
        {t(profile.nameEditable
          ? 'workspace.settings.profile.nameHelp'
          : 'workspace.settings.profile.directoryManaged')}
      </p>
      {!parsed.ok ? (
        <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
          {t('workspace.settings.profile.invalid')}
        </p>
      ) : notice?.kind === 'error' ? (
        <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
          {t(notice.key)}
        </p>
      ) : notice?.kind === 'saved' ? (
        <p className="text-sm font-semibold text-[var(--workbench-success)]" role="status">
          {t('workspace.settings.profile.saved')}
        </p>
      ) : null}
      {editable ? (
        <button
          className="workbench-button-primary min-h-10 w-fit px-4"
          data-testid="settings-profile-save"
          disabled={!changed || saving}
          type="submit"
        >
          {t(saving ? 'workspace.settings.profile.saving' : 'workspace.settings.profile.save')}
        </button>
      ) : null}
    </form>
  )
}

/** Inputs for the profile section connected to the profile API. */
export type MemberProfileSectionContainerProps = {
  /** Cognito access token. */
  accessToken: string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Signed-in account label shown until the profile loads. */
  userLabel: string
}

/**
 * Connects the profile controller to the profile section.
 *
 * @param props - Access token, message resolver, and fallback label.
 * @returns The connected profile section.
 */
export function MemberProfileSectionContainer({
  accessToken,
  t,
  userLabel,
}: MemberProfileSectionContainerProps) {
  const controller = useMemberProfileController(accessToken)

  return (
    <MemberProfileSection
      loadFailed={controller.loadFailed}
      profile={controller.profile}
      t={t}
      userLabel={userLabel}
      onRetry={controller.retry}
      onSave={controller.saveName}
    />
  )
}
