# Isolated restore drill

The restore drill is a production-data recovery test. It restores data only to
resources that are not referenced by the API, workers, runtime configuration,
or traffic routing. A successful drill is evidence that a selected historical
point can be restored and verified; it is not permission to fail over
production traffic.

## Recovery objectives

Version one has two same-Region objectives:

- RPO is at most 300 seconds.
- RTO is at most 14,400 seconds.

At admission, the runner reads the PITR window for all six protected DynamoDB
tables. It computes:

```text
common earliest = maximum(all earliest restorable timestamps)
common latest   = minimum(all latest restorable timestamps)
restore point   = common latest
RPO             = drill start - restore point
RTO             = verified completion - drill start
```

An empty common interval, a future restore point, RPO above 300 seconds, or RTO
above 14,400 seconds is a failed run. A failed run still proceeds to
evidence sealing and waits for cleanup approval.

## Protected dataset

Every run uses one common restore point for:

- Work Items;
- Work Item Configuration;
- Project Directory;
- Workspace Access;
- Audit Events; and
- File Proofing.

Each table is restored under the reserved `mukuroji-restore-drill-` physical
name prefix. The runner rejects a target whose restore provenance, source ARN,
point, account, Region, or physical identity does not match the admitted
command. Existing application roles receive no permission for that prefix.

The source File bucket is never used as a destination. Each exact object
version referenced by the restored File Proofing snapshot is copied into a
private, KMS-encrypted, versioned scratch bucket. S3 assigns a new physical
`VersionId`, so the runner updates only the isolated File Proofing row to the
new value. Source metadata remains unchanged.

The copy gate verifies the source and destination body digest, byte count,
content type, user metadata, upload/deletion tags, and GuardDuty malware tag.
It does not accept an ETag as a general-purpose content digest. The maximum
accepted object size is the same 2 GiB limit enforced by the production File
upload policy. Source and destination bodies are read independently by exact
`VersionId` in inclusive ranges of at most 16 MiB. Each step validates the
returned `VersionId`, `Content-Range`, `Content-Length`, and total size, compares
the two range SHA-256 values, and advances an authenticated ordered range-chain
checkpoint. A Lambda invocation therefore never needs to retain a whole 2 GiB
object body.

Before `CopyObject`, the runner durably records the exact destination VersionId
baseline. If an SDK retry or a lost response creates more than one new version,
the runner records every post-baseline VersionId in the cleanup scope. It
deterministically selects one version for content verification and isolated-row
remapping; the other created versions are never remapped, but they remain
approval-bound cleanup targets.

## Exact baseline

A live production `Scan` is not an exact baseline for a PITR point. Even a
strongly consistent multi-page scan has no table-wide snapshot isolation, and
production writers continue while restore and verification run.

For that reason, the runner starts a `DYNAMODB_JSON` point-in-time export for
each source table at the same admitted restore point. It binds the summary,
files manifest, checksums, data-object keys, and exact S3 `VersionId` values to
the recorded export before reading data. Export rows and restored rows are
reduced incrementally to bounded keyed multiset checkpoints. Logical-partition
tokens are written before the aggregate progress CAS and are counted in bounded
pages, so a retry cannot silently lose a partition. The File Proofing aggregate
normalizes only the system-generated source and destination object `VersionId`;
all logical metadata remains comparison-bound.

The exported snapshot and isolated restore must have identical per-resource
item counts and authenticated aggregates. A current live observation may be
collected for diagnosis, but it is never promoted to an exact comparison.

## Verification gates

A terminal pass requires all of the following:

1. Every export completed for the admitted table ARN and restore point.
2. Every recovery table became `ACTIVE` with matching restore provenance.
3. Table attribute definitions, base key schema, sorted GSI key/projection
   contract and `ACTIVE` state, billing mode, SSE type/readiness and KMS identity,
   and the source TTL contract matched; recovery-table TTL remained disabled.
4. Export and restore exact item counts, logical-partition counts, key
   aggregates, and content aggregates matched for all six tables.
5. Every export manifest/data object was read by its recorded immutable version
   and passed its checksum, provenance, item-count, and configured capacity
   gates.
6. Every referenced S3 object version was copied and its content, metadata,
   tags, and File Proofing relation were verified.
7. The cross-domain checker passed over the six recovery tables and the
   scratch bucket.
