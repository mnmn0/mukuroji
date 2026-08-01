import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTranslator } from '../src/shared/i18n/i18n'
import { TaskHeader } from '../src/tasks/ui/TaskHeader'

const t = createTranslator('en')

/**
 * Renders the task header with a controlled Project quick-access state.
 *
 * @param isProjectQuickAccess - Whether the Project is currently starred.
 * @param isProjectQuickAccessSaving - Whether a change is being persisted.
 * @param canToggle - Whether the routed Project has enough Team context to mutate.
 * @returns Static header markup for accessibility assertions.
 */
function renderTaskHeader(
  isProjectQuickAccess: boolean,
  isProjectQuickAccessSaving = false,
  canToggle = true,
) {
  return renderToStaticMarkup(
    <TaskHeader
      activeTab="table"
      isCreateTaskOpen={false}
      isProjectQuickAccess={isProjectQuickAccess}
      isProjectQuickAccessSaving={isProjectQuickAccessSaving}
      onMobileSidebarOpen={() => undefined}
      onProjectQuickAccessToggle={canToggle ? () => undefined : undefined}
      onTabChange={() => undefined}
      projectName="Refero"
      t={t}
      tasks={[]}
      teamName="Core team"
      userInitial="D"
    />,
  )
}

describe('TaskHeader Project quick access', () => {
  test('announces an unstarred Project as an available add action', () => {
    const html = renderTaskHeader(false)

    expect(html).toContain('aria-label="Add project to quick access"')
    expect(html).toContain('aria-pressed="false"')
  })

  test('announces a starred Project as a filled remove action', () => {
    const html = renderTaskHeader(true)

    expect(html).toContain('aria-label="Remove project from quick access"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('fill="currentColor"')
  })

  test('disables the star while saving or when Team context is unavailable', () => {
    const savingHtml = renderTaskHeader(true, true)
    const missingTeamHtml = renderTaskHeader(false, false, false)

    expect(savingHtml).toContain('aria-busy="true"')
    expect(savingHtml).toContain('disabled=""')
    expect(missingTeamHtml).toContain('disabled=""')
  })
})
