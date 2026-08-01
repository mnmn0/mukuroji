/** Registers restore-drill isolation, durability, orchestration, and alarm tests. */
import { expect, test } from '@jest/globals';
import {
  serializeAwsSdkCall,
  synthesizedTemplate,
} from './test-support';

/**
 * Narrows synthesized CloudFormation fragments before semantic inspection.
 *
 * @param value Untrusted synthesized value.
 * @returns Whether the value is a string-keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Finds exactly one synthesized resource by type and stable logical-ID prefix.
 *
 * @param resourceType CloudFormation resource type.
 * @param logicalIdPrefix Stable construct-derived logical-ID prefix.
 * @returns Matching logical ID and resource.
 */
function findResource(
  resourceType: string,
  logicalIdPrefix: string,
): readonly [string, Record<string, unknown>] {
  const matches = Object.entries(synthesizedTemplate.findResources(resourceType))
    .filter(([logicalId]) => logicalId.startsWith(logicalIdPrefix));
  expect(matches).toHaveLength(1);
  const match = matches[0];
  if (!match || !isRecord(match[1])) {
    throw new Error(`${logicalIdPrefix} was not synthesized exactly once.`);
  }
  return [match[0], match[1]];
}

/**
 * Reads a required nested record property.
 *
 * @param owner Synthesized record containing the property.
 * @param propertyName Required property name.
 * @returns Narrowed nested record.
 */
function requiredRecord(
  owner: Record<string, unknown>,
  propertyName: string,
): Record<string, unknown> {
  const value = owner[propertyName];
  if (!isRecord(value)) {
    throw new Error(`${propertyName} is not a synthesized object.`);
  }
  return value;
}

/**
 * Collects normalized IAM statements from policies attached to one role.
 *
 * @param roleLogicalId Logical ID of the role receiving inline policies.
 * @returns IAM statements attached to the exact role.
 */
function statementsForRole(
  roleLogicalId: string,
): readonly Record<string, unknown>[] {
  return Object.values(synthesizedTemplate.findResources('AWS::IAM::Policy'))
    .filter(isRecord)
    .filter((resource) => {
      const properties = requiredRecord(resource, 'Properties');
      return JSON.stringify(properties.Roles).includes(roleLogicalId);
    })
    .flatMap((resource) => {
      const properties = requiredRecord(resource, 'Properties');
      const policyDocument = requiredRecord(properties, 'PolicyDocument');
      return Array.isArray(policyDocument.Statement)
        ? policyDocument.Statement.filter(isRecord)
        : [];
    });
}

/**
 * Normalizes one synthesized IAM action field into an ordered string list.
 *
 * @param statement Synthesized IAM statement.
 * @returns Exact action names declared by the statement.
 */
function actionNames(statement: Record<string, unknown>): readonly string[] {
  const actions = statement.Action;
  if (typeof actions === 'string') return [actions];
  if (!Array.isArray(actions) || actions.some((action) => typeof action !== 'string')) {
    throw new Error('IAM statement actions were not synthesized as strings.');
  }
  return actions;
}

test('restore-drill state and object stores are retained, isolated, and durable', () => {
  const [stateTableId, stateTable] = findResource(
    'AWS::DynamoDB::Table',
    'RestoreDrillStateTable',
  );
  const [, scratchKey] = findResource('AWS::KMS::Key', 'RestoreDrillScratchKey');
  const [scratchBucketId, scratchBucket] = findResource(
    'AWS::S3::Bucket',
    'RestoreDrillScratchBucket',
  );
  const [evidenceKeyId, evidenceKey] = findResource(
    'AWS::KMS::Key',
    'RestoreDrillEvidenceKey',
  );
  const [evidenceBucketId, evidenceBucket] = findResource(
    'AWS::S3::Bucket',
    'RestoreDrillEvidenceBucket',
  );
  const [accessLogsBucketId, accessLogsBucket] = findResource(
    'AWS::S3::Bucket',
    'RestoreDrillEvidenceAccessLogsBucket',
  );

  expect(stateTable).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    Type: 'AWS::DynamoDB::Table',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      AttributeDefinitions: [
        { AttributeName: 'scopeKey', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      DeletionProtectionEnabled: true,
      KeySchema: [
        { AttributeName: 'scopeKey', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true },
    }),
  }));
  expect(stateTableId).toMatch(/^RestoreDrillStateTable/);
  expect(scratchKey).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({ EnableKeyRotation: true }),
  }));
  expect(scratchBucket).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      BucketEncryption: expect.any(Object),
      OwnershipControls: {
        Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  }));
  expect(JSON.stringify(scratchBucket)).toContain('aws:kms');
  expect(JSON.stringify(scratchBucket)).toContain('RestoreDrillScratchKey');

  expect(evidenceKey).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      Description: 'Encrypts immutable secret-free restore-drill evidence.',
      EnableKeyRotation: true,
    }),
  }));
  expect(evidenceBucket).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      LoggingConfiguration: {
        DestinationBucketName: { Ref: accessLogsBucketId },
        LogFilePrefix: 'restore-drill-evidence/',
      },
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Days: 400, Mode: 'COMPLIANCE' } },
      },
      ObjectLockEnabled: true,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  }));
  expect(JSON.stringify(evidenceBucket)).toContain(evidenceKeyId);
  expect(accessLogsBucket).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      BucketEncryption: expect.any(Object),
      LifecycleConfiguration: {
        Rules: [expect.objectContaining({
          ExpirationInDays: 400,
          Id: 'ExpireRestoreDrillEvidenceAccessLogs',
          NoncurrentVersionExpiration: { NoncurrentDays: 400 },
          Status: 'Enabled',
        })],
      },
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  }));

  const [, evidenceBucketPolicy] = findResource(
    'AWS::S3::BucketPolicy',
    'RestoreDrillEvidenceBucketPolicy',
  );
  const serializedPolicy = JSON.stringify(evidenceBucketPolicy);
  for (const statementId of [
    'DenyRestoreDrillEvidenceDeletion',
    'DenyUnconditionalRestoreDrillEvidenceUploads',
    'DenyNonExclusiveRestoreDrillEvidenceUploads',
    'DenyNonKmsRestoreDrillEvidenceUploads',
    'DenyWrongRestoreDrillEvidenceKey',
  ]) {
    expect(serializedPolicy).toContain(statementId);
  }
  expect(serializedPolicy).toContain('s3:if-none-match');
  expect(serializedPolicy).toContain('approvals/v1/runs/*');
  expect(serializedPolicy).toContain('s3:x-amz-server-side-encryption-aws-kms-key-id');
  expect(serializedPolicy).toContain(evidenceBucketId);
  expect(serializedPolicy).toContain(evidenceKeyId);
  expect(serializedPolicy).toContain('s3:DeleteObjectVersion');
  expect(serializedPolicy).toContain('aws:SecureTransport');
  expect(serializedPolicy).toContain('s3:TlsVersion');
  expect(scratchBucketId).not.toBe(evidenceBucketId);
  for (const outputName of [
    'RestoreDrillStateMachineArn',
    'RestoreDrillCleanupStateMachineArn',
    'RestoreDrillEvidenceBucketName',
    'RestoreDrillScratchBucketName',
    'RestoreDrillStateTableName',
    'RestoreDrillCleanupApprovalPolicyArn',
    'RestoreDrillScheduleDlqUrl',
  ]) {
    expect(synthesizedTemplate.toJSON().Outputs).toHaveProperty(outputName);
  }
});

