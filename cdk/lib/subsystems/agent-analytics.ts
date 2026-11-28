import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { IConstruct } from 'constructs';

/** Days an analytics object is kept: 13 months, so a year is compared with the year before. */
export const AGENT_ANALYTICS_RETENTION_DAYS = 400;

/** Largest amount of data one Athena query of the workgroup may scan. */
export const AGENT_ANALYTICS_QUERY_SCAN_LIMIT_BYTES = 1024 * 1024 * 1024;

/** Glue column of an analytics table. */
type AnalyticsColumn = Readonly<{
  /** Column name, as the rows' JSON property. */
  readonly name: string;
  /** Hive type. */
  readonly type: 'string' | 'bigint' | 'boolean';
}>;

/** One table of the analytics store: its Glue schema and the Firehose stream that fills it. */
type AnalyticsTableSpec = Readonly<{
  /** PascalCase construct ID prefix. */
  readonly id: string;
  /** Glue table name. */
  readonly tableName: string;
  /** S3 prefix below `agent-analytics/`. */
  readonly prefix: string;
  /** Data columns. */
  readonly columns: readonly AnalyticsColumn[];
}>;

/** Tables of the analytics store; the columns match `server/src/modules/agent-runs/domain/agent-telemetry-analytics.ts`. */
const analyticsTables: readonly AnalyticsTableSpec[] = [
  {
    id: 'Events',
    tableName: 'agent_events',
    prefix: 'events',
    columns: [
      { name: 'event_id', type: 'string' },
      { name: 'batch_id', type: 'string' },
      { name: 'received_at_ms', type: 'bigint' },
      { name: 'occurred_at_ms', type: 'bigint' },
      { name: 'event_name', type: 'string' },
      { name: 'member_key', type: 'string' },
      { name: 'instance_hash', type: 'string' },
      { name: 'session_hash', type: 'string' },
      { name: 'sequence', type: 'bigint' },
      { name: 'model', type: 'string' },
      { name: 'input_tokens', type: 'bigint' },
      { name: 'output_tokens', type: 'bigint' },
      { name: 'cache_read_tokens', type: 'bigint' },
      { name: 'cache_creation_tokens', type: 'bigint' },
      { name: 'cost_micro_usd', type: 'bigint' },
      { name: 'duration_ms', type: 'bigint' },
      { name: 'tool_kind', type: 'string' },
      { name: 'tool_name', type: 'string' },
      { name: 'success', type: 'boolean' },
      { name: 'decided_by_person', type: 'boolean' },
    ],
  },
  {
    id: 'Runs',
    tableName: 'agent_runs',
    prefix: 'runs',
    columns: [
      { name: 'run_id', type: 'string' },
      { name: 'record_kind', type: 'string' },
      { name: 'recorded_at_ms', type: 'bigint' },
      { name: 'team_id', type: 'string' },
      { name: 'work_item_id', type: 'string' },
      { name: 'instance_hash', type: 'string' },
      { name: 'runtime', type: 'string' },
      { name: 'started_at_ms', type: 'bigint' },
      { name: 'member_key', type: 'string' },
      { name: 'project_id', type: 'string' },
      { name: 'work_item_type_id', type: 'string' },
      { name: 'planned_effort_minutes', type: 'bigint' },
      { name: 'size_band', type: 'string' },
      { name: 'priority', type: 'string' },
      { name: 'compare_fields_json', type: 'string' },
      { name: 'resumed_from_run_id', type: 'string' },
      { name: 'state', type: 'string' },
      { name: 'outcome', type: 'string' },
      { name: 'finished_at_ms', type: 'bigint' },
    ],
  },
  {
    id: 'WorkItems',
    tableName: 'agent_work_items',
    prefix: 'work-items',
    columns: [
      { name: 'team_id', type: 'string' },
      { name: 'work_item_id', type: 'string' },
      { name: 'exported_at_ms', type: 'bigint' },
      { name: 'status_category', type: 'string' },
      { name: 'project_id', type: 'string' },
      { name: 'work_item_type_id', type: 'string' },
      { name: 'planned_effort_minutes', type: 'bigint' },
      { name: 'size_band', type: 'string' },
      { name: 'remaining_effort_minutes', type: 'bigint' },
      { name: 'priority', type: 'string' },
      { name: 'actual_start_date', type: 'string' },
      { name: 'actual_end_date', type: 'string' },
      { name: 'archived', type: 'boolean' },
    ],
  },
];

