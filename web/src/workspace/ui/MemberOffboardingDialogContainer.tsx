import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../api/access'
import { useMemberOffboardingActions } from '../mutations/useMemberOffboardingActions'
import { useWorkspaceAccess } from '../queries/useWorkspaceAccess'
import { useWorkspaceMemberOffboarding } from '../queries/useWorkspaceMemberOffboarding'
import { MemberOffboardingDialog, type MemberOffboardingLoadState } from './MemberOffboardingDialog'

/** Props of {@link MemberOffboardingDialogContainer}. */
export type MemberOffboardingDialogContainerProps = {
  /** Access token of the administrator's session. */
  accessToken: string
  /** Member who is leaving, as the member list shows them now. */
  member: WorkspaceMember
  /** Every Workspace member; active, unexpired non-guest members other than `member` can take over. */
  members: readonly WorkspaceMember[]
  /** Whether the administrator can set an access expiry on the member. */
  canEditAccessExpiry: boolean
  /**
   * Saves or clears the member's access expiry and reloads the member list.
   *
   * @param accessExpiresAt - ISO 8601 instant access ends, or null to clear it.
   */
  onSaveAccessExpiry: (accessExpiresAt: string | null) => Promise<void>
  /** Opens the handover of the member's open Work Items; absent hides the link. */
  onOpenWorkHandover?: () => void
  /** Display locale of dates. */
  locale: Locale
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Closes the dialog. */
  onClose: () => void
}

/**
 * Connects the member offboarding dialog to the handover summary and the handover APIs.
 *
 * @param props - Session, member, candidates, and callbacks.
 * @returns The dialog.
 */
export function MemberOffboardingDialogContainer({
  accessToken,
  member,
  onSaveAccessExpiry,
  ...props
}: MemberOffboardingDialogContainerProps) {
  const query = useWorkspaceMemberOffboarding(accessToken, member.memberKey)
  const { mutate } = query
  // A Project handover raises the Workspace member versions, so the member list is read again too.
  const { mutate: reloadMembers } = useWorkspaceAccess(accessToken)
  const actions = useMemberOffboardingActions(accessToken, member.memberKey, mutate, reloadMembers)
  const loadState: MemberOffboardingLoadState = query.data
    ? { status: 'loaded', offboarding: query.data }
    : query.error
      ? { status: 'failed' }
      : { status: 'loading' }
  return (
    <MemberOffboardingDialog
      {...props}
      actions={actions}
      loadState={loadState}
      member={member}
      onReload={() => {
        void mutate()
      }}
      onSaveAccessExpiry={async (accessExpiresAt) => {
        try {
          await onSaveAccessExpiry(accessExpiresAt)
        } finally {
          await mutate()
        }
      }}
    />
  )
}