8. RPO and RTO met their targets.
9. Secret-free immutable evidence was published exactly once.

This automated descriptor gate does not inspect DynamoDB Streams, CloudWatch
alarms, resource tags, IAM/application bindings, or traffic routing, and it does
not claim that PITR restores those settings. They remain separate
infrastructure-drift and recovery-plan checks. TTL is different: the source TTL
configuration is comparison-bound, while TTL must remain disabled on every
recovery table during verification so expired historical rows cannot disappear
from the selected snapshot.

## Durable execution and cadence

A Standard Step Functions workflow invokes bounded runner steps. DynamoDB
restore/export polling, File copies, table scans, and digest work are
checkpointed outside Step Functions execution data. Execution logging excludes
payload data. Each continuation returns a dynamic wait: durable local
checkpoint progress is redriven with zero seconds, while AWS
restore/export/delete/abort convergence and copy-claim reconciliation use the
bounded polling wait. A task error does not skip evidence sealing; both initial
and continuation task catches repeatedly invoke the durable failure finalizer
until the run reaches `awaiting-cleanup-approval`. Generic Lambda, AWS service,
KMS, or state-store failures seal the non-integrity operational code
`WORKFLOW_TASK_FAILED`. Every sealed failed terminal result contributes to the
general drill-failure alarm; only an explicitly observed descriptor, aggregate,
cross-domain, or exact File-copy mismatch additionally contributes to the
integrity alarm. When fallback evidence is required after restore-point
selection, the runner still emits the mechanically known `RpoSeconds` value and
retains `RPO_TARGET_MISSED` in terminal run state alongside the operational
failure.

Verification is incremental rather than one unbounded Lambda call. One source
export data file, restored-table Scan page, or exact 16 MiB File-body range is
reduced per logical step; completed File-copy proofs are also reduced in pages.
Cross-domain rows are normalized into opaque HMAC facts, uniqueness claims,
lifecycle candidates, and deferred requirements. Before semantic scans start,
the exact Secrets Manager version of the Workspace Audit pseudonym key is pinned
for the run. Each semantic Scan page requests at most 25 raw rows, while the
requirement and latest-Audit reducers read at most 100 durable records per
logical step and select the latest current Audit event independently of Scan
page order before final assembly. One Lambda invocation may batch eligible
page-like stages, but it stops after at most 50 logical steps or after the
eight-minute elapsed-time guard. Only authenticated compact checkpoints, opaque
claims, and exact resume cursors are durable. Raw normalized tenant rows do not
cross the invocation boundary.

The verifier fails closed instead of truncating work. Current limits include
10 export-object listing pages and 10,000 listed export objects per table, 256
export data files per table, 100,000 rows and 1 GiB of uncompressed data per
export file, 1,000,000 rows or 10,000 restore pages per table, and 10,000 File
versions. Semantic verification permits at most 1,000,000 retained opaque units
and 10,000 raw pages across the six isolated tables, with at most 150,000 claims
emitted by one normalized page. The claim ceiling covers the physical 1 MiB
DynamoDB page envelope: at least 95 item bytes per canonical pending File
version permits no more than 11,037 versions, each expands to at most 13 claims,
and a page can add only four stable external File failures. A manifest,
inventory, row, page,
semantic-claim, or File limit breach is a failed verification: it produces
stable failure evidence, does not advance the last-successful cadence
timestamp, and is alarm/remediation work. These limits never authorize cleanup
inventory truncation; the failure finalizer continues enumerating every exact
created resource before approval can be issued.

These are fail-closed logical data ceilings, not a promise that every maximum
can be combined in one successful run. Actual completion must also fit the
per-invocation batch bounds, the four-hour RTO, and the main workflow's global
continuation fuse. Every main-loop `pending` result, including a zero-second
local-state redrive, consumes that execution-wide budget. If another
continuation is still required after 1,200 poll-loop iterations, the workflow
enters the dedicated durable failure finalizer instead of treating partial work
as a pass. It seals the stable operational failure
`WORKFLOW_POLL_BUDGET_EXCEEDED`, not an integrity failure. The finalizer
inventories every exact created resource, seals failure evidence, leaves the
last-successful cadence unchanged, and drives the run to
`awaiting-cleanup-approval`; `DrillFailureCount` is the stable result signal, and
a failed main workflow is an additional alarm/remediation signal. One finalizer
invocation may replay at most 50
zero-wait logical steps or eight minutes and re-reads the RUN owner before each
step; an external wait ends the batch.

