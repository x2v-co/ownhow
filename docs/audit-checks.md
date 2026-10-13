# Mandatory artifact checks

The required list is `REQUIRED_CHECKS` in `src/audit-checks.js`. The Plugin and standalone governance Skills carry the same IDs in `required_checks`. Every live scanner projection attaches per-Skill `auditChecks`; the analyzer includes the checks in `requiredChecks` and merges their file findings into the existing finding list and severity groups. Checks apply within the analyzer's existing lifecycle/runtime scope. They do not change task routing or approval policy.

| ID | Required item | Finding severity |
|---|---|---|
| `python_bytecode` | Stale/mismatched Python bytecode | High |
| `cross_session_residue` | Cross-session file residue | Medium |

`pass` means no indicators in the inspected scope. `findings` means at least one indicator was found. `unknown` means evidence is incomplete and no finding was established. A check can have findings and limitations together: `unknownSkills` also counts those incomplete inspections. `passedSkills` and `findingSkills` summarize per-Skill results. Each check's `results` includes component IDs, status, inspected/finding counts and limitations so a read-only `analyze --json` exposes incomplete evidence without saving inventory. Empty inventories, old snapshots without check evidence and runtime-reported Skills without local files are unknown. Inspect a live installation for current evidence; `--cached` and `--fast` can retain older filesystem observations.

## Python bytecode

The checker visits `.pyc` artifacts independently of Skill discovery exclusions. It maps adjacent `module.pyc` to `module.py`, and tagged/optimized `__pycache__/module.cpython-313.opt-2.pyc` to the parent's `module.py`. Untagged cache files also map to source in the parent directory.

Findings identify missing/non-file source, malformed or truncated bytecode headers, invalid PEP 552 flags, timestamp/size mismatches and hash mismatches. Timestamp comparison uses whole seconds and unsigned 32-bit fields. Only the lowest two flag bits are accepted; flag value `2` uses timestamp validation, as in [CPython's loader](https://github.com/python/cpython/blob/3.13/Lib/importlib/_bootstrap_external.py). Legacy timestamp layouts are supported alongside the modern 16-byte header.

For both checked and unchecked PEP 552 caches, a fixed `python3 -I -S` helper hashes raw source bytes with `importlib.util.source_hash`. Python must be trusted and its magic number must match the artifact. An absent interpreter, timeout or different bytecode version produces a limitation rather than a mismatch or pass. The checker never imports or executes the source or bytecode, and does not deserialize the bytecode body.

This is header/source consistency checking. An attacker can substitute a body and forge matching header metadata; same-size edits with preserved timestamps also evade timestamp-only validation. A matching header therefore does not prove behavioral equivalence. Trusted compilation and body comparison are separate review work. The motivating [PyCache Trap paper, arXiv:2610.10612](https://arxiv.org/abs/2610.10612) describes the inspection/execution gap and stronger artifact reproduction.

## Cross-session residue

The checker reports candidates based on file locations and declarations, without inventing session history:

- Temporary, cache, output, log and state artifacts inside the Skill, including files under `tmp`, `.cache`, `__pycache__`, `outputs`, `build`, `state` and `sessions`, common temporary/cache suffixes and state filenames.
- Declared writes whose canonical targets escape the Skill directory, including writes through existing symlinked ancestors and outputs that do not yet exist. Findings distinguish existing artifacts from planned persistence surfaces with `exists` and `kind`.
- Existing declared internal output targets, and existing declared inputs outside the Skill or in a declared writable location. This includes reads under a declared writable directory.

Each finding retains `provenance: unknown`. Legitimate caches and outputs can trigger this check. Verify the producing session, intended reader, data boundaries and cleanup/isolation policy before reuse. The check does not delete files or create a new approval rule. The motivating [cross-session artifact paper, arXiv:2610.13227](https://arxiv.org/abs/2610.13227) explains how persistent artifacts can propagate instructions, cross data boundaries or poison evidence.

External inspection uses only declared `reads` and `writes`; it stats the exact target and resolves its location without reading external contents or walking external directories. Relative paths resolve against the Skill directory. Absolute paths, `~/`, `$HOME`, `$CWD`, `$WORKSPACE` and `$SKILL_DIR` are supported; braced forms such as `${HOME}` also work. `CWD`/`WORKSPACE` refer to the scan's working directory. For example:

```yaml
reads: ['$HOME/.cache/example/state.json', '$WORKSPACE/outputs/result.json']
writes: ['$HOME/.cache/example/state.json', '$WORKSPACE/outputs/result.json']
```

Globs, unknown variables and abstract labels such as `source-code` remain unresolved limitations. Static file inspection cannot establish who created a file, detect every arbitrary residue filename or infer undeclared script effects. Review scripts and session boundary file manifests when available to cover dynamically computed paths, shared home/workspace residue and persisted state outside declared targets.

## Inspection boundaries

Artifact traversal skips `.git` metadata, does not follow internal symlinks or special files, and stops at 10,000 entries or depth 32. Unreadable directories, skipped files and reached limits remain visible limitations in both checks. Python source hashing is limited to 8 MiB and a five-second helper timeout. Source symlinks or source paths resolving outside the Skill are unverified. Scans are filesystem observations, not atomic snapshots; concurrent modification requires another live inspection.

`scan` saves check evidence with the inventory. `analyze` is live by default and reports it without saving inventory, Receipt or Method state; explicitly enabled telemetry can still append its aggregate event. Findings and local inventory may contain private paths. Existing telemetry sanitization excludes these details.
