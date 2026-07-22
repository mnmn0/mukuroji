/**
 * MobileSidebarButton に渡す props です。
 */
export type MobileSidebarButtonProps = {
  /**
   * スクリーンリーダー用のボタンラベルです。
   */
  label: string
  /**
   * ボタンクリック時に呼ばれる callback です。
   */
  onClick: () => void
}

/**
 * モバイル表示時にサイドバーを開くためのハンバーガーボタンです。
 */
export function MobileSidebarButton({ label, onClick }: MobileSidebarButtonProps) {
  return (
    <button
      aria-label={label}
      className="grid h-11 w-11 flex-none place-items-center rounded-lg border border-[var(--workbench-border-strong)] bg-white text-[var(--workbench-text)] shadow-[0_1px_2px_rgba(23,32,29,0.04)] transition hover:border-[var(--workbench-primary)] hover:text-[var(--workbench-primary)] min-[981px]:hidden"
      type="button"
      onClick={onClick}
    >
      <span className="grid gap-1" aria-hidden="true">
        <span className="h-0.5 w-5 rounded-full bg-current" />
        <span className="h-0.5 w-5 rounded-full bg-current" />
        <span className="h-0.5 w-5 rounded-full bg-current" />
      </span>
    </button>
  )
}
