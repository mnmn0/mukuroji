import { createHash } from 'node:crypto';
import {
  GetBucketVersioningCommand,
  GetObjectAttributesCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/** Supported CloudFormation lifecycle operations for the marker resource. */
type MarkerRequestType = 'Create' | 'Delete' | 'Update';

/** Parsed properties supplied to the marker custom resource. */
interface MarkerResourceProperties {
  /** Name of the versioned bucket that owns the marker. */
  readonly bucketName: string;
  /** Exact AWS account that must own the bucket. */
  readonly expectedAccount: string;
  /** Fixed object key reserved for the marker. */
  readonly markerKey: string;
}

/** Validated CloudFormation event fields used by the marker handler. */
interface MarkerEvent {
  /** Stable logical resource identifier included in the marker body. */
  readonly logicalResourceId: string;
  /** Existing exact marker version for update and delete events. */
  readonly physicalResourceId?: string;
  /** Requested CloudFormation lifecycle operation. */
  readonly requestType: MarkerRequestType;
  /** Validated marker resource properties. */
  readonly resourceProperties: MarkerResourceProperties;
  /** Stack incarnation identifier included in the marker body. */
  readonly stackId: string;
}

/** Deterministic marker bytes and their expected S3 attributes. */
interface MarkerMaterial {
  /** Canonical JSON marker body. */
  readonly body: string;
  /** Base64-encoded SHA-256 checksum of the body. */
  readonly checksumSha256: string;
  /** Marker body size in bytes. */
  readonly size: number;
}

/** Exact immutable attributes of one S3 marker object version. */
export interface FileBucketIncarnationMarkerSnapshot {
  /** Base64-encoded SHA-256 checksum returned by S3. */
  readonly checksumSha256: string;
  /** Object size returned by S3. */
  readonly size: number;
  /** Opaque S3 version identifier for this exact marker incarnation. */
  readonly versionId: string;
}

/** Narrow S3 boundary used by the marker lifecycle logic. */
export interface FileBucketIncarnationMarkerClient {
  /**
   * Creates the marker only if the exact key does not currently exist.
   *
   * @param bucketName Versioned bucket that owns the marker.
   * @param expectedBucketOwner Exact AWS account that must own the bucket.
   * @param markerKey Fixed marker object key.
   * @param body Canonical marker bytes.
   * @param checksumSha256 Base64-encoded SHA-256 checksum of the body.
   * @returns Opaque version identifier minted by S3.
   */
  createMarker(
    bucketName: string,
    expectedBucketOwner: string,
    markerKey: string,
    body: string,
    checksumSha256: string,
  ): Promise<string>;
  /**
   * Reads the bucket versioning state.
   *
   * @param bucketName Bucket whose versioning state is required.
   * @param expectedBucketOwner Exact AWS account that must own the bucket.
   * @returns S3 versioning status, when configured.
   */
  getBucketVersioning(
    bucketName: string,
    expectedBucketOwner: string,
  ): Promise<string | undefined>;
  /**
   * Reads current or exact-version marker attributes without reading its body.
   *
   * @param bucketName Bucket that owns the marker.
   * @param expectedBucketOwner Exact AWS account that must own the bucket.
   * @param markerKey Fixed marker object key.
   * @param versionId Optional exact S3 version identifier.
   * @returns Marker attributes, or undefined when the requested object is absent.
   */
  readMarker(
    bucketName: string,
    expectedBucketOwner: string,
    markerKey: string,
    versionId?: string,
  ): Promise<FileBucketIncarnationMarkerSnapshot | undefined>;
}

/** Attributes returned through the CDK provider framework. */
export interface FileBucketIncarnationMarkerResponseData {
  /** Base64-encoded SHA-256 checksum of the exact marker version. */
  readonly ChecksumSHA256: string;
  /** Fixed marker object key. */
  readonly Key: string;
  /** Marker body size in bytes. */
  readonly Size: number;
  /** Opaque exact S3 object version identifier. */
  readonly VersionId: string;
}

/** Response contract consumed by the CDK custom-resource provider framework. */
export interface FileBucketIncarnationMarkerResponse {
  /** Marker attributes published through custom-resource data fields. */
  readonly Data?: FileBucketIncarnationMarkerResponseData;
  /** Exact S3 marker version used as the stable physical resource identifier. */
  readonly PhysicalResourceId: string;
}

/** Maximum UTF-8 byte length documented for an S3 object version ID. */
const maximumS3VersionIdBytes = 1_024;

/** Exact syntax of an AWS account identifier. */
const awsAccountIdPattern = /^\d{12}$/u;

/**
 * Validates one opaque S3 object version identifier at a provider boundary.
 *
 * The literal `null` identifies an unversioned S3 object and is never a valid
 * incarnation marker. Byte and control-character limits also keep the value
 * safe for the CloudFormation physical-resource and output boundaries.
 *
 * @param value Unknown identifier returned by S3 or CloudFormation.
 * @param fieldName Boundary field used in validation errors.
 * @returns Validated non-null S3 object version identifier.
 */
function validateS3VersionId(value: unknown, fieldName: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === 'null' ||
    Buffer.byteLength(value, 'utf8') > maximumS3VersionIdBytes ||
    containsS3VersionIdControlCharacter(value)
  ) {
    throw new Error(
      `${fieldName} must be a non-empty S3 version ID other than "null", ` +
      `at most ${maximumS3VersionIdBytes} UTF-8 bytes, without control characters.`,
    );
  }
  return value;
}

