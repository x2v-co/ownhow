# OwnHow v0.9.0

OwnHow v0.9.0 adds mandatory artifact checks to every live `analyze` run and
hardens CI.

## Highlights

- Added the mandatory `python_bytecode` check: orphan `.pyc` files (including
  `__pycache__`) and embedded source mtime/size or PEP 552 hash mismatches are
  reported, because bytecode can carry behavior that differs from reviewed
  source.
- Added the mandatory `cross_session_residue` check: temp files, caches,
  outputs and state inside a Skill, declared writes outside it, and shared or
  writable state declared as input are reported as persistence surfaces.
- `analyze --json` now reports `requiredChecks` coverage and per-Skill results
  with limitations; full evidence lives in inventory `auditChecks`.
  See [audit check definitions and limits](audit-checks.md).
- CI installs dependencies with `npm ci --ignore-scripts`.
- Package and plugin metadata now point to the GitHub repository.

## Behavior changes

- The checks never execute scanned code or remove files. Source-hash
  verification runs a fixed helper with `python3 -I -S`.
- Old snapshots and unavailable evidence remain `unknown`; run a live scan for
  an audit.

## Upgrade

```sh
npm install --global github:x2v-co/ownhow#v0.9.0
```
