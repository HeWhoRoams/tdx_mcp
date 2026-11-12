## What changed

<!-- A short description. Link the issue if there is one. -->

## Checklist

- [ ] `npm run build`, `npm test` and `npm run check:sensitive` pass locally
- [ ] No tenant URLs, email addresses, application names, ticket contents or tokens appear in code, fixtures, docs, logs or this description (use `example`, `yourorg` and `user@example.com` placeholders)
- [ ] Tool counts and area lists in `AGENTS.md` and the README are updated if tools were added or removed
- [ ] If a tool was renamed or merged, `LEGACY_TOOL_ALIASES` is updated and the major version bumped
- [ ] If the change relies on how TeamDynamix behaves (a filter, a field name, a limit), `npm run test:contract` was run against a sandbox, or the assumption is called out in this description