If the workflow reaches `FAILED` or its 270-minute hard `TIMED_OUT` state, an
EventBridge status rule starts a separate Standard workflow that repeatedly
invokes the same idempotent failure finalizer. A deliberate terminal failure
after evidence has already been sealed is therefore an idempotent no-op.
Exhausted event deliveries go to the retained control-plane DLQ. EventBridge
status delivery is not the only recovery path:
the next daily cadence execution conditionally takes ownership of an active run
whose four-hour deadline has expired, using the run revision and execution ARN
as a CAS fence, and drives the same failure sealing. The superseded execution
cannot continue as the new owner.

A daily schedule performs a point-read of the cadence record:

- a new run becomes due 89 days after the last successful verified run;
- 90 days without a successful verified run is overdue and alarms; and
- one active drill prevents another run from being admitted.

Failed runs do not advance the last-successful timestamp. Duplicate schedule
delivery and Lambda response loss are reconciled from deterministic commands,
immutable receipts, and conditional state transitions; an ambiguous external
mutation fails closed.

## Evidence

Evidence is written to a dedicated KMS-encrypted, versioned bucket with Object
Lock COMPLIANCE retention. The bucket rejects deletion, overwrite, upload
without `If-None-Match: *`, and encryption with another key.

Writer permissions are separated by artifact. The runner can publish only the
terminal `evidence/v1/runs/<drill-id>/result.json`; the cleanup role can publish
only `evidence/v1/runs/<drill-id>/cleanup.json`. Neither role can use its writer
permission to replace the other artifact.

Before either Object Lock write, the responsible role conditionally pins the
exact canonical artifact bytes, key, retention reference, and ordered
post-publication effects in durable state. A concurrent finalizer, response-loss
retry, replacement cleanup approval, or daily takeover must replay that same
intent rather than calculate a different immutable body. Successful cadence
updates, alarm-backed metrics, cleanup lease release, and their progress are
then replayed in fixed order before the workflow reports terminal success.

The terminal result contains only the fields in its strict contract:

- contract version, drill ID, canonical start/completion time, and restore point;
- measured/target RPO and RTO with their pass/fail booleans;
- source and isolated-restore dataset aggregate digests, which authenticate the
  already-validated per-resource descriptors, counts, content, and metadata
  without serializing those raw values;
- one digest of the exact approval-facing cleanup resource scope;
- aggregate-comparison and cross-domain/Work Items gate statuses; and
- sorted stable failure codes and the terminal run outcome.

If a complete terminal result cannot be constructed safely, the strict
operational-failure variant contains only its contract version, drill ID,
failure time, last durable phase, and one stable failure code.

The separate cleanup artifact contains the approved result/resource digests,
approval body digest and object key, attempt count, start/completion times,
expected and deleted counts by resource kind, and one authenticated aggregate
of every exact absence receipt. Individual target identities and absence
receipts remain restricted operational state rather than fields in the
immutable evidence artifact.

It never contains tenant rows, object bodies, tenant/source/scratch/export
object keys, physical scan cursors, credentials, secret material, raw AWS
errors, or per-row digests. The cleanup artifact's approval object key is a
control-plane locator under the fixed per-run approval prefix, not a tenant
object locator.

Operational state may contain exact object/resource locators and DynamoDB/S3
resume cursors required to continue, reconcile response loss, and clean a run.
Semantic join state uses opaque HMAC claims rather than raw tenant identifiers.
The operational state table is retained, encrypted, and IAM-restricted; it is
not the immutable evidence artifact, and its exact locators/cursors are never
copied into Step Functions logs or immutable evidence. Version one configures
no TTL or per-run state deletion, including after approved resource cleanup, so
these operational records are retained indefinitely. Environment owners must
monitor table capacity/cost and treat any future state-retirement or janitor
policy as a separately reviewed data-lifecycle change.

## Cleanup approval

Cleanup is a separate workflow and is never an automatic success-path step.
Both passing and failed drills stop in `awaiting-cleanup-approval`.

An approved receipt binds:

- the drill and configuration;
- the terminal result/evidence digest;
- the exact isolated resource vector;
- the data-owner principal and role;
- the reviewed change locator;
- the cleanup policy version; and
- approval and expiry timestamps.

