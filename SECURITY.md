# Security Policy

## Reporting

Report security issues privately through GitHub Security Advisories for `x2v-co/ownhow`. Do not open a public issue for a vulnerability or attach private method data to a report.

## Sensitive Local Data

OwnHow stores local state under `~/.ownhow` by default. Inventories, receipts, corrections, proposals, and Personal Methods may reveal private workflows, filesystem paths, installed capabilities, or organizational practices.

Do not commit or upload:

- `~/.ownhow` or another OwnHow state directory;
- real Plugin or Skill inventories;
- receipts, corrections, proposals, or Personal Methods;
- credentials, tokens, private Skill content, or execution traces.

Use synthetic fixtures and an isolated `--state` directory when reproducing an issue. Review all generated output before sharing it.

## Trust Boundary

OwnHow treats scanned Plugin and Skill content as untrusted data. Reports derived from static text are signals, not proof that a component performed an action. The CLI does not install, disable, delete, or modify scanned components.
