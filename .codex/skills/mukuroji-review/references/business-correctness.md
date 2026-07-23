# Business correctness review

Trace the changed use case from input through authorization, domain rules,
persistence, events, and response. Confirm that state transitions and invariants are
preserved on both success and failure paths.

Check:

- Required fields, defaults, allowed values, and cross-field validation.
- State transition rules, terminal states, self/duplicate/cycle rejection, and
  revision checks.
- Empty, maximum, duplicate, stale, deleted, deactivated, and partially configured
  records.
- Timezone, date boundary, DST, currency, rounding, pagination, and ordering rules
  when relevant.
- Whether a failure can leave a visible partial mutation, event, notification,
  projection, receipt, or audit record.
- Whether the response reflects the committed state and stable error category/code.

Do not infer product behavior from naming alone. Use the Issue, nearby domain code,
docs, existing tests, and contracts as evidence.
