export function renderProjectGlossaryTemplate(): string {
  return `# Glossary

This file is the project source of truth for abbreviations allowed in durable comments and documentation.

Edit this table when the project needs to add, remove, or clarify an allowed abbreviation.

| Abbreviation | Full Term | Meaning / Allowed Use |
| --- | --- | --- |
| AI | Artificial Intelligence | AI-assisted roles, tooling, or workflows. |
| API | Application Programming Interface | Public, module-to-module, or integration-facing callable contract. |
| CLI | Command Line Interface | Command-line tool or command surface. |
| E2E | End-to-End | Whole-flow validation from user or external entry point. |
| ID | Identifier | Stable identity value. |
| IO | Input/Output | File, network, or process input/output boundaries. |
| JSON | JavaScript Object Notation | JSON data, files, or payloads. |
| KI | Known Issue | Durable known-issue entry or its \`KI-<n>\` identifier in \`docs/known-issues.md\`. |
| L0 | Level 0 | VCM fast validation level. |
| L1 | Level 1 | VCM baseline implementation validation level. |
| L2 | Level 2 | VCM module or integration validation level. |
| L3 | Level 3 | VCM smoke end-to-end validation level. |
| L4 | Level 4 | VCM full regression or release validation level. |
| PM | Project Manager | The VCM project-manager role and routing hub. |
| PR | Pull Request | GitHub pull request or equivalent code review request. |
| TODO | To Do | Deferred-work code comment marker. |
| UI | User Interface | User-facing interface behavior, flows, or components. |
| UTC | Coordinated Universal Time | UTC timestamps in filenames and reports. |
| VCM | VibeCodingMaster | VCM-managed harness, workflow, task, role, or runtime concept. |
`;
}