test('restore runner and cleanup roles cannot cross production or isolation boundaries', () => {
  const [runnerRoleId] = findResource('AWS::IAM::Role', 'RestoreDrillRunnerRole');
  const [cleanupRoleId] = findResource('AWS::IAM::Role', 'RestoreDrillCleanupRole');
  const runnerStatements = statementsForRole(runnerRoleId);
  const cleanupStatements = statementsForRole(cleanupRoleId);
  const serializedRunner = JSON.stringify(runnerStatements);
  const serializedCleanup = JSON.stringify(cleanupStatements);
  const sourceTableIds = [
    'AuditEventsTable',
    'FileProofingTable',
    'ProjectDirectoryTable',
    'TeamIssuesTable',
    'WorkItemConfigurationTable',
    'WorkspaceAccessTable',
  ];

  const sourceRestoreStatement = runnerStatements.find((statement) =>
    JSON.stringify(statement.Action).includes('dynamodb:RestoreTableToPointInTime'));
  expect(sourceRestoreStatement).toBeDefined();
  const serializedSourceRestore = JSON.stringify(sourceRestoreStatement);
  for (const logicalIdPrefix of sourceTableIds) {
    expect(serializedSourceRestore).toContain(logicalIdPrefix);
  }
  for (const forbiddenTableId of [
    'AutomationTable',
    'DocumentsTable',
    'EnterpriseIdentityTable',
    'PlanningTable',
    'WorkspaceSearchTable',
  ]) {
    expect(serializedSourceRestore).not.toContain(forbiddenTableId);
  }
  expect(sourceRestoreStatement).toEqual(expect.objectContaining({
    Action: expect.arrayContaining([
      'dynamodb:DescribeContinuousBackups',
      'dynamodb:DescribeTable',
      'dynamodb:DescribeTimeToLive',
      'dynamodb:ExportTableToPointInTime',
      'dynamodb:RestoreTableToPointInTime',
    ]),
    Effect: 'Allow',
  }));

  const restoreTargetStatement = runnerStatements.find((statement) =>
    JSON.stringify(statement.Resource).includes('mukuroji-restore-drill-*'));
  expect(restoreTargetStatement).toBeDefined();
  expect(restoreTargetStatement).toEqual(expect.objectContaining({
    Action: expect.arrayContaining([
      'dynamodb:DescribeTable',
      'dynamodb:PutItem',
      'dynamodb:Scan',
    ]),
    Effect: 'Allow',
  }));
  expect(JSON.stringify(restoreTargetStatement)).not.toContain('table/*');

  const exactVersionReadStatement = runnerStatements.find((statement) =>
    JSON.stringify(statement.Action).includes('s3:GetObjectVersionAttributes'));
  expect(exactVersionReadStatement).toEqual(expect.objectContaining({
    Action: expect.arrayContaining([
      's3:GetObjectVersion',
      's3:GetObjectVersionAttributes',
      's3:GetObjectVersionTagging',
    ]),
    Effect: 'Allow',
  }));
  expect(JSON.stringify(exactVersionReadStatement)).toContain('/workspaces/*');
  expect(JSON.stringify(exactVersionReadStatement)).not.toContain('s3:GetObject"');
  const [, sourceBucketPolicy] = findResource(
    'AWS::S3::BucketPolicy',
    'FileBucketPolicy',
  );
  const sourcePolicyStatements = requiredRecord(
    requiredRecord(sourceBucketPolicy, 'Properties'),
    'PolicyDocument',
  ).Statement;
  if (!Array.isArray(sourcePolicyStatements)) {
    throw new Error('File bucket policy statements were not synthesized.');
  }
  for (const statementId of [
    'NoReadUnlessGuardDutyClean',
    'DeletedObjectsCannotBeRead',
  ]) {
    const statement = sourcePolicyStatements
      .filter(isRecord)
      .find((candidate) => candidate.Sid === statementId);
    expect(statement).toBeDefined();
    expect(JSON.stringify(statement)).toContain(runnerRoleId);
  }
  expect(serializedRunner).toContain('restore-drill/*');
  expect(serializedRunner).toContain('workspaces/*');
  expect(serializedRunner).toContain('s3:GetObjectVersionAttributes');
  expect(serializedRunner).toContain('dynamodb:TransactWriteItems');
  const runnerStateStatement = runnerStatements.find((statement) =>
    actionNames(statement).includes('dynamodb:TransactWriteItems'));
  expect(runnerStateStatement).toBeDefined();
  expect(JSON.stringify(runnerStateStatement)).toContain('RESTORE_DRILL#*');
  expect(JSON.stringify(runnerStateStatement)).toContain('RESTORE_DRILL_LEDGER#*');
  expect(JSON.stringify(runnerStateStatement)).not.toContain('RESTORE_DRILL_CLEANUP#*');
  expect(serializedRunner).toContain('s3:ListBucketMultipartUploads');
  const scratchObjectStatement = runnerStatements.find((statement) =>
    JSON.stringify(statement.Action).includes('s3:AbortMultipartUpload') &&
    JSON.stringify(statement.Resource).includes('RestoreDrillScratchBucket'));
  expect(scratchObjectStatement).toEqual(expect.objectContaining({
    Action: expect.arrayContaining([
      's3:GetObjectVersion',
      's3:GetObjectVersionAttributes',
      's3:GetObjectVersionTagging',
    ]),
  }));
  expect(JSON.stringify(scratchObjectStatement)).not.toContain('s3:GetObject"');
  expect(JSON.stringify(scratchObjectStatement)).not.toContain('s3:GetObjectTagging');
  const runnerEvidenceWrite = runnerStatements.find((statement) =>
    JSON.stringify(statement.Action).includes('s3:PutObject') &&
    JSON.stringify(statement.Resource).includes('result.json'));
  expect(JSON.stringify(runnerEvidenceWrite)).toContain(
    'evidence/v1/runs/*/result.json',
  );
  expect(JSON.stringify(runnerEvidenceWrite)).not.toContain('cleanup.json');
  const runnerEvidenceRead = runnerStatements.find((statement) =>
    actionNames(statement).includes('s3:GetObjectRetention') &&
    JSON.stringify(statement.Resource).includes('result.json'));
  expect(actionNames(runnerEvidenceRead ?? {})).toEqual([
    's3:GetObject',
    's3:GetObjectRetention',
    's3:GetObjectVersion',
  ]);
  expect(serializedRunner).not.toContain('dynamodb:TagResource');
  expect(serializedRunner).not.toContain('dynamodb:UpdateTimeToLive');
  expect(serializedCleanup).not.toContain('RestoreDrillScratchKey');
  expect(serializedRunner).not.toContain('dynamodb:DeleteTable');
  expect(serializedRunner).not.toContain('s3:DeleteObject');
  expect(serializedCleanup).toContain('dynamodb:DeleteTable');
  expect(serializedCleanup).toContain('mukuroji-restore-drill-*');
  expect(serializedCleanup).toContain('restore-drill/*');
  expect(serializedCleanup).toContain('workspaces/*');
  expect(serializedCleanup).toContain('s3:DeleteObjectVersion');
  expect(serializedCleanup).toContain('s3:GetObjectVersionAttributes');
  expect(serializedCleanup).toContain('s3:AbortMultipartUpload');
  expect(serializedCleanup).toContain('s3:ListBucketMultipartUploads');
  const cleanupScratchList = cleanupStatements.find((statement) =>
    actionNames(statement).includes('s3:ListBucketMultipartUploads'));
  expect(actionNames(cleanupScratchList ?? {})).toEqual([
    's3:ListBucketMultipartUploads',
  ]);
  expect(JSON.stringify(cleanupScratchList)).not.toContain('s3:ListBucketVersions');
  expect(JSON.stringify(cleanupScratchList)).not.toContain('s3:ListBucket"');
  expect(serializedCleanup).toContain('s3:ListMultipartUploadParts');
  const cleanupScratchObjectStatement = cleanupStatements.find((statement) =>
    actionNames(statement).includes('s3:DeleteObjectVersion') &&
    JSON.stringify(statement.Resource).includes('RestoreDrillScratchBucket'));
  expect(actionNames(cleanupScratchObjectStatement ?? {})).toEqual([
    's3:AbortMultipartUpload',
    's3:DeleteObjectVersion',
    's3:GetObjectVersionAttributes',
    's3:ListMultipartUploadParts',
  ]);
  expect(JSON.stringify(cleanupScratchObjectStatement)).not.toContain(
    's3:GetObjectVersion"',
  );
  expect(serializedCleanup).toContain('states:DescribeExecution');
  expect(serializedCleanup).toContain('restore-cleanup-*');
  const cleanupExecutionRead = cleanupStatements.find((statement) =>
    JSON.stringify(statement.Action).includes('states:DescribeExecution'));
  expect(JSON.stringify(cleanupExecutionRead)).toContain(
    'restore-drill-cleanup:restore-cleanup-*',
  );
  expect(JSON.stringify(cleanupExecutionRead)).not.toContain(
    ':*:restore-cleanup-*',
  );
  const cleanupStateRead = cleanupStatements.find((statement) =>
    actionNames(statement).includes('dynamodb:GetItem') &&
    JSON.stringify(statement).includes('RESTORE_DRILL_LEDGER#*'));
  expect(actionNames(cleanupStateRead ?? {})).toEqual(['dynamodb:GetItem']);
  expect(JSON.stringify(cleanupStateRead)).toContain('RESTORE_DRILL_CLEANUP#*');
  expect(JSON.stringify(cleanupStateRead)).not.toContain('RESTORE_DRILL#*');
  const cleanupRunRead = cleanupStatements.find((statement) =>
    actionNames(statement).includes('dynamodb:GetItem') &&
    JSON.stringify(statement).includes('dynamodb:Attributes'));
  expect(actionNames(cleanupRunRead ?? {})).toEqual(['dynamodb:GetItem']);
  expect(JSON.stringify(cleanupRunRead)).toContain('RESTORE_DRILL#*');
  expect(JSON.stringify(cleanupRunRead)).toContain('SPECIFIC_ATTRIBUTES');
  expect(JSON.stringify(cleanupRunRead)).toContain('digestKeyEnvelope');
  expect(JSON.stringify(cleanupRunRead)).toContain('runnerExecutionArn');
  expect(JSON.stringify(cleanupRunRead)).not.toContain('payloadJson');
  const cleanupLedgerQuery = cleanupStatements.find((statement) =>
    actionNames(statement).includes('dynamodb:Query'));
  expect(actionNames(cleanupLedgerQuery ?? {})).toEqual(['dynamodb:Query']);
  expect(JSON.stringify(cleanupLedgerQuery)).toContain('RESTORE_DRILL_LEDGER#*');
  expect(JSON.stringify(cleanupLedgerQuery)).not.toContain('RESTORE_DRILL#*');
  const cleanupProgressWrite = cleanupStatements.find((statement) =>
    actionNames(statement).includes('dynamodb:PutItem'));
  expect(actionNames(cleanupProgressWrite ?? {})).toEqual(['dynamodb:PutItem']);
  expect(JSON.stringify(cleanupProgressWrite)).toContain('RESTORE_DRILL_CLEANUP#*');
  expect(JSON.stringify(cleanupProgressWrite)).toContain('payloadJson');
  expect(JSON.stringify(cleanupProgressWrite)).not.toContain('RESTORE_DRILL_LEDGER#*');
  const cleanupUpdates = cleanupStatements.filter((statement) =>
    actionNames(statement).includes('dynamodb:UpdateItem'));
  expect(cleanupUpdates).toHaveLength(2);
  const cleanupRunUpdate = cleanupUpdates.find((statement) =>
    JSON.stringify(statement).includes('RESTORE_DRILL#*'));
  expect(actionNames(cleanupRunUpdate ?? {})).toEqual(['dynamodb:UpdateItem']);
  for (const mutableAttribute of [
    'approvalDigest',
    'approvalObjectKey',
    'approvedAt',
    'cleanupAttemptCount',
    'cleanupExecutionArn',
    'cleanupExecutionName',
    'cleanupStartedAt',
    'outcome',
    'phase',
    'revision',
    'updatedAt',
  ]) {
    expect(JSON.stringify(cleanupRunUpdate)).toContain(mutableAttribute);
  }
  for (const runnerOwnedAttribute of [
    'digestKeyEnvelope',
    'resourceDigest',
    'resultDigest',
    'runnerExecutionArn',
  ]) {
    expect(JSON.stringify(cleanupRunUpdate)).not.toContain(runnerOwnedAttribute);
  }
  const cleanupControlUpdate = cleanupUpdates.find((statement) =>
    JSON.stringify(statement).includes('CONTROL'));
  expect(actionNames(cleanupControlUpdate ?? {})).toEqual(['dynamodb:UpdateItem']);
  expect(JSON.stringify(cleanupControlUpdate)).toContain('activeDrillId');
  expect(JSON.stringify(cleanupControlUpdate)).not.toContain('payloadJson');
  const serializedCleanupStateWrites = JSON.stringify([
    cleanupProgressWrite,
    ...cleanupUpdates,
  ]);
  expect(serializedCleanupStateWrites).not.toContain('dynamodb:TransactWriteItems');
  expect(serializedCleanupStateWrites).not.toContain('dynamodb:DeleteItem');
  const cleanupEvidenceWrite = cleanupStatements.find((statement) =>
    JSON.stringify(statement.Action).includes('s3:PutObject') &&
    JSON.stringify(statement.Resource).includes('cleanup.json'));
  expect(JSON.stringify(cleanupEvidenceWrite)).toContain(
    'evidence/v1/runs/*/cleanup.json',
  );
  expect(JSON.stringify(cleanupEvidenceWrite)).not.toContain('result.json');
  const runnerEvidenceKmsStatements = runnerStatements.filter((statement) =>
    JSON.stringify(statement.Resource).includes('RestoreDrillEvidenceKey') &&
    actionNames(statement).some((action) => action.startsWith('kms:')));
  expect(runnerEvidenceKmsStatements).toHaveLength(2);
  const runnerDirectEvidenceKms = runnerEvidenceKmsStatements.find((statement) =>
    JSON.stringify(statement).includes('kms:EncryptionContext:purpose'));
  expect(actionNames(runnerDirectEvidenceKms ?? {})).toEqual([
    'kms:Decrypt',
    'kms:Encrypt',
  ]);
  expect(JSON.stringify(runnerDirectEvidenceKms)).toContain(
    'restore-drill-evidence-digest-v1',
  );
  expect(JSON.stringify(runnerDirectEvidenceKms)).not.toContain('kms:ViaService');
  const runnerS3EvidenceKms = runnerEvidenceKmsStatements.find((statement) =>
    JSON.stringify(statement).includes('kms:ViaService'));
  expect(actionNames(runnerS3EvidenceKms ?? {})).toEqual([
    'kms:Decrypt',
    'kms:GenerateDataKey',
  ]);
  expect(JSON.stringify(runnerS3EvidenceKms)).toContain(
    'kms:EncryptionContext:aws:s3:arn',
  );
  expect(JSON.stringify(runnerS3EvidenceKms)).not.toContain(
    'kms:EncryptionContext:purpose',
  );
  const cleanupEvidenceKmsStatements = cleanupStatements.filter((statement) =>
    JSON.stringify(statement.Resource).includes('RestoreDrillEvidenceKey') &&
    actionNames(statement).some((action) => action.startsWith('kms:')));
  expect(cleanupEvidenceKmsStatements).toHaveLength(2);
  const cleanupDirectEvidenceKms = cleanupEvidenceKmsStatements.find((statement) =>
    JSON.stringify(statement).includes('kms:EncryptionContext:purpose'));
  expect(actionNames(cleanupDirectEvidenceKms ?? {})).toEqual(['kms:Decrypt']);
  expect(JSON.stringify(cleanupDirectEvidenceKms)).toContain(
    'restore-drill-evidence-digest-v1',
  );
  expect(JSON.stringify(cleanupDirectEvidenceKms)).not.toContain('kms:ViaService');
  const cleanupS3EvidenceKms = cleanupEvidenceKmsStatements.find((statement) =>
    JSON.stringify(statement).includes('kms:ViaService'));
  expect(actionNames(cleanupS3EvidenceKms ?? {})).toEqual([
    'kms:Decrypt',
    'kms:GenerateDataKey',
  ]);
  expect(JSON.stringify(cleanupS3EvidenceKms)).toContain(
    'kms:EncryptionContext:aws:s3:arn',
  );
  expect(JSON.stringify(cleanupS3EvidenceKms)).not.toContain(
    'kms:EncryptionContext:purpose',
  );
  for (const statement of [
    ...runnerEvidenceKmsStatements,
    ...cleanupEvidenceKmsStatements,
  ]) {
    const serializedStatement = JSON.stringify(statement);
    expect(
      serializedStatement.includes('kms:EncryptionContext:purpose') ||
      (
        serializedStatement.includes('kms:EncryptionContext:aws:s3:arn') &&
        serializedStatement.includes('kms:ViaService')
      ),
    ).toBe(true);
  }
  expect(serializedCleanup).not.toContain('RestoreTableToPointInTime');
  for (const sourceTableId of sourceTableIds) {
    expect(serializedCleanup).not.toContain(sourceTableId);
  }

  const [approvalPolicyId, approvalPolicy] = findResource(
    'AWS::IAM::ManagedPolicy',
    'RestoreDrillCleanupApprovalPolicy',
  );
  const approvalProperties = requiredRecord(approvalPolicy, 'Properties');
  expect(approvalProperties).not.toHaveProperty('Roles');
  expect(approvalProperties).not.toHaveProperty('Users');
  expect(approvalProperties).not.toHaveProperty('Groups');
  expect(JSON.stringify(approvalPolicy)).toContain('dynamodb:LeadingKeys');
  expect(JSON.stringify(approvalPolicy)).toContain('ForAllValues:StringLike');
  expect(JSON.stringify(approvalPolicy)).toContain('aws:PrincipalArn');
  expect(JSON.stringify(approvalPolicy)).toContain(
    'RestoreDrillCleanupApproverRoleArn',
  );
  expect(JSON.stringify(approvalPolicy)).toContain('dynamodb:Attributes');
  expect(JSON.stringify(approvalPolicy)).toContain('dynamodb:Select');
  expect(JSON.stringify(approvalPolicy)).toContain('SPECIFIC_ATTRIBUTES');
  expect(JSON.stringify(approvalPolicy)).toContain('CONTROL');
  expect(JSON.stringify(approvalPolicy)).toContain('RESTORE_DRILL#*');
  expect(JSON.stringify(approvalPolicy)).toContain('kms:Decrypt');
  expect(JSON.stringify(approvalPolicy)).toContain(
    'restore-drill-evidence-digest-v1',
  );
  expect(JSON.stringify(approvalPolicy)).toContain('s3:GetObject');
  expect(JSON.stringify(approvalPolicy)).toContain('s3:GetObjectRetention');
  expect(JSON.stringify(approvalPolicy)).toContain('s3:PutObject');
  expect(JSON.stringify(approvalPolicy)).toContain('s3:if-none-match');
  expect(JSON.stringify(approvalPolicy)).toContain('approvals/v1/runs/*');
  expect(JSON.stringify(approvalPolicy)).toContain('evidence/v1/runs/*');
  expect(JSON.stringify(approvalPolicy)).toContain(
    'kms:EncryptionContext:aws:s3:arn',
  );
  expect(JSON.stringify(approvalPolicy)).toContain('kms:ViaService');
  expect(JSON.stringify(approvalPolicy)).toContain('states:StartExecution');
  expect(JSON.stringify(approvalPolicy)).toContain('states:ListExecutions');
  expect(JSON.stringify(approvalPolicy)).toContain('states:DescribeExecution');
  for (const cleanupBindingAttribute of [
    'approvalDigest',
    'approvalObjectKey',
    'approvedAt',
    'cleanupAttemptCount',
    'cleanupExecutionArn',
    'cleanupExecutionName',
    'cleanupStartedAt',
  ]) {
    expect(JSON.stringify(approvalPolicy)).toContain(cleanupBindingAttribute);
  }
  expect(JSON.stringify(approvalPolicy)).not.toContain('states:StopExecution');
  expect(JSON.stringify(approvalPolicy)).not.toContain('dynamodb:PutItem');
  expect(JSON.stringify(approvalPolicy)).not.toContain('dynamodb:UpdateItem');
  expect(approvalPolicyId).toMatch(/^RestoreDrillCleanupApprovalPolicy/);

  const lambdaResources = synthesizedTemplate.findResources('AWS::Lambda::Function');
  for (const [logicalId, resource] of Object.entries(lambdaResources)) {
    if (!isRecord(resource)) continue;
    const serializedEnvironment = JSON.stringify(
      requiredRecord(resource, 'Properties').Environment ?? {},
    );
    if (logicalId.startsWith('RestoreDrill')) {
      expect(serializedEnvironment).toContain('EVIDENCE_BUCKET_NAME');
      expect(serializedEnvironment).toContain('TARGET_TABLE_PREFIX');
    } else {
      expect(serializedEnvironment).not.toContain('EVIDENCE_BUCKET_NAME');
      expect(serializedEnvironment).not.toContain('TARGET_TABLE_PREFIX');
    }
  }
});

