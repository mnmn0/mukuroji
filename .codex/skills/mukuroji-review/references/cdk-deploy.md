# CDK and deployment-safety review

Treat synthesized CloudFormation as the deployed contract. Review source and synth
output together for every infrastructure change.

Check:

- Existing logical IDs, physical names, exports, parameters, and dependencies remain
  stable unless an explicit migration plan exists.
- Stateful resources do not receive unintended replacement, deletion, data-loss,
  retention, PITR, encryption, or versioning changes.
- IAM actions, resources, principals, trust policies, bucket policies, and network
  access are least-privilege and scoped to the owning resource.
- Secrets and PII do not enter source, context, synthesized templates, environment
  variables, logs, or outputs in plaintext.
- Stage/account/region configuration fails fast for unknown or incomplete values and
  does not silently fall back to an unsafe environment.
- Lambda/event source retry, timeout, batch failure, DLQ, log retention, alarm, and
  permission behavior match the runtime contract.
- Builder/Construct extraction preserves scope and stable Construct IDs, and public
  Props expose only typed references actually needed by consumers.
- Tests assert important security and replacement properties semantically, not only
  through a broad snapshot.

Prefer inspecting a pre-generated CloudFormation template and its diff. Do not run
`cdk synth` by default during review because it can create `cdk.out` and perform
context lookups. If the user explicitly authorizes synthesis, use a disposable copy
with generated output outside the worktree, no AWS credentials, and context lookups
disabled; never deploy, destroy, bootstrap, or modify an AWS account during review.
