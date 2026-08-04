import { createHash } from 'node:crypto';
import { expect, test } from '@jest/globals';
import {
  handleFileBucketIncarnationMarkerEvent,
  type FileBucketIncarnationMarkerClient,
  type FileBucketIncarnationMarkerSnapshot,
} from '../lib/handlers/file-bucket-incarnation-marker-handler';

const bucketName = 'file-bucket';
const accountId = '123456789012';
const logicalResourceId = 'FileBucketIncarnationMarker';
const markerKey = 'system/data-integrity/file-bucket-incarnation/v1.json';
const stackId = `arn:aws:cloudformation:ap-northeast-1:${accountId}:stack/Test/stack-uuid`;

/**
 * Builds the deterministic marker snapshot expected from the test event.
 *
 * @param versionId Opaque S3 version identifier assigned to the snapshot.
 * @returns Expected exact marker attributes.
 */
function expectedSnapshot(
  versionId: string,
): FileBucketIncarnationMarkerSnapshot {
  const body = JSON.stringify({
    kind: 'mukuroji-file-bucket-incarnation-marker',
    logicalResourceId,
    stackId,
    version: 1,
  });
  return {
    checksumSha256: createHash('sha256').update(body).digest('base64'),
    size: Buffer.byteLength(body),
    versionId,
  };
}

/**
 * Builds one provider event with stable stack and marker properties.
 *
 * @param requestType CloudFormation lifecycle operation.
 * @param physicalResourceId Existing exact marker version for non-create events.
 * @param expectedAccount Exact account supplied through the custom resource.
 * @param requestedStackId CloudFormation stack ARN supplied with the event.
 * @returns Provider event accepted by the marker handler.
 */
function markerEvent(
  requestType: 'Create' | 'Delete' | 'Update',
  physicalResourceId?: string,
  expectedAccount = accountId,
  requestedStackId = stackId,
): Record<string, unknown> {
  return {
    LogicalResourceId: logicalResourceId,
    ...(physicalResourceId === undefined ? {} : { PhysicalResourceId: physicalResourceId }),
    RequestType: requestType,
    ResourceProperties: {
      BucketName: bucketName,
      ExpectedAccount: expectedAccount,
      MarkerKey: markerKey,
    },
    StackId: requestedStackId,
  };
}

/**
 * Creates a narrow in-memory S3 fixture with ordered marker reads.
 *
 * @param readResponses Ordered current and exact marker read outcomes.
 * @param createError Optional ambiguous create failure used for reconciliation tests.
 * @param versioningStatus Bucket versioning status returned to the handler.
 * @returns Injectable client and observable bounded call records.
 */
function markerClientFixture(
  readResponses: Array<
    Error | FileBucketIncarnationMarkerSnapshot | undefined
  >,
  createError?: Error,
  versioningStatus = 'Enabled',
): {
  readonly client: FileBucketIncarnationMarkerClient;
  readonly createChecksums: string[];
  readonly createExpectedBucketOwners: string[];
  readonly createdBodies: string[];
  readonly readExpectedBucketOwners: string[];
  readonly readVersionIds: Array<string | undefined>;
  readonly versioningExpectedBucketOwners: string[];
  readonly versioningBuckets: string[];
} {
  const createChecksums: string[] = [];
  const createExpectedBucketOwners: string[] = [];
  const createdBodies: string[] = [];
  const readExpectedBucketOwners: string[] = [];
  const readVersionIds: Array<string | undefined> = [];
  const versioningExpectedBucketOwners: string[] = [];
  const versioningBuckets: string[] = [];
  const client: FileBucketIncarnationMarkerClient = {
    /** Records the one conditional marker write requested by the handler. */
    async createMarker(
      _bucketName: string,
      expectedBucketOwner: string,
      _markerKey: string,
      body: string,
      checksumSha256: string,
    ): Promise<string> {
      createExpectedBucketOwners.push(expectedBucketOwner);
      createdBodies.push(body);
      createChecksums.push(checksumSha256);
      if (createError) {
        throw createError;
      }
      return 'version-created';
    },
    /** Returns the configured bucket versioning status. */
    async getBucketVersioning(
      requestedBucketName: string,
      expectedBucketOwner: string,
    ): Promise<string> {
      versioningBuckets.push(requestedBucketName);
      versioningExpectedBucketOwners.push(expectedBucketOwner);
      return versioningStatus;
    },
    /** Returns the next configured current or exact marker snapshot. */
    async readMarker(
      _bucketName: string,
      expectedBucketOwner: string,
      _markerKey: string,
      versionId?: string,
    ): Promise<FileBucketIncarnationMarkerSnapshot | undefined> {
      readExpectedBucketOwners.push(expectedBucketOwner);
      readVersionIds.push(versionId);
      const outcome = readResponses.shift();
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    },
  };
  return {
    client,
    createChecksums,
    createExpectedBucketOwners,
    createdBodies,
    readExpectedBucketOwners,
    readVersionIds,
    versioningExpectedBucketOwners,
    versioningBuckets,
  };
}

