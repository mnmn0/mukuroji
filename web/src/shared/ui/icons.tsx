/** Shared presentation props accepted by workbench icons. */
type IconProps = {
  /** Optional class names that replace the default icon dimensions and stroke style. */
  className?: string
}

const iconClass =
  'h-[23px] w-[23px] fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]'
const iconStrokeClass =
  'h-[23px] w-[23px] stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]'

/**
 * Renders the shared mail outline icon.
 *
 * @param props - Optional icon presentation props.
 * @returns Decorative mail icon markup.
 */
export function MailIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6.5h16v11H4z" />
      <path d="m4.5 7 7.5 6 7.5-6" />
    </svg>
  )
}

/**
 * Renders the shared lock outline icon.
 *
 * @param props - Optional icon presentation props.
 * @returns Decorative lock icon markup.
 */
export function LockIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 10h11v9h-11z" />
      <path d="M8.5 10V7.8a3.5 3.5 0 0 1 7 0V10" />
    </svg>
  )
}

/**
 * Renders the shared visibility outline icon.
 *
 * @param props - Optional icon presentation props.
 * @returns Decorative visibility icon markup.
 */
export function EyeIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.8 12s3.4-5.2 9.2-5.2S21.2 12 21.2 12s-3.4 5.2-9.2 5.2S2.8 12 2.8 12z" />
      <circle cx="12" cy="12" r="2.4" />
    </svg>
  )
}

/**
 * Renders the shared globe outline icon.
 *
 * @param props - Optional icon presentation props.
 * @returns Decorative globe icon markup.
 */
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

/**
 * Renders the shared chevron outline icon.
 *
 * @param props - Optional icon presentation props.
 * @returns Decorative chevron icon markup.
 */
export function ChevronIcon({ className = iconClass }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 9 5 5 5-5" />
    </svg>
  )
}

/**
 * Renders the shared notification-watch icon.
 *
 * @param props - Optional class name and filled state. Custom class names should not add `fill-*` utilities.
 * @returns A decorative bell icon.
 */
export function WatchIcon({
  className = iconStrokeClass,
  filled = false,
}: IconProps & { filled?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`${className} ${filled ? 'fill-current' : 'fill-none'}`}
      viewBox="0 0 24 24"
    >
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
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
 * Renders the shared copy outline icon.
 *
 * @param props - Optional icon presentation props.
 * @returns Decorative copy icon markup.
 */
export function CopyIcon({ className = iconClass }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <rect height="12" rx="2" width="12" x="8" y="8" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
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
 * Renders the shared view-settings sliders outline icon.
 *
 * @param props - Optional icon presentation props.
 * @returns Decorative sliders icon markup.
 */
export function SlidersIcon({ className = iconClass }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="M4 7h7M15 7h5M4 17h4M12 17h8" />
      <circle cx="13" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
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
 * Renders the shared star outline icon, optionally filled.
 *
 * @param props - Icon presentation and fill state.
 * @returns Decorative star icon markup.
 */
export function StarIcon({ className = iconClass, filled = false }: IconProps & {
  /** Whether the star interior is filled. */
  filled?: boolean
}) {
  return (
    <svg
      aria-hidden="true"
      className={`${className} ${filled ? 'fill-current' : 'fill-none'}`}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
    </svg>
  )
}

/**
 * Renders the shared completed or accepted-state icon.
 *
 * @param props - Optional class name.
 * @returns A decorative check enclosed by a circle.
 */
export function CheckCircleIcon({ className = iconClass }: IconProps) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.5 2.5L16.5 9" />
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
 * Renders the shared pin outline icon, optionally filled.
 *
 * @param props - Icon presentation and fill state.
 * @returns Decorative pin icon markup.
 */
export function PinIcon({ className = iconClass, filled = false }: IconProps & {
  /** Whether the pin interior is filled. */
  filled?: boolean
}) {
  return (
    <svg
      aria-hidden="true"
      className={`${className} ${filled ? 'fill-current' : 'fill-none'}`}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="m9 4 6 0-.8 5 3.3 3.3v1.2h-4.7L12 21l-.8-7.5H6.5v-1.2L9.8 9z" />
    </svg>
  )
}

/**
 * Renders the shared external-link icon.
 *
 * @param props - Optional class name.
 * @returns A decorative arrow leaving a square.
 */
export function ExternalLinkIcon({ className = iconClass }: IconProps) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
      <path d="M14 5h5v5" />
      <path d="m12 12 7-7" />
      <path d="M19 13v6H5V5h6" />
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
 * Renders the shared checkmark outline icon.
 *
 * @param props - Optional icon presentation props.
 * @returns Decorative checkmark icon markup.
 */
export function CheckIcon({ className = iconClass }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="m5 12 4.2 4.2L19 6.5" />
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

/**
 * Renders the shared horizontal overflow icon.
 *
 * @param props - Optional icon presentation props.
 * @returns Decorative horizontal overflow icon markup.
 */
export function MoreHorizontalIcon({ className = iconClass }: IconProps) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}
