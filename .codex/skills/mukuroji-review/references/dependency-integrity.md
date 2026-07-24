# Dependency and artifact integrity review

Review dependency metadata and non-source artifacts without executing target-controlled
content. Establish what changed, where it came from, and whether consumers can verify
and reproduce it.

## Manifests and lockfiles

Check:

- Manifest and lockfile changes agree, with no unexplained package, version, feature,
  registry, URL, git source, checksum, or transitive-resolution change.
- Integrity hashes, resolved URLs, package identities, workspace links, and platform
  variants are present and consistent with the repository's package manager.
- New or changed install, prepare, postinstall, build, lifecycle, or download scripts
  are treated as executable code and reviewed in full.
- Native code, prebuilt addons, optional dependencies, platform-specific packages,
  and bundled executables have a justified need, supported platforms, and verifiable
  provenance.

## Artifacts and repository metadata

Check:

- Added or changed binaries have recorded hashes, trusted provenance, expected file
  type and architecture, a reviewable build source, and an update process.
- Symlink targets are intentional, remain inside the allowed repository or package
  boundary, and do not redirect tools to secrets or host-controlled paths.
- Gitlinks identify the intended repository and pinned commit; the commit is
  reviewable, reachable from trusted provenance, and not silently moved.
- File-mode changes do not unexpectedly add executable bits, remove required
  protections, or alter how CI, packaging, deployment, or hooks execute a file.
- Generated files map to identified source inputs, generator name and version, and a
  reproducible procedure. Review the source change and generated delta together; do
  not accept a generated label as proof that content is safe.

## Supply-chain risks

Check for dependency confusion, typosquatting, untrusted registries or git hosts,
mutable tags or branches, missing integrity data, compromised maintainer or package
transfers, unexpected install-time network access, and artifacts that bypass normal
source review. Require evidence proportionate to whether the artifact executes during
installation, CI, build, deployment, or application runtime.

## Review safety

Do not install dependencies, run package-manager resolution, execute lifecycle
scripts, load native code, run binaries, invoke generators, build artifacts, fetch
remote content, or follow symlinks during review. Use only supplied manifests,
lockfiles, pinned blobs, hashes, provenance records, and sanitized source evidence.
If required provenance, generator inputs, binary identity, gitlink content, or
resolution evidence is unavailable, report the omission and mark the perspective
`INCOMPLETE`.
