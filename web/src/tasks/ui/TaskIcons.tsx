import type { ReactNode } from 'react'
import type { TaskTab } from '../model/taskViewTypes'

/** アクセシブルラベル付きのタスク画面用アイコンボタンです。 */
export function IconButton({
  children,
  label,
  rounded = false,
}: {
  children: ReactNode
  label: string
  rounded?: boolean
}) {
  return (
    <button
      aria-label={label}
      className={`grid h-9 w-9 place-items-center text-[#505967] transition hover:bg-[#f3f4f6] hover:text-[#1c1d1f] focus:outline-none focus:ring-4 focus:ring-[#2563eb]/10 ${
        rounded ? 'rounded-full' : 'rounded-md'
      }`}
      type="button"
    >
      {children}
    </button>
  )
}

/** プロジェクトを表す小さなグリフです。 */
export function ProjectGlyph() {
  return (
    <span className="grid h-5 w-5 place-items-center rounded border border-[#d3d8df] bg-[#f3f4f6] text-app-micro font-semibold text-[#505967]">
      P
    </span>
  )
}

/** タスクビューの種別を示すタブアイコンです。 */
export function TabIcon({ tab }: { tab: TaskTab }) {
  const icons: Record<TaskTab, string> = {
    table: 'T',
    board: 'B',
    gantt: 'G',
    calendar: 'C',
    file: 'F',
    permissions: 'P',
  }

  return (
    <span
      aria-hidden="true"
      className="grid h-5 w-5 place-items-center rounded border border-[#d3d8df] bg-white text-[0.65rem] font-semibold text-[#505967]"
    >
      {icons[tab]}
    </span>
  )
}

function IconShell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className || 'h-5 w-5'}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  )
}

/** お気に入り操作のアイコンです。 */
export function StarIcon() {
  return (
    <IconShell>
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2 7.5 14 3 9.6l6.2-.9L12 3Z" />
    </IconShell>
  )
}

/** その他の操作を示すアイコンです。 */
export function MoreIcon() {
  return (
    <IconShell>
      <path d="M5 12h.01M12 12h.01M19 12h.01" />
    </IconShell>
  )
}

/** 共有メンバーを示すアイコンです。 */
export function UsersMiniIcon() {
  return (
    <IconShell>
      <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <circle cx="9.5" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </IconShell>
  )
}

/** 検索操作を示すアイコンです。 */
export function SearchIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <IconShell className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </IconShell>
  )
}

/** 追加操作を示すアイコンです。 */
export function PlusIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <IconShell className={className}>
      <path d="M12 5v14M5 12h14" />
    </IconShell>
  )
}

/** 通知操作を示すアイコンです。 */
export function BellOutlineIcon() {
  return (
    <IconShell>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </IconShell>
  )
}

/** フィルター操作を示すアイコンです。 */
export function FilterIcon() {
  return (
    <IconShell>
      <path d="M4 5h16l-6 7v5l-4 2v-7L4 5Z" />
    </IconShell>
  )
}

/** ステータスフィルターを示すアイコンです。 */
export function StatusIcon() {
  return (
    <IconShell>
      <path d="M6 14a6 6 0 1 0 12 0" />
      <path d="M12 2v6" />
      <path d="M8 6h8" />
    </IconShell>
  )
}

/** 担当者フィルターを示すアイコンです。 */
export function AssigneeIcon() {
  return (
    <IconShell>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </IconShell>
  )
}

/** 期限フィルターを示すアイコンです。 */
export function CalendarIcon() {
  return (
    <IconShell>
      <path d="M7 3v4M17 3v4M4 9h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z" />
    </IconShell>
  )
}

/** 優先度を示すアイコンです。 */
export function FlagIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <IconShell className={className}>
      <path d="M5 21V5" />
      <path d="M5 5h12l-1.5 4L17 13H5" />
    </IconShell>
  )
}

/** 選択済み状態を示すアイコンです。 */
export function CheckIcon() {
  return (
    <IconShell className="h-4 w-4">
      <path d="m5 12 4 4L19 6" />
    </IconShell>
  )
}
