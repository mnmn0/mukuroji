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
