import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { createTranslator } from '../src/shared/i18n/i18n'
import { codingAgentConfigurationTemplate } from '../src/workspace/model/codingAgentGuide'
import { HelpWorkspaceView } from '../src/workspace/ui/HelpWorkspaceView'

describe('Coding agent connection guide', () => {
  test('copies the documented configuration without introducing credential fields', () => {
    const guide = readFileSync(new URL('../../docs/coding-agent-mcp.md', import.meta.url), 'utf8')
    const documentedConfiguration = guide.match(/```json\n([\s\S]*?)\n```/)?.[1]
    expect(documentedConfiguration).toBeDefined()
    expect(JSON.parse(codingAgentConfigurationTemplate)).toEqual(JSON.parse(documentedConfiguration ?? '{}'))
    expect(codingAgentConfigurationTemplate).not.toContain('MUKUROJI_MCP_TOKEN')
    expect(codingAgentConfigurationTemplate).not.toContain('Authorization')
  })

  test.each(['en', 'ja'] as const)('provides an addressable Help guide and honest runtime limits in %s', (locale) => {
    const t = createTranslator(locale)
    const html = renderToStaticMarkup(
      <MemoryRouter><HelpWorkspaceView t={t} /></MemoryRouter>,
    )
    expect(html).toContain('id="coding-agent"')
    expect(html).toContain('href="/settings"')
    expect(html).toContain('work-items:read')
    expect(html).toContain('work-items:write')
    expect(html).toContain('start_task')
    expect(html).toContain('idempotencyKey')
    expect(html).toContain('heartbeat')
    expect(html).toContain('role="status"')
    expect(html).toContain('readOnly=""')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('type="password"')
  })
})
