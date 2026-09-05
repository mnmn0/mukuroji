import type { ComponentType } from 'react'
import {
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  FormIcon,
  MailIcon,
  MoreHorizontalIcon,
  PinIcon,
  ShieldIcon,
  StarIcon,
} from '../../shared/ui/icons'

/** Presentation props accepted by a Work Item Type icon. */
export type WorkItemTypeIconProps = {
  /** Stable icon token from the Work Item Type definition. */
  iconToken: string
  /** Optional CSS classes applied to the rendered icon. */
  className?: string
}

const workItemTypeIconRegistry: Readonly<
  Record<string, ComponentType<{ className?: string }>>
> = {
  archive: MoreHorizontalIcon,
  bug: ShieldIcon,
  check: CheckIcon,
  epic: StarIcon,
  folder: CopyIcon,
  inbox: MailIcon,
  incident: ShieldIcon,
  milestone: PinIcon,
  project: CopyIcon,
  request: MailIcon,
  story: FormIcon,
  task: CheckCircleIcon,
  'work-item': FormIcon,
}

/**
 * Renders the shared icon associated with a Work Item Type token.
 *
 * Unknown tokens intentionally use the generic Work Item icon so configuration data can be
 * displayed without letting an untrusted token become executable markup.
 *
 * @param props - Icon token and presentation options.
 * @returns Decorative Work Item Type icon markup.
 */
export function WorkItemTypeIcon({ className, iconToken }: WorkItemTypeIconProps) {
  const normalizedToken = iconToken.trim().toLowerCase()
  const Icon = workItemTypeIconRegistry[normalizedToken] ?? FormIcon

  return (
    <span aria-hidden="true" data-work-item-type-icon-token={iconToken}>
      <Icon className={className} />
    </span>
  )
}