/**
 * Detects C0, DEL, and C1 control code points without a control-character regex.
 *
 * @param value Candidate opaque S3 version identifier.
 * @returns True when the value contains a forbidden control code point.
 */
function containsS3VersionIdControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

/** Production implementation of the narrow marker S3 boundary. */
class AwsFileBucketIncarnationMarkerClient
implements FileBucketIncarnationMarkerClient {
  /** AWS SDK client used for all bounded S3 calls. */
  private readonly client: S3Client;

  /** Creates the production S3 adapter. */
  constructor() {
    this.client = new S3Client({});
  }

  /**
   * Creates a checksummed marker using an atomic absence precondition.
   *
   * @param bucketName Versioned bucket that owns the marker.
   * @param expectedBucketOwner Exact AWS account that must own the bucket.
   * @param markerKey Fixed marker object key.
   * @param body Canonical marker bytes.
   * @param checksumSha256 Base64-encoded SHA-256 checksum of the body.
   * @returns Opaque version identifier minted by S3.
   */
  async createMarker(
    bucketName: string,
    expectedBucketOwner: string,
    markerKey: string,
    body: string,
    checksumSha256: string,
  ): Promise<string> {
    const response = await this.client.send(new PutObjectCommand({
      Body: body,
      Bucket: bucketName,
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: checksumSha256,
      ContentType: 'application/json',
      ExpectedBucketOwner: expectedBucketOwner,
      IfNoneMatch: '*',
      Key: markerKey,
      ServerSideEncryption: 'AES256',
    }));

    return validateS3VersionId(response.VersionId, 'PutObject VersionId');
  }

  /**
   * Reads the bucket versioning state.
   *
   * @param bucketName Bucket whose versioning state is required.
   * @param expectedBucketOwner Exact AWS account that must own the bucket.
   * @returns S3 versioning status, when configured.
   */
  async getBucketVersioning(
    bucketName: string,
    expectedBucketOwner: string,
  ): Promise<string | undefined> {
    const response = await this.client.send(new GetBucketVersioningCommand({
      Bucket: bucketName,
      ExpectedBucketOwner: expectedBucketOwner,
    }));
    return response.Status;
  }

  /**
   * Reads the checksum, size, and version of a current or exact marker.
   *
   * @param bucketName Bucket that owns the marker.
   * @param expectedBucketOwner Exact AWS account that must own the bucket.
   * @param markerKey Fixed marker object key.
   * @param versionId Optional exact S3 version identifier.
   * @returns Marker attributes, or undefined when the object is absent.
   */
  async readMarker(
    bucketName: string,
    expectedBucketOwner: string,
    markerKey: string,
    versionId?: string,
  ): Promise<FileBucketIncarnationMarkerSnapshot | undefined> {
    try {
      const response = await this.client.send(new GetObjectAttributesCommand({
        Bucket: bucketName,
        ExpectedBucketOwner: expectedBucketOwner,
        Key: markerKey,
        ObjectAttributes: ['Checksum', 'ObjectSize'],
        ...(versionId === undefined ? {} : { VersionId: versionId }),
      }));
      const checksumSha256 = response.Checksum?.ChecksumSHA256;
      const size = response.ObjectSize;
      if (!checksumSha256 || size === undefined) {
        throw new Error(
          'S3 returned incomplete incarnation marker attributes.',
        );
      }
      const resolvedVersionId = validateS3VersionId(
        response.VersionId,
        'GetObjectAttributes VersionId',
      );
      return { checksumSha256, size, versionId: resolvedVersionId };
    } catch (error) {
      if (isMissingMarkerError(error)) {
        return undefined;
      }
      throw error;
    }
  }
}

