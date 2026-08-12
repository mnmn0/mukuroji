import type { ComponentType } from 'react'
import type { TriageSourceKind } from '../api'
import {
  ChatIcon,
  FormIcon,
  HandoffIcon,
  MailIcon,
  WebhookIcon,
} from '../../shared/ui/icons'

/** Props accepted by the normalized triage source icon. */
export type TriageSourceIconProps = {
  /** Source channel represented by the icon. */
  readonly source: TriageSourceKind
  /** Optional CSS class override forwarded to the shared icon. */
  readonly className?: string
}

const sourceIcons: Record<TriageSourceKind, ComponentType<{ className?: string }>> = {
  chat: ChatIcon,
  email: MailIcon,
  form: FormIcon,
  'manual-handoff': HandoffIcon,
  webhook: WebhookIcon,
}

/**
 * Renders one source glyph through the shared Mukuroji icon boundary.
 *
 * @param props - Source channel and optional CSS class.
 * @returns A decorative source icon accompanied by visible text at the call site.
 */
export function TriageSourceIcon({ className, source }: TriageSourceIconProps) {
  const Icon = sourceIcons[source]
  return <Icon className={className} />
}
