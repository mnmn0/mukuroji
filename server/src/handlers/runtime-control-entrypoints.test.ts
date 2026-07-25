import { expect, test } from 'bun:test'
import type {
  RuntimeControlWorkerSurface,
} from '../infrastructure/runtime/runtime-control'

/**
 * One Lambda export that must evaluate a stable runtime-control surface.
 */
interface RuntimeControlledEntrypoint {
  /** Handler source filename relative to this test. */
  readonly filename: string
  /** Export selected by the corresponding Lambda configuration. */
  readonly exportName: string
  /** Exact scope injected into that Lambda by CDK. */
  readonly surface: RuntimeControlWorkerSurface
}

const runtimeControlledEntrypoints: readonly RuntimeControlledEntrypoint[] = [
  {
    filename: 'analytics-schedule-handler.ts',
    exportName: 'handler',
    surface: 'analytics-schedule',
  },
  {
    filename: 'audit-projection-handler.ts',
    exportName: 'handler',
    surface: 'audit-projection',
  },
  {
    filename: 'automation-event-handler.ts',
    exportName: 'handler',
    surface: 'automation-event',
  },
  {
    filename: 'automation-schedule-handler.ts',
    exportName: 'handler',
    surface: 'automation-schedule',
  },
  {
    filename: 'connector-handler.ts',
    exportName: 'queueHandler',
    surface: 'connector-sync',
  },
  {
    filename: 'connector-handler.ts',
    exportName: 'pollHandler',
    surface: 'connector-poll',
  },
  {
    filename: 'enterprise-identity-maintenance-handler.ts',
    exportName: 'handler',
    surface: 'enterprise-identity-maintenance',
  },
  {
    filename: 'enterprise-scim-group-job-worker-handler.ts',
    exportName: 'handler',
    surface: 'enterprise-scim-group-job',
  },
  {
    filename: 'notification-schedule-handler.ts',
    exportName: 'handler',
    surface: 'notification-schedule',
  },
  {
    filename: 'realtime-handler.ts',
    exportName: 'handler',
    surface: 'realtime',
  },
  {
    filename: 'request-intake-email-handler.ts',
    exportName: 'handler',
    surface: 'request-intake-email',
  },
  {
    filename: 'webhook-handler.ts',
    exportName: 'deliveryHandler',
    surface: 'webhook-delivery',
  },
  {
    filename: 'work-item-import.handler.ts',
    exportName: 'workItemImportHandler',
    surface: 'work-item-import',
  },
]

test('guards every deployed worker and realtime entrypoint with its exact surface', async () => {
  for (const entrypoint of runtimeControlledEntrypoints) {
    const source = await Bun.file(
      `${import.meta.dir}/${entrypoint.filename}`,
    ).text()
    const compactSource = source.replace(/\s+/gu, ' ')

    if (entrypoint.surface === 'audit-projection') {
      expect(compactSource).toContain(
        'export const handler = createAuditProjectionEntrypoint(',
      )
      expect(compactSource).toContain(
        "createRuntimeControlGuardedHandler( 'audit-projection',",
      )
      continue
    }

    expect(compactSource).toContain(
      `export const ${entrypoint.exportName} = ` +
      `createRuntimeControlGuardedHandler( '${entrypoint.surface}',`,
    )
  }
})

test('leaves recovery backfills and the inner Connector projection unguarded', async () => {
  const backfillSource = await Bun.file(
    `${import.meta.dir}/webhook-authorization-backfill-handler.ts`,
  ).text()
  const connectorSource = await Bun.file(
    `${import.meta.dir}/connector-handler.ts`,
  ).text()
  const compactConnectorSource = connectorSource.replace(/\s+/gu, ' ')

  expect(backfillSource).not.toContain('createRuntimeControlGuardedHandler')
  expect(compactConnectorSource).toContain(
    'export const auditProjectionHandler = (...args:',
  )
})
