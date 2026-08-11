import { describe, expect, test } from 'bun:test'
import { WORK_ITEM_ACTION_SCHEMA_VERSION } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkspaceCommandMenu } from '../src/commands/ui/WorkspaceCommandMenu'
import { resolveWorkspaceCommandMenuWorkItemActions } from '../src/commands/ui/WorkspaceCommandMenuContext'

describe('WorkspaceCommandMenu Work Item actions', () => {
  test('keeps navigation and quick create while showing shortcuts and disabled reasons', () => {
    const workItemActions = resolveWorkspaceCommandMenuWorkItemActions([{
      registrationId: 'project-surface',
      context: {
        schemaVersion: WORK_ITEM_ACTION_SCHEMA_VERSION,
        surface: 'project',
        scope: { kind: 'project', projectId: 'refero', teamId: 'core-team' },
        selection: {
          mode: 'single',
          targets: [{ teamId: 'core-team', workItemId: 'wireframe' }],
        },
      },
      actions: [
        {
          id: 'edit',
          label: 'Edit selected Work Item',
          description: 'Change fields and relationships',
          shortcut: 'E',
          execute: () => undefined,
        },
        {
          id: 'archive',
          label: 'Archive selected Work Item',
          shortcut: '⌘ ⇧ A',
          disabledReason: 'Requires editor permission',
          execute: () => undefined,
        },
      ],
    }])
    const html = renderToStaticMarkup(
      <WorkspaceCommandMenu
        currentLocation="/projects/refero/issues?teamId=core-team"
        isOpen
        locale="en"
        workItemActions={workItemActions}
        onClose={() => undefined}
        onNavigate={() => undefined}
      />,
    )

    expect(html).toContain('More actions')
    expect(html).toContain('Edit selected Work Item')
    expect(html).toContain('Change fields and relationships')
    expect(html).toContain('>E</span>')
    expect(html).toContain('Archive selected Work Item')
    expect(html).toContain('Requires editor permission')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Quick actions')
    expect(html).toContain('Create a Work Item in this view')
    expect(html).toContain('Navigation')
    expect(html).toContain('Home')
  })
})
