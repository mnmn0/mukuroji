import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { createTranslator } from '../src/shared/i18n/i18n'
import { HomeWorkspaceView } from '../src/workspace/ui/HomeWorkspaceView'
import { WorkspaceSettingsView } from '../src/workspace/ui/WorkspaceSettingsView'

/**
 * Renders the personal settings view with or without the agent connection link.
 *
 * @param showAgentConnection - Whether the deployment serves Software factory.
 * @returns Static markup.
 */
function renderPersonalSettings(showAgentConnection: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WorkspaceSettingsView
        fontSizePreference="standard"
        locale="en"
        onFontSizePreferenceChange={() => undefined}
        onThemePreferenceChange={() => undefined}
        showAgentConnection={showAgentConnection}
        t={createTranslator('en')}
        themePreference="light"
        userLabel="demo@example.com"
      />
    </MemoryRouter>,
  )
}

describe('Software factory entries in personal settings', () => {
  test('links the agent connection page only when the deployment serves Software factory', () => {
    expect(renderPersonalSettings(true)).toContain('data-testid="agent-connection-settings-link"')
    const hidden = renderPersonalSettings(false)
    expect(hidden).not.toContain('data-testid="agent-connection-settings-link"')
    expect(hidden).not.toContain('href="/settings/agent-connection"')
    expect(hidden).toContain('data-testid="theme-preference-control"')
  })
})

/**
 * Renders the Workspace home with or without the coding-agent handoff banner.
 *
 * @param showCodingAgentHandoff - Whether the deployment serves Software factory.
 * @returns Static markup.
 */
function renderHome(showCodingAgentHandoff: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <HomeWorkspaceView
        showCodingAgentHandoff={showCodingAgentHandoff}
        summary={{ blocked: 0, projects: 0, tasks: 0 }}
        t={createTranslator('en')}
        teams={[]}
        workItemConfigurationsByTeam={{}}
      />
    </MemoryRouter>,
  )
}

describe('Software factory entries on the Workspace home', () => {
  test('links the coding agent guide only when the deployment serves Software factory', () => {
    const shown = renderHome(true)
    expect(shown).toContain('href="/help#coding-agent"')
    expect(shown).toContain('Connect a coding agent')
    const hidden = renderHome(false)
    expect(hidden).not.toContain('href="/help#coding-agent"')
    expect(hidden).not.toContain('Connect a coding agent')
    expect(hidden).toContain('Open tasks')
  })
})
