import { describe, expect, it } from "vitest";
import { findPmUserQuestion } from "../../../src/backend/services/pm-user-question.js";

describe("findPmUserQuestion", () => {
  it.each([
    'The architect must answer "is this the same defect?" before the plan lands.',
    '| absent-unreadable | ok | 20 `?` samples recorded |',
    '## So: can this be completed?',
    'See https://example.com/x?tab=readme for the upstream note.',
    'No question was asked of the user; the only question mark sits in reported speech - "does wiring close it?".',
    'The Tester was instructed: "Please confirm the observed behavior."',
    'The Tester was instructed: "Please confirm\nthe observed behavior?"',
    'The Tester was instructed to\nconfirm the observed behavior.',
    '`Please provide the input` is the example placeholder.',
    'The Architect must decide whether to ask you for confirmation.',
    'The user previously asked “Which option do you want, A or B?” and chose B.',
    "The Architect asked 'Should I continue with option A?' in an earlier report.",
    '架构师的问题是「你是否确认？」；这个问题已解决。',
    'Tester 的检查清单写着：请确认测试覆盖。',
    'The old question was deferred, not asked: Which option do you want, A or B?',
    'No question was asked. The last response quoted `Please give your decision`.',
    'I do not need your confirmation; work is proceeding.',
    'The Architect is working on the plan.',
    '```text\nPlease confirm the choice?\n```',
    '~~~text\nWhich option do you want?\n~~~',
    '    Please confirm the choice?',
    '> Please confirm the choice?\n\nThat quotation is test evidence.',
    '~~Please confirm the old choice?~~',
    '[upstream note](https://example.com/x?please=confirm)',
    '<https://example.com/x?tab=readme>',
    '[https://example.com/x?tab=readme](https://example.com/x?tab=readme)',
    '![Please confirm the choice?](screenshot.png)',
    '| Result | Evidence |\n| --- | --- |\n| pass | `?` samples recorded |',
    '| Result | Evidence |\n| --- | --- |\n| pass | "Please provide input" is the fixture |',
    'No decision is pending.[^old]\n\n[^old]: Please confirm the old choice?'
  ])("does not interpret reported text or data as a user question: %s", (message) => {
    expect(findPmUserQuestion(message)).toBeUndefined();
  });

  it.each([
    'Which option do you want, A or B?',
    'Which option do\nyou want, A or B?',
    'Should I continue with option A?',
    'Which behavior should be authoritative?',
    'What is your preferred behavior?',
    'How should we proceed?',
    'Can you confirm the expected behavior',
    'Please give your decision on option A or option B.',
    'I need your confirmation before continuing.',
    'Your decision is required before continuing.',
    'Waiting for your answer.',
    'Let me know which option to use.',
    'The implementation is ready. Could you confirm the behavior?',
    'Before we continue, could you confirm the behavior?',
    'Question for you: which option do you want?',
    '请给出下一步选择。',
    '等待您的确认后继续。',
    '请您确认最终行为。',
    '你是否接受这个结果？',
    '问题：请确认最终行为。',
    '验证已完成。请确认下一步。',
    '## Which option do you want?',
    '1. **Please confirm** the choice.',
    '- [ ] Please confirm the choice.',
    '| Topic | User decision |\n| --- | --- |\n| behavior | Which option do you want? |',
    '| Topic | User decision |\n| --- | --- |\n| behavior | 请给出下一步选择。 |',
    'Please confirm whether "is this the same defect?" belongs in the report.',
    'Should I use `optionA`?',
    'Please confirm:\n\n> Should we keep the current behavior?',
    '[Please confirm the choice](https://example.com/x?tab=readme).',
    '```text\nWhich option do you want?\n```\n\nPlease confirm the actual behavior.'
  ])("identifies a direct question or request even when formatted: %s", (message) => {
    expect(findPmUserQuestion(message)).toBeTruthy();
  });

  it("returns the matched request instead of a long preceding report", () => {
    expect(findPmUserQuestion(`${'The gate is running. '.repeat(100)}**Please confirm** the expected behavior.`))
      .toBe('Please confirm the expected behavior.');
  });
});
