import type {
  CreateImportDryRunInput,
  ImportJob,
} from '@mukuroji/contracts'

/**
 * Mapping between a source field and a Work Item field.
 */
export type DeveloperImportFieldMapping = ImportJob['mapping'][number]

/**
 * Supported import source format.
 */
export type DeveloperImportFormat = ImportJob['format']

/**
 * Input used for both import dry-runs and committed imports.
 */
export type DryRunDeveloperImportInput = CreateImportDryRunInput

/**
 * Supported Work Item export format.
 */
export type DeveloperExportFormat = 'csv' | 'json'

/**
 * Replaces one property in an import mapping row without mutating the source.
 *
 * @param mappings - Current import mapping rows.
 * @param index - Row index to update.
 * @param property - Mapping property to replace.
 * @param value - New property value.
 * @returns A new mapping array containing the updated row.
 */
export function updateImportMapping(
  mappings: DeveloperImportFieldMapping[],
  index: number,
  property: keyof DeveloperImportFieldMapping,
  value: string,
) {
  return mappings.map((mapping, mappingIndex) =>
    mappingIndex === index
      ? { ...mapping, [property]: value }
      : mapping,
  )
}

/**
 * Filters import Project options to the selected Team.
 *
 * @param options - Project options containing Team ownership.
 * @param teamId - Selected Team identifier.
 * @returns Project options owned by the selected Team.
 */
export function filterImportProjectOptions<
  TOption extends { teamId: string },
>(options: TOption[], teamId: string) {
  return options.filter((option) => option.teamId === teamId)
}

/**
 * Selects the most recently created import job.
 *
 * @param imports - Import jobs returned by the aggregate resource.
 * @returns Most recent import job, or undefined when the list is empty.
 */
export function selectLatestImport(imports: ImportJob[]) {
  return [...imports].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0]
}
