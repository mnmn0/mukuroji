import { expect, test, type Page } from '@playwright/test'
import type { ApplyDocumentOperationsInput } from '@mukuroji/contracts'
import { documentRecordFixture, documentSummaryFixtures } from '../src/documents/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

/**
 * Creates an unsigned JWT-shaped access token, so the Web app can tell accounts apart.
 *
 * @param subject - Account subject.
 * @param id - Distinguishes tokens of the same account.
 * @returns The token.
 */
function createJwtShapedAccessToken(subject: string, id: string) {
  const payload = Buffer.from(JSON.stringify({ sub: subject, jti: id })).toString('base64url')
  return `header.${payload}.signature`
}

/** Mutable state of the mocked Documents API. */
type DocumentsMockState = {
  /** Revision the mocked Document is at. */
  revision: number
  /** Blocks of the mocked Document, as saved operations left them. */
  blocks: typeof documentRecordFixture.blocks
  /** Operation batches the API accepted. */
  savedBatches: ApplyDocumentOperationsInput[]
  /** Whether the next operation batch fails as a request from an ended session. */
  rejectNextSave: boolean
}

/**
 * Installs a session that a reload does not reinstall, the shell data, and an in-memory
 * Documents API.
 *
 * @param page - Browser page whose API requests are intercepted.
 * @returns Mutable mock state.
 */
