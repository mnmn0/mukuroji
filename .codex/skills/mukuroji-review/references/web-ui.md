# Web UI and accessibility review

Review user-visible behavior and the boundaries between route containers, queries,
mutations, models, and pure UI.

Check:

- URL/deep-link mapping, browser back/forward, selection, filters, and navigation
  remain stable.
- Loading, empty, error, retry, stale, optimistic, and mutation-refresh states are
  explicit and do not display data from the wrong scope.
- SWR/cache ownership is preserved; no page or pure view adds direct fetch/SWR use
  contrary to the Web guide.
- Forms validate and normalize consistently, destructive actions require the
  intended confirmation, and one-time secrets are not re-shown or logged.
- Keyboard navigation, focus restoration, focus trap, labels, roles, error messages,
  contrast, reduced motion, and screen-reader announcements work for changed flows.
- Responsive and mobile interaction, touch target size, slow network, and offline or
  reconnect behavior are handled when the selected intent source requires them.
- Existing test IDs, locale keys, Storybook stories, and important error text remain
  compatible when the selected intent source says behavior is preserved.

Prefer a finding with a reproducible interaction or user impact over subjective
visual taste.