test('restore and cleanup workflows use bounded Standard wait loops without execution data logs', () => {
  const [, runnerFunction] = findResource(
    'AWS::Lambda::Function',
    'RestoreDrillRunnerFunction',
  );
  const [, cleanupFunction] = findResource(
    'AWS::Lambda::Function',
    'RestoreDrillCleanupFunction',
  );
  const [, workflow] = findResource(
    'AWS::StepFunctions::StateMachine',
    'RestoreDrillWorkflow',
  );
  const [, cleanupWorkflow] = findResource(
    'AWS::StepFunctions::StateMachine',
    'RestoreDrillCleanupWorkflow',
  );
  const [, timeoutFinalizerWorkflow] = findResource(
    'AWS::StepFunctions::StateMachine',
    'RestoreDrillTimeoutFinalizerWorkflow',
  );
  const cleanupWorkflowProperties = requiredRecord(cleanupWorkflow, 'Properties');
  const cleanupWorkflowName = cleanupWorkflowProperties.StateMachineName;
  if (typeof cleanupWorkflowName !== 'string') {
    throw new Error('Cleanup workflow name was not synthesized as a string.');
  }
  expect(cleanupWorkflowName).toMatch(/-restore-drill-cleanup$/);
  expect(JSON.stringify(requiredRecord(cleanupFunction, 'Properties').Environment))
    .toContain(cleanupWorkflowName);
  expect(
    requiredRecord(timeoutFinalizerWorkflow, 'Properties'),
  ).not.toHaveProperty('StateMachineName');
  const [cleanupRoleId] = findResource('AWS::IAM::Role', 'RestoreDrillCleanupRole');
  const cleanupExecutionRead = statementsForRole(cleanupRoleId).find((statement) =>
    actionNames(statement).includes('states:DescribeExecution'));
  expect(JSON.stringify(cleanupExecutionRead)).toContain(
    `${cleanupWorkflowName}:restore-cleanup-*`,
  );

  expect(requiredRecord(runnerFunction, 'Properties')).toEqual(
    expect.objectContaining({
      Handler: 'index.handler',
      MemorySize: 2048,
      Runtime: 'nodejs22.x',
      Timeout: 900,
      TracingConfig: { Mode: 'Active' },
    }),
  );
  expect(requiredRecord(cleanupFunction, 'Properties')).toEqual(
    expect.objectContaining({
      Handler: 'index.cleanupHandler',
      MemorySize: 512,
      Runtime: 'nodejs22.x',
      Timeout: 900,
      TracingConfig: { Mode: 'Active' },
    }),
  );

  expect(requiredRecord(workflow, 'Properties')).toEqual(expect.objectContaining({
    LoggingConfiguration: expect.objectContaining({
      IncludeExecutionData: false,
      Level: 'ERROR',
    }),
    StateMachineType: 'STANDARD',
    TracingConfiguration: { Enabled: true },
  }));
  expect(cleanupWorkflowProperties).toEqual(
    expect.objectContaining({
      LoggingConfiguration: expect.objectContaining({
        IncludeExecutionData: false,
        Level: 'ERROR',
      }),
      StateMachineType: 'STANDARD',
      TracingConfiguration: { Enabled: true },
    }),
  );
  expect(requiredRecord(timeoutFinalizerWorkflow, 'Properties')).toEqual(
    expect.objectContaining({
      LoggingConfiguration: expect.objectContaining({
        IncludeExecutionData: false,
        Level: 'ERROR',
      }),
      StateMachineType: 'STANDARD',
      TracingConfiguration: { Enabled: true },
    }),
  );

  const serializedWorkflow = JSON.stringify(workflow);
  const serializedWorkflowDefinition = serializeAwsSdkCall(
    requiredRecord(workflow, 'Properties').DefinitionString,
  );
  expect(serializedWorkflow).toContain('AdvanceRestoreDrill');
  expect(serializedWorkflowDefinition).toContain('"TimeoutSeconds":16200');
  expect(serializedWorkflow).toContain('PollRestoreDrill');
  expect(serializedWorkflow).toContain('InitializeRestoreDrillPollBudget');
  expect(serializedWorkflow).toContain('IncrementRestoreDrillPollCount');
  expect(serializedWorkflow).toContain('WaitForRestoreDrill');
  expect(serializedWorkflow).toContain(
    'WaitForRestoreDrillInitialFailureFinalizer',
  );
  expect(serializedWorkflow).toContain(
    'WaitForRestoreDrillPollFailureFinalizer',
  );
  expect(serializedWorkflow).toContain('FinalizeRestoreDrillInitialTaskFailure');
  expect(serializedWorkflow).toContain('FinalizeRestoreDrillPollTaskFailure');
  expect(serializedWorkflow).toContain(
    'FinalizeRestoreDrillPollBudgetExhaustion',
  );
  expect(serializedWorkflow).toContain(
    'WaitForRestoreDrillPollBudgetFinalizer',
  );
  expect(serializedWorkflow).toContain(
    'WaitForRestoreDrillPollBudgetFinalizerServiceRecovery',
  );
  expect(serializedWorkflowDefinition).toContain(
    '"SecondsPath":"$.result.waitSeconds"',
  );
  expect(serializedWorkflowDefinition).toContain(
    '"SecondsPath":"$.finalizer.waitSeconds"',
  );
  expect(serializedWorkflowDefinition).toContain('"action":"advance"');
  expect(serializedWorkflowDefinition).toContain('"action":"finalize-failure"');
  expect(serializedWorkflowDefinition).toContain(
    '"action":"finalize-poll-budget-exceeded"',
  );
  expect(serializedWorkflowDefinition).toContain('"event.$":"$.scheduledEvent"');
  expect(serializedWorkflowDefinition).toContain('"pollCount":0');
  expect(serializedWorkflowDefinition).toContain(
    '"pollCount.$":"States.MathAdd($.pollCount, 1)"',
  );
  expect(serializedWorkflowDefinition).toContain(
    '"Variable":"$.pollCount","NumericLessThan":1200',
  );
  expect(serializedWorkflowDefinition).not.toContain('"Retry"');
  expect(serializedWorkflowDefinition).toContain(
    '"Variable":"$.pollCount","NumericLessThan":1200}],"Next":"IncrementRestoreDrillPollCount"',
  );
  expect(serializedWorkflowDefinition).toContain(
    '"Variable":"$.result.status","StringEquals":"pending","Next":"FinalizeRestoreDrillPollBudgetExhaustion"',
  );
  expect(serializedWorkflowDefinition).toContain(
    '"Variable":"$.finalizer.status","StringEquals":"awaiting-cleanup-approval","Next":"RestoreDrillFailed"',
  );
  expect(serializedWorkflowDefinition).toContain(
    '"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"WaitForRestoreDrillPollBudgetFinalizerServiceRecovery"',
  );
  expect(serializedWorkflow).toContain('runnerExecutionArn');
  expect(serializedWorkflow).toContain('$$.Execution.Id');
  expect(serializedWorkflow).toContain('awaiting-cleanup-approval');
  expect(serializedWorkflow).toContain('not-due');
  expect(serializedWorkflow).toContain('pending');
  expect(serializedWorkflow).not.toContain('IncludeExecutionData":true');

  const serializedCleanupWorkflow = JSON.stringify(cleanupWorkflow);
  const serializedCleanupWorkflowDefinition = serializeAwsSdkCall(
    requiredRecord(cleanupWorkflow, 'Properties').DefinitionString,
  );
  expect(serializedCleanupWorkflowDefinition).toContain('"TimeoutSeconds":14400');
  expect(serializedCleanupWorkflow).toContain('AdvanceRestoreDrillCleanup');
  expect(serializedCleanupWorkflow).toContain('WaitForRestoreDrillCleanup');
  expect(serializedCleanupWorkflowDefinition).toContain(
    '"SecondsPath":"$.result.waitSeconds"',
  );
  expect(serializedCleanupWorkflowDefinition).toContain('"action":"cleanup"');
  expect(serializedCleanupWorkflow).toContain('approvalObjectKey');
  expect(serializedCleanupWorkflow).toContain('cleanupExecutionArn');
  expect(serializedCleanupWorkflow).toContain('cleanupExecutionName');
  expect(serializedCleanupWorkflow).toContain('$$.Execution.Id');
  expect(serializedCleanupWorkflow).toContain('$$.Execution.Name');
  expect(serializedCleanupWorkflow).toContain('completed');
  expect(serializedCleanupWorkflow).toContain('pending');
  expect(serializedCleanupWorkflowDefinition).not.toContain('"Retry"');

  const serializedTimeoutFinalizerWorkflow = JSON.stringify(
    timeoutFinalizerWorkflow,
  );
  const serializedTimeoutFinalizerDefinition = serializeAwsSdkCall(
    requiredRecord(timeoutFinalizerWorkflow, 'Properties').DefinitionString,
  );
  expect(serializedTimeoutFinalizerDefinition).toContain('"TimeoutSeconds":7200');
  expect(serializedTimeoutFinalizerWorkflow).toContain(
    'FinalizeTimedOutRestoreDrill',
  );
  expect(serializedTimeoutFinalizerWorkflow).toContain(
    'WaitForRestoreDrillTimeoutFinalizer',
  );
  expect(serializedTimeoutFinalizerDefinition).toContain(
    '"SecondsPath":"$.result.waitSeconds"',
  );
  expect(serializedTimeoutFinalizerDefinition).toContain(
    '"action":"finalize-failure"',
  );
  expect(serializedTimeoutFinalizerWorkflow).toContain('runnerExecutionArn');
  expect(serializedTimeoutFinalizerWorkflow).toContain(
    'awaiting-cleanup-approval',
  );
  expect(serializedTimeoutFinalizerWorkflow).toContain('pending');
  expect(serializedTimeoutFinalizerDefinition).not.toContain('"Retry"');
});

