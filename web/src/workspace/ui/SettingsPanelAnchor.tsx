import type { ReactNode } from 'react'
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