The cleanup role rejects a missing, expired, forged, replayed, or
resource-substituted receipt before issuing a delete. It can delete only
recovery tables under the reserved prefix, every exact File-copy VersionId,
every exact DynamoDB-export object VersionId, and incomplete multipart uploads
recorded below the run-owned DynamoDB-export prefixes. Export object versions and
multipart upload identities are included in the approval `resourceDigest` and
inventory before cleanup starts. The role has no source-table, source-object,
evidence-object, or application-resource deletion permission.

Cleanup targets are appended by the runner to a per-run ledger partition
`RESTORE_DRILL_LEDGER#<drill-id>`, separate from mutable run state. Each first
insert is part of a bounded transaction that advances the shared ledger
count/revision by the exact number of new targets; one transaction owns a group
instead of racing per-target updates against the same control row. The final
scope seal fences that control record so no later target can be appended.
Before the seal, every CopyObject intent is reconciled in two complete
deterministic passes separated by a 16-minute quiet window. The pass digest and
terminal cursor must match; otherwise reconciliation restarts. This captures
versions created by a late CopyObject response before the approval resource
digest is fixed.

Cleanup is complete only after every target has an identity-bound absence
receipt, a final run-prefix multipart-upload listing is empty, and immutable
cleanup evidence has been appended. Each logical cleanup step processes at most
25 recorded targets and persists its cursor and bounded receipt chain. One
Lambda invocation may replay at most 50 zero-wait cleanup steps or eight
minutes, re-reading the RUN and pinned cleanup execution identity before every
step. The execution must still be `RUNNING` with `redriveCount` zero; a
same-ARN Step Functions redrive is rejected. An external wait ends the batch.
The final cleanup timestamp and approval-bound canonical artifact bytes are
pinned in the same progress CAS. A replacement execution therefore either
replays bytes already pinned by the earlier attempt or pins a new snapshot whose
completion timestamp is not earlier than its approval; the RUN timestamp never
moves backwards.
The retained evidence bucket and audit state are not cleanup targets.

The cleanup Lambda has read-only access to the sealed ledger, writes mutable
cursor/receipt progress only below `RESTORE_DRILL_CLEANUP#<drill-id>`, and may
conditionally update only the cleanup-owned fields of the run and cadence
records. It cannot use a broad `PutItem` to replace either record. The cleanup
Step Functions state machine has an explicit physical name; approval
`StartExecution`/`ListExecutions` permissions and both approval/cleanup
`DescribeExecution` permissions are bound to that same workflow identity, not
to the timeout finalizer workflow.

### Operator procedure

Do not start cleanup until the terminal result evidence and exact resource
digest have been reviewed under an approved change. Use the stack outputs
`RestoreDrillStateTableName`, `RestoreDrillEvidenceBucketName`,
`RestoreDrillCleanupStateMachineArn`, and
`RestoreDrillCleanupApprovalPolicyArn`. Assume a data-owner session to which
the unattached approval policy has been deliberately attached. The role must
be exactly the existing IAM role supplied at deployment as
`RestoreDrillCleanupApproverRoleArn`; attaching the policy to another role
does not authorize approval. Confirm the exact assumed-role session identity:

```sh
aws sts get-caller-identity \
  --region <region> \
  --profile <data-owner-profile>
```

Copy the returned `Arn` exactly into `--approver`. Record one immutable
approval with an expiry no more than 24 hours after the approval time. The
expiry must leave enough time to admit the cleanup workflow and must not
outlive the approved change window:

```sh
aws dynamodb get-item \
  --region <region> \
  --profile <data-owner-profile> \
  --table-name <RestoreDrillStateTableName> \
  --consistent-read \
  --key '{"scopeKey":{"S":"CONTROL"},"recordKey":{"S":"CADENCE"}}' \
  --projection-expression 'scopeKey,recordKey,activeDrillId'

aws s3api get-object \
  --region <region> \
  --profile <data-owner-profile> \
  --bucket <RestoreDrillEvidenceBucketName> \
  --key evidence/v1/runs/<drill-id>/result.json \
  --checksum-mode ENABLED \
  --expected-bucket-owner <12-digit-account-id> \
  <owner-controlled-review-file>
```

