# Cross-domain data integrity

The cross-domain integrity checker is a read-only quality gate for a live
source dataset or an isolated restore dataset. It complements, rather than
replaces, the Work Items single-table manifest verifier.

## Version-one scope

One check reads these six DynamoDB tables and the exact-version workspace file
bucket through an explicit account, Region, dataset role, evaluation timestamp,
and bounded request:

- Work Items
- Work Item Configuration, including the relation graph
- Project Directory
- Workspace Access
- Audit Events
- File Proofing metadata

The checker fails closed when a required resource cannot be read, a scan is
incomplete, a page cursor repeats, a configured item/page bound is exceeded,
a relevant storage shape is unknown, or an exact S3 object version cannot be
observed. Known auxiliary rows in shared tables are validated only enough to
identify and exclude them. The same input and result contract is used for
`source` and `restore`; the role changes evidence provenance, not the
invariants.

Version one checks:

- each Work Item is a canonical storage record;
- each Work Item workflow status and category exist in its effective Team or
  Workspace configuration;
- a retained legacy Work Item `deletedAt` tombstone has a canonical deletion
  clock within its row lifetime and is excluded from live cross-table joins;
- each assigned Team and Project exists in the same Workspace, and a Project
  belongs to the Work Item Team;
- each Work Item creator resolves to an active or historically retained
  Workspace Access row in the same Workspace;
- each relation edge has an existing same-Team endpoint, a valid reciprocal
  edge, and the same derived relation identifier on its Work Item endpoint;
- each canonical Audit Event keeps all duplicated workspace, entity, target,
  and index keys in the same tenant boundary;
- current-resource Audit Events resolve when their event semantics require a
  current row, while exact Work Item deletion, TTL-expired File deletion, and
  backfill or migration snapshots are not treated as corruption only because
  their resource is no longer live; deactivated Workspace members and archived
  Teams or Projects remain current joins because their canonical rows are
  retained; canonical Workspace member Audit pseudonyms are joined to Workspace
  Access with the existing environment-specific Audit pseudonym key;
- each File Proofing row is internally canonical and remains in the same
  Workspace, Team, Work Item, or Project boundary as its parent scope;
- every verified file version references one unique, immutable S3
  `VersionId`, and its size, writer-allowed content type, upload lifecycle,
  clean/quarantine state, and GuardDuty malware tag agree with the exact
  object-version observation;
- expected one-way upload, scan, and quarantine transitions do not create
  false positives, and a valid tombstone retained after its TTL deadline no
  longer requires an expired S3 version.

Known-corruption fixtures cover missing configuration/status/member/project,
orphan and non-reciprocal relations, tenant-crossing audit or file metadata,
missing exact object versions, and metadata/tag differences. A normal fixture
also covers historical Audit Events so the gate does not report those as
false positives.

## Explicit non-goals

Version one does not:

- replace the Work Items schema/GSI/TTL/encryption/PITR/content manifest;
- stop writers or claim a multi-table transactional snapshot of live tables;
- execute DynamoDB restore, S3 copy, cleanup, failover, or deployment;
- prove that historical resources still exist in current-state tables;
- resolve Work Item assignee or archive-actor membership, or prove that a
  comment attachment's current Collaboration row still exists;
- read file bodies or prove the correctness of the malware engine itself;
- publish raw Workspace, Team, member, Work Item, file, object key, object
  version, DynamoDB cursor, or per-row digest values;
- repair, delete, quarantine, or otherwise mutate data.

The [isolated restore drill](./restore-drill.md) supplies those resources and
combines this result with its restore-point, point-in-time export baseline,
RPO/RTO, descriptor, S3-copy, and cleanup evidence.
The restore drill may not convert an incomplete or failed checker result into a
successful terminal receipt. Wiring the contract into the restore workflow
remains caller-owned.

## Bounded execution and evidence

The checker requires explicit page-size, page-count, and total normalized-item
ceilings. `maxItems` must not exceed `maxPages * pageSize`, and the raw scan
capacity is capped at 1,000,000 rows. File-version expansion and external file
evidence count against `maxItems`; each exact object version causes exactly
three bounded metadata reads (HEAD, attributes, and tags).

The exported AWS bridge validates every ceiling before its first AWS read and
counts raw pages across all six tables. Empty pages and pages containing only
recognized auxiliary rows consume the same shared `maxPages` budget; needing
another page produces authenticated `INTEGRITY_LIMIT_EXCEEDED` evidence.

Every DynamoDB page is strongly consistent, every `LastEvaluatedKey` is
consumed exactly once, and reaching a ceiling with more data remaining is a
failure. S3 reads are pinned to the object key and immutable `VersionId`
obtained from strictly parsed File Proofing metadata.

