import { MobileSidebarDrawer } from './MobileSidebarDrawer'
import { Sidebar, type SidebarProps } from './Sidebar'

/**
 * デスクトップ表示とモバイルドロワー表示をまとめた Workspace 共通サイドバーの入力です。
 */
export type WorkspaceSidebarProps = Omit<SidebarProps, 'className'> & {
  /**
   * デスクトップ用サイドバーに追加する CSS class です。
   */
  desktopClassName?: string
  /**
   * モバイル用サイドバーを表示するかどうかです。
   */
  isMobileOpen: boolean
  /**
   * モバイル用ドロワーの close button の aria-label です。
   */
  mobileCloseLabel: string
  /**
   * モバイル用ドロワーのアクセシブルな dialog 名です。
   */
  mobileDialogLabel: string
  /**
   * モバイル用ドロワーを閉じる callback です。
   */
  onMobileClose: () => void
  /**
   * 選択操作の後にモバイル用ドロワーを閉じるかどうかです。
   *
   * 画面遷移前に未保存状態の確認などを行う画面では false を指定し、
   * callback 側で処理成功後にドロワーを閉じます。
   */
  closeMobileOnSelect?: boolean
}

/**
 * 認証済み Workspace で共通利用するデスクトップ/モバイルサイドバーです。
 *
 * サイドバーの表示モードごとの差分と、モバイル選択時のドロワー close 処理を
 * このコンポーネントに集約します。
 */
export function WorkspaceSidebar({
  closeMobileOnSelect = true,
  desktopClassName = 'max-[980px]:hidden',
  isMobileOpen,
  mobileCloseLabel,
  mobileDialogLabel,
  onMobileClose,
  ...sidebarProps
}: WorkspaceSidebarProps) {
  const mobileSidebarProps = createMobileSidebarProps(
    sidebarProps,
    closeMobileOnSelect ? onMobileClose : undefined,
  )

  return (
    <>
      <Sidebar
        {...sidebarProps}
        className={desktopClassName}
      />
      <MobileSidebarDrawer
        closeLabel={mobileCloseLabel}
        dialogLabel={mobileDialogLabel}
        isOpen={isMobileOpen}
        onClose={onMobileClose}
      >
        <Sidebar {...mobileSidebarProps} />
      </MobileSidebarDrawer>
    </>
  )
}

/**
 * Creates sidebar props that close the mobile drawer after selection.
 *
 * @param sidebarProps - Shared desktop sidebar behavior to adapt.
 * @param onMobileSelect - Optional callback that closes the mobile drawer.
 * @returns Sidebar props with mobile selection behavior applied.
 */
function createMobileSidebarProps(
  sidebarProps: Omit<SidebarProps, 'className'>,
  onMobileSelect?: () => void,
): SidebarProps {
  /** Wraps a selection callback while preserving drawer close behavior. */
  const wrapSelection = <Arguments extends unknown[]>(
    callback: ((...args: Arguments) => void) | undefined,
  ) => (...args: Arguments) => {
    onMobileSelect?.()
    callback?.(...args)
  }
  /** Keeps optional UI actions unavailable when their source callback is absent. */
  const wrapOptionalSelection = <Arguments extends unknown[]>(
    callback: ((...args: Arguments) => void) | undefined,
  ) => callback ? wrapSelection(callback) : undefined

  return {
    ...sidebarProps,
    collapsed: undefined,
    defaultCollapsed: undefined,
    onCollapsedChange: undefined,
    onOpenSearch: wrapOptionalSelection(sidebarProps.onOpenSearch),
    onSelectNav: wrapSelection(sidebarProps.onSelectNav),
    onSelectTeamView: wrapSelection(sidebarProps.onSelectTeamView),
    onSelectProject: wrapSelection(sidebarProps.onSelectProject),
    onShowAllQuickAccess: wrapOptionalSelection(sidebarProps.onShowAllQuickAccess),
    onShowAllProjects: wrapOptionalSelection(sidebarProps.onShowAllProjects),
  }
}
