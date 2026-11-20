import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import {
  resolveLambdaHandlerEntry,
  type LambdaBuildPaths,
} from '../config/lambda-build-paths';

/**
 * One table a data migration may rewrite, by the logical name that
 * migration definitions use in their `table` field.
 */
export type DataMigrationTarget = {
  /** Logical table name, such as `work-items`. */
  readonly logicalName: string;
  /** Table whose rows the migration Lambda may read and conditionally replace. */
  readonly table: dynamodb.ITable;
};

/**
 * Inputs of the operator-invoked data migration runner.
 */
export type DataMigrationInput = {
  /** Shared Lambda bundling paths. */
  readonly lambdaBuildPaths: LambdaBuildPaths;
  /**
   * Allowlist of tables a migration may target. A migration on another table
   * adds its table here in the same change that registers the migration.
   */
  readonly targets: readonly DataMigrationTarget[];
};

/**
 * Resources of the data migration runner.
 */
export type DataMigrationResources = {
  /** Checkpoints and run records of every migration. */
  readonly checkpointTable: dynamodb.Table;
  /** Operator-invoked runner; it has no schedule or event source. */
  readonly migrationFunction: lambdaNodejs.NodejsFunction;
  /** Unattached policy that allows invoking only the runner. */
  readonly operatorPolicy: iam.ManagedPolicy;
};

/** Pattern of a logical table name, matching the server-side allowlist parser. */
const LOGICAL_TABLE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Creates the data migration runner: a checkpoint table, a Lambda function
 * that an operator invokes with `bun run data:migrate:aws`, its own role, and
 * an unattached operator policy.
 *
 * The function has no trigger and costs nothing while idle. Its role reads
 * and conditionally replaces rows only in the allowlisted target tables, and
 * reads and writes only the checkpoint table. Operators never get table
 * permissions: they get `lambda:InvokeFunction` on this function, and an
 * applying run must carry a presigned STS `GetCallerIdentity` proof so the
 * function records the authenticated operator.
 *
 * @param scope - Stack that owns the runner.
 * @param input - Bundling paths and the target table allowlist.
 * @returns The runner resources, also published as stack outputs.
 */
export function buildDataMigration(
  scope: cdk.Stack,
  input: DataMigrationInput,
): DataMigrationResources {
  const logicalNames = input.targets.map((target) => target.logicalName);
  if (
    logicalNames.some((name) => !LOGICAL_TABLE_NAME_PATTERN.test(name))
    || new Set(logicalNames).size !== logicalNames.length
  ) {
    throw new Error('Data migration targets need unique lowercase logical table names.');
  }

  const checkpointTable = new dynamodb.Table(scope, 'DataMigrationCheckpointTable', {
    partitionKey: { name: 'migrationId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'partitionId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    encryption: dynamodb.TableEncryption.AWS_MANAGED,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const role = new iam.Role(scope, 'DataMigrationFunctionRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description:
      'Runs registered data migrations on allowlisted tables and records checkpoints.',
  });
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:Query', 'dynamodb:PutItem'],
    resources: [checkpointTable.tableArn],
  }));
  if (input.targets.length > 0) {
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:PutItem'],
      resources: input.targets.map((target) => target.table.tableArn),
    }));
  }
  for (const target of input.targets) {
    target.table.encryptionKey?.grantEncryptDecrypt(role);
  }

  const logGroup = new logs.LogGroup(scope, 'DataMigrationLogGroup', {
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.ONE_YEAR,
  });
  logGroup.grants.write(role);

  const migrationFunction = new lambdaNodejs.NodejsFunction(
    scope,
    'DataMigrationFunction',
    {
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
      depsLockFilePath: input.lambdaBuildPaths.depsLockFilePath,
      description:
        'Operator-invoked, resumable data migration runner; never scheduled.',
      entry: resolveLambdaHandlerEntry(
        input.lambdaBuildPaths,
        'data-migration-handler.ts',
      ),
      environment: {
        DATA_MIGRATION_CHECKPOINT_TABLE_NAME: checkpointTable.tableName,
        DATA_MIGRATION_TARGET_TABLES: scope.toJsonString(Object.fromEntries(
          input.targets.map((target) => [target.logicalName, target.table.tableName]),
        )),
      },
      handler: 'handler',
      logGroup,
      memorySize: 1_024,
      projectRoot: input.lambdaBuildPaths.projectRoot,
      retryAttempts: 0,
      role,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(15),
      tracing: lambda.Tracing.ACTIVE,
    },
  );

  const operatorPolicy = new iam.ManagedPolicy(scope, 'DataMigrationOperatorPolicy', {
    description:
      'Invoke-only access to the data migration runner; grants no table access.',
    statements: [
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [migrationFunction.functionArn],
      }),
    ],
  });

  new cdk.CfnOutput(scope, 'DataMigrationFunctionName', {
    value: migrationFunction.functionName,
  });
  new cdk.CfnOutput(scope, 'DataMigrationCheckpointTableName', {
    value: checkpointTable.tableName,
  });
  new cdk.CfnOutput(scope, 'DataMigrationOperatorPolicyArn', {
    value: operatorPolicy.managedPolicyArn,
  });

  return { checkpointTable, migrationFunction, operatorPolicy };
}
