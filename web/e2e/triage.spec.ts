import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type {
  TriageActionInput,
  TriageConfiguration,
  TriageEntry,
} from '@mukuroji/contracts'
import type { AuthSession } from '../src/auth/session'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import {
  triageConfigurationFixture,
  triageEntryFixtures,
} from '../src/triage/fixtures'

/** Authenticated browser session used by Team Triage scenarios. */
const triageAuthSession = {
  accessToken: 'triage-e2e-access-token',
  expiresAt: Date.now() + 60 * 60 * 1_000,
  remember: true,
  tokenType: 'Bearer',
} satisfies AuthSession

/** Mutable provider-neutral API state retained by one browser scenario. */
type TriageApiState = {
  /** Current canonical entries returned by queue and detail endpoints. */
  entries: TriageEntry[]
  /** Number of action requests received after explicit form submission. */
  actionRequests: number
  /** Current Team settings returned by the versioned settings endpoint. */
  settings: TriageConfiguration
  /** Number of settings replacement requests received. */
  settingsRequests: number
  /** Whether the next settings replacement should simulate a concurrent update. */
  settingsConflictOnce: boolean
}

/** Installs authenticated Workspace and mutable Triage API responses.
 *
 * @param page The Playwright page whose requests are intercepted.
 * @returns Mutable API state used to simulate source activity between reloads.
 */
async function mockTriageApis(page: Page): Promise<TriageApiState> {
  const state: TriageApiState = {
    actionRequests: 0,
    entries: structuredClone([...triageEntryFixtures]),
    settings: structuredClone(triageConfigurationFixture),
    settingsConflictOnce: false,
    settingsRequests: 0,
  }
  await page.addInitScript((session) => {
    window.localStorage.setItem('mukuroji.auth', JSON.stringify(session))
    window.localStorage.setItem('mukuroji.locale', 'en')
  }, triageAuthSession)

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      json: {
        attributes: {
          'custom:workspace_id': 'workspace-demo',
          email: 'demo@example.com',
          name: 'Demo User',
        },
        groups: ['mukuroji-system-admins'],
        isSystemAdmin: true,
        username: 'demo@example.com',
        workspaceMemberStatus: 'active',
        workspaceRole: 'owner',
      },
    })
  })
  await page.route('**/api/teams/projects**', async (route) => {
    await route.fulfill({ json: { teams: projectDirectoryFixtures } })
  })
  await page.route('**/api/projects/quick-access', async (route) => {
    await route.fulfill({ json: { items: [], revision: 0 } })
  })
  await page.route('**/api/notifications/unread-count', async (route) => {
    await route.fulfill({ json: { unreadCount: 0 } })
  })
  await page.route('**/api/teams/core-team/triage-settings', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      await route.fulfill({ json: structuredClone(state.settings) })
      return
    }
    state.settingsRequests += 1
    if (state.settingsConflictOnce) {
      state.settingsConflictOnce = false
      state.settings = {
        ...state.settings,
        retentionDays: 444,
        revision: state.settings.revision + 1,
        updatedAt: '2026-08-09T02:30:00.000Z',
      }
      await route.fulfill({
        status: 409,
        json: {
          code: 'TriageConfigurationConflict',
          message: 'Triage settings changed.',
        },
      })
      return
    }
    const input = request.postDataJSON()
    state.settings = {
      ...state.settings,
      retentionDays: isRecord(input) && typeof input.retentionDays === 'number'
        ? input.retentionDays
        : state.settings.retentionDays,
      revision: state.settings.revision + 1,
      updatedAt: '2026-08-09T02:31:00.000Z',
    }
    await route.fulfill({ json: structuredClone(state.settings) })
  })
  await page.route(/.*\/api\/teams\/core-team\/triage-entries(?:\/[^/?]+(?:\/actions)?)?(?:\?.*)?$/, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const segments = path.split('/').filter(Boolean)
    const entryId = segments[4]
    const isAction = segments[5] === 'actions'
    if (!entryId) {
      await route.fulfill({
        json: {
          allowedBulkActions: ['assign', 'decline', 'snooze'],
          canManageConfiguration: true,
          entries: structuredClone(state.entries),
        },
      })
      return
    }
    const entryIndex = state.entries.findIndex((entry) => entry.id === entryId)
    const entry = state.entries[entryIndex]
    if (!entry || entryIndex < 0) {
      await route.fulfill({ status: 404, json: { code: 'TriageEntryNotFound' } })
      return
    }
    if (!isAction) {
      await route.fulfill({ json: structuredClone(entry) })
      return
    }
    const input = readTriageActionInput(request.postDataJSON())
    state.actionRequests += 1
    const updated = applyMockTriageAction(entry, input)
    state.entries[entryIndex] = updated
    await route.fulfill({ json: { entry: structuredClone(updated), replayed: false } })
  })
  return state
}

