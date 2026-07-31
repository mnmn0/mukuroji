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
  current row, while delete, archive, backfill, and other historical events
  are not treated as corruption only because their resource is no longer
  live; canonical Workspace member Audit pseudonyms are joined to Workspace
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

Restore automation must supply isolated resources and combine this result with
its restore-point, RPO/RTO, descriptor, S3-copy, and cleanup evidence.
Migration rehearsal must supply its own writer-fence and checkpoint provenance.
Neither caller may convert an incomplete or failed checker result into a
successful terminal receipt. This issue provides the callable contract; wiring
it into each restore, migration, or deployment workflow remains caller-owned.

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

Evidence contains only:

- schema and digest contract versions, dataset role, the caller-supplied
  `checkedAt`, and configured bounds;
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

## Operator boundary

`CrossDomainIntegrityOperatorPolicyArn` is an unattached stack output. An
environment owner may attach it temporarily to a reviewed operator principal.
It allows only `dynamodb:Scan` on the six deployed application tables and the
exact-version S3 permissions needed for HEAD, object attributes, and tags
under `workspaces/*`. A `s3:ListBucket` grant is restricted to the exact file
bucket and is present only so S3 can distinguish a missing key from denied
access; the checker does not issue list requests or read object bodies. The
policy grants no restore, write, delete, cleanup, application traffic, or
runtime role permissions. Restore automation must create an equivalently
narrow temporary policy for its separately named isolated resources.

The operator must select explicit account, Region, named credential profile,
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
  --audit-pseudonym-key-file /secure/workspace-audit-pseudonym.key \
  --digest-key-file /secure/cross-domain-integrity.key \
  --output /secure/source-integrity.json
```

Both key files must contain 64 lowercase hexadecimal characters and have no
group or other permission bits. The evidence digest key must be newly
dedicated to this checker and must not equal the Workspace Audit pseudonym
key. Run the restore check with the same `checkedAt`, bounds, Audit pseudonym
key, and evidence digest key, but isolated physical resources and a different
new output path. Both decoded keys are erased from invocation-owned buffers on
every success or failure path.

## Hook contract

Deploy, migration, restore, and rehearsal code can call the exported checker
with the same versioned request and read port used by the CLI. These callers
are not wired by this issue; once integrated, a terminal caller must bind all
of the following from the result:

- checker schema/digest version, dataset role, `checkedAt`, and configured
  bounds;
- shared logical-resource binding, the fixed per-target keyed
  physical-resource identity vector, and its aggregate digest;
- per-domain and total aggregate HMACs, checked counts, and sorted failure
  codes;
- the authenticated whole-result `resultMac`.

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

Changing any resource, role, bound, evaluation timestamp, or evidence version
requires a fresh check. A `fail` result, an unavailable checker, an
unsupported version, an invalid MAC, or missing evidence remains a hard gate
failure.
