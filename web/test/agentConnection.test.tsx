import { describe, expect, test } from 'bun:test'
import type { PersonalAgentCredentialOverview } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  buildAgentConnectionSnippet,
  buildChecksumCommand,
  buildTokenEnvironmentCommand,
  resolveAgentConnectionOrigin,
  resolvePersonalKeyExpiryBounds,
  type AgentConnectionSettings,
} from '../src/developer-platform/model/agentConnection'
import {
  AgentConnectionPanel,
  type AgentConnectionPanelProps,
} from '../src/developer-platform/ui/AgentConnectionPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const settings: AgentConnectionSettings = {
  origin: 'https://mukuroji.example.com',
  teamId: 'team-core',
  memberId: 'taro@example.com',
  client: 'claude-code',
  mcpPath: '/Users/taro/mukuroji/mcp.mjs',
  shell: 'posix',
}

describe('agent connection snippets', () => {
  test('resolves the MCP origin from relative and absolute API base URLs', () => {
    expect(resolveAgentConnectionOrigin('/api', 'https://app.example.com')).toBe('https://app.example.com')
    expect(resolveAgentConnectionOrigin('https://api.example.com/api', 'https://app.example.com'))
      .toBe('https://api.example.com')
  })

  test('fills Claude Code, Codex, and Kiro configurations without the token value', () => {
    const claude = buildAgentConnectionSnippet(settings).content
    expect(claude).toContain('claude mcp add --scope user --transport stdio')
    expect(claude).toContain('--env MUKUROJI_MCP_ASSIGNEE_ID=taro@example.com')
    expect(claude).toContain('--env MUKUROJI_MCP_TEAM_ID=team-core')
    expect(claude).toContain('--env MUKUROJI_MCP_RUNTIME=claude-code')
    expect(claude).toContain("--env 'MUKUROJI_MCP_TOKEN=${MUKUROJI_MCP_TOKEN}'")
    expect(claude).toContain('mukuroji-tasks -- node /Users/taro/mukuroji/mcp.mjs')
    expect(claude).toContain(' \\\n  ')

    const codex = buildAgentConnectionSnippet({ ...settings, client: 'codex' })
    expect(codex.location).toBe('~/.codex/config.toml')
    expect(codex.content).toContain('args = ["/Users/taro/mukuroji/mcp.mjs"]')
    expect(codex.content).toContain('env_vars = ["MUKUROJI_MCP_TOKEN"]')
    expect(codex.content).toContain('MUKUROJI_MCP_RUNTIME = "codex"')

    const kiro = buildAgentConnectionSnippet({ ...settings, client: 'kiro' })
    expect(JSON.parse(kiro.content)).toEqual({
      mcpServers: {
        'mukuroji-tasks': {
          command: 'node',
          args: ['/Users/taro/mukuroji/mcp.mjs'],
          env: {
            MUKUROJI_MCP_URL: 'https://mukuroji.example.com',
            MUKUROJI_MCP_TEAM_ID: 'team-core',
            MUKUROJI_MCP_ASSIGNEE_ID: 'taro@example.com',
            MUKUROJI_MCP_AGENT_NAME: 'kiro',
            MUKUROJI_MCP_RUNTIME: 'kiro',
            MUKUROJI_MCP_TOKEN: '${MUKUROJI_MCP_TOKEN}',
          },
        },
      },
    })
  })

  test('uses Windows paths, PowerShell quoting, and line continuation', () => {
    const windows = { ...settings, shell: 'powershell' as const, mcpPath: 'C:\\Users\\Taro Y\\mcp.mjs' }
    const claude = buildAgentConnectionSnippet(windows).content
    expect(claude).toContain(' `\n  ')
    expect(claude).toContain("node 'C:\\Users\\Taro Y\\mcp.mjs'")
    expect(buildAgentConnectionSnippet({ ...windows, client: 'codex' }).content)
      .toContain('args = ["C:\\\\Users\\\\Taro Y\\\\mcp.mjs"]')
    expect(buildAgentConnectionSnippet({ ...windows, client: 'kiro' }).location)
      .toBe('%USERPROFILE%\\.kiro\\settings\\mcp.json')
    expect(buildAgentConnectionSnippet({ ...windows, mcpPath: '' }).content)
      .toContain('C:\\Users\\you\\mukuroji\\mcp.mjs')
    expect(buildTokenEnvironmentCommand('powershell', 'mk_key_abc'))
      .toBe("[Environment]::SetEnvironmentVariable('MUKUROJI_MCP_TOKEN', 'mk_key_abc', 'User')")
    expect(buildTokenEnvironmentCommand('posix', 'mk_key_abc')).toBe('export MUKUROJI_MCP_TOKEN=mk_key_abc')
    expect(buildChecksumCommand('powershell')).toContain('Get-FileHash .\\mcp.mjs -Algorithm SHA256')
    expect(buildChecksumCommand('posix')).toBe('shasum -a 256 -c mcp.mjs.sha256')
  })

  test('keeps the selectable expiry inside the server lifetime limit', () => {
    const bounds = resolvePersonalKeyExpiryBounds(new Date(2026, 10, 10, 9, 0), 90)
    expect(bounds).toEqual({ min: '2026-11-11', defaultValue: '2026-12-10', max: '2027-02-07' })
  })
})

