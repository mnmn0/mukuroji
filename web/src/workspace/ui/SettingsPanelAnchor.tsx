import { useEffect, type ReactNode } from 'react'
import { settingsPanelAnchorId, type SettingsPanelId } from '../model/settingsSections'

/** Inputs for a settings panel that a URL fragment can open. */
export type SettingsPanelAnchorProps = {
  /** Panel the fragment names. */
  panel: SettingsPanelId
  /** Panel content. */
  children: ReactNode
}

/**
 * Wraps a settings panel in an element whose ID a URL fragment can name.
 *
 * @param props - Panel and its content.
 * @returns The panel inside its anchor element.
 */
export function SettingsPanelAnchor({ children, panel }: SettingsPanelAnchorProps) {
  return (
    <div className="min-w-0 scroll-mt-4" data-settings-panel={panel} id={settingsPanelAnchorId(panel)}>
      {children}
    </div>
  )
}

/** How long to wait for a panel that renders after its data loads, in milliseconds. */
const PANEL_WAIT_MS = 3_000
/** How often to look for the panel while waiting, in milliseconds. */
const PANEL_POLL_MS = 100

/**
 * Scrolls to the settings panel a URL fragment names, once that panel is on the page.
 *
 * Panels render after their permissions and data load, so the browser's own fragment scroll
 * often runs before the panel exists. This keeps looking for a short while.
 *
 * @param hash - Current URL fragment, with the leading `#`.
 */
export function useSettingsPanelScroll(hash: string) {
  useEffect(() => {
    if (!hash.startsWith('#settings-')) return
    let id: string
    try {
      id = decodeURIComponent(hash.slice(1))
    } catch {
      return
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const element = document.getElementById(id)
      if (element) {
        window.clearInterval(timer)
        element.scrollIntoView({ block: 'start' })
      } else if (Date.now() - startedAt >= PANEL_WAIT_MS) {
        window.clearInterval(timer)
      }
    }, PANEL_POLL_MS)
    return () => window.clearInterval(timer)
  }, [hash])
}
