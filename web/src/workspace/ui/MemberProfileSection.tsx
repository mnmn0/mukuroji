import { MEMBER_DISPLAY_NAME_MAX_LENGTH, readMemberDisplayName } from '@mukuroji/contracts'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSWRConfig } from 'swr'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createMutationRequestRunner,
} from '../../shared/api/mutationHeaders'
import { WorkspaceAccessApiError } from '../api/errors'
import { updateMemberProfile, type MemberProfile } from '../api/memberProfile'
import { useMemberProfile } from '../queries/useMemberProfile'

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
  const savedName = profile?.name ?? ''
  const [draft, setDraft] = useState(savedName)
  const [saving, setSaving] = useState(false)
  const [errorKey, setErrorKey] = useState<MessageKey>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setDraft(savedName)
  }, [savedName])

  const parsed = readMemberDisplayName(draft)
  const changed = parsed.ok && (parsed.name ?? '') !== savedName
  const editable = profile?.nameEditable === true && onSave !== undefined

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!profile || !onSave || !parsed.ok || !changed) return
    setSaving(true)
    setErrorKey(undefined)
    setSaved(false)
    try {
      await onSave(parsed.name, profile.version)
      setSaved(true)
    } catch (error) {
      setErrorKey(resolveSaveErrorKey(error))
    } finally {
      setSaving(false)
    }
  }

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
                setSaved(false)
                setErrorKey(undefined)
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
          {errorKey ? (
            <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
              {t(errorKey)}
            </p>
          ) : !parsed.ok ? (
            <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
              {t('workspace.settings.profile.invalid')}
            </p>
          ) : saved ? (
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
      ) : null}
    </section>
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
 * Loads the signed-in member's profile and saves display name changes.
 *
 * @param props - Access token, message resolver, and fallback label.
 * @returns The connected profile section.
 */
export function MemberProfileSectionContainer({
  accessToken,
  t,
  userLabel,
}: MemberProfileSectionContainerProps) {
  const { data, error, mutate } = useMemberProfile(accessToken)
  const { mutate: mutateCache } = useSWRConfig()
  const runner = useMemo(() => createMutationRequestRunner(), [])

  return (
    <MemberProfileSection
      loadFailed={Boolean(error) && !data}
      profile={data}
      t={t}
      userLabel={userLabel}
      onRetry={() => void mutate()}
      onSave={async (name, expectedVersion) => {
        const input = { name: name ?? null, expectedVersion }
        try {
          const profile = await runner.run(
            'member-profile:name',
            JSON.stringify(input),
            (context) => updateMemberProfile(accessToken, input, context),
            (failure) => !(failure instanceof WorkspaceAccessApiError),
          )
          await mutate(profile, { revalidate: false })
          // The member list on the Workspace settings shows this name too.
          void mutateCache(
            (key) => Array.isArray(key) && key[0] === 'workspace-access',
            undefined,
            { revalidate: true },
          )
        } catch (failure) {
          // A conflict means the member changed elsewhere; show the latest name.
          if (failure instanceof WorkspaceAccessApiError && failure.status === 409) void mutate()
          throw failure
        }
      }}
    />
  )
}