const defaultClient = new AwsFileBucketIncarnationMarkerClient();

/**
 * Checks whether an AWS SDK failure proves that the requested marker is absent.
 *
 * @param error Unknown exception raised by the S3 client.
 * @returns True only for S3 not-found responses.
 */
function isMissingMarkerError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = Reflect.get(error, 'name');
  if (name === 'NoSuchKey' || name === 'NoSuchVersion' || name === 'NotFound') {
    return true;
  }
  const metadata = Reflect.get(error, '$metadata');
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }
  return Reflect.get(metadata, 'httpStatusCode') === 404;
}

/**
 * Reads one required non-empty string field from an object.
 *
 * @param value Object containing the field.
 * @param fieldName Required field name.
 * @returns Validated non-empty string value.
 */
function readRequiredString(value: object, fieldName: string): string {
  const field = Reflect.get(value, fieldName);
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return field;
}

/**
 * Validates one exact 12-digit AWS account identifier.
 *
 * @param value Untrusted account identifier.
 * @param fieldName Boundary field used in validation errors.
 * @returns Validated account identifier.
 */
function validateAwsAccountId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !awsAccountIdPattern.test(value)) {
    throw new Error(`${fieldName} must be an exact 12-digit AWS account ID.`);
  }
  return value;
}

/**
 * Extracts the owning account from one CloudFormation stack ARN.
 *
 * @param stackId Untrusted CloudFormation StackId field.
 * @returns Validated 12-digit AWS account identifier from the ARN.
 */
function readStackAccount(stackId: string): string {
  const fields = stackId.split(':');
  const [arnPrefix, partition, service, region, accountId, resource] = fields;
  const resourceFields = resource?.split('/');
  if (
    fields.length !== 6 ||
    arnPrefix !== 'arn' ||
    !partition ||
    service !== 'cloudformation' ||
    !region ||
    resourceFields?.length !== 3 ||
    resourceFields[0] !== 'stack' ||
    !resourceFields[1] ||
    !resourceFields[2]
  ) {
    throw new Error('StackId must be a complete CloudFormation stack ARN.');
  }
  return validateAwsAccountId(accountId, 'StackId account');
}

/**
 * Parses the untrusted provider event into the bounded marker contract.
 *
 * @param value Unknown Lambda event value.
 * @returns Validated marker lifecycle event.
 */
