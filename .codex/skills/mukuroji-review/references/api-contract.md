# API and contract compatibility review

Review HTTP and shared TypeScript contracts as externally consumed behavior.

Check:

- Request validation starts from `unknown`; path, query, header, and body parsing is
  explicit and rejects malformed or ambiguous input.
- Canonical `/api` paths and Lambda Function URL normalization remain compatible.
- Existing request/response JSON shapes, required/optional fields, enum values,
  stable error codes, and HTTP status mappings remain compatible unless the selected
  intent source explicitly changes them.
- Authentication context and authorization are derived server-side, not from DTOs.
- Cursors are opaque, scope-bound, stable, and correctly paginated; physical keys and
  AWS response shapes never cross the API boundary.
- Contract declarations are owned by the correct domain and consumers use the public
  package entrypoint without duplicate types.
- Public API, SDK, webhook, import/export, and event schema changes have a migration
  or versioning strategy and tests for old clients where required.

Flag a compatibility issue when an existing consumer can fail, misinterpret a
successful response, or bypass a validation/authorization rule.
