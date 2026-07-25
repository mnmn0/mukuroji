import { Validations } from 'aws-cdk-lib';
import type { Stack } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

const secretPaths = [
  'ConnectorRuntimeSecret/Resource',
  'DocumentPublicShareTokenSecret/Resource',
] as const;
const deadLetterQueuePaths = [
  'ConnectorPollDlq/Resource',
  'CollaborationProjectionDlq/Resource',
  'AutomationEventDlq/Resource',
  'AutomationScheduleDlq/Resource',
  'AnalyticsScheduleDlq/Resource',
  'NotificationScheduleDlq/Resource',
  'RequestEmailIngestionDlq/Resource',
] as const;
const lambdaPaths = [
  'ListProjectTasksFunction/Resource',
  'WorkItemImportFunction/Resource',
  'RealtimeHandlerFunction/Resource',
  'CollaborationProjectionFunction/Resource',
  'AutomationEventFunction/Resource',
  'AutomationScheduleFunction/Resource',
  'RuntimeControlAlarmReadinessOnEventFunction/Resource',
  'RuntimeControlAlarmReadinessPollFunction/Resource',
  'WebhookAuthorizationBackfillFunction/Resource',
  'WebhookAuthorizationBackfillProgressFunction/Resource',
  'WebhookDeliveryFunction/Resource',
  'ConnectorSyncFunction/Resource',
  'ConnectorPollFunction/Resource',
  'AnalyticsScheduleFunction/Resource',
  'NotificationScheduleFunction/Resource',
  'RequestEmailIngestionFunction/Resource',
] as const;
const managedPolicyRolePaths = [
  'BucketNotificationsHandler050a0587b7544547bf325f094a3db834/Role/Resource',
  'ListProjectTasksFunction/ServiceRole/Resource',
  'WorkItemImportFunction/ServiceRole/Resource',
  'RealtimeHandlerFunction/ServiceRole/Resource',
  'CollaborationProjectionFunction/ServiceRole/Resource',
  'AutomationEventFunction/ServiceRole/Resource',
  'AutomationScheduleFunction/ServiceRole/Resource',
  'RuntimeControlAlarmReadinessOnEventFunction/ServiceRole/Resource',
  'RuntimeControlAlarmReadinessPollFunction/ServiceRole/Resource',
  'RuntimeControlAlarmReadinessProvider/framework-onEvent/ServiceRole/Resource',
  'RuntimeControlAlarmReadinessProvider/framework-isComplete/ServiceRole/Resource',
  'RuntimeControlAlarmReadinessProvider/framework-onTimeout/ServiceRole/Resource',
  'WebhookAuthorizationBackfillFunction/ServiceRole/Resource',
  'WebhookAuthorizationBackfillProgressFunction/ServiceRole/Resource',
  'WebhookAuthorizationBackfillProvider/framework-onEvent/ServiceRole/Resource',
  'WebhookAuthorizationBackfillProvider/framework-isComplete/ServiceRole/Resource',
  'WebhookAuthorizationBackfillProvider/framework-onTimeout/ServiceRole/Resource',
  'WebhookDeliveryFunction/ServiceRole/Resource',
  'ConnectorSyncFunction/ServiceRole/Resource',
  'ConnectorPollFunction/ServiceRole/Resource',
  'AnalyticsScheduleFunction/ServiceRole/Resource',
  'NotificationScheduleFunction/ServiceRole/Resource',
  'RequestEmailIngestionFunction/ServiceRole/Resource',
  'AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource',
] as const;
const httpApiRoutePaths = [
  'ProjectTasksHttpApi/DefaultRoute/Resource',
  'RealtimeWebSocketApi/$connect-Route/Resource',
  'RealtimeWebSocketApi/$disconnect-Route/Resource',
  'RealtimeWebSocketApi/$default-Route/Resource',
] as const;
const apiStagePaths = [
  'ProjectTasksHttpApi/DefaultStage/Resource',
  'RealtimeWebSocketStage/Resource',
] as const;
const waiterStateMachinePath = [
  'RuntimeControlAlarmReadinessProvider/waiter-state-machine/Resource',
  'WebhookAuthorizationBackfillProvider/waiter-state-machine/Resource',
] as const;
const iam5FindingScopePaths = new Map<string, readonly string[]>([
  [
    'AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:events:<AWS::Region>:<AWS::AccountId>:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*]',
    ['FileMalwareProtectionPolicy/Resource'],
  ],
  [
    'AwsSolutions-IAM5[Resource::<FileBucketCDFCD6DE.Arn>/workspaces/*]',
    [
      'FileMalwareProtectionPolicy/Resource',
      'ListProjectTasksFunction/ServiceRole/DefaultPolicy/Resource',
      'CollaborationProjectionFunction/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<ProjectTasksTableE21F6637.Arn>/index/*]',
    ['ListProjectTasksFunction/ServiceRole/DefaultPolicy/Resource'],
  ],
  [
    'AwsSolutions-IAM5[Resource::<AuditEventsTable0723963E.Arn>/index/*]',
    [
      'ListProjectTasksFunction/ServiceRole/DefaultPolicy/Resource',
      'WorkItemImportFunction/ServiceRole/DefaultPolicy/Resource',
      'AutomationEventFunction/ServiceRole/DefaultPolicy/Resource',
      'AutomationScheduleFunction/ServiceRole/DefaultPolicy/Resource',
      'ConnectorSyncFunction/ServiceRole/DefaultPolicy/Resource',
      'NotificationScheduleFunction/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<NotificationsTable76DCFC6C.Arn>/index/*]',
    [
      'ListProjectTasksFunction/ServiceRole/DefaultPolicy/Resource',
      'CollaborationProjectionFunction/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<ProjectDirectoryTable9ED01C01.Arn>/index/*]',
    [
      'ListProjectTasksFunction/ServiceRole/DefaultPolicy/Resource',
      'WorkItemImportFunction/ServiceRole/DefaultPolicy/Resource',
      'RealtimeHandlerFunction/ServiceRole/DefaultPolicy/Resource',
      'CollaborationProjectionFunction/ServiceRole/DefaultPolicy/Resource',
      'AutomationEventFunction/ServiceRole/DefaultPolicy/Resource',
      'AutomationScheduleFunction/ServiceRole/DefaultPolicy/Resource',
      'WebhookAuthorizationBackfillFunction/ServiceRole/DefaultPolicy/Resource',
      'WebhookAuthorizationBackfillProgressFunction/ServiceRole/DefaultPolicy/Resource',
      'ConnectorSyncFunction/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<TeamIssuesTable189D851D.Arn>/index/*]',
    [
      'ListProjectTasksFunction/ServiceRole/DefaultPolicy/Resource',
      'WorkItemImportFunction/ServiceRole/DefaultPolicy/Resource',
      'RealtimeHandlerFunction/ServiceRole/DefaultPolicy/Resource',
      'CollaborationProjectionFunction/ServiceRole/DefaultPolicy/Resource',
      'AutomationEventFunction/ServiceRole/DefaultPolicy/Resource',
      'AutomationScheduleFunction/ServiceRole/DefaultPolicy/Resource',
      'ConnectorSyncFunction/ServiceRole/DefaultPolicy/Resource',
      'NotificationScheduleFunction/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<RealtimeSessionsTable607096EB.Arn>/index/*]',
    [
      'ListProjectTasksFunction/ServiceRole/DefaultPolicy/Resource',
      'RealtimeHandlerFunction/ServiceRole/DefaultPolicy/Resource',
      'CollaborationProjectionFunction/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<WorkItemImportBucket14068778.Arn>/work-item-imports/*]',
    [
      'ListProjectTasksFunction/ServiceRole/DefaultPolicy/Resource',
      'WorkItemImportFunction/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<AutomationTableE3D67F0D.Arn>/index/*]',
    [
      'ApiAutomationDataPolicy/Resource',
      'AutomationEventFunction/ServiceRole/DefaultPolicy/Resource',
      'AutomationScheduleFunction/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<RequestIntakeTable608708D4.Arn>/index/*]',
    ['ApiRequestIntakeDataPolicy/Resource'],
  ],
  [
    'AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:secretsmanager:<AWS::Region>:<AWS::AccountId>:secret:mukuroji/automation-webhooks/*]',
    [
      'ApiAutomationWebhookSecretPolicy/Resource',
      'AutomationEventWebhookSecretPolicy/Resource',
      'AutomationScheduleWebhookSecretPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:secretsmanager:<AWS::Region>:<AWS::AccountId>:secret:mukuroji/automation-inbound-webhooks/*]',
    [
      'ApiAutomationInboundWebhookSecretPolicy/Resource',
      'AutomationScheduleInboundWebhookSecretCleanupPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<DeveloperPlatformTable772E085C.Arn>/index/*]',
    [
      'WorkItemImportFunction/ServiceRole/DefaultPolicy/Resource',
      'WebhookAuthorizationBackfillFunction/ServiceRole/DefaultPolicy/Resource',
      'WebhookAuthorizationBackfillProgressFunction/ServiceRole/DefaultPolicy/Resource',
      'ConnectorSyncFunction/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:execute-api:<AWS::Region>:<AWS::AccountId>:<RealtimeWebSocketApiC99C6240>/production/*/@connections/*]',
    [
      'RealtimeHandlerFunction/ServiceRole/DefaultPolicy/Resource',
      'CollaborationProjectionFunction/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::*]',
    [
      'CollaborationProjectionFunction/ServiceRole/DefaultPolicy/Resource',
      'AutomationEventFunction/ServiceRole/DefaultPolicy/Resource',
      'RuntimeControlAlarmReadinessPollFunction/ServiceRole/DefaultPolicy/Resource',
      'RuntimeControlAlarmMonitorPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<RuntimeControlAlarmReadinessOnEventFunctionA25C5A0C.Arn>:*]',
    [
      'RuntimeControlAlarmReadinessProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource',
      'RuntimeControlAlarmReadinessProvider/framework-isComplete/ServiceRole/DefaultPolicy/Resource',
      'RuntimeControlAlarmReadinessProvider/framework-onTimeout/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<RuntimeControlAlarmReadinessPollFunctionCD017060.Arn>:*]',
    [
      'RuntimeControlAlarmReadinessProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource',
      'RuntimeControlAlarmReadinessProvider/framework-isComplete/ServiceRole/DefaultPolicy/Resource',
      'RuntimeControlAlarmReadinessProvider/framework-onTimeout/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<RuntimeControlAlarmReadinessProviderframeworkisComplete30325ABD.Arn>:*]',
    ['RuntimeControlAlarmReadinessProvider/waiter-state-machine/Role/DefaultPolicy/Resource'],
  ],
  [
    'AwsSolutions-IAM5[Resource::<RuntimeControlAlarmReadinessProviderframeworkonTimeout38DF830E.Arn>:*]',
    ['RuntimeControlAlarmReadinessProvider/waiter-state-machine/Role/DefaultPolicy/Resource'],
  ],
  [
    'AwsSolutions-IAM5[Resource::<WebhookAuthorizationBackfillFunction5ABBA705.Arn>:*]',
    [
      'WebhookAuthorizationBackfillProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource',
      'WebhookAuthorizationBackfillProvider/framework-isComplete/ServiceRole/DefaultPolicy/Resource',
      'WebhookAuthorizationBackfillProvider/framework-onTimeout/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<WebhookAuthorizationBackfillProgressFunction1FF04FD2.Arn>:*]',
    [
      'WebhookAuthorizationBackfillProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource',
      'WebhookAuthorizationBackfillProvider/framework-isComplete/ServiceRole/DefaultPolicy/Resource',
      'WebhookAuthorizationBackfillProvider/framework-onTimeout/ServiceRole/DefaultPolicy/Resource',
    ],
  ],
  [
    'AwsSolutions-IAM5[Resource::<WebhookAuthorizationBackfillProviderframeworkisComplete0B745C37.Arn>:*]',
    ['WebhookAuthorizationBackfillProvider/waiter-state-machine/Role/DefaultPolicy/Resource'],
  ],
  [
    'AwsSolutions-IAM5[Resource::<WebhookAuthorizationBackfillProviderframeworkonTimeoutB47F77F4.Arn>:*]',
    ['WebhookAuthorizationBackfillProvider/waiter-state-machine/Role/DefaultPolicy/Resource'],
  ],
]);

const acknowledgedFindings = [
  {
    id: 'AwsSolutions-SMG4',
    reason: 'These secrets are application configuration inputs; automatic rotation requires coordinated consumers and is not supported by the current deployment contract.',
    scopePaths: secretPaths,
  },
  {
    id: 'AwsSolutions-S1',
    reason: 'File uploads are private application data. Access is audited by the application and CloudTrail; adding an S3 server-log bucket would introduce a separate log lifecycle without improving the required audit trail.',
    scopePaths: ['FileBucket/Resource'],
  },
  {
    id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    reason: 'The AWS-managed basic execution policy is attached by CDK to Lambda service roles, including framework-generated roles; replacing it would require duplicating AWS-managed logging permissions.',
    scopePaths: managedPolicyRolePaths,
  },
  {
    id: 'AwsSolutions-SQS3',
    reason: 'The reported queues are terminal dead-letter queues. Adding another dead-letter queue would create an unbounded failure chain instead of improving recovery.',
    scopePaths: deadLetterQueuePaths,
  },
  {
    id: 'AwsSolutions-L1',
    reason: 'The finding includes CDK framework-generated Lambda providers whose runtime is controlled by the library; application Lambda runtimes are pinned to the current supported Node.js runtime.',
    scopePaths: lambdaPaths,
  },
  {
    id: 'AwsSolutions-APIG4',
    reason: 'HTTP requests are authorized in the Hono application and WebSocket connection/message authorization is handled by the realtime Lambda integration rather than an API Gateway authorizer.',
    scopePaths: httpApiRoutePaths,
  },
  {
    id: 'AwsSolutions-APIG1',
    reason: 'API request and realtime event auditing is handled by application and CloudWatch logs; API Gateway access-log delivery is intentionally not enabled for these stages.',
    scopePaths: apiStagePaths,
  },
  {
    id: 'AwsSolutions-SF1',
    reason: 'This state machine is the CDK Provider waiter generated for a custom resource, not an application-owned workflow; its logging configuration is controlled by the CDK provider implementation.',
    scopePaths: waiterStateMachinePath,
  },
  {
    id: 'AwsSolutions-SF2',
    reason: 'This state machine is the CDK Provider waiter generated for a custom resource, not an application-owned workflow; its tracing configuration is controlled by the CDK provider implementation.',
    scopePaths: waiterStateMachinePath,
  },
  ...[
    'AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:events:<AWS::Region>:<AWS::AccountId>:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*]',
    'AwsSolutions-IAM5[Resource::<FileBucketCDFCD6DE.Arn>/workspaces/*]',
    'AwsSolutions-IAM5[Resource::<ProjectTasksTableE21F6637.Arn>/index/*]',
    'AwsSolutions-IAM5[Resource::<AuditEventsTable0723963E.Arn>/index/*]',
    'AwsSolutions-IAM5[Resource::<NotificationsTable76DCFC6C.Arn>/index/*]',
    'AwsSolutions-IAM5[Resource::<ProjectDirectoryTable9ED01C01.Arn>/index/*]',
    'AwsSolutions-IAM5[Resource::<TeamIssuesTable189D851D.Arn>/index/*]',
    'AwsSolutions-IAM5[Resource::<RealtimeSessionsTable607096EB.Arn>/index/*]',
    'AwsSolutions-IAM5[Resource::<WorkItemImportBucket14068778.Arn>/work-item-imports/*]',
    'AwsSolutions-IAM5[Resource::<AutomationTableE3D67F0D.Arn>/index/*]',
    'AwsSolutions-IAM5[Resource::<RequestIntakeTable608708D4.Arn>/index/*]',
    'AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:secretsmanager:<AWS::Region>:<AWS::AccountId>:secret:mukuroji/automation-webhooks/*]',
    'AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:secretsmanager:<AWS::Region>:<AWS::AccountId>:secret:mukuroji/automation-inbound-webhooks/*]',
    'AwsSolutions-IAM5[Resource::<DeveloperPlatformTable772E085C.Arn>/index/*]',
    'AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:execute-api:<AWS::Region>:<AWS::AccountId>:<RealtimeWebSocketApiC99C6240>/production/*/@connections/*]',
    'AwsSolutions-IAM5[Resource::*]',
    'AwsSolutions-IAM5[Resource::<RuntimeControlAlarmReadinessOnEventFunctionA25C5A0C.Arn>:*]',
    'AwsSolutions-IAM5[Resource::<RuntimeControlAlarmReadinessPollFunctionCD017060.Arn>:*]',
    'AwsSolutions-IAM5[Resource::<RuntimeControlAlarmReadinessProviderframeworkisComplete30325ABD.Arn>:*]',
    'AwsSolutions-IAM5[Resource::<RuntimeControlAlarmReadinessProviderframeworkonTimeout38DF830E.Arn>:*]',
    'AwsSolutions-IAM5[Resource::<WebhookAuthorizationBackfillFunction5ABBA705.Arn>:*]',
    'AwsSolutions-IAM5[Resource::<WebhookAuthorizationBackfillProgressFunction1FF04FD2.Arn>:*]',
    'AwsSolutions-IAM5[Resource::<WebhookAuthorizationBackfillProviderframeworkisComplete0B745C37.Arn>:*]',
    'AwsSolutions-IAM5[Resource::<WebhookAuthorizationBackfillProviderframeworkonTimeoutB47F77F4.Arn>:*]',
  ].map((id) => ({
    id,
    reason: 'The wildcard is constrained to the required S3 prefix, DynamoDB index, Secrets Manager namespace, API Gateway connection, GuardDuty rule, CDK custom-resource provider resource, or CloudWatch DescribeAlarms action required for AppConfig alarm monitoring.',
    scopePaths: iam5FindingScopePaths.get(id),
  })),
] as const;

/**
 * Acknowledges the current, reviewed AwsSolutions findings for the stack.
 *
 * New findings remain unacknowledged and therefore continue to fail synthesis.
 */
export function acknowledgeKnownNagFindings(stack: Stack): void {
  for (const finding of acknowledgedFindings) {
    const id = `AwsSolutions::${finding.id}`;
    const scopePaths = 'scopePaths' in finding ? finding.scopePaths : undefined;
    const scopes: IConstruct[] = scopePaths
      ? scopePaths.map((path: string) => findConstruct(stack, path))
      : [stack];

    for (const scope of scopes) {
      if (finding.id.includes('[')) {
        // CDK 2.261.0 rejects nested `::` delimiters in Validations.acknowledge,
        // while cdk-nag uses them in granular finding IDs such as Resource::.
        scope.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
          [id]: finding.reason,
        });
        continue;
      }

      Validations.of(scope).acknowledge({ ...finding, id });
    }
  }
}

function findConstruct(stack: Stack, relativePath: string): IConstruct {
  let current: IConstruct = stack;

  for (const segment of relativePath.split('/')) {
    current = current.node.findChild(segment);
  }

  return current;
}
