## 1. Preflight Change Selection

- [ ] 1.1 Add a reusable helper that resolves required change-name input and detects missing or ambiguous cases.
- [ ] 1.2 Load candidates from `openspec list --json` and rank by `lastModified` descending.
- [ ] 1.3 Limit prompt options to the top 3-4 most recently modified changes.
- [ ] 1.4 Render fallback metadata for each option (`schema` -> `spec-driven`, derived status, recency text).
- [ ] 1.5 Handle the no-change case with a clear message and stop further artifact processing.

## 2. Explicit Selection Flow

- [ ] 2.1 Present a constrained option question and mark the most recent change as `(Recommended)`.
- [ ] 2.2 Map options to canonical change names and resolve selection from structured answer data.
- [ ] 2.3 Validate user responses against known candidates and re-prompt or fail gracefully when invalid.
- [ ] 2.4 Enforce no auto-selection when multiple candidates exist.

## 3. Continue Command Integration

- [ ] 3.1 Integrate the preflight helper into `/opsx-continue` before `openspec status` and `openspec instructions` calls.
- [ ] 3.2 Continue the workflow in the same invocation after selection, using the selected canonical change name.
- [ ] 3.3 Preserve existing behavior when a valid change name is supplied explicitly.

## 4. Verification

- [ ] 4.1 Add or update tests for missing-name, multiple-candidate, and explicit-name `/opsx-continue` flows.
- [ ] 4.2 Validate option ordering, metadata display, and recommended-label behavior.
- [ ] 4.3 Run manual checks for single change, missing schema metadata, and no available changes.
