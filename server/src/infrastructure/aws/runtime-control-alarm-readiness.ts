import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  type DescribeAlarmsCommandOutput,
} from '@aws-sdk/client-cloudwatch'

/**
 * CloudFormation Provider event used while waiting for the runtime-control alarm.
 */
export interface RuntimeControlAlarmReadinessEvent {
  /** Existing physical identifier supplied during update and delete requests. */
  readonly PhysicalResourceId?: string
  /** CloudFormation request operation. */
  readonly RequestType?: 'Create' | 'Delete' | 'Update'
  /** Properties supplied by the runtime-control custom resource. */
  readonly ResourceProperties?: {
    /** Exact CloudWatch metric alarm name to inspect. */
    readonly AlarmName?: unknown
  }
  /** Delete short-circuit returned by the on-event handler. */
  readonly SkipWait?: boolean
}

/**
 * Minimal CloudWatch client contract used by the readiness poll.
 */
export interface RuntimeControlAlarmReadinessClient {
  /**
   * Describes the exact metric alarm selected by the request.
   *
   * @param command - Bounded DescribeAlarms request.
   * @returns CloudWatch alarm state response.
   */
  send(command: DescribeAlarmsCommand): Promise<DescribeAlarmsCommandOutput>
}

/** Stable custom-resource physical identifier retained across stack updates. */
const RUNTIME_CONTROL_ALARM_READINESS_PHYSICAL_ID =
  'mukuroji-runtime-control-alarm-readiness-v1'

/**
 * Starts a read-only CloudFormation Provider wait.
 *
 * Delete requests deliberately skip property validation so a malformed or
 * superseded resource can always be removed.
 *
 * @param event - CloudFormation Provider event.
 * @returns Stable physical identifier and delete short-circuit state.
 */
export async function onEventHandler(
  event: RuntimeControlAlarmReadinessEvent,
): Promise<{
  /** Stable custom-resource physical identifier. */
  readonly PhysicalResourceId: string
  /** Whether the completion poll can return immediately. */
  readonly SkipWait?: true
}> {
  const physicalResourceId = readPhysicalResourceId(event)
  if (event.RequestType === 'Delete') {
    return {
      PhysicalResourceId: physicalResourceId,
      SkipWait: true,
    }
  }

  readAlarmName(event)
  return { PhysicalResourceId: physicalResourceId }
}

/**
 * Polls until CloudWatch naturally evaluates the exact alarm as actionable OK.
 *
 * This function never calls SetAlarmState. An alarm is ready only when its
 * natural state is OK and actions remain enabled, which is the monitor contract
 * AWS AppConfig relies on for automatic rollback.
 *
 * @param event - CloudFormation Provider event.
 * @returns Provider completion response.
 */
export async function isCompleteHandler(
  event: RuntimeControlAlarmReadinessEvent,
): Promise<{
  /** Whether CloudFormation may continue creating the AppConfig environment. */
  readonly IsComplete: boolean
}> {
  return await checkRuntimeControlAlarmReadiness(
    event,
    new CloudWatchClient({}),
  )
}

/**
 * Evaluates one alarm-readiness poll with an explicit CloudWatch boundary.
 *
 * Keeping dependency injection outside the Lambda handler signature prevents
 * the runtime's second context argument from being mistaken for a client.
 *
 * @param event - CloudFormation Provider event.
 * @param client - CloudWatch client used for the exact read-only request.
 * @returns Provider completion response.
 */
export async function checkRuntimeControlAlarmReadiness(
  event: RuntimeControlAlarmReadinessEvent,
  client: RuntimeControlAlarmReadinessClient,
): Promise<{
  /** Whether CloudFormation may continue creating the AppConfig environment. */
  readonly IsComplete: boolean
}> {
  if (event.RequestType === 'Delete' || event.SkipWait === true) {
    return { IsComplete: true }
  }

  const alarmName = readAlarmName(event)
  const response = await client.send(new DescribeAlarmsCommand({
    AlarmNames: [alarmName],
    AlarmTypes: ['MetricAlarm'],
  }))
  const alarms = response.MetricAlarms ?? []
  const ready = alarms.length === 1 &&
    alarms[0]?.AlarmName === alarmName &&
    alarms[0].ActionsEnabled === true &&
    alarms[0].StateValue === 'OK'

  return { IsComplete: ready }
}

/**
 * Reads the stable physical identifier without trusting blank event values.
 *
 * @param event - CloudFormation Provider event.
 * @returns Existing non-blank identifier or the stable initial identifier.
 */
function readPhysicalResourceId(
  event: RuntimeControlAlarmReadinessEvent,
): string {
  const candidate = event.PhysicalResourceId?.trim()
  return candidate || RUNTIME_CONTROL_ALARM_READINESS_PHYSICAL_ID
}

/**
 * Validates the exact alarm name supplied by the CDK custom resource.
 *
 * @param event - CloudFormation Provider event.
 * @returns Validated CloudWatch alarm name.
 */
function readAlarmName(event: RuntimeControlAlarmReadinessEvent): string {
  const candidate = event.ResourceProperties?.AlarmName
  if (
    typeof candidate !== 'string' ||
    candidate.length < 1 ||
    candidate.length > 255 ||
    candidate.trim() !== candidate ||
    Array.from(candidate).some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127)
    })
  ) {
    throw new TypeError('Runtime-control alarm name is invalid.')
  }
  return candidate
}