async function mockDocuments(page: Page): Promise<DocumentsMockState> {
  const state: DocumentsMockState = { revision: documentRecordFixture.revision, blocks: documentRecordFixture.blocks, savedBatches: [], rejectNextSave: false }
  await page.addInitScript((accessToken) => {
    localStorage.setItem('mukuroji.locale', 'en')
    // A reload must not sign the tab back in once the test ended the session.
    if (sessionStorage.getItem('e2e.sessionInstalled')) return
    sessionStorage.setItem('e2e.sessionInstalled', 'true')
    localStorage.setItem('mukuroji.auth', JSON.stringify({ accessToken, expiresAt: Date.now() + 3600000, refreshToken: 'refresh-first', remember: true, tokenType: 'Bearer' }))
  }, createJwtShapedAccessToken('member-a', 'first'))
  // Data this flow does not depend on, such as preferences and member lists, is left out.
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.fulfill({ status: 404, json: { code: 'NotFound', message: 'Not mocked.' } }))
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { attributes: { 'custom:workspace_id': 'workspace-demo', email: 'member-a@example.com', name: 'Member A' }, groups: [], isSystemAdmin: false, username: 'member-a@example.com', workspaceMemberStatus: 'active', workspaceRole: 'member' } }))
  await page.route('**/api/teams/projects**', (route) => route.fulfill({ json: { teams: projectDirectoryFixtures } }))
  await page.route('**/api/projects/quick-access', (route) => route.fulfill({ json: { items: [], revision: 0 } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.route('**/api/auth/sso/discovery?*', (route) => route.fulfill({ json: { loginMode: 'password-or-sso', ssoRequired: false } }))
  await page.route('**/api/auth/login', (route) => route.fulfill({
    json: { accessToken: createJwtShapedAccessToken('member-a', 'second'), expiresAt: Date.now() + 3600000, refreshToken: 'refresh-second', tokenType: 'Bearer' },
  }))
  // The refresh token is no longer accepted, so a rejected save ends the session.
  await page.route('**/api/auth/refresh', (route) => route.fulfill({ status: 401, json: { code: 'InvalidRefreshToken', message: 'Sign in again.' } }))
  await page.route((url) => url.pathname === '/api/documents', (route) => route.fulfill({ json: { nodes: documentSummaryFixtures } }))
  await page.route((url) => url.pathname === '/api/documents/recent', (route) => route.fulfill({ json: { documents: [] } }))
  const documentPath = `/api/documents/${documentRecordFixture.id}`
  await page.route((url) => url.pathname === `${documentPath}/versions`, (route) => route.fulfill({ json: { versions: [] } }))
  await page.route((url) => url.pathname === `${documentPath}/comments`, (route) => route.fulfill({ json: { comments: [] } }))
  await page.route((url) => url.pathname === `${documentPath}/shares`, (route) => route.fulfill({ json: { memberShares: [], publicShares: [] } }))
  await page.route((url) => url.pathname.startsWith(`${documentPath}/presence`), (route) => route.fulfill({ json: { presences: [] } }))
  await page.route((url) => url.pathname === `${documentPath}/recent`, (route) => route.fulfill({ status: 204 }))
  await page.route((url) => url.pathname === `${documentPath}/realtime/tickets`, (route) => route.fulfill({ status: 503, json: { code: 'RealtimeUnavailable', message: 'Unavailable.' } }))
  await page.route((url) => url.pathname === `/api/documents/${documentRecordFixture.id}`, (route) => route.fulfill({
    json: { document: { ...documentRecordFixture, blocks: state.blocks, revision: state.revision } },
  }))
  await page.route((url) => url.pathname === `/api/documents/${documentRecordFixture.id}/operations`, (route) => {
    if (state.rejectNextSave) {
      state.rejectNextSave = false
      return route.fulfill({ status: 401, json: { code: 'Unauthorized', message: 'Unauthorized' } })
    }
    const input: ApplyDocumentOperationsInput = route.request().postDataJSON()
    if (input.baseRevision !== state.revision) {
      return route.fulfill({ status: 409, json: { code: 'DocumentRevisionConflict', message: 'Conflict.' } })
    }
    state.savedBatches.push(input)
    for (const operation of input.operations) {
      if (operation.type === 'insert-block') state.blocks = [...state.blocks.slice(0, operation.index), operation.block, ...state.blocks.slice(operation.index)]
      if (operation.type !== 'update-block') continue
      if (!state.blocks.some((block) => block.id === operation.blockId)) {
        return route.fulfill({ status: 404, json: { code: 'DocumentElementNotFound', message: 'Block was not found.' } })
      }
      state.blocks = state.blocks.map((block) => block.id === operation.blockId ? operation.block : block)
    }
    state.revision += 1
    return route.fulfill({ json: { documentId: documentRecordFixture.id, revision: state.revision, acceptedOperationIds: input.operations.map((operation) => operation.operationId) } })
  })
  return state
}

test.describe('Document editing across an ended session', () => {
  test('keeps unsaved edits and saves them after the same account signs in again', async ({ page }) => {
    const state = await mockDocuments(page)
    await page.goto(`/documents/${documentRecordFixture.id}`)
    const paragraph = page.getByLabel('Text', { exact: true })
    state.rejectNextSave = true
    await paragraph.fill('Edited while the session ended.')
    // The autosave fails and the refresh token is refused, which ends the session.
    await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible()
    expect(state.savedBatches).toHaveLength(0)

    await page.reload()
    await expect(page).toHaveURL(/returnTo=/u)
    await page.getByLabel('Email address').fill('member-a@example.com')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByLabel('Password', { exact: true }).fill('MemberA123!')
    await page.getByRole('button', { name: 'Log in', exact: true }).click()

    await expect(page).toHaveURL(`/documents/${documentRecordFixture.id}`)
    await expect(paragraph).toHaveValue('Edited while the session ended.')
    await expect(page.getByText('Restored the changes that were not saved when your session ended.')).toBeVisible()
    // The restored edits are saved against the revision they were made on.
    await expect.poll(() => state.savedBatches.length).toBe(1)
    expect(state.savedBatches[0]?.baseRevision).toBe(documentRecordFixture.revision)
    expect(JSON.stringify(state.savedBatches[0]?.operations)).toContain('Edited while the session ended.')
  })

  test('asks before overwriting a Document that changed while the session was over', async ({ page }) => {
    const state = await mockDocuments(page)
    await page.goto(`/documents/${documentRecordFixture.id}`)
    const paragraph = page.getByLabel('Text', { exact: true })
    state.rejectNextSave = true
    await paragraph.fill('Edited before someone else saved.')
    await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible()
    // Another member saves the Document before this member comes back.
    state.revision += 1

    await page.reload()
    await page.getByLabel('Email address').fill('member-a@example.com')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByLabel('Password', { exact: true }).fill('MemberA123!')
    await page.getByRole('button', { name: 'Log in', exact: true }).click()

    await expect(paragraph).toHaveValue('Edited before someone else saved.')
    await expect(page.getByRole('button', { name: 'Overwrite latest revision' })).toBeVisible()
    expect(state.savedBatches).toHaveLength(0)
  })

  test('adds back a block that someone deleted while the session was over', async ({ page }) => {
    const state = await mockDocuments(page)
    await page.goto(`/documents/${documentRecordFixture.id}`)
    const paragraph = page.getByLabel('Text', { exact: true })
    state.rejectNextSave = true
    await paragraph.fill('Edited before someone deleted it.')
    await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible()
    // Another member deletes the paragraph before this member comes back.
    state.blocks = state.blocks.filter((block) => block.type !== 'paragraph')
    state.revision += 1

    await page.reload()
    await page.getByLabel('Email address').fill('member-a@example.com')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByLabel('Password', { exact: true }).fill('MemberA123!')
    await page.getByRole('button', { name: 'Log in', exact: true }).click()

    await expect(paragraph).toHaveValue('Edited before someone deleted it.')
    await expect(page.getByText('Changes to parts deleted in the meantime were added back', { exact: false })).toBeVisible()
    // The Document changed, so the member confirms before the paragraph is added back.
    await page.getByRole('button', { name: 'Overwrite latest revision' }).click()
    await expect.poll(() => state.savedBatches.length).toBe(1)
    expect(state.savedBatches[0]?.operations.map((operation) => operation.type)).toEqual(['insert-block'])
    expect(state.blocks.at(-1)).toMatchObject({ text: 'Edited before someone deleted it.', type: 'paragraph' })
  })
})