/** Resources of the agent telemetry analytics store (ADR 0118). */
export type AgentAnalyticsResources = Readonly<{
  /** Bucket of the Parquet objects, the delivery errors, and the Athena results. */
  readonly bucket: s3.Bucket;
  /** Delivery stream of `agent_events`. */
  readonly eventsStream: firehose.CfnDeliveryStream;
  /** Delivery stream of `agent_runs`. */
  readonly runsStream: firehose.CfnDeliveryStream;
  /** Delivery stream of `agent_work_items`. */
  readonly workItemsStream: firehose.CfnDeliveryStream;
  /** Environment that points a runtime at the three streams. */
  readonly streamEnvironment: Readonly<Record<string, string>>;
  /** Workgroup that analysts query in. */
  readonly workGroup: athena.CfnWorkGroup;
}>;

/**
 * Builds the S3 analytics store of agent telemetry: one private bucket, a Glue database whose
 * tables find their partitions by projection, one Firehose stream per table that turns JSON rows
 * into Parquet under `workspace_key=<hash>/dt=<day>/`, and an Athena workgroup with a scan limit.
 *
 * Nothing here costs money while idle: Firehose, Glue, and Athena bill per GB, request, or scan.
 *
 * @param scope - Stack scope used directly to keep construct paths flat.
 * @returns The bucket, streams, stream environment, and workgroup.
 */
