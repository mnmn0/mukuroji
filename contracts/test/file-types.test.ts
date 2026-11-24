import { describe, expect, test } from 'bun:test'
import {
  BLOCKED_FILE_CONTENT_TYPES,
  BLOCKED_FILE_EXTENSIONS,
  DEFAULT_WORKSPACE_FILE_TYPE_SETTINGS,
  FILE_TYPE_CATALOG,
  createWorkspaceFileTypeSettings,
  findFileTypeByContentType,
  isFileTypeAllowed,
  listAllowedFileTypes,
  readFileTypeRejection,
  readWorkspaceFileTypeSettings,
  resolveFileType,
} from '../src/file-types'

/**
 * Resolves a file and returns the matched type identifier or the failure kind.
 *
 * @param fileName - File name.
 * @param contentType - Reported media type.
 * @returns Matched identifier, `dangerous`, or `unrecognized`.
 */
function resolveId(fileName: string, contentType = ''): string {
  const resolution = resolveFileType(fileName, contentType)
  return resolution.kind === 'known' ? resolution.type.id : resolution.kind
}

describe('File type catalog', () => {
  test('never lists a dangerous extension or media type as a known type', () => {
    const blockedExtensions = new Set(BLOCKED_FILE_EXTENSIONS)
    const blockedContentTypes = new Set(BLOCKED_FILE_CONTENT_TYPES)
    for (const type of FILE_TYPE_CATALOG) {
      for (const extension of type.extensions) expect(blockedExtensions.has(extension)).toBeFalse()
      for (const contentType of [type.contentType, ...type.contentTypeAliases]) {
        expect(blockedContentTypes.has(contentType)).toBeFalse()
      }
    }
  })

  test('keeps extensions and media types unique across types', () => {
    const extensions = FILE_TYPE_CATALOG.flatMap((type) => type.extensions)
    const contentTypes = FILE_TYPE_CATALOG.flatMap((type) => [type.contentType, ...type.contentTypeAliases])
    expect(new Set(extensions).size).toBe(extensions.length)
    expect(new Set(contentTypes).size).toBe(contentTypes.length)
  })

  test('accepts the WBS deliverables by default, even when the browser reports no media type', () => {
    expect(resolveId('wbs.md')).toBe('markdown')
    expect(resolveId('old-plan.xls', 'application/vnd.ms-excel')).toBe('xls')
    expect(resolveId('macro.xlsm', 'application/vnd.ms-excel.sheet.macroenabled.12')).toBe('xlsm')
    expect(resolveId('macro.XLSM', 'application/octet-stream')).toBe('xlsm')
    expect(resolveId('flow.drawio', 'application/octet-stream')).toBe('drawio')
    expect(resolveId('server.log')).toBe('text')
    expect(resolveId('backup.tar.gz', 'application/x-gzip')).toBe('gzip')
    for (const id of ['markdown', 'xls', 'xlsm', 'drawio', 'text', 'yaml', 'xml', 'vsdx', 'seven-zip'] as const) {
      expect(isFileTypeAllowed(DEFAULT_WORKSPACE_FILE_TYPE_SETTINGS, id)).toBeTrue()
    }
  })

  test('lets the extension decide over a conflicting media type and falls back to the media type', () => {
    expect(resolveId('report.csv', 'application/vnd.ms-excel')).toBe('csv')
    expect(resolveId('pasted-image', 'image/png')).toBe('png')
    expect(resolveId('noextension', 'application/octet-stream')).toBe('unrecognized')
    expect(resolveId('model.blend', 'image/png')).toBe('unrecognized')
  })

  test('refuses executables, scripts, and active documents whatever the other half says', () => {
    for (const fileName of ['setup.exe', 'run.BAT', 'deploy.sh', 'tool.ps1', 'invoice.pdf.exe', 'setup.exe. ', 'page.html', 'logo.svg', 'app.jar']) {
      expect(resolveId(fileName, 'application/pdf')).toBe('dangerous')
    }
    expect(resolveId('notes.md', 'text/html')).toBe('dangerous')
    expect(resolveId('payload', 'application/x-msdownload')).toBe('dangerous')
    // A program name in the middle of a longer name is not the type of the file.
    expect(resolveId('app.config.json', 'application/json')).toBe('json')
  })

  test('stores only canonical media types', () => {
    expect(findFileTypeByContentType('text/markdown')?.id).toBe('markdown')
    expect(findFileTypeByContentType('text/xml')).toBeUndefined()
    expect(findFileTypeByContentType('image/svg+xml')).toBeUndefined()
  })
})

describe('Workspace File type settings', () => {
  test('enables types off by default and blocks types on by default', () => {
    const settings = createWorkspaceFileTypeSettings(
      listAllowedFileTypes(DEFAULT_WORKSPACE_FILE_TYPE_SETTINGS).filter((id) => id !== 'xlsm').concat('rar'),
    )
    expect(settings).toEqual({ allowed: ['rar'], blocked: ['xlsm'] })
    expect(isFileTypeAllowed(settings, 'rar')).toBeTrue()
    expect(isFileTypeAllowed(settings, 'xlsm')).toBeFalse()
    expect(isFileTypeAllowed(DEFAULT_WORKSPACE_FILE_TYPE_SETTINGS, 'rar')).toBeFalse()
  })

  test('refuses settings that would enable a type outside the catalog', () => {
    expect(readWorkspaceFileTypeSettings({ allowed: ['msg', 'rar'], blocked: ['xlsm'] }))
      .toEqual({ allowed: ['rar', 'msg'], blocked: ['xlsm'] })
    for (const value of [
      undefined,
      [],
      { allowed: [] },
      { allowed: ['exe'], blocked: [] },
      { allowed: ['svg'], blocked: [] },
      { allowed: ['html'], blocked: [] },
      { allowed: ['rar', 'rar'], blocked: [] },
      { allowed: ['pdf'], blocked: [] },
      { allowed: [], blocked: ['rar'] },
      { allowed: [], blocked: ['exe'] },
    ]) {
      expect(readWorkspaceFileTypeSettings(value)).toBeUndefined()
    }
  })

  test('reads rejection details only when every listed type is known', () => {
    expect(readFileTypeRejection({ reason: 'not-allowed', allowedFileTypes: ['pdf'] }))
      .toEqual({ reason: 'not-allowed', allowedFileTypes: ['pdf'] })
    expect(readFileTypeRejection({ reason: 'not-allowed', allowedFileTypes: ['exe'] })).toBeUndefined()
    expect(readFileTypeRejection({ reason: 'other', allowedFileTypes: [] })).toBeUndefined()
  })
})