function parseMarkerEvent(value: unknown): MarkerEvent {
  if (!value || typeof value !== 'object') {
    throw new Error('The custom-resource event must be an object.');
  }
  const requestTypeValue = readRequiredString(value, 'RequestType');
  if (
    requestTypeValue !== 'Create' &&
    requestTypeValue !== 'Delete' &&
    requestTypeValue !== 'Update'
  ) {
    throw new Error(`Unsupported RequestType: ${requestTypeValue}`);
  }
  const rawProperties = Reflect.get(value, 'ResourceProperties');
  if (!rawProperties || typeof rawProperties !== 'object') {
    throw new Error('ResourceProperties must be an object.');
  }
  const physicalResourceId = requestTypeValue === 'Create'
    ? undefined
    : validateS3VersionId(
      readRequiredString(value, 'PhysicalResourceId'),
      'PhysicalResourceId',
    );
  const stackId = readRequiredString(value, 'StackId');
  const stackAccount = readStackAccount(stackId);
  const expectedAccount = validateAwsAccountId(
    readRequiredString(rawProperties, 'ExpectedAccount'),
    'ExpectedAccount',
  );
  if (stackAccount !== expectedAccount) {
    throw new Error(
      'ExpectedAccount must match the AWS account in StackId.',
    );
  }

  return {
    logicalResourceId: readRequiredString(value, 'LogicalResourceId'),
    ...(physicalResourceId === undefined ? {} : { physicalResourceId }),
    requestType: requestTypeValue,
    resourceProperties: {
      bucketName: readRequiredString(rawProperties, 'BucketName'),
      expectedAccount,
      markerKey: readRequiredString(rawProperties, 'MarkerKey'),
    },
    stackId,
  };
}

/**
 * Builds canonical marker bytes tied to one CloudFormation stack incarnation.
 *
 * @param event Validated custom-resource event.
 * @returns Deterministic marker bytes, checksum, and size.
 */
function buildMarkerMaterial(event: MarkerEvent): MarkerMaterial {
  const body = JSON.stringify({
    kind: 'mukuroji-file-bucket-incarnation-marker',
    logicalResourceId: event.logicalResourceId,
    stackId: event.stackId,
    version: 1,
  });
  return {
    body,
    checksumSha256: createHash('sha256').update(body).digest('base64'),
    size: Buffer.byteLength(body),
  };
}

/**
 * Fails closed unless the bucket is actively versioned.
 *
 * @param client Marker S3 boundary.
 * @param bucketName Bucket whose versioning state must be enabled.
 * @param expectedBucketOwner Exact AWS account that must own the bucket.
 * @returns Nothing.
 */
async function requireEnabledVersioning(
  client: FileBucketIncarnationMarkerClient,
  bucketName: string,
  expectedBucketOwner: string,
): Promise<void> {
  const status = await client.getBucketVersioning(
    bucketName,
    expectedBucketOwner,
  );
  if (status !== 'Enabled') {
    throw new Error(
      `File bucket versioning must be Enabled, received ${status ?? 'unset'}.`,
    );
  }
}

/**
 * Validates that S3 attributes exactly match the deterministic marker contract.
 *
 * @param snapshot Attributes returned by S3.
 * @param material Expected marker bytes and attributes.
 * @param expectedVersionId Optional version identifier that must also match.
 * @returns The validated snapshot.
 */
function validateMarkerSnapshot(
  snapshot: FileBucketIncarnationMarkerSnapshot | undefined,
  material: MarkerMaterial,
  expectedVersionId?: string,
): FileBucketIncarnationMarkerSnapshot {
  if (!snapshot) {
    throw new Error('The file bucket incarnation marker does not exist.');
  }
  const snapshotVersionId = validateS3VersionId(
    snapshot.versionId,
    'Marker snapshot VersionId',
  );
  if (
    snapshot.checksumSha256 !== material.checksumSha256 ||
    snapshot.size !== material.size
  ) {
    throw new Error(
      'The existing file bucket incarnation marker does not match this stack.',
    );
  }
  if (
    expectedVersionId !== undefined &&
    snapshotVersionId !== expectedVersionId
  ) {
    throw new Error(
      'The current file bucket incarnation marker version has changed.',
    );
  }
  return {
    ...snapshot,
    versionId: snapshotVersionId,
  };
}

