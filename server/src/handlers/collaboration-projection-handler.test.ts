import { expect, test } from 'bun:test'

test('imports the production collaboration projection without unrelated API secrets', async () => {
  const environment = {
    ...process.env,
    AWS_LAMBDA_FUNCTION_NAME: 'audit-projection',
    AWS_REGION: 'ap-northeast-1',
    COLLABORATION_TABLE_NAME: 'CollaborationTable',
    DOCUMENTS_TABLE_NAME: 'DocumentsTable',
    NODE_ENV: 'production',
    PROJECT_DIRECTORY_TABLE_NAME: 'ProjectDirectoryTable',
    WORK_ITEMS_TABLE_NAME: 'WorkItemsTable',
    WORKSPACE_SEARCH_TABLE_NAME: 'WorkspaceSearchTable',
  }
  Reflect.deleteProperty(environment, 'ANALYTICS_TABLE_NAME')
  Reflect.deleteProperty(environment, 'REQUEST_TOKEN_HASH_SECRET')
  const moduleUrl = new URL('./collaboration-projection-handler.ts', import.meta.url).href
  const subprocess = Bun.spawn({
    cmd: [
      process.execPath,
      '--eval',
      `await import(${JSON.stringify(moduleUrl)}); console.log('projection-imported')`,
    ],
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [exitCode, standardError, standardOutput] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
    new Response(subprocess.stdout).text(),
  ])

  expect(exitCode).toBe(0)
  expect(standardError).toBe('')
  expect(standardOutput).toContain('projection-imported')
  expect(standardError).not.toContain('REQUEST_TOKEN_HASH_SECRET')
  expect(standardError).not.toContain('ANALYTICS_TABLE_NAME')
})
