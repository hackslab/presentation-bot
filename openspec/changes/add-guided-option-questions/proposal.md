## Why

The current command flow expects users to provide exact change names, which slows progress when they are unsure what is available. We need a guided selection step so users can quickly choose from recent changes with clear context.

## What Changes

- Add a guided option-question pattern for OpenSpec commands when required input is missing or ambiguous.
- Show a short, ranked list of recent changes with useful metadata (schema, status, and recency) and a recommended default.
- Require explicit user selection instead of auto-choosing a change when multiple candidates exist.
- Standardize command behavior so follow-up artifact creation can proceed immediately after selection.

## Capabilities

### New Capabilities

- `guided-option-questions`: Interactive command prompts that present constrained choices with recommendation labels and capture explicit user selections.

### Modified Capabilities

- None.

## Impact

- Affects OpenSpec command workflows that currently rely on free-form change-name input.
- Improves reliability of `/opsx-continue` and similar commands by reducing ambiguous input handling.
- Requires updates to command templates or execution logic where change selection is performed.
