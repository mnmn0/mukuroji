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
      className="grid h-11 w-11 flex-none place-items-center rounded-lg border border-slate-300 bg-white text-[#0d1833] shadow-[0_8px_18px_rgba(30,52,88,0.04)] transition hover:border-blue-500 hover:text-blue-600 min-[981px]:hidden"
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