/** Narrows the JSON request body to the actions exercised by browser scenarios.
 *
 * @param value The parsed untrusted request body.
 * @returns A supported revision-fenced Triage action.
 */
function readTriageActionInput(value: unknown): TriageActionInput {
  if (!isRecord(value) || typeof value.action !== 'string' ||
    typeof value.expectedRevision !== 'number') {
    throw new Error('The Triage E2E action body is invalid.')
  }
  if (value.action === 'accept' && value.mode === 'create') {
    return {
      action: 'accept',
      expectedRevision: value.expectedRevision,
      mode: 'create',
      ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    }
  }
  if (value.action === 'duplicate' && typeof value.canonicalWorkItemId === 'string') {
    return {
      action: 'duplicate',
      canonicalWorkItemId: value.canonicalWorkItemId,
      expectedRevision: value.expectedRevision,
    }
  }
  if (value.action === 'snooze' && typeof value.until === 'string') {
    return { action: 'snooze', expectedRevision: value.expectedRevision, until: value.until }
  }
  throw new Error('The Triage E2E action is unsupported.')
}

/** Applies one browser-focused action to mutable canonical API state.
 *
 * @param entry The current entry fixture.
 * @param input The validated action submitted from the confirmation form.
 * @returns The next entry returned by detail and queue endpoints.
 */
