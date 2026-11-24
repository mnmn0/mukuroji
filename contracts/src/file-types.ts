/**
 * Identifiers of every File type a Workspace can attach, in display order. A type outside this
 * list (an executable, a script, HTML, SVG, or anything unrecognized) is never accepted.
 */
export const FILE_TYPE_IDS = [
  'png',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'tiff',
  'heic',
  'mp4',
  'webm',
  'mov',
  'mp3',
  'wav',
  'm4a',
  'pdf',
  'docx',
  'doc',
  'docm',
  'odt',
  'xlsx',
  'xls',
  'xlsm',
  'ods',
  'pptx',
  'ppt',
  'pptm',
  'odp',
  'text',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'drawio',
  'vsdx',
  'zip',
  'seven-zip',
  'tar',
  'gzip',
  'rar',
  'eml',
  'msg',
] as const

/** Identifier of one File type a Workspace can attach. */
export type FileTypeId = (typeof FILE_TYPE_IDS)[number]

/** Kind of content a File type holds, used to group types on screen. */
export type FileTypeGroup =
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'text'
  | 'diagram'
  | 'archive'
  | 'mail'

/** One File type a Workspace can attach. */
export type FileTypeDefinition = {
  /** Stable identifier stored in the Workspace settings. */
  id: FileTypeId
  /** Kind of content, for grouping on screen. */
  group: FileTypeGroup
  /** Lowercase extensions without the dot; the first is the one shown on screen. */
  extensions: readonly string[]
  /** Canonical media type stored on the File version and sent to object storage. */
  contentType: string
  /** Other media types browsers report for the same files. */
  contentTypeAliases: readonly string[]
  /**
   * Whether a Workspace that has not changed its settings accepts the type. A type off by default
   * can still be enabled by an administrator.
   */
  allowedByDefault: boolean
}

/** Catalog entry without its identifier. */
type FileTypeSpec = Omit<FileTypeDefinition, 'id'>

