# Issue fit review

Use the GitHub Issue as the acceptance contract when one exists. Otherwise use the
user's request or PR description and explicitly record that fallback. Compare the
implementation and tests with the background, task list, completion criteria,
dependencies, and explicitly named compatibility requirements.

Check:

- Every completion criterion has an implementation or a deliberate, documented
  reason it is out of scope.
- The change solves the stated problem rather than only moving code or changing
  names.
- Existing behavior called out as preserved remains preserved, including routes,
  response shapes, navigation, security UX, and migration compatibility.
- Issue dependencies are actually satisfied at the current base revision.
- The change does not silently introduce a second source of truth, duplicate model,
  or new public API contrary to the Issue.
- Tests demonstrate the acceptance criteria, not only internal helper behavior.

Treat an unimplemented completion criterion as P1 when it makes the requested change
incomplete or unsafe to merge. Treat a minor omission as P2 only when the remaining
behavior is still usable and the impact is bounded. If no intent source is available,
do not invent requirements; report the missing acceptance contract as a limitation.