export function buildAgentAnalytics(scope: cdk.Stack): AgentAnalyticsResources {
  const bucket = new s3.Bucket(scope, 'AgentAnalyticsBucket', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    lifecycleRules: [
      { id: 'AbortIncompleteAgentAnalyticsUploads', abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
      { id: 'ExpireAgentAnalytics', prefix: 'agent-analytics/', expiration: cdk.Duration.days(AGENT_ANALYTICS_RETENTION_DAYS) },
      // Rows Firehose could not partition or convert; kept long enough to look into.
      { id: 'ExpireAgentAnalyticsErrors', prefix: 'agent-analytics-errors/', expiration: cdk.Duration.days(30) },
      { id: 'ExpireAthenaResults', prefix: 'athena-results/', expiration: cdk.Duration.days(7) },
    ],
  });
  acknowledge(bucket, 'AwsSolutions-S1', 'Analytics objects are written only by Firehose and read through Athena; CloudTrail records the access, so server access logs would only add cost.');

  const databaseName = analyticsDatabaseName(scope);
  const database = new glue.CfnDatabase(scope, 'AgentAnalyticsDatabase', {
    catalogId: scope.account,
    databaseInput: {
      name: databaseName,
      description: 'Allowlisted coding agent telemetry, run snapshots, and Work Item values (ADR 0118).',
    },
  });

  const deliveryLogGroup = new logs.LogGroup(scope, 'AgentAnalyticsDeliveryLogGroup', {
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.THREE_MONTHS,
  });
  const deliveryRole = new iam.Role(scope, 'AgentAnalyticsDeliveryRole', {
    assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': scope.account } },
    }),
    description: 'Lets Firehose read the analytics schemas and write Parquet objects.',
  });
  deliveryRole.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:AbortMultipartUpload', 's3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'],
    resources: [bucket.bucketArn],
  }));
  deliveryRole.addToPolicy(new iam.PolicyStatement({
    actions: ['s3:AbortMultipartUpload', 's3:GetObject', 's3:PutObject'],
    resources: [bucket.arnForObjects('agent-analytics/*'), bucket.arnForObjects('agent-analytics-errors/*')],
  }));
  deliveryRole.addToPolicy(new iam.PolicyStatement({
    actions: ['logs:PutLogEvents'],
    resources: [deliveryLogGroup.logGroupArn],
  }));

  const streams: firehose.CfnDeliveryStream[] = [];
  const tableArns: string[] = [];
  for (const spec of analyticsTables) {
    const table = new glue.CfnTable(scope, `AgentAnalytics${spec.id}Table`, {
      catalogId: scope.account,
      databaseName,
      tableInput: buildTableInput(bucket, spec),
    });
    table.addDependency(database);
    tableArns.push(cdk.Stack.of(scope).formatArn({ service: 'glue', resource: 'table', resourceName: `${databaseName}/${spec.tableName}` }));
    const logStream = new logs.LogStream(scope, `AgentAnalytics${spec.id}DeliveryLogStream`, {
      logGroup: deliveryLogGroup,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const stream = new firehose.CfnDeliveryStream(scope, `AgentAnalytics${spec.id}Stream`, {
      deliveryStreamType: 'DirectPut',
      deliveryStreamEncryptionConfigurationInput: { keyType: 'AWS_OWNED_CMK' },
      extendedS3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: deliveryRole.roleArn,
        prefix: `agent-analytics/${spec.prefix}/workspace_key=!{partitionKeyFromQuery:workspace_key}/dt=!{timestamp:yyyy-MM-dd}/`,
        errorOutputPrefix: `agent-analytics-errors/${spec.prefix}/!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/`,
        // Dynamic partitioning needs at least 64 MB; the longest interval keeps the objects few.
        bufferingHints: { intervalInSeconds: 900, sizeInMBs: 64 },
        // Parquet is compressed by its serializer.
        compressionFormat: 'UNCOMPRESSED',
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: deliveryLogGroup.logGroupName,
          logStreamName: logStream.logStreamName,
        },
        dynamicPartitioningConfiguration: { enabled: true, retryOptions: { durationInSeconds: 300 } },
        processingConfiguration: {
          enabled: true,
          processors: [
            // The receiver packs one export's rows into one record of newline-separated JSON.
            { type: 'RecordDeAggregation', parameters: [{ parameterName: 'SubRecordType', parameterValue: 'JSON' }] },
            {
              type: 'MetadataExtraction',
              parameters: [
                { parameterName: 'MetadataExtractionQuery', parameterValue: '{workspace_key: .workspace_key}' },
                { parameterName: 'JsonParsingEngine', parameterValue: 'JQ-1.6' },
              ],
            },
          ],
        },
        dataFormatConversionConfiguration: {
          enabled: true,
          inputFormatConfiguration: { deserializer: { openXJsonSerDe: {} } },
          outputFormatConfiguration: { serializer: { parquetSerDe: { compression: 'SNAPPY' } } },
          schemaConfiguration: {
            catalogId: scope.account,
            databaseName,
            tableName: spec.tableName,
            region: scope.region,
            roleArn: deliveryRole.roleArn,
            versionId: 'LATEST',
          },
        },
      },
    });
    stream.addDependency(table);
    // The role's policy must exist before Firehose checks that it can write.
    const rolePolicy = deliveryRole.node.tryFindChild('DefaultPolicy');
    if (rolePolicy) stream.node.addDependency(rolePolicy);
    streams.push(stream);
  }
  deliveryRole.addToPolicy(new iam.PolicyStatement({
    actions: ['glue:GetTable', 'glue:GetTableVersion', 'glue:GetTableVersions'],
    resources: [
      cdk.Stack.of(scope).formatArn({ service: 'glue', resource: 'catalog' }),
      cdk.Stack.of(scope).formatArn({ service: 'glue', resource: 'database', resourceName: databaseName }),
      ...tableArns,
    ],
  }));
  const [eventsStream, runsStream, workItemsStream] = streams;
  if (!eventsStream || !runsStream || !workItemsStream) throw new Error('Agent analytics streams were not created.');

  const workGroup = new athena.CfnWorkGroup(scope, 'AgentAnalyticsWorkGroup', {
    name: `${databaseName.replace(/_/gu, '-')}`,
    description: 'Queries the agent telemetry analytics store, with a scan limit per query (ADR 0118).',
    recursiveDeleteOption: false,
    state: 'ENABLED',
    workGroupConfiguration: {
      bytesScannedCutoffPerQuery: AGENT_ANALYTICS_QUERY_SCAN_LIMIT_BYTES,
      enforceWorkGroupConfiguration: true,
      publishCloudWatchMetricsEnabled: true,
      resultConfiguration: {
        encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        outputLocation: `s3://${bucket.bucketName}/athena-results/`,
      },
    },
  });

  return {
    bucket,
    eventsStream,
    runsStream,
    workItemsStream,
    streamEnvironment: {
      AGENT_ANALYTICS_EVENTS_STREAM_NAME: eventsStream.ref,
      AGENT_ANALYTICS_RUNS_STREAM_NAME: runsStream.ref,
      AGENT_ANALYTICS_WORK_ITEMS_STREAM_NAME: workItemsStream.ref,
    },
    workGroup,
  };
}