test('retried Create reconciles a matching current marker without minting a version', async () => {
  const snapshot = expectedSnapshot('version-existing');
  const fixture = markerClientFixture(
    [snapshot],
    new Error('conditional write precondition failed'),
  );

  const response = await handleFileBucketIncarnationMarkerEvent(
    markerEvent('Create'),
    fixture.client,
  );

  expect(response).toEqual({
    Data: {
      ChecksumSHA256: snapshot.checksumSha256,
      Key: markerKey,
      Size: snapshot.size,
      VersionId: snapshot.versionId,
    },
    PhysicalResourceId: snapshot.versionId,
  });
  expect(fixture.createdBodies).toHaveLength(1);
  expect(fixture.readVersionIds).toEqual([undefined]);
});

test('Create writes once and verifies the exact version returned by S3', async () => {
  const snapshot = expectedSnapshot('version-created');
  const fixture = markerClientFixture([snapshot]);

  const response = await handleFileBucketIncarnationMarkerEvent(
    markerEvent('Create'),
    fixture.client,
  );

  expect(response.PhysicalResourceId).toBe('version-created');
  expect(fixture.createdBodies).toHaveLength(1);
  expect(fixture.createChecksums).toEqual([snapshot.checksumSha256]);
  expect(fixture.createExpectedBucketOwners).toEqual([accountId]);
  expect(fixture.readExpectedBucketOwners).toEqual([accountId]);
  expect(fixture.readVersionIds).toEqual(['version-created']);
  expect(fixture.versioningExpectedBucketOwners).toEqual([accountId]);
});

test('Create reconciles an ambiguous successful write after its response is lost', async () => {
  const snapshot = expectedSnapshot('version-response-lost');
  const fixture = markerClientFixture(
    [snapshot],
    new Error('response lost after S3 accepted the conditional write'),
  );

  const response = await handleFileBucketIncarnationMarkerEvent(
    markerEvent('Create'),
    fixture.client,
  );

  expect(response.PhysicalResourceId).toBe('version-response-lost');
  expect(fixture.createdBodies).toHaveLength(1);
  expect(fixture.readVersionIds).toEqual([undefined]);
});

test('Create preserves the write failure when reconciliation cannot read a marker', async () => {
  const createError = new Error('conditional write outcome is unknown');
  const fixture = markerClientFixture(
    [new Error('missing marker read was denied')],
    createError,
  );

  await expect(handleFileBucketIncarnationMarkerEvent(
    markerEvent('Create'),
    fixture.client,
  )).rejects.toBe(createError);
  expect(fixture.createdBodies).toHaveLength(1);
  expect(fixture.readVersionIds).toEqual([undefined]);
});

