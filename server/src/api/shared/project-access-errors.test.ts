import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import { toProjectDataErrorResponse } from './project-access'

test('reports a schedule baseline switched during a Work Item edit as a reloadable conflict', async () => {
  const app = new Hono()
  app.get('/', (c) => toProjectDataErrorResponse(c, new ProjectDataError(
    409,
    'ScheduleBaselineChanged',
    'The Project schedule baseline changed during the update. Reload and try again.',
  )))

  const response = await app.request('/')

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    code: 'ScheduleBaselineChanged',
    message: 'The Project schedule baseline changed during the update. Reload and try again.',
  })
})
