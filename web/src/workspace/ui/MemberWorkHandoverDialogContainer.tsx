import type { MessageKey } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../api/access'
import { useMemberWorkHandover } from '../mutations/useMemberWorkHandover'
import { MemberWorkHandoverDialog } from './MemberWorkHandoverDialog'

/** Props of {@link MemberWorkHandoverDialogContainer}. */
export type MemberWorkHandoverDialogContainerProps = {
  /** Access token for the Work Item and bulk operation APIs. */
  accessToken: string
  /** Workspace that scopes the bulk request. */
  workspaceId: string
  /** Member whose open work is handed over. */
  member: WorkspaceMember
  /** Every Workspace member; active non-guest members other than `member` can take over. */
  members: readonly WorkspaceMember[]
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Closes the dialog. */
  onClose: () => void
}

/**
 * Connects the member handover dialog to the member's Work Items and the bulk operation API.
 *
 * @param props - Session, member, candidates, and close callback.
 * @returns The dialog.
 */
export function MemberWorkHandoverDialogContainer({
  accessToken,
  member,
  t,
  ...props
}: MemberWorkHandoverDialogContainerProps) {
  const { loadState, reload, handlers } = useMemberWorkHandover(accessToken, member.memberKey, t)
  return (
    <MemberWorkHandoverDialog
      {...props}
      handlers={handlers}
      loadState={loadState}
      member={member}
      t={t}
      onReload={reload}
    />
  )
}