The automated restore caller uses the same strict row normalizers and semantic
invariants through a durable page adapter. Each logical Scan step requests at
most 25 raw rows and, before returning, converts process-local identifiers into
domain-separated HMAC facts, uniqueness claims, Audit lifecycle candidates,
and deferred requirements. A response-loss retry may replay the same claims but
cannot silently replace a different origin. Exact `LastEvaluatedKey` values may
exist only as restricted operational resume state; raw rows and identifiers are
not persisted as semantic claims or copied into immutable evidence. The run
pins the exact Secrets Manager version of the Audit pseudonym key before its
first semantic page. Across all six isolated tables it accepts at most 10,000
raw pages, 1,000,000 retained opaque units, and 150,000 claims from one
normalized page. That claim ceiling covers the physical 1 MiB DynamoDB page:
at least 95 item bytes per canonical pending File version allows no more than
11,037 versions, each expands to at most 13 claims, and a page can add only four
stable external File failures. Requirement and Audit lifecycle reduction handle
at most 100 durable
records per logical step, and the latter chooses the latest current candidate
independently of Scan page order. The restore runtime may batch up to 50 eligible
logical verification steps in one Lambda invocation, subject to an eight-minute
elapsed-time guard. Once every page is exhausted, these bounded reducers produce
the secret-free cross-domain status. Any page, item, claim-capacity, execution
budget, or recovery-objective breach is a failed restore verification, never a
partial success. Generic Lambda, AWS service, KMS, or durable-state failures use
the separate non-integrity `WORKFLOW_TASK_FAILED` evidence code; they are not
reported as an observed cross-domain or File-copy mismatch.

Evidence contains only:

- schema and digest contract versions, dataset role, logical caller-supplied or
  live trusted-clock `checkedAt`, and configured bounds;
- safe aggregate counts, per-domain aggregate HMACs, sorted stable failure
  codes, and overall `pass` or `fail`;
- one shared logical-resource binding digest, a fixed seven-target vector of
  keyed physical-resource identities, and its keyed aggregate digest;
- a whole-result `resultMac` covering role, timestamp, bounds, status, failure
  codes, scope, resource digests, counts, and aggregate evidence.

Use a dedicated 32-byte HMAC key stored separately from evidence. Output is
published owner-only, without overwriting an existing path. Raw AWS errors,
resource names, profiles, table cursors, tenant identifiers, and individual
row/object digests are not serialized into the evidence or JSONL terminal
result. The existing Workspace Audit pseudonym key is likewise held only in
memory while member pseudonyms are joined and is never included in evidence.
The strict result parser rejects missing or unknown fields, unknown or
unsorted failure codes, and inconsistent status/counts. Consumers must also
call the MAC verifier, which rejects a failed `resultMac` or an aggregate that
does not agree with the authenticated domain vector.

Paired source and restore checks use the same key, `checkedAt`, bounds, and
logical binding. Every corresponding keyed physical-resource identity must
differ; changing only one restore resource cannot hide reuse of any other
protected source table or bucket.

The existing source/restore workflow remains logical: `--checked-at` is
operator supplied and no runtime provenance field is emitted. An explicit
Workspace Search rehearsal instead uses
`--observation-mode migration-rehearsal-live`, requires `--role source`, and
forbids `--checked-at`. A trusted wall clock is sampled immediately before the
checker bridge and exactly once more after all DynamoDB and exact-version S3
reads finish. The result sets `checkedAt` to that completion sample and adds
strict `runtimeProvenance` containing the start, completion, live-mode
discriminator, version, and trusted-clock source. Those fields are covered by
the whole-result HMAC; adding, removing, changing, or backdating provenance
without the result key invalidates the result.

## Operator boundary

`CrossDomainIntegrityOperatorPolicyArn` is an unattached stack output. An
environment owner must attach it only temporarily to a reviewed operator
principal used through a short-lived session, audit that attachment and
invocation, and remove the attachment immediately after the bounded check. It
allows only `dynamodb:Scan` on the six deployed application tables and the
exact-version S3 permissions needed for HEAD, object attributes, and tags under
`workspaces/*`. S3 authorizes an exact-version HEAD request with
`s3:GetObjectVersion`; that IAM action also technically permits downloading
the body of the named object version. The checker issues HEAD, attributes,
and tag requests only and never downloads object bodies, so the short-lived,
reviewed, and audited operator boundary is mandatory. A `s3:ListBucket` grant
is restricted to the exact file bucket and the `workspaces/*` prefix and is
present only so S3 can distinguish a missing key from denied access; the
checker does not issue list requests. The policy grants no restore, write,
delete, cleanup, application traffic, or runtime role permissions. The
automated restore does not attach this operator policy. Its dedicated runner
role is separately scoped to the six source-table PITR/export operations,
exact-version source File reads, isolated recovery-table prefix, and scratch
bucket required for copy/range verification; it has no source-table/object
write or delete permission and is not an application runtime role.

For a standalone check, the operator must select an explicit account, Region,
named credential profile,
dataset role, shared `checkedAt`, all six physical table names, the file
bucket, the existing Workspace Audit pseudonym-key file, a separate dedicated
evidence digest-key file, finite bounds, and a new evidence path.
The checker confirms the caller account with STS, sends that account as
`ExpectedBucketOwner` on every S3 request, and never discovers resources from
environment variables or broad account-wide listing.