Require `activeDrillId` to equal the reviewed drill ID. Verify the downloaded
checksum, the artifact, and the linked change record before running:

```sh
bun run restore-drill:approve-cleanup -- \
  --region <region> \
  --profile <data-owner-profile> \
  --state-table-name <RestoreDrillStateTableName> \
  --approval-bucket-name <RestoreDrillEvidenceBucketName> \
  --drill-id <drill-id> \
  --approver <GetCallerIdentity-Arn> \
  --change-locator <immutable-change-record-locator> \
  --expires-at <canonical-UTC-timestamp>
```

The command strongly reads the sealed run, verifies the actual STS caller,
decrypts the run-bound approval key with its exact KMS context, zeroizes the
plaintext key, and exclusively creates an Object Lock protected receipt below
`approvals/v1/runs/<drill-id>/`. Before reporting success it reads the exact
object back with checksum validation and requires effective Object Lock
`COMPLIANCE` retention through at least 400 days after `approvedAt`. It prints a
secret-free `approvalObjectKey`, `cleanupExecutionName`, status, and drill ID.
It does not start cleanup. Keep the exact JSON output with the change record.

After the receipt has been recorded, start the separate Standard workflow with
the printed object key and deterministic execution name:

```sh
aws stepfunctions start-execution \
  --region <region> \
  --profile <data-owner-profile> \
  --state-machine-arn <RestoreDrillCleanupStateMachineArn> \
  --name <printed-cleanupExecutionName> \
  --input '{"drillId":"<drill-id>","approvalObjectKey":"<printed-approvalObjectKey>"}'
```

If the start response is lost, retry with the exact same name and byte-for-byte
input. A running Standard execution treats that retry idempotently. If AWS
reports `ExecutionAlreadyExists`, use `list-executions` and
`describe-execution` to reconcile that name before taking further action.
Approval expiry is checked when cleanup is first admitted; an already admitted
execution resumes only with the receipt digest and object key pinned in the
run.

If that pinned execution reaches `FAILED`, `TIMED_OUT`, or `ABORTED`, do not
immediately start another execution and do not call `RedriveExecution`.
Confirm its exact ARN, state-machine ARN, name, terminal `stopDate`, and failure
evidence, then wait until at least 16 minutes after `stopDate`. Re-run the
approval command under a newly reviewed change window. The command performs a
metadata-only `DescribeExecution` and creates a new immutable receipt and
therefore a new deterministic execution name. The runtime requires that new
receipt's `approvedAt` be later than the prior approval and no earlier than the
currently pinned execution's `stopDate` plus 16 minutes, so an unused receipt
issued for an older attempt cannot be replayed. Start the replacement workflow
only with those newly printed values. `RUNNING`, `PENDING_REDRIVE`, and
`SUCCEEDED` executions are not reapprovable. The original `cleanupStartedAt`
remains fixed while the attempt count and approval chain advance.

Detach the approval policy from the short-lived data-owner role immediately
after the start has been reconciled. Monitor the execution until `completed`,
then confirm the immutable cleanup evidence and verify that the cadence record
no longer holds the drill as active:

```sh
aws dynamodb get-item \
  --region <region> \
  --profile <data-owner-profile> \
  --table-name <RestoreDrillStateTableName> \
  --consistent-read \
  --key '{"scopeKey":{"S":"CONTROL"},"recordKey":{"S":"CADENCE"}}' \
  --projection-expression 'scopeKey,recordKey,activeDrillId'
```

A conditional-write conflict, expired receipt at admission,
resource-identity mismatch, or partial absence check is a failed cleanup
attempt. Reconcile the pinned execution first. Only a failed, timed-out, or
aborted execution that has passed the 16-minute safety interval may receive a
new immutable approval receipt; never modify an existing receipt or reuse its
execution name.

## Alarm response

Operators investigate sealed terminal drill failures, the schedule DLQ, Step
Functions failed/timed-out executions, RPO/RTO/integrity failures, cadence
overdue state, and cleanup approval overdue state through the stack's mandatory
primary and secondary SNS destinations. `DrillFailureCount` covers every sealed
failed result even when the durable finalizer lets the control workflow finish
successfully.

Do not delete a recovery resource to silence an alarm. Preserve the run state
and immutable failure evidence, record remediation, obtain a new exact cleanup
approval, and then run the cleanup workflow.
