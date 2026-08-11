/** Props for the compact assignee avatar used by task-view rows and cards. */
export type WorkItemAssigneeAvatarProps = {
  /** Assignee label whose first visible character becomes the avatar initial. */
  label?: string
}

/**
 * Renders a decorative initial beside a separately visible assignee label.
 *
 * @param props - Assignee label used to derive the initial.
 * @returns A compact non-interactive avatar.
 */
export function WorkItemAssigneeAvatar({ label }: WorkItemAssigneeAvatarProps) {
  const initial = label?.trim().charAt(0).toLocaleUpperCase() || '?'
  return (
    <span
      aria-hidden="true"
      className="grid h-6 w-6 flex-none place-items-center rounded-full bg-[#dceeea] text-[10px] font-bold text-[var(--workbench-primary)]"
      data-testid="work-item-assignee-avatar"
    >
      {initial}
    </span>
  )
}
