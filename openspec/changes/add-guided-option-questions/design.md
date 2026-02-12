## Context

OpenSpec command flows currently depend on users supplying an exact change name up front. When input is missing or ambiguous, progress stalls and users need to guess valid names. This change adds a guided selection step that presents recent changes with concise metadata, then captures an explicit selection before continuing artifact work.

The proposal defines one new capability (`guided-option-questions`) focused on command ergonomics and reliability. The immediate target is `/opsx-continue`, but the pattern should be reusable by other commands that require a change name.

## Goals / Non-Goals

**Goals:**

- Provide a consistent resolver for missing or ambiguous change-name input.
- Show a ranked list (top 3-4 by recency) with schema, status, and last-modified context.
- Mark the most recently modified change as recommended while still requiring explicit user choice.
- Return a validated canonical change name so downstream steps (`status`, `instructions`, artifact creation) can proceed immediately.

**Non-Goals:**

- Changing artifact sequencing or schema semantics.
- Implementing auto-selection without user confirmation.
- Redesigning all command UX text beyond what is needed for guided selection.

## Decisions

1. Introduce a reusable change-selection preflight step.
   - Rationale: Multiple commands need the same behavior; centralizing prevents drift and reduces duplicated prompt logic.
   - Alternatives considered:
     - Per-command custom prompting: rejected due to inconsistent behavior and maintenance overhead.
     - Strict failure on missing name: rejected because it preserves current friction.

2. Use `openspec list --json` as the source of candidate changes.
   - Rationale: It is authoritative, machine-readable, and already includes recency and task metadata.
   - Alternatives considered:
     - Filesystem scanning under `openspec/changes`: rejected because it bypasses CLI-level filtering and status shaping.

3. Normalize option display metadata with deterministic fallbacks.
   - Rationale: Some list payloads may omit fields (for example, schema). The UI should still remain clear.
   - Implementation choice:
     - Schema: `schema` if present, else `spec-driven`.
     - Status: derive from status field when available, otherwise from task counts (`X/Y tasks`) or `no tasks`.
     - Recency: render from `lastModified` in a human-friendly relative form when possible.

4. Enforce explicit selection and canonical mapping.
   - Rationale: The flow requires user intent, and downstream commands need the raw change name.
   - Implementation choice: bind each option to its exact `name` and resolve from structured selection output rather than parsing display text.
   - Alternatives considered:
     - Auto-picking the first result: rejected by requirement.

## Risks / Trade-offs

- [Inconsistent metadata across CLI versions] -> Use fallback rendering rules and keep required fields minimal.
- [Option labels may become long for verbose change names] -> Keep option label primarily as the name and move details into descriptions.
- [Custom free-text replies could bypass constrained options] -> Validate returned value against known candidate names and reprompt when invalid.
- [No available changes to select] -> Short-circuit with a clear message and suggest creating a new change.

## Migration Plan

1. Add the reusable preflight selection helper.
2. Integrate it into `/opsx-continue` before status/instructions calls.
3. Validate scenarios: single change, multiple changes, missing schema metadata, no changes.
4. Extend the helper to other commands that require change-name disambiguation.

Rollback strategy: remove helper integration points and return to direct name-only input handling.

## Open Questions

- Should recency be shown as relative time only, absolute timestamp only, or both?
- Should commands show all available changes on demand (for example, a "show more" path) beyond the initial top 3-4?
- Should manual free-text input remain available when options are presented, or should selection be strictly constrained?