/** Every File type, keyed by identifier, so that each identifier has exactly one entry. */
const FILE_TYPE_SPECS: Record<FileTypeId, FileTypeSpec> = {
  png: spec('image', ['png'], 'image/png'),
  jpeg: spec('image', ['jpg', 'jpeg'], 'image/jpeg', ['image/pjpeg']),
  gif: spec('image', ['gif'], 'image/gif'),
  webp: spec('image', ['webp'], 'image/webp'),
  avif: spec('image', ['avif'], 'image/avif'),
  tiff: spec('image', ['tif', 'tiff'], 'image/tiff', [], false),
  heic: spec('image', ['heic', 'heif'], 'image/heic', ['image/heif'], false),
  mp4: spec('video', ['mp4', 'm4v'], 'video/mp4', ['video/x-m4v']),
  webm: spec('video', ['webm'], 'video/webm'),
  mov: spec('video', ['mov'], 'video/quicktime'),
  mp3: spec('audio', ['mp3'], 'audio/mpeg', ['audio/mp3']),
  wav: spec('audio', ['wav'], 'audio/wav', ['audio/x-wav', 'audio/wave', 'audio/vnd.wave']),
  m4a: spec('audio', ['m4a'], 'audio/mp4', ['audio/x-m4a']),
  pdf: spec('document', ['pdf'], 'application/pdf'),
  docx: spec('document', ['docx'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  doc: spec('document', ['doc'], 'application/msword'),
  docm: spec('document', ['docm'], 'application/vnd.ms-word.document.macroenabled.12', [], false),
  odt: spec('document', ['odt'], 'application/vnd.oasis.opendocument.text'),
  xlsx: spec('spreadsheet', ['xlsx'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  xls: spec('spreadsheet', ['xls'], 'application/vnd.ms-excel'),
  xlsm: spec('spreadsheet', ['xlsm'], 'application/vnd.ms-excel.sheet.macroenabled.12'),
  ods: spec('spreadsheet', ['ods'], 'application/vnd.oasis.opendocument.spreadsheet'),
  pptx: spec(
    'presentation',
    ['pptx'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ),
  ppt: spec('presentation', ['ppt'], 'application/vnd.ms-powerpoint'),
  pptm: spec(
    'presentation',
    ['pptm'],
    'application/vnd.ms-powerpoint.presentation.macroenabled.12',
    [],
    false,
  ),
  odp: spec('presentation', ['odp'], 'application/vnd.oasis.opendocument.presentation'),
  text: spec('text', ['txt', 'log'], 'text/plain', ['text/x-log']),
  markdown: spec('text', ['md', 'markdown'], 'text/markdown', ['text/x-markdown']),
  csv: spec('text', ['csv'], 'text/csv', ['application/csv', 'text/x-csv']),
  tsv: spec('text', ['tsv'], 'text/tab-separated-values'),
  json: spec('text', ['json'], 'application/json'),
  xml: spec('text', ['xml'], 'application/xml', ['text/xml']),
  yaml: spec('text', ['yaml', 'yml'], 'application/yaml', ['application/x-yaml', 'text/yaml', 'text/x-yaml']),
  drawio: spec('diagram', ['drawio'], 'application/vnd.jgraph.mxfile'),
  vsdx: spec('diagram', ['vsdx'], 'application/vnd.ms-visio.drawing.main+xml'),
  zip: spec('archive', ['zip'], 'application/zip', ['application/x-zip-compressed', 'application/x-zip']),
  'seven-zip': spec('archive', ['7z'], 'application/x-7z-compressed'),
  tar: spec('archive', ['tar'], 'application/x-tar'),
  gzip: spec('archive', ['gz', 'tgz'], 'application/gzip', ['application/x-gzip']),
  rar: spec('archive', ['rar'], 'application/vnd.rar', ['application/x-rar-compressed'], false),
  eml: spec('mail', ['eml'], 'message/rfc822', [], false),
  msg: spec('mail', ['msg'], 'application/vnd.ms-outlook', [], false),
}

/**
 * Builds one catalog entry.
 *
 * @param group - Kind of content.
 * @param extensions - Lowercase extensions without the dot.
 * @param contentType - Canonical media type.
 * @param contentTypeAliases - Other media types browsers report for the same files.
 * @param allowedByDefault - Whether a Workspace accepts the type before changing its settings.
 * @returns The catalog entry.
 */
function spec(
  group: FileTypeGroup,
  extensions: readonly string[],
  contentType: string,
  contentTypeAliases: readonly string[] = [],
  allowedByDefault = true,
): FileTypeSpec {
  return { group, extensions, contentType, contentTypeAliases, allowedByDefault }
}

/** Every File type a Workspace can attach, in display order. */
export const FILE_TYPE_CATALOG: readonly FileTypeDefinition[] = FILE_TYPE_IDS.map((id) => ({
  id,
  ...FILE_TYPE_SPECS[id],
}))

/**
 * Extensions that are never accepted, whatever the Workspace settings: programs, installers,
 * scripts, shortcuts, disk images, and documents a browser runs as a page.
 */
export const BLOCKED_FILE_EXTENSIONS: readonly string[] = [
  'exe', 'dll', 'com', 'scr', 'pif', 'cpl', 'sys', 'drv', 'ocx',
  'msi', 'msp', 'mst', 'appx', 'msix',
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'wsf', 'wsh', 'wsc', 'hta',
  'sh', 'bash', 'zsh', 'csh', 'ksh', 'command', 'py', 'pyc', 'pl', 'rb', 'php',
  'jar', 'class', 'apk', 'aab', 'ipa', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'run', 'bin', 'elf',
  'lnk', 'url', 'scf', 'inf', 'reg', 'iso', 'img', 'vhd', 'vhdx',
  'html', 'htm', 'xhtml', 'shtml', 'mht', 'mhtml', 'svg', 'svgz',
]

/** Media types that are never accepted, whatever the extension or the Workspace settings. */
export const BLOCKED_FILE_CONTENT_TYPES: readonly string[] = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-ms-dos-executable',
  'application/x-executable',
  'application/x-elf',
  'application/x-mach-binary',
  'application/x-dosexec',
  'application/vnd.microsoft.portable-executable',
  'application/x-msi',
  'application/x-ms-installer',
  'application/x-ms-shortcut',
  'application/x-sh',
  'application/x-csh',
  'application/x-shellscript',
  'application/x-bat',
  'application/x-python-code',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/javascript',
  'text/ecmascript',
  'application/hta',
  'application/java-archive',
  'application/x-java-archive',
  'application/vnd.android.package-archive',
  'application/x-apple-diskimage',
  'application/x-iso9660-image',
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'multipart/related',
  'message/partial',
]

/** Media types a browser reports when it cannot tell the type, so the extension decides. */
const GENERIC_CONTENT_TYPES: ReadonlySet<string> = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
  'application/x-unknown',
])

/** Lookup of {@link FILE_TYPE_IDS} for type guards. */
const FILE_TYPE_ID_SET: ReadonlySet<string> = new Set(FILE_TYPE_IDS)

/** Lookup of {@link BLOCKED_FILE_EXTENSIONS}. */
const BLOCKED_EXTENSION_SET: ReadonlySet<string> = new Set(BLOCKED_FILE_EXTENSIONS)

/** Lookup of {@link BLOCKED_FILE_CONTENT_TYPES}. */
const BLOCKED_CONTENT_TYPE_SET: ReadonlySet<string> = new Set(BLOCKED_FILE_CONTENT_TYPES)

/** Catalog entries by extension. */
const FILE_TYPE_BY_EXTENSION: ReadonlyMap<string, FileTypeDefinition> = new Map(
  FILE_TYPE_CATALOG.flatMap((type) =>
    type.extensions.map((extension): [string, FileTypeDefinition] => [extension, type])
  ),
)

/** Catalog entries by canonical media type and alias. */
const FILE_TYPE_BY_CONTENT_TYPE: ReadonlyMap<string, FileTypeDefinition> = new Map(
  FILE_TYPE_CATALOG.flatMap((type) =>
    [type.contentType, ...type.contentTypeAliases].map(
      (contentType): [string, FileTypeDefinition] => [contentType, type],
    )
  ),
)

/** Catalog entries by canonical media type only. */
const FILE_TYPE_BY_CANONICAL_CONTENT_TYPE: ReadonlyMap<string, FileTypeDefinition> = new Map(
  FILE_TYPE_CATALOG.map((type): [string, FileTypeDefinition] => [type.contentType, type]),
)

/**
 * File types a Workspace changed from the defaults. Types not listed keep their default.
 */
export type WorkspaceFileTypeSettings = {
  /** Types off by default that the Workspace accepts, in catalog order. */
  allowed: FileTypeId[]
  /** Types on by default that the Workspace refuses, in catalog order. */
  blocked: FileTypeId[]
}

/** Settings of a Workspace that has not changed its File types. */
export const DEFAULT_WORKSPACE_FILE_TYPE_SETTINGS: WorkspaceFileTypeSettings = {
  allowed: [],
  blocked: [],
}

/**
 * Why an upload was refused because of its type.
 *
 * - `dangerous`: an executable, script, or other type that is never accepted.
 * - `unrecognized`: neither the extension nor the media type is a known File type.
 * - `not-allowed`: a known type that the Workspace does not accept.
 */
export type FileTypeRejectionReason = 'dangerous' | 'unrecognized' | 'not-allowed'

/** Details of a `415 FileTypeNotAllowed` response. */
export type FileTypeRejection = {
  /** Why the type was refused. */
  reason: FileTypeRejectionReason
  /** Types the Workspace accepts, in catalog order. */
  allowedFileTypes: FileTypeId[]
}

/** Result of matching a file against the catalog. */
export type FileTypeResolution =
  | {
      /** The file is a known type. */
      kind: 'known'
      /** Matched catalog entry. */
      type: FileTypeDefinition
    }
  | {
      /** The file is a type that is never accepted. */
      kind: 'dangerous'
    }
  | {
      /** The file is not a known type. */
      kind: 'unrecognized'
    }

/**
 * Reports whether a value is a File type identifier.
 *
 * @param value - Candidate identifier.
 * @returns Whether the value names a catalog entry.
 */
export function isFileTypeId(value: unknown): value is FileTypeId {
  return typeof value === 'string' && FILE_TYPE_ID_SET.has(value)
}

/**
 * Finds a catalog entry by identifier.
 *
 * @param id - File type identifier.
 * @returns The catalog entry.
 */
export function getFileTypeDefinition(id: FileTypeId): FileTypeDefinition {
  return { id, ...FILE_TYPE_SPECS[id] }
}

/**
 * Reads the lowercase extensions of a file name, longest first (`report.tar.gz` gives `tar.gz`
 * then `gz`). Trailing dots and spaces are dropped first, because Windows drops them when it saves
 * the file (`setup.exe.` is saved as `setup.exe`).
 *
 * @param fileName - File name as the user chose it.
 * @returns Candidate extensions, or an empty list when the name has none.
 */
function readFileExtensions(fileName: string): string[] {
  const baseName = (fileName.split(/[\\/]/u).at(-1) ?? '').toLowerCase().replace(/[.\s]+$/u, '')
  const parts = baseName.split('.').slice(1)
  return parts.map((_, index) => parts.slice(index).join('.'))
}

/**
 * Matches a file against the catalog. A dangerous final extension or media type always wins.
 * Otherwise the extension decides, because browsers report different or empty media types for the
 * same file; the media type decides only when the name has no extension.
 *
 * @param fileName - File name as the user chose it.
 * @param contentType - Lowercase media type essence the browser reported, or an empty string.
 * @returns The matched entry, or why there is none.
 */
export function resolveFileType(fileName: string, contentType: string): FileTypeResolution {
  const extensions = readFileExtensions(fileName)
  const finalExtension = extensions.at(-1)
  if ((finalExtension !== undefined && BLOCKED_EXTENSION_SET.has(finalExtension)) ||
    BLOCKED_CONTENT_TYPE_SET.has(contentType)) {
    return { kind: 'dangerous' }
  }
  for (const extension of extensions) {
    const type = FILE_TYPE_BY_EXTENSION.get(extension)
    if (type) return { kind: 'known', type }
  }
  if (extensions.length > 0 || GENERIC_CONTENT_TYPES.has(contentType)) {
    return { kind: 'unrecognized' }
  }
  const type = FILE_TYPE_BY_CONTENT_TYPE.get(contentType)
  return type ? { kind: 'known', type } : { kind: 'unrecognized' }
}

/**
 * Finds the catalog entry whose canonical media type is the stored one.
 *
 * @param contentType - Canonical media type stored on a File version.
 * @returns The entry, or undefined when the media type is not canonical for any catalog type.
 */
export function findFileTypeByContentType(contentType: string): FileTypeDefinition | undefined {
  return FILE_TYPE_BY_CANONICAL_CONTENT_TYPE.get(contentType)
}

/**
 * Reports whether a Workspace accepts a File type.
 *
 * @param settings - Workspace File type settings.
 * @param id - File type identifier.
 * @returns Whether new uploads of the type are accepted.
 */
export function isFileTypeAllowed(settings: WorkspaceFileTypeSettings, id: FileTypeId): boolean {
  return FILE_TYPE_SPECS[id].allowedByDefault
    ? !settings.blocked.includes(id)
    : settings.allowed.includes(id)
}

/**
 * Lists the File types a Workspace accepts.
 *
 * @param settings - Workspace File type settings.
 * @returns Accepted identifiers in catalog order.
 */
export function listAllowedFileTypes(settings: WorkspaceFileTypeSettings): FileTypeId[] {
  return FILE_TYPE_IDS.filter((id) => isFileTypeAllowed(settings, id))
}

/**
 * Builds the settings that accept exactly the given types.
 *
 * @param accepted - Types the Workspace should accept.
 * @returns Settings listing the differences from the defaults, in catalog order.
 */
export function createWorkspaceFileTypeSettings(accepted: Iterable<FileTypeId>): WorkspaceFileTypeSettings {
  const acceptedSet = new Set(accepted)
  return {
    allowed: FILE_TYPE_IDS.filter((id) => !FILE_TYPE_SPECS[id].allowedByDefault && acceptedSet.has(id)),
    blocked: FILE_TYPE_IDS.filter((id) => FILE_TYPE_SPECS[id].allowedByDefault && !acceptedSet.has(id)),
  }
}

/**
 * Reads a list of File type identifiers that must all match one default.
 *
 * @param value - Untrusted list.
 * @param allowedByDefault - The default every listed type must have.
 * @returns The identifiers in catalog order, or undefined when the list is not an array, repeats an
 *   identifier, or names an unknown type or one with the other default.
 */
function readFileTypeIdList(value: unknown, allowedByDefault: boolean): FileTypeId[] | undefined {
  if (!Array.isArray(value) || value.length > FILE_TYPE_IDS.length) return undefined
  const ids = new Set<FileTypeId>()
  for (const item of value) {
    if (!isFileTypeId(item) || ids.has(item) || FILE_TYPE_SPECS[item].allowedByDefault !== allowedByDefault) {
      return undefined
    }
    ids.add(item)
  }
  return FILE_TYPE_IDS.filter((id) => ids.has(id))
}

/**
 * Validates Workspace File type settings.
 *
 * @param value - Untrusted settings.
 * @returns The settings with both lists in catalog order, or undefined when a list is missing,
 *   repeats a type, names a type outside the catalog (such as an executable), enables a type that
 *   is already on by default, or blocks one that is already off.
 */
export function readWorkspaceFileTypeSettings(value: unknown): WorkspaceFileTypeSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const allowed = readFileTypeIdList(Reflect.get(value, 'allowed'), false)
  const blocked = readFileTypeIdList(Reflect.get(value, 'blocked'), true)
  return allowed && blocked ? { allowed, blocked } : undefined
}

/**
 * Validates the details of a `415 FileTypeNotAllowed` response.
 *
 * @param value - Untrusted response body.
 * @returns The details, or undefined when they are missing or malformed.
 */
export function readFileTypeRejection(value: unknown): FileTypeRejection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const reason: unknown = Reflect.get(value, 'reason')
  const allowedFileTypes: unknown = Reflect.get(value, 'allowedFileTypes')
  if (reason !== 'dangerous' && reason !== 'unrecognized' && reason !== 'not-allowed') return undefined
  if (!Array.isArray(allowedFileTypes)) return undefined
  const ids = allowedFileTypes.filter(isFileTypeId)
  return ids.length === allowedFileTypes.length ? { reason, allowedFileTypes: ids } : undefined
}