test('Create fails closed when an existing marker has different bytes', async () => {
  const fixture = markerClientFixture(
    [{
      ...expectedSnapshot('version-conflict'),
      checksumSha256: 'unexpected-checksum',
    }],
    new Error('conditional write precondition failed'),
  );

  await expect(handleFileBucketIncarnationMarkerEvent(
    markerEvent('Create'),
    fixture.client,
  )).rejects.toThrow(
    'The existing file bucket incarnation marker does not match this stack.',
  );
  expect(fixture.createdBodies).toHaveLength(1);
});

test.each([
  ['an empty value', ''],
  ['the unversioned literal', 'null'],
  ['a control character', 'version\nid'],
  ['more than 1024 UTF-8 bytes', 'v'.repeat(1_025)],
])('Create rejects a current marker VersionId containing %s', async (
  _caseName: string,
  invalidVersionId: string,
) => {
  const fixture = markerClientFixture(
    [expectedSnapshot(invalidVersionId)],
    new Error('conditional write precondition failed'),
  );

  await expect(handleFileBucketIncarnationMarkerEvent(
    markerEvent('Create'),
    fixture.client,
  )).rejects.toThrow(
    'Marker snapshot VersionId must be a non-empty S3 version ID other than "null",',
  );
  expect(fixture.createdBodies).toHaveLength(1);
});

test('Update only reconciles the same current exact marker version', async () => {
  const snapshot = expectedSnapshot('version-existing');
  const fixture = markerClientFixture([snapshot]);

  const response = await handleFileBucketIncarnationMarkerEvent(
    markerEvent('Update', snapshot.versionId),
    fixture.client,
  );

  expect(response.PhysicalResourceId).toBe(snapshot.versionId);
  expect(fixture.createdBodies).toHaveLength(0);
  expect(fixture.readVersionIds).toEqual([undefined]);
});

test('Delete retains the marker without making any S3 call', async () => {
  const fixture = markerClientFixture([]);

  const response = await handleFileBucketIncarnationMarkerEvent(
    markerEvent('Delete', 'version-retained'),
    fixture.client,
  );

  expect(response).toEqual({ PhysicalResourceId: 'version-retained' });
  expect(fixture.createdBodies).toHaveLength(0);
  expect(fixture.readVersionIds).toHaveLength(0);
  expect(fixture.versioningBuckets).toHaveLength(0);
});

test('Create rejects a bucket owner that differs from the StackId account', async () => {
  const fixture = markerClientFixture([]);

  await expect(handleFileBucketIncarnationMarkerEvent(
    markerEvent('Create', undefined, '210987654321'),
    fixture.client,
  )).rejects.toThrow(
    'ExpectedAccount must match the AWS account in StackId.',
  );
  expect(fixture.createdBodies).toHaveLength(0);
  expect(fixture.readVersionIds).toHaveLength(0);
  expect(fixture.versioningBuckets).toHaveLength(0);
});

test.each(['12345678901', '12345678901x'])(
  'Create rejects malformed ExpectedAccount %s',
  async (expectedAccount: string) => {
    const fixture = markerClientFixture([]);

    await expect(handleFileBucketIncarnationMarkerEvent(
      markerEvent('Create', undefined, expectedAccount),
      fixture.client,
    )).rejects.toThrow(
      'ExpectedAccount must be an exact 12-digit AWS account ID.',
    );
    expect(fixture.versioningBuckets).toHaveLength(0);
  },
);

test('Create fails before reading or writing when bucket versioning is not enabled', async () => {
  const fixture = markerClientFixture([], undefined, 'Suspended');

  await expect(handleFileBucketIncarnationMarkerEvent(
    markerEvent('Create'),
    fixture.client,
  )).rejects.toThrow(
    'File bucket versioning must be Enabled, received Suspended.',
  );
  expect(fixture.createdBodies).toHaveLength(0);
  expect(fixture.readVersionIds).toHaveLength(0);
});
