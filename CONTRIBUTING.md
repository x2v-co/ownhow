# Contributing to OwnHow

OwnHow is an early local-first MVP. Keep contributions focused on reproducible method-governance problems and preserve the user's ownership of local data.

## Before opening a change

- Search existing issues and describe the real task that exposed the problem.
- Use synthetic Plugins, Skills, receipts, and corrections. Never attach private user or company data.
- Prefer deterministic evidence and explicit uncertainty over inferred conflicts.
- Do not add cloud accounts, hosted registries, team controls, or additional agent adapters without an accepted design issue.

## Development

```bash
npm install
npm run verify
npm pack --dry-run
```

Add a focused test for behavioral changes. Personal Method application must remain explicit and must not modify an installed Plugin or Skill.

By submitting a contribution, you agree that it is licensed under Apache-2.0.
