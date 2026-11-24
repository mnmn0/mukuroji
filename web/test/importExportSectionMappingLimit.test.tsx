import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { WORK_ITEM_IMPORT_MAPPING_MAX_ENTRIES } from '@mukuroji/contracts'
import { ImportExportSection } from '../src/developer-platform/ui/ImportExportSection'
import { developerPlatformLabelsFixture } from '../src/developer-platform/fixtures'

/**
 * Renders the import section with the given number of mapping rows.
 *
 * @param count - Mapping rows to show.
 * @returns Rendered markup.
 */
function renderWithMappings(count: number) {
  return renderToStaticMarkup(
    <ImportExportSection
      canExport
      canImport
      format="csv"
      importMappings={Array.from({ length: count }, (_, index) => ({ sourceField: `c${index}`, targetField: `t${index}` }))}
      importProjectId=""
      importProjectOptions={[]}
      importTeamId="team-1"
      importTeamOptions={[{ value: 'team-1', label: 'Team', description: 'Team' }]}
      labels={developerPlatformLabelsFixture}
      onFileChange={() => undefined}
      onFormatChange={() => undefined}
      onMappingChange={() => undefined}
      onProjectChange={() => undefined}
      onSubmit={() => undefined}
      onTeamChange={() => undefined}
    />,
  )
}

describe('ImportExportSection mapping limit', () => {
  test('stops adding mapping rows at the limit an import accepts', () => {
    const addButton = /<button[^>]*>Add mapping<\/button>/u

    expect(renderWithMappings(WORK_ITEM_IMPORT_MAPPING_MAX_ENTRIES - 1).match(addButton)?.[0]).not.toContain('disabled')
    expect(renderWithMappings(WORK_ITEM_IMPORT_MAPPING_MAX_ENTRIES).match(addButton)?.[0]).toContain('disabled=""')
  })
})