/**
 * Grants a runtime the `PutRecordBatch` call on some analytics streams.
 *
 * @param grantee - Runtime role or policy principal.
 * @param streams - Streams it writes.
 */
export function grantAgentAnalyticsPut(grantee: iam.IGrantable, streams: readonly firehose.CfnDeliveryStream[]): void {
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['firehose:PutRecordBatch'],
    resources: streams.map((stream) => stream.attrArn),
  }));
}

/**
 * Builds the Glue table input of one analytics table: Parquet objects whose partitions Athena
 * finds by projection. `workspace_key` is injected, so every query names the Workspace it reads.
 *
 * @param bucket - Analytics bucket.
 * @param spec - Table.
 * @returns Table input.
 */
function buildTableInput(bucket: s3.IBucket, spec: AnalyticsTableSpec): glue.CfnTable.TableInputProperty {
  const location = `s3://${bucket.bucketName}/agent-analytics/${spec.prefix}/`;
  return {
    name: spec.tableName,
    tableType: 'EXTERNAL_TABLE',
    partitionKeys: [
      { name: 'workspace_key', type: 'string' },
      { name: 'dt', type: 'string' },
    ],
    parameters: {
      classification: 'parquet',
      'projection.enabled': 'true',
      'projection.workspace_key.type': 'injected',
      'projection.dt.type': 'date',
      'projection.dt.format': 'yyyy-MM-dd',
      'projection.dt.range': '2026-11-01,NOW',
      'projection.dt.interval': '1',
      'projection.dt.interval.unit': 'DAYS',
      'storage.location.template': `${location}workspace_key=\${workspace_key}/dt=\${dt}/`,
    },
    storageDescriptor: {
      location,
      columns: spec.columns.map((column) => ({ name: column.name, type: column.type })),
      inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
      outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
      serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
    },
  };
}

/**
 * Names the Glue database after the stack, so two stacks in one account keep apart.
 *
 * @param scope - Stack.
 * @returns Lowercase name of letters, digits, and underscores.
 */
function analyticsDatabaseName(scope: cdk.Stack): string {
  const stackName = cdk.Token.isUnresolved(scope.stackName) ? 'mukuroji' : scope.stackName;
  return `${stackName.toLowerCase().replace(/[^a-z0-9]+/gu, '_')}_agent_analytics`;
}

/**
 * Acknowledges one cdk-nag rule on a construct's resource, with its reason.
 *
 * @param construct - Construct whose resource carries the acknowledgement.
 * @param rule - Rule ID.
 * @param reason - Why the finding does not apply.
 */
function acknowledge(construct: IConstruct, rule: string, reason: string): void {
  const resource = construct.node.defaultChild ?? construct;
  resource.node.addMetadata(cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY, { [`AwsSolutions::${rule}`]: reason });
}
