import { expect, test } from 'bun:test'
import type {
  DescribeAlarmsCommand,
  DescribeAlarmsCommandOutput,
} from '@aws-sdk/client-cloudwatch'
import {
  checkRuntimeControlAlarmReadiness,
  isCompleteHandler,
  onEventHandler,
  type RuntimeControlAlarmReadinessClient,
} from './runtime-control-alarm-readiness'

/**
 * Creates a deterministic client that records each DescribeAlarms request.
 *
 * @param response - CloudWatch response returned for every request.
 * @returns Fake client and captured commands.
 */
function createClient(response: DescribeAlarmsCommandOutput): {
  /** Captured DescribeAlarms commands. */
  readonly commands: DescribeAlarmsCommand[]
  /** Fake readiness client. */
  readonly client: RuntimeControlAlarmReadinessClient
} {
  const commands: DescribeAlarmsCommand[] = []
  return {
    commands,
    client: {
      async send(command) {
        commands.push(command)
        return response
      },
    },
  }
}

test('starts a stable readiness wait for a validated alarm name', async () => {
  await expect(onEventHandler({
    RequestType: 'Create',
    ResourceProperties: {
      AlarmName: 'runtime-control-configuration-failure',
    },
  })).resolves.toEqual({
    PhysicalResourceId: 'mukuroji-runtime-control-alarm-readiness-v1',
  })
})

test('preserves the physical identifier and skips all delete validation', async () => {
  await expect(onEventHandler({
    PhysicalResourceId: 'retained-physical-id',
    RequestType: 'Delete',
    ResourceProperties: { AlarmName: 42 },
  })).resolves.toEqual({
    PhysicalResourceId: 'retained-physical-id',
    SkipWait: true,
  })
  await expect(onEventHandler({
    RequestType: 'Delete',
  })).resolves.toEqual({
    PhysicalResourceId: 'mukuroji-runtime-control-alarm-readiness-v1',
    SkipWait: true,
  })
  await expect(isCompleteHandler({
    RequestType: 'Delete',
  })).resolves.toEqual({ IsComplete: true })

  const fake = createClient({ $metadata: {} })
  await expect(checkRuntimeControlAlarmReadiness({
    RequestType: 'Delete',
    ResourceProperties: { AlarmName: 42 },
  }, fake.client)).resolves.toEqual({ IsComplete: true })
  expect(fake.commands).toHaveLength(0)
})

test('waits for exactly one matching naturally OK alarm with actions enabled', async () => {
  const alarmName = 'runtime-control-configuration-failure'
  for (const response of [
    { $metadata: {} },
    {
      $metadata: {},
      MetricAlarms: [{
        ActionsEnabled: true,
        AlarmName: alarmName,
        StateValue: 'INSUFFICIENT_DATA',
      }],
    },
    {
      $metadata: {},
      MetricAlarms: [{
        ActionsEnabled: true,
        AlarmName: alarmName,
        StateValue: 'ALARM',
      }],
    },
    {
      $metadata: {},
      MetricAlarms: [{
        AlarmName: alarmName,
        StateValue: 'OK',
      }],
    },
    {
      $metadata: {},
      MetricAlarms: [{
        ActionsEnabled: false,
        AlarmName: alarmName,
        StateValue: 'OK',
      }],
    },
    {
      $metadata: {},
      MetricAlarms: [{
        ActionsEnabled: true,
        AlarmName: 'different-alarm',
        StateValue: 'OK',
      }],
    },
    {
      $metadata: {},
      MetricAlarms: [
        {
          ActionsEnabled: true,
          AlarmName: alarmName,
          StateValue: 'OK',
        },
        {
          ActionsEnabled: true,
          AlarmName: alarmName,
          StateValue: 'OK',
        },
      ],
    },
  ] satisfies DescribeAlarmsCommandOutput[]) {
    const fake = createClient(response)
    await expect(checkRuntimeControlAlarmReadiness({
      RequestType: 'Create',
      ResourceProperties: { AlarmName: alarmName },
    }, fake.client)).resolves.toEqual({ IsComplete: false })
    expect(fake.commands).toHaveLength(1)
    expect(fake.commands[0]?.input).toEqual({
      AlarmNames: [alarmName],
      AlarmTypes: ['MetricAlarm'],
    })
  }

  const ready = createClient({
    $metadata: {},
    MetricAlarms: [{
      ActionsEnabled: true,
      AlarmName: alarmName,
      StateValue: 'OK',
    }],
  })
  await expect(checkRuntimeControlAlarmReadiness({
    RequestType: 'Update',
    ResourceProperties: { AlarmName: alarmName },
  }, ready.client)).resolves.toEqual({ IsComplete: true })
})

test('propagates DescribeAlarms failures instead of treating them as ready', async () => {
  const client: RuntimeControlAlarmReadinessClient = {
    async send() {
      throw new Error('CloudWatch unavailable')
    },
  }

  await expect(checkRuntimeControlAlarmReadiness({
    RequestType: 'Create',
    ResourceProperties: {
      AlarmName: 'runtime-control-configuration-failure',
    },
  }, client)).rejects.toThrow('CloudWatch unavailable')
})

test('rejects missing, blank, unbounded, or control-character alarm names', async () => {
  for (const AlarmName of [
    undefined,
    '',
    ' padded ',
    'x'.repeat(256),
    'alarm\nname',
  ]) {
    await expect(onEventHandler({
      RequestType: 'Create',
      ResourceProperties: { AlarmName },
    })).rejects.toThrow('Runtime-control alarm name is invalid.')
  }
})
