/**
 * Prints the GitHub Release notes for a coding agent MCP release tag.
 *
 * Usage: `bun server/scripts/coding-agent-mcp/release-notes.ts --tag mcp-v1.2.0 [--changelog CHANGELOG.md]`.
 * It fails when the tag does not match the version built into `mcp.mjs`, or when `CHANGELOG.md` has no
 * section for that version, so a release is never published without its changes recorded.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CODING_AGENT_MCP_API_REVISION } from '@mukuroji/contracts'
import { CODING_AGENT_MCP_VERSION } from '../../src/modules/coding-agent-mcp/application/compatibility'

/** Release tag format: `mcp-v` followed by a semantic version without pre-release or build metadata. */
const releaseTagPattern = /^mcp-v(\d+\.\d+\.\d+)$/u

/**
 * Reads the MCP version from a release tag.
 *
 * @param tag - Git tag name, such as `mcp-v1.2.0`.
 * @returns The version part of the tag.
 */
export function parseReleaseTag(tag: string): string {
  const version = releaseTagPattern.exec(tag)?.[1]
  if (version === undefined) throw new Error(`${tag} is not an MCP release tag; use mcp-v<major>.<minor>.<patch>.`)
  return version
}

/**
 * Returns the body of the `## [version]` section of a Keep a Changelog style file.
 *
 * @param changelog - Full CHANGELOG.md text.
 * @param version - Version whose section is read.
 * @returns The section body without its heading, trimmed.
 */
export function extractChangelogSection(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start === -1) throw new Error(`CHANGELOG.md has no "## [${version}]" section.`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
  if (body === '') throw new Error(`The CHANGELOG.md section for ${version} is empty.`)
  return body
}

/**
 * Builds the release notes: the CHANGELOG section followed by compatibility and verification steps.
 *
 * @param version - MCP version being released.
 * @param section - CHANGELOG section body for the version.
 * @param apiRevision - MCP API revision the build was built against.
 * @returns Markdown release notes.
 */
export function buildReleaseNotes(version: string, section: string, apiRevision: number): string {
  return [
    section,
    '',
    '## Compatibility',
    '',
    `mukuroji MCP ${version} uses MCP API revision ${apiRevision}. It works with servers whose \`GET /api/health\``,
    `reports \`codingAgentMcp.minimumApiRevision <= ${apiRevision} <= codingAgentMcp.apiRevision\`, and warns at startup otherwise.`,
    '',
    '## Verify the download',
    '',
    '```sh',
    'sha256sum -c mcp.mjs.sha256',
    'gh attestation verify mcp.mjs --repo mnmn0/mukuroji',
    'node mcp.mjs --version',
    '```',
    '',
  ].join('\n')
}

/**
 * Reads a command-line option value.
 *
 * @param args - Command-line arguments after the script path.
 * @param name - Option name including the leading dashes.
 * @returns The value, or undefined when the option is absent.
 */
function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value) throw new Error(`${name} needs a value.`)
  return value
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const tag = readOption(args, '--tag')
  if (tag === undefined) throw new Error('--tag is required, for example --tag mcp-v1.2.0.')
  const version = parseReleaseTag(tag)
  if (version !== CODING_AGENT_MCP_VERSION) {
    throw new Error(`${tag} does not match the MCP build version ${CODING_AGENT_MCP_VERSION}; update CODING_AGENT_MCP_VERSION first.`)
  }
  const changelogPath = resolve(readOption(args, '--changelog') ?? resolve(import.meta.dir, '../../../CHANGELOG.md'))
  const section = extractChangelogSection(await readFile(changelogPath, 'utf8'), version)
  process.stdout.write(buildReleaseNotes(version, section, CODING_AGENT_MCP_API_REVISION))
}
