import {
  FILE_TYPE_CATALOG,
  createWorkspaceFileTypeSettings,
  isFileTypeAllowed,
  listAllowedFileTypes,
  type FileTypeDefinition,
  type FileTypeGroup,
  type WorkspaceFileTypeSettings,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Translated heading of each File type group, in display order. */
const fileTypeGroupLabelKeys = {
  image: 'workspace.tenantAdministration.fileTypes.group.image',
  video: 'workspace.tenantAdministration.fileTypes.group.video',
  audio: 'workspace.tenantAdministration.fileTypes.group.audio',
  document: 'workspace.tenantAdministration.fileTypes.group.document',
  spreadsheet: 'workspace.tenantAdministration.fileTypes.group.spreadsheet',
  presentation: 'workspace.tenantAdministration.fileTypes.group.presentation',
  text: 'workspace.tenantAdministration.fileTypes.group.text',
  diagram: 'workspace.tenantAdministration.fileTypes.group.diagram',
  archive: 'workspace.tenantAdministration.fileTypes.group.archive',
  mail: 'workspace.tenantAdministration.fileTypes.group.mail',
} as const satisfies Record<FileTypeGroup, MessageKey>

/** Group identifiers in display order. */
const FILE_TYPE_GROUPS: readonly FileTypeGroup[] = [
  'image',
  'video',
  'audio',
  'document',
  'spreadsheet',
  'presentation',
  'text',
  'diagram',
  'archive',
  'mail',
]

/** Props of the File type editor. */
export type FileTypeFieldsProps = {
  /** Settings being edited. */
  settings: WorkspaceFileTypeSettings
  /** Whether the fields are read-only, for example while the tenant is closing. */
  disabled: boolean
  /** Receives the edited settings. */
  onChange: (settings: WorkspaceFileTypeSettings) => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Edits which File types members may attach. Every type in the catalog can be turned on or off;
 * programs, scripts, and other dangerous types are not in the catalog, so they never appear here.
 *
 * @param props - Settings draft, lock state, change callback, and translator.
 * @returns The grouped list of File types.
 */
export function FileTypeFields({ settings, disabled, onChange, t }: FileTypeFieldsProps) {
  /**
   * Turns one type on or off.
   *
   * @param type - File type being changed.
   * @param accepted - Whether the Workspace should accept it.
   */
  const toggle = (type: FileTypeDefinition, accepted: boolean) => {
    const current = new Set(listAllowedFileTypes(settings))
    if (accepted) current.add(type.id)
    else current.delete(type.id)
    onChange(createWorkspaceFileTypeSettings(current))
  }

  return (
    <fieldset className="mt-5 grid gap-3" data-testid="tenant-file-types">
      <legend className="text-sm font-semibold text-[var(--workbench-text)]">
        {t('workspace.tenantAdministration.fileTypes.title')}
      </legend>
      <p className="text-xs text-[var(--workbench-muted)]">
        {t('workspace.tenantAdministration.fileTypes.hint')}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {FILE_TYPE_GROUPS.map((group) => (
          <div className="grid content-start gap-1.5" key={group}>
            <p className="text-xs font-semibold text-[var(--workbench-muted)]">{t(fileTypeGroupLabelKeys[group])}</p>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">
              {FILE_TYPE_CATALOG.filter((type) => type.group === group).map((type) => (
                <label className="inline-flex items-center gap-1.5 text-sm text-[var(--workbench-text)]" key={type.id}>
                  <input
                    checked={isFileTypeAllowed(settings, type.id)}
                    data-testid={`tenant-file-type-${type.id}`}
                    disabled={disabled}
                    onChange={(event) => toggle(type, event.target.checked)}
                    type="checkbox"
                  />
                  {type.extensions.map((extension) => `.${extension}`).join(' ')}
                  {type.allowedByDefault ? null : (
                    <span className="text-[0.68rem] text-[var(--workbench-muted)]">
                      {t('workspace.tenantAdministration.fileTypes.optIn')}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-[var(--workbench-muted)]">
        {t('workspace.tenantAdministration.fileTypes.neverAllowed')}
      </p>
    </fieldset>
  )
}