const overview: PersonalAgentCredentialOverview = {
  memberId: 'taro@example.com',
  canIssue: true,
  policy: { selfIssuanceEnabled: true },
  scopes: ['work-items:read', 'work-items:write'],
  maxLifetimeDays: 90,
  apiKeys: [{
    id: 'key-1',
    name: 'Laptop',
    prefix: 'mk_key_abcd123',
    scopes: ['work-items:read', 'work-items:write'],
    status: 'active',
    createdByUserId: 'taro@example.com',
    createdAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
  }],
}

/** Renders the view with default props for the given overrides. */
function render(overrides: Partial<AgentConnectionPanelProps> = {}) {
  const noop = () => undefined
  return renderToStaticMarkup(
    <AgentConnectionPanel
      choices={{ client: 'claude-code', teamId: 'team-core', shell: 'posix', mcpPath: '' }}
      expiryBounds={{ min: '2026-11-11', max: '2027-02-07' }}
      form={{ name: '', expiryDate: '2026-12-10' }}
      formatDateTime={(value) => value}
      hasLoadError={false}
      hasOperationError={false}
      isLoading={false}
      onChoicesChange={noop}
      onDismissIssuedToken={noop}
      onFormChange={noop}
      onIssue={noop}
      onRetry={noop}
      onRevoke={noop}
      onRotate={noop}
      origin="https://mukuroji.example.com"
      overview={overview}
      t={createTranslator('ja')}
      teams={[{ id: 'team-core', name: 'Core' }]}
      {...overrides}
    />,
  )
}

describe('agent connection view', () => {
  test('shows the member ID, origin, and a configuration without any secret', () => {
    const html = render()
    expect(html).toContain('taro@example.com')
    expect(html).toContain('https://mukuroji.example.com')
    expect(html).toContain('MUKUROJI_MCP_TEAM_ID=team-core')
    expect(html).toContain('Laptop')
    expect(html).not.toContain('data-testid="issued-agent-token"')
  })

  test('shows the one-time token with the environment command only while it is kept', () => {
    const html = render({ issuedToken: { name: 'Laptop', secret: 'mk_key_secret_value' } })
    expect(html).toContain('data-testid="issued-agent-token"')
    expect(html).toContain('export MUKUROJI_MCP_TOKEN=mk_key_secret_value')
  })

  test('explains why issuance is blocked and hides the form', () => {
    const html = render({
      overview: { ...overview, canIssue: false, issuanceBlockedReason: 'policy-disabled' },
    })
    expect(html).toContain('管理者がメンバーによる token の発行を停止しています')
    expect(html).not.toContain('type="date"')
    expect(html).not.toContain('期限を更新して再発行')
    expect(html).toContain('失効')
  })
})