For example:

```sh
bun server/scripts/data-integrity/verify-cross-domain-integrity.ts check \
  --role source \
  --checked-at 2026-07-31T00:00:00.000Z \
  --account 123456789012 \
  --region ap-northeast-1 \
  --profile reviewed-source \
  --table work-items=mukuroji-work-items \
  --table work-item-configuration=mukuroji-work-item-configuration \
  --table project-directory=mukuroji-project-directory \
  --table workspace-access=mukuroji-workspace-access \
  --table audit-events=mukuroji-audit-events \
  --table file-proofing=mukuroji-file-proofing \
  --bucket file=mukuroji-files \
  --page-size 100 \
  --max-pages 100 \
  --max-items 10000 \
  --maximum-duration-milliseconds 900000 \
  --audit-pseudonym-key-file /secure/workspace-audit-pseudonym.key \
  --digest-key-file /secure/cross-domain-integrity.key \
  --output /secure/source-integrity.json
```

For a live migration-rehearsal observation, use the same bounded explicit
resource/key arguments but replace `--checked-at ...` with:

```sh
--observation-mode migration-rehearsal-live
```

The live mode cannot be used with `--role restore`. Publication fails if the
checker omits or invokes the trusted completion seam more than once, returns a
different completion timestamp, or returns a logical result without the exact
authenticated live provenance.

Both key files must contain 64 lowercase hexadecimal characters and have no
group or other permission bits. The evidence digest key must be newly
dedicated to this checker and must not equal the Workspace Audit pseudonym
key. Run the restore check with the same `checkedAt`, bounds, Audit pseudonym
key, and evidence digest key, but isolated physical resources and a different
new output path. Both decoded keys are erased from invocation-owned buffers on
every success or failure path.

`--maximum-duration-milliseconds` is required and must be between 1 and
900,000. One non-resettable monotonic deadline covers key reads, STS,
DynamoDB, exact-version S3 requests, result generation, and exclusive durable
publication. Every AWS request receives the shared abort signal. Publication
starts only with at least 30 seconds of remaining headroom; a deadline crossed
during publication is a failure even when the exact artifact exists. A later
retry may accept only that byte-for-byte authenticated artifact and re-sync its
directory entry.

## Hook contract

Deploy, migration, and rehearsal code can call the exported full-result checker
with the same versioned request and read port used by the CLI. The isolated
restore drill instead uses the bounded normalized-page bridge and durable opaque
claim reducer described above, preserving the same invariant/failure-code
semantics without retaining a whole six-table normalized dataset in one Lambda
invocation. Other callers remain responsible for their own wiring. A caller
that consumes the exported full result must bind all of the following:

- checker schema/digest version, dataset role, `checkedAt`, and configured
  bounds;
- shared logical-resource binding, the fixed per-target keyed
  physical-resource identity vector, and its aggregate digest;
- per-domain and total aggregate HMACs, checked counts, and sorted failure
  codes;
- the authenticated whole-result `resultMac`.

Workspace Search rehearsal consumers additionally require a passing live
source result whose physical-resource identity digest equals the authenticated
permit/manifest digest. Rollback evidence requires the complete before check to
finish strictly before apply starts and the complete after check to finish
strictly after the authoritative rollback terminal. The exported opaque
preimage capability authenticates and retains the exact canonical file
`contentDigest`, byte length, result digest/MAC, completion `checkedAt`, runtime
provenance, aggregate digest, and resource-identity digest; it can be consumed
only once by the planning publication boundary.

In-process callers must also supply the existing 32-byte Workspace Audit
pseudonym key separately from the evidence digest key and erase both after the
call. The exported bridge rejects either key unless it is exactly 32 bytes and
rejects equal key material before its first AWS read. The pseudonym key is an
input for member joins, never an evidence field.

Consumers parse and authenticate each stored result before calling
`compareCrossDomainIntegrityResults` with the same in-memory key. The
comparison rejects different timestamps or bounds, a changed logical binding,
reused physical resource identity, failed source/restore checks, or any
per-domain aggregate difference. S3 `VersionId` values remain mandatory,
dataset-local inputs to every exact metadata/object/tag read and invariant, but
are normalized out of the paired File aggregate because an isolated S3 copy
receives new system-generated Version IDs. Every other raw File row attribute
and logical object observation remains comparison-bound.

The automated restore drill does not compare a live source scan with a
historical restore. It uses DynamoDB point-in-time exports at the admitted
restore point for exact row aggregates, then applies the incremental semantic
gate to the isolated six-table/S3 dataset. Exact File body equality is verified
separately by the restore runtime's 16 MiB range chain; the semantic gate checks
the normalized File metadata/object relationship. This avoids treating
legitimate writes after the restore point as corruption.

Changing any resource, role, bound, evaluation timestamp, or evidence version
requires a fresh check. A `fail` result, an unavailable checker, an
unsupported version, an invalid MAC, or missing evidence remains a hard gate
failure.