test('runner history fuse reserves a thousand finalizer polls for large workloads', () => {
  const [, workflow] = findResource(
    'AWS::StepFunctions::StateMachine',
    'RestoreDrillWorkflow',
  );
  const definition = serializeAwsSdkCall(
    requiredRecord(workflow, 'Properties').DefinitionString,
  );
  const pollBudgetMatch =
    /"Variable":"\$\.pollCount","NumericLessThan":(\d+)/.exec(definition);
  expect(pollBudgetMatch).not.toBeNull();
  const pollBudget = Number(pollBudgetMatch?.[1]);
  const standardHistoryEventLimit = 25_000;
  const fixedWorkflowEventReserve = 500;
  const normalPollEventUpperBound = 11;
  const failureFinalizerPollEventUpperBound = 9;
  const reservedFailureFinalizerPolls = 1_000;
  expect(
    fixedWorkflowEventReserve +
      pollBudget * normalPollEventUpperBound +
      reservedFailureFinalizerPolls * failureFinalizerPollEventUpperBound,
  ).toBeLessThan(standardHistoryEventLimit);
});

test('daily due checks use retained encrypted DLQ delivery and explicit retries', () => {
  const [dlqId, dlq] = findResource('AWS::SQS::Queue', 'RestoreDrillScheduleDlq');
  const [, scheduleRule] = findResource('AWS::Events::Rule', 'RestoreDrillScheduleRule');
  const [, timeoutFinalizerRule] = findResource(
    'AWS::Events::Rule',
    'RestoreDrillTimeoutFinalizerRule',
  );
  const scheduleProperties = requiredRecord(scheduleRule, 'Properties');

  expect(dlq).toEqual(expect.objectContaining({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: expect.objectContaining({
      MessageRetentionPeriod: 1_209_600,
      SqsManagedSseEnabled: true,
    }),
  }));
  expect(scheduleProperties).toEqual(expect.objectContaining({
    Description: 'Checks restore-drill cadence daily and starts a due run at 89 days.',
    ScheduleExpression: 'rate(1 day)',
    State: 'ENABLED',
    Targets: [expect.objectContaining({
      DeadLetterConfig: {
        Arn: { 'Fn::GetAtt': [dlqId, 'Arn'] },
      },
      RetryPolicy: {
        MaximumEventAgeInSeconds: 86_400,
        MaximumRetryAttempts: 2,
      },
    })],
  }));
  const timeoutFinalizerProperties = requiredRecord(
    timeoutFinalizerRule,
    'Properties',
  );
  expect(timeoutFinalizerProperties).toEqual(expect.objectContaining({
    Description:
      'Finalizes immutable failure evidence after the restore workflow fails or times out.',
    EventPattern: expect.objectContaining({
      detail: expect.objectContaining({
        status: ['FAILED', 'TIMED_OUT'],
      }),
      'detail-type': ['Step Functions Execution Status Change'],
      source: ['aws.states'],
    }),
    State: 'ENABLED',
    Targets: [expect.objectContaining({
      DeadLetterConfig: {
        Arn: { 'Fn::GetAtt': [dlqId, 'Arn'] },
      },
      InputTransformer: {
        InputPathsMap: {
          'detail-executionArn': '$.detail.executionArn',
        },
        InputTemplate:
          '{"action":"finalize-failure","runnerExecutionArn":<detail-executionArn>}',
      },
      RetryPolicy: {
        MaximumEventAgeInSeconds: 86_400,
        MaximumRetryAttempts: 2,
      },
    })],
  }));
  expect(JSON.stringify(timeoutFinalizerProperties.EventPattern)).toContain(
    'RestoreDrillWorkflow',
  );

  const queuePolicies = Object.values(
    synthesizedTemplate.findResources('AWS::SQS::QueuePolicy'),
  ).filter(isRecord);
  const dlqPolicy = queuePolicies.find((policy) =>
    JSON.stringify(policy).includes(dlqId));
  expect(JSON.stringify(dlqPolicy)).toContain('aws:SecureTransport');
  expect(JSON.stringify(dlqPolicy)).toContain('false');
});