function applyMockTriageAction(entry: TriageEntry, input: TriageActionInput): TriageEntry {
  const revision = entry.revision + 1
  const updatedAt = '2026-08-09T02:00:00.000Z'
  if (input.action === 'accept' && input.mode === 'create') {
    return {
      ...entry,
      canonicalWorkItem: {
        teamId: entry.teamId,
        workItemId: 'triage-created-work-item',
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
      capabilities: terminalCapabilities(),
      projectId: input.projectId,
      revision,
      state: 'accepted',
      updatedAt,
    }
  }
  if (input.action === 'duplicate') {
    return {
      ...entry,
      canonicalWorkItem: {
        teamId: entry.teamId,
        workItemId: input.canonicalWorkItemId,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
      },
      capabilities: terminalCapabilities(),
      mergeReceipt: {
        canonicalWorkItemId: input.canonicalWorkItemId,
        completedAt: updatedAt,
        mergedAttachmentCount: entry.sourcePreview.attachmentCount,
        mergedCommentCount: entry.sourcePreview.commentCount,
        mergedSourceCount: 1,
        mergedWatcherCount: entry.sourcePreview.watcherCount,
      },
      revision,
      state: 'duplicate',
      updatedAt,
    }
  }
  if (input.action === 'snooze') {
    return {
      ...entry,
      revision,
      snoozedUntil: input.until,
      state: 'snoozed',
      updatedAt,
    }
  }
  throw new Error('The Triage E2E action cannot be applied.')
}

/** Returns disabled capabilities for a terminal decision. */
function terminalCapabilities(): TriageEntry['capabilities'] {
  return {
    canAcceptCreate: false,
    canAcceptLink: false,
    canAssign: false,
    canDecline: false,
    canMarkDuplicate: false,
    canReply: false,
    canRequestInformation: false,
    canSnooze: false,
    canViewInternalContext: true,
  }
}

/** Checks whether an untrusted value is a non-array object.
 *
 * @param value The value to inspect.
 * @returns Whether named properties may be read safely.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

test('deep links, roving keyboard navigation, and Accept confirmation survive reload', async ({
  page,
}) => {
  const state = await mockTriageApis(page)
  await page.goto('/teams/core-team/triage?entryId=triage-chat-1')

  await expect(page).toHaveURL(/\/teams\/core-team\/triage\?entryId=triage-chat-1$/)
  await expect(page.getByTestId('triage-entry-detail')).toContainText(
    'Workspace provisioning blocks customer launch',
  )
  const firstRow = page.getByTestId('triage-entry-triage-chat-1')
  await firstRow.focus()
  await firstRow.press('ArrowDown')
  await expect(page).toHaveURL(/entryId=triage-email-1/)
  await expect(page.getByTestId('triage-entry-detail')).not.toContainText(
    'This body must not be rendered',
  )
  await page.getByTestId('triage-entry-triage-email-1').press('ArrowUp')
  await expect(page).toHaveURL(/entryId=triage-chat-1/)

  const acceptButton = page.getByRole('button', { name: /Accept A/ })
  await acceptButton.focus()
  await acceptButton.press('a')
  await expect(page.getByTestId('triage-action-accept')).toBeVisible()
  expect(state.actionRequests).toBe(0)
  await page.getByLabel('Project ID').fill('refero')
  await page.getByRole('button', { name: 'Review and apply' }).click()

  await expect(firstRow).toBeFocused()
  await expect(page.getByRole('status')).toHaveText('The triage action was completed.')
  await expect(page.getByTestId('triage-entry-detail')).toContainText('Accepted')
  await expect(page.getByRole('link', { name: 'Open canonical Work Item' })).toHaveAttribute(
    'href',
    /\/teams\/core-team\/issues\?issueId=triage-created-work-item/,
  )
  expect(state.actionRequests).toBe(1)
  await page.reload()
  await expect(page).toHaveURL(/entryId=triage-chat-1/)
  await expect(page.getByTestId('triage-entry-detail')).toContainText('Accepted')
})

test('Duplicate preserves context and Snooze resurfaces after new source activity', async ({
  page,
}) => {
  const state = await mockTriageApis(page)
  await page.goto('/teams/core-team/triage?entryId=triage-chat-1')

  await page.getByRole('button', { name: /Merge as duplicate D/ }).click()
  await page.getByLabel('Canonical Work Item ID').fill('canonical-42')
  await page.getByRole('button', { name: 'Review and apply' }).click()
  await expect(page.getByTestId('triage-entry-detail')).toContainText(
    'Recorded 1 source snapshot with metadata counts for 8 comments, 2 attachments, and 4 watchers.',
  )
  await expect(page.getByRole('link', { name: 'Open canonical Work Item' })).toHaveAttribute(
    'href',
    /issueId=canonical-42/,
  )

  await page.goto('/teams/core-team/triage?entryId=triage-email-1')
  const emailIndex = state.entries.findIndex((entry) => entry.id === 'triage-email-1')
  const emailEntry = state.entries[emailIndex]
  if (!emailEntry || emailIndex < 0) throw new Error('Missing email E2E fixture.')
  state.entries[emailIndex] = {
    ...emailEntry,
    capabilities: { ...emailEntry.capabilities, canSnooze: true },
  }
  await page.reload()
  await page.getByRole('button', { name: /Snooze S/ }).click()
  const snoozeUntil = new Date(Date.now() + 48 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 16)
  await page.getByLabel('Resurface at').fill(snoozeUntil)
  await page.getByRole('button', { name: 'Review and apply' }).click()
  await expect(page.getByTestId('triage-entry-detail')).toContainText('Snoozed')

  const snoozed = state.entries[emailIndex]
  if (!snoozed) throw new Error('Missing snoozed E2E fixture.')
  state.entries[emailIndex] = {
    ...snoozed,
    lastActivityAt: '2026-08-09T03:00:00.000Z',
    revision: snoozed.revision + 1,
    snoozedUntil: undefined,
    state: 'pending',
    updatedAt: '2026-08-09T03:00:00.000Z',
  }
  await page.reload()
  await expect(page.getByTestId('triage-entry-detail')).toContainText('Pending')
})

test('mobile drill-in hides denied source content and restores the queue', async ({ page }) => {
  await mockTriageApis(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/teams/core-team/triage')

  await expect(page.getByTestId('triage-queue')).toBeVisible()
  await page.getByTestId('triage-entry-triage-webhook-denied').click()
  await expect(page).toHaveURL(/entryId=triage-webhook-denied/)
  await expect(page.getByTestId('triage-queue')).toBeHidden()
  await expect(page.getByTestId('triage-entry-detail')).toContainText('Restricted source')
  await expect(page.getByTestId('triage-entry-detail')).not.toContainText(
    'This denied title must never render',
  )
  await expect(page.getByTestId('triage-entry-detail')).not.toContainText(
    'This denied body must never render',
  )
  await page.getByRole('button', { name: 'Back to queue' }).click()
  await expect(page).toHaveURL('/teams/core-team/triage')
  await expect(page.getByTestId('triage-queue')).toBeVisible()
})

test('settings conflict refreshes the revision before the operator retries', async ({ page }) => {
  const state = await mockTriageApis(page)
  state.settingsConflictOnce = true
  await page.goto('/teams/core-team/triage?view=settings')

  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'The settings changed while you were editing. The latest revision has been loaded',
  )
  await expect(page.getByLabel('Retention days')).toHaveValue('444')

  await page.getByLabel('Retention days').fill('445')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('status')).toHaveText('Triage settings saved.')
  expect(state.settingsRequests).toBe(2)
})
