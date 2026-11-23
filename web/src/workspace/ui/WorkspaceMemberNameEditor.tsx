import { MEMBER_DISPLAY_NAME_MAX_LENGTH, readMemberDisplayName } from '@mukuroji/contracts'
import { useRef, useState, type FormEvent } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../api/access'

/** Inputs for correcting one member's display name in the member list. */
export type WorkspaceMemberNameEditorProps = {
  /** Member to rename. */
  member: WorkspaceMember
  /** Saves the new name; undefined removes it. Rejects on failure. */
  onSave: (name: string | undefined, expectedVersion: number) => Promise<void>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Suffix of the test IDs, unique per member. */
  testId: string
}

/**
 * Renders a button that opens an inline form to correct a member's display name.
 *
 * @param props - Member, save action, and message resolver.
 * @returns The rename button, or the inline form while editing.
 */
export function WorkspaceMemberNameEditor({ member, onSave, t, testId }: WorkspaceMemberNameEditorProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(member.name ?? '')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const parsed = readMemberDisplayName(draft)
  const renameButtonRef = useRef<HTMLButtonElement>(null)

  const close = () => {
    setEditing(false)
    // Closing the form removes the focused field, so focus goes back to the button that opened it
    // once it renders again.
    window.requestAnimationFrame(() => renameButtonRef.current?.focus())
  }

  if (!editing) {
    return (
      <button
        className="mt-1 text-xs font-semibold text-[var(--workbench-primary-text)] underline-offset-4 hover:underline"
        data-testid={`workspace-member-rename-${testId}`}
        ref={renameButtonRef}
        type="button"
        onClick={() => {
          setDraft(member.name ?? '')
          setFailed(false)
          setEditing(true)
        }}
      >
        {t('workspace.access.members.rename')}
      </button>
    )
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!parsed.ok) return
    setSaving(true)
    setFailed(false)
    try {
      await onSave(parsed.name, member.version)
      close()
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="mt-2 grid max-w-[360px] gap-2" onSubmit={(event) => void submit(event)}>
      <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('workspace.settings.profile.nameLabel')}
        <input
          aria-invalid={!parsed.ok}
          autoFocus
          className="workbench-input min-h-9 px-3 text-sm"
          data-testid={`workspace-member-rename-input-${testId}`}
          disabled={saving}
          maxLength={MEMBER_DISPLAY_NAME_MAX_LENGTH}
          placeholder={member.email}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      {!parsed.ok || failed ? (
        <p className="text-xs font-semibold text-[var(--workbench-danger)]" role="alert">
          {t(parsed.ok ? 'workspace.access.members.renameFailed' : 'workspace.settings.profile.invalid')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          className="workbench-button-primary min-h-9 px-3"
          data-testid={`workspace-member-rename-save-${testId}`}
          disabled={!parsed.ok || saving}
          type="submit"
        >
          {t('workspace.access.members.renameSave')}
        </button>
        <button
          className="workbench-button-secondary min-h-9 px-3"
          disabled={saving}
          type="button"
          onClick={close}
        >
          {t('workspace.access.members.renameCancel')}
        </button>
      </div>
    </form>
  )
}