test('restore-drill alarms cover objectives, terminal failure, integrity, cadence, cleanup, workflows, and DLQ', () => {
  const alarmContracts = [
    ['RestoreDrillRpoAlarm', 'RpoSeconds', 300, 'GreaterThanThreshold'],
    ['RestoreDrillRtoAlarm', 'RtoSeconds', 14_400, 'GreaterThanThreshold'],
    [
      'RestoreDrillFailureAlarm',
      'DrillFailureCount',
      1,
      'GreaterThanOrEqualToThreshold',
    ],
    [
      'RestoreDrillIntegrityAlarm',
      'IntegrityFailureCount',
      1,
      'GreaterThanOrEqualToThreshold',
    ],
    [
      'RestoreDrillCadenceOverdueAlarm',
      'CadenceOverdueCount',
      1,
      'GreaterThanOrEqualToThreshold',
    ],
    [
      'RestoreDrillCleanupOverdueAlarm',
      'CleanupOverdueCount',
      1,
      'GreaterThanOrEqualToThreshold',
    ],
  ];
  for (const [logicalIdPrefix, metricName, threshold, comparisonOperator]
    of alarmContracts) {
    const [, alarm] = findResource('AWS::CloudWatch::Alarm', String(logicalIdPrefix));
    expect(requiredRecord(alarm, 'Properties')).toEqual(expect.objectContaining({
      ComparisonOperator: comparisonOperator,
      Dimensions: [{ Name: 'Service', Value: 'mukuroji-restore-drill' }],
      EvaluationPeriods: 1,
      MetricName: metricName,
      Namespace: 'Mukuroji/RestoreDrill',
      Threshold: threshold,
      TreatMissingData: 'notBreaching',
    }));
  }

  for (const logicalIdPrefix of [
    'RestoreDrillWorkflowFailureAlarm',
    'RestoreDrillWorkflowTimeoutAlarm',
    'RestoreDrillTimeoutFinalizerWorkflowFailureAlarm',
    'RestoreDrillTimeoutFinalizerWorkflowTimeoutAlarm',
    'RestoreDrillCleanupWorkflowFailureAlarm',
    'RestoreDrillCleanupWorkflowTimeoutAlarm',
    'RestoreDrillScheduleDlqAlarm',
    'RestoreDrillScheduleFailureAlarm',
  ]) {
    const [, alarm] = findResource('AWS::CloudWatch::Alarm', logicalIdPrefix);
    expect(requiredRecord(alarm, 'Properties')).toEqual(expect.objectContaining({
      EvaluationPeriods: 1,
      Threshold: 1,
      TreatMissingData: 'notBreaching',
    }));
  }
});