/**
 * Creates a provider response from validated exact marker attributes.
 *
 * @param markerKey Fixed marker object key.
 * @param snapshot Validated exact marker attributes.
 * @returns CDK provider response with stable physical and data fields.
 */
function buildMarkerResponse(
  markerKey: string,
  snapshot: FileBucketIncarnationMarkerSnapshot,
): FileBucketIncarnationMarkerResponse {
  return {
    Data: {
      ChecksumSHA256: snapshot.checksumSha256,
      Key: markerKey,
      Size: snapshot.size,
      VersionId: snapshot.versionId,
    },
    PhysicalResourceId: snapshot.versionId,
  };
}

/**
 * Creates or reconciles one immutable file-bucket incarnation marker.
 *
 * Create always starts with one conditional write. A rejected retry or a lost
 * successful response then validates the current marker, so no preliminary
 * missing-object read and no second S3 version are required. Update is
 * read-only, and Delete intentionally retains the exact marker with the
 * retained bucket.
 *
 * @param rawEvent Unknown CDK provider event.
 * @param client Injectable S3 boundary used by tests and production.
 * @returns Provider response containing exact immutable marker attributes.
 */
export async function handleFileBucketIncarnationMarkerEvent(
  rawEvent: unknown,
  client: FileBucketIncarnationMarkerClient = defaultClient,
): Promise<FileBucketIncarnationMarkerResponse> {
  const event = parseMarkerEvent(rawEvent);
  const { bucketName, expectedAccount, markerKey } = event.resourceProperties;
  if (event.requestType === 'Delete') {
    if (!event.physicalResourceId) {
      throw new Error('Delete requires the existing marker version ID.');
    }
    return { PhysicalResourceId: event.physicalResourceId };
  }

  const material = buildMarkerMaterial(event);
  await requireEnabledVersioning(client, bucketName, expectedAccount);

  if (event.requestType === 'Update') {
    if (!event.physicalResourceId) {
      throw new Error('Update requires the existing marker version ID.');
    }
    const currentMarker = await client.readMarker(
      bucketName,
      expectedAccount,
      markerKey,
    );
    const snapshot = validateMarkerSnapshot(
      currentMarker,
      material,
      event.physicalResourceId,
    );
    return buildMarkerResponse(markerKey, snapshot);
  }

  let versionId: string;
  try {
    versionId = validateS3VersionId(
      await client.createMarker(
        bucketName,
        expectedAccount,
        markerKey,
        material.body,
        material.checksumSha256,
      ),
      'PutObject VersionId',
    );
  } catch (createError) {
    let reconciledMarker: FileBucketIncarnationMarkerSnapshot | undefined;
    try {
      reconciledMarker = await client.readMarker(
        bucketName,
        expectedAccount,
        markerKey,
      );
    } catch {
      throw createError;
    }
    if (!reconciledMarker) {
      throw createError;
    }
    return buildMarkerResponse(
      markerKey,
      validateMarkerSnapshot(reconciledMarker, material),
    );
  }

  const exactMarker = await client.readMarker(
    bucketName,
    expectedAccount,
    markerKey,
    versionId,
  );
  return buildMarkerResponse(
    markerKey,
    validateMarkerSnapshot(exactMarker, material, versionId),
  );
}

/**
 * Lambda entrypoint used by the CDK custom-resource provider framework.
 *
 * @param event Unknown provider event.
 * @returns Provider response containing exact marker attributes.
 */
export async function handler(
  event: unknown,
): Promise<FileBucketIncarnationMarkerResponse> {
  return handleFileBucketIncarnationMarkerEvent(event);
}
