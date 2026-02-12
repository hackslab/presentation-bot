## ADDED Requirements

### Requirement: Prompt with ranked change options

When a command requires a change name and the input is missing or ambiguous, the system MUST present a ranked option question containing the most recently modified available changes.

#### Scenario: Missing change name prompts ranked choices

- **WHEN** a user invokes a command that requires a change name without providing one
- **THEN** the system presents a constrained option list ordered by most recently modified changes
- **THEN** each option includes the change name, schema, current status, and recency metadata
- **THEN** the most recently modified option is labeled as recommended

### Requirement: Require explicit change selection

The system MUST require an explicit user selection from the presented options and MUST NOT auto-select a change when multiple candidates are available.

#### Scenario: Multiple candidates require explicit selection

- **WHEN** more than one change candidate is available for selection
- **THEN** the system waits for a user choice before continuing
- **THEN** the system does not infer or auto-select a change

### Requirement: Continue workflow after selection

After a user selects a change through the guided option question, the command workflow SHALL continue artifact processing for the selected change without restarting the command.

#### Scenario: Selected change proceeds to artifact handling

- **WHEN** a user selects a change from the guided options
- **THEN** the command resolves status and proceeds to the next artifact action for that selected change in the same invocation
