type IconProps = {
  className?: string
}

const iconClass =
  'h-[23px] w-[23px] fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]'

export function MailIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6.5h16v11H4z" />
      <path d="m4.5 7 7.5 6 7.5-6" />
    </svg>
  )
}

export function LockIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 10h11v9h-11z" />
      <path d="M8.5 10V7.8a3.5 3.5 0 0 1 7 0V10" />
    </svg>
  )
}

export function EyeIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.8 12s3.4-5.2 9.2-5.2S21.2 12 21.2 12s-3.4 5.2-9.2 5.2S2.8 12 2.8 12z" />
      <circle cx="12" cy="12" r="2.4" />
    </svg>
  )
}

export function GlobeIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.8 12h16.4" />
      <path d="M12 3.5a13 13 0 0 1 0 17" />
      <path d="M12 3.5a13 13 0 0 0 0 17" />
    </svg>
  )
}

export function ChevronIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 9 5 5 5-5" />
    </svg>
  )
}

/**
 * Renders the shared form/document source icon.
 *
 * @param props - Optional CSS class override.
 * @returns A decorative form icon.
 */
export function FormIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3.5h9l3 3V20.5H6z" />
      <path d="M15 3.5v4h3" />
      <path d="M9 11h6M9 15h6" />
    </svg>
  )
}

/**
 * Renders the shared conversation source icon.
 *
 * @param props - Optional CSS class override.
 * @returns A decorative chat icon.
 */
export function ChatIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5h16v11H9l-5 4z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </svg>
  )
}

/**
 * Renders the shared webhook source icon.
 *
 * @param props - Optional CSS class override.
 * @returns A decorative webhook icon.
 */
export function WebhookIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.8 7.5a4 4 0 1 1 6.5 0" />
      <path d="M15.2 16.5a4 4 0 1 1-6.5 0" />
      <path d="M6.8 14a4 4 0 1 1 1.8-6.8" />
      <path d="m12 6-2.5 4.5h5L12 15" />
    </svg>
  )
}

/**
 * Renders the shared manual handoff source icon.
 *
 * @param props - Optional CSS class override.
 * @returns A decorative handoff icon.
 */
export function HandoffIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 8h11" />
      <path d="m12 5 3 3-3 3" />
      <path d="M20 16H9" />
      <path d="m12 13-3 3 3 3" />
    </svg>
  )
}

/**
 * Renders the shared clock icon.
 *
 * @param props - Optional CSS class override.
 * @returns A decorative clock icon.
 */
export function ClockIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

/**
 * Renders the shared shield icon.
 *
 * @param props - Optional CSS class override.
 * @returns A decorative shield icon.
 */
export function ShieldIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5 19 6v5.5c0 4.2-2.8 7.2-7 9-4.2-1.8-7-4.8-7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}
