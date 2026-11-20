import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CODING_AGENT_MCP_VERSION } from '../../src/modules/coding-agent-mcp/application/compatibility'
import { buildReleaseNotes, extractChangelogSection, parseReleaseTag } from './release-notes'

const changelog = `# Changelog

## [Unreleased]

- Pending change.

## [1.1.0] - 2026-12-01

### Added

- New tool.

## [1.0.0] - 2026-11-20

- First release.
`

test('reads the version from an MCP release tag and rejects other tags', () => {
  expect(parseReleaseTag('mcp-v1.2.3')).toBe('1.2.3')
  for (const tag of ['v1.2.3', 'mcp-v1.2', 'mcp-v1.2.3-rc.1', 'mcp-v1.2.3\n', 'refs/tags/mcp-v1.2.3']) {
    expect(() => parseReleaseTag(tag)).toThrow('not an MCP release tag')
  }
})

test('extracts only the requested CHANGELOG section', () => {
  expect(extractChangelogSection(changelog, '1.1.0')).toBe('### Added\n\n- New tool.')
  expect(extractChangelogSection(changelog, '1.0.0')).toBe('- First release.')
  expect(() => extractChangelogSection(changelog, '2.0.0')).toThrow('no "## [2.0.0]" section')
  expect(() => extractChangelogSection('## [3.0.0]\n\n## [2.0.0]\n- x', '3.0.0')).toThrow('is empty')
})

test('appends compatibility and verification steps to the release notes', () => {
  const notes = buildReleaseNotes('1.0.0', '- First release.', 1)
  expect(notes.startsWith('- First release.\n')).toBe(true)
  expect(notes).toContain('MCP API revision 1')
  expect(notes).toContain('sha256sum -c mcp.mjs.sha256')
  expect(notes).toContain('gh attestation verify mcp.mjs --repo mnmn0/mukuroji')
})

test('the repository CHANGELOG has a section for the current MCP build version', async () => {
  const repositoryChangelog = await readFile(resolve(import.meta.dir, '../../../CHANGELOG.md'), 'utf8')
  expect(extractChangelogSection(repositoryChangelog, CODING_AGENT_MCP_VERSION).length).toBeGreaterThan(0)
})
