/** Shared presentation props accepted by workbench icons. */
type IconProps = {
  /** Optional class names that replace the default icon dimensions and stroke style. */
  className?: string
}

const iconClass =
  'h-[23px] w-[23px] fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]'

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
