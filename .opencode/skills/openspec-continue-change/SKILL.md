---
name: openspec-continue-change
description: Continue working on an OpenSpec change by creating the next artifact. Use when the user wants to progress their change, create the next artifact, or continue their workflow.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.1.1"
---

Continue working on a change by creating the next artifact.

**Input**: Optionally specify a change name. If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **Resolve required change name (reusable preflight helper)**

   Before running `openspec status` or `openspec instructions`, resolve a canonical change name with a reusable helper routine.

   Helper behavior:
   - If a valid change name was provided explicitly, preserve existing behavior: use that canonical name and skip selection prompts.
   - Otherwise, infer from conversation context only when exactly one change is clearly referenced.
   - If input is missing or ambiguous, run `openspec list --json` and parse candidates.
   - Rank candidates by `lastModified` descending (most recent first).
   - If no candidates exist, show a clear stop message and suggest creating a change with `/opsx-new`.
   - If exactly one candidate exists, select it and continue.
   - If multiple candidates exist:
     - Limit options to the top 3-4 most recently modified changes.
     - Render metadata with deterministic fallbacks:
       - Schema: `schema` field when present, otherwise `spec-driven`.
       - Status: `status` field when present; otherwise derive from task counts (`<completedTasks>/<totalTasks> tasks`) or `no tasks`.
       - Recency: human-friendly relative time from `lastModified` when possible, otherwise `unknown recency`.
     - Use the **AskUserQuestion tool** with constrained options and label the most recent option as `(Recommended)`.
     - Keep an option-to-canonical-name mapping and resolve the user answer from structured selection data, not by parsing display text.
     - Validate the returned selection against known candidates; re-prompt once (or fail gracefully) if invalid.
     - **Do NOT auto-select** when multiple candidates exist.

   After resolution, always announce:
   - `Using change: <name>`
   - `Override with: /opsx-continue <other-change>`

2. **Check current status**

   ```bash
   openspec status --change "<name>" --json
   ```

   Parse the JSON to understand current state. The response includes:
   - `schemaName`: The workflow schema being used (e.g., "spec-driven")
   - `artifacts`: Array of artifacts with their status ("done", "ready", "blocked")
   - `isComplete`: Boolean indicating if all artifacts are complete

3. **Act based on status**:

   ***

   **If all artifacts are complete (`isComplete: true`)**:
   - Congratulate the user
   - Show final status including the schema used
   - Suggest: "All artifacts created! You can now implement this change or archive it."
   - STOP

   ***

   **If artifacts are ready to create** (status shows artifacts with `status: "ready"`):
   - Pick the FIRST artifact with `status: "ready"` from the status output
   - Get its instructions:
     ```bash
     openspec instructions <artifact-id> --change "<name>" --json
     ```
   - Parse the JSON. The key fields are:
     - `context`: Project background (constraints for you - do NOT include in output)
     - `rules`: Artifact-specific rules (constraints for you - do NOT include in output)
     - `template`: The structure to use for your output file
     - `instruction`: Schema-specific guidance
     - `outputPath`: Where to write the artifact
     - `dependencies`: Completed artifacts to read for context
   - **Create the artifact file**:
     - Read any completed dependency files for context
     - Use `template` as the structure - fill in its sections
     - Apply `context` and `rules` as constraints when writing - but do NOT copy them into the file
     - Write to the output path specified in instructions
   - Show what was created and what's now unlocked
   - STOP after creating ONE artifact

   ***

   **If no artifacts are ready (all blocked)**:
   - This shouldn't happen with a valid schema
   - Show status and suggest checking for issues

4. **After creating an artifact, show progress**
   ```bash
   openspec status --change "<name>"
   ```

**Output**

After each invocation, show:

- Which artifact was created
- Schema workflow being used
- Current progress (N/M complete)
- What artifacts are now unlocked
- Prompt: "Want to continue? Just ask me to continue or tell me what to do next."

**Artifact Creation Guidelines**

The artifact types and their purpose depend on the schema. Use the `instruction` field from the instructions output to understand what to create.

Common artifact patterns:

**spec-driven schema** (proposal → specs → design → tasks):

- **proposal.md**: Ask user about the change if not clear. Fill in Why, What Changes, Capabilities, Impact.
  - The Capabilities section is critical - each capability listed will need a spec file.
- **specs/<capability>/spec.md**: Create one spec per capability listed in the proposal's Capabilities section (use the capability name, not the change name).
- **design.md**: Document technical decisions, architecture, and implementation approach.
- **tasks.md**: Break down implementation into checkboxed tasks.

For other schemas, follow the `instruction` field from the CLI output.

**Guardrails**

- Create ONE artifact per invocation
- Always read dependency artifacts before creating a new one
- Never skip artifacts or create out of order
- If context is unclear, ask the user before creating
- Verify the artifact file exists after writing before marking progress
- Use the schema's artifact sequence, don't assume specific artifact names
- **IMPORTANT**: `context` and `rules` are constraints for YOU, not content for the file
  - Do NOT copy `<context>`, `<rules>`, `<project_context>` blocks into the artifact
  - These guide what you write, but should never appear in the output

**Verification Checklist**

- Missing-name flow with multiple candidates: prompt top 3-4 options in descending recency, include metadata, and mark most recent `(Recommended)`.
- Explicit-name flow: skip selection prompt and proceed directly to `openspec status`/`openspec instructions`.
- Invalid selection flow: detect unmapped answer, re-prompt or fail gracefully without continuing.
- Single-candidate flow: continue in the same invocation using the canonical selected name.
- Metadata fallback checks: schema defaults to `spec-driven`, status derives from task fields when needed, recency falls back when missing.
- No-change flow: show a clear no-available-changes message and stop artifact processing.
