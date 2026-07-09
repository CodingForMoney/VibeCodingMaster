export function renderPullRequestTemplateHarnessRules(): string {
  return `## Summary

## Validation

- Commands run or checked:
- Result:

## Review

- Test result:
- Final acceptance:

## Docs

- Durable docs updated or confirmed unchanged:
- Known issues disposition:

## Risks

## Checklist

- [ ] Final acceptance completed.
- [ ] Tester validation completed.
- [ ] Durable docs updated or confirmed unchanged.
- [ ] Known issues resolved or recorded.
- [ ] No uncommitted changes remain.
`;
}
