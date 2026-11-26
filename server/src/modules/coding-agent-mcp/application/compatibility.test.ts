import { expect, test } from 'bun:test'
import { assessServerCompatibility, CODING_AGENT_MCP_VERSION, describeCodingAgentMcpBuild } from './compatibility'

test('describes this build with a semantic version and the shared MCP API revision', () => {
  expect(CODING_AGENT_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/u)
  expect(describeCodingAgentMcpBuild()).toEqual({ version: CODING_AGENT_MCP_VERSION, apiRevision: 6 })
})

test('accepts a build whose revision is inside the server range', () => {
  for (const apiRevision of [2, 3, 4]) {
    expect(assessServerCompatibility({ apiRevision: 4, minimumApiRevision: 2 }, apiRevision).status).toBe('compatible')
  }
})

test('tells which side to update when the build is outside the server range', () => {
  const serverOutdated = assessServerCompatibility({ apiRevision: 2, minimumApiRevision: 1 }, 3)
  expect(serverOutdated).toMatchObject({ status: 'server_outdated', server: { apiRevision: 2, minimumApiRevision: 1 } })
  expect(serverOutdated.message).toContain('needs a newer server')
  const mcpOutdated = assessServerCompatibility({ apiRevision: 6, minimumApiRevision: 3 }, 2)
  expect(mcpOutdated.status).toBe('mcp_outdated')
  expect(mcpOutdated.message).toContain('Download the latest mcp.mjs')
})

test('reports an unknown status when the server does not report a range', () => {
  const unknown = assessServerCompatibility(undefined, 1)
  expect(unknown.status).toBe('unknown')
  expect(unknown).not.toHaveProperty('server')
})
