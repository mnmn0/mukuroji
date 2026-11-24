import { useEffect } from 'react'

/** How long to wait for a panel that renders after its data loads, in milliseconds. */
const PANEL_WAIT_MS = 3_000
/** How often to look for the panel while waiting, in milliseconds. */
const PANEL_POLL_MS = 100

/**
 * Scrolls to the settings panel a URL fragment names, once that panel is on the page.
 *
 * Panels render after their permissions and data load, so the browser's own fragment scroll
 * often runs before the panel exists, and following the same in-page link again does not scroll
 * at all. This scrolls on every navigation to a panel fragment, waiting a short while for it.
 *
 * @param hash - Current URL fragment, with the leading `#`.
 * @param navigationKey - Key of the current navigation, so following the same link again scrolls again.
 */
export function useSettingsPanelScroll(hash: string, navigationKey: string) {
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
  }, [hash, navigationKey])
}
