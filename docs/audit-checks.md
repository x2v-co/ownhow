# Mandatory artifact checks

The required list is `REQUIRED_CHECKS` in `src/audit-checks.js`. The Plugin and standalone governance Skills carry the same IDs in `required_checks`. Every live scanner projection attaches per-Skill `auditChecks`; the analyzer includes the checks in `requiredChecks` and merges their file findings into the existing finding list and severity groups. Checks apply within the analyzer's existing lifecycle/runtime scope. They do not change task routing or approval policy. Permission checks can optionally change the `analyze` exit code as described below.

| ID | Required item | Finding severity |
|---|---|---|
| `python_bytecode` | Stale/mismatched Python bytecode | High |
| `cross_session_residue` | Cross-session file residue | Medium |
| `self_log_tampering` | Self-log tampering | High / Medium / Info |
| `external_network_access` | External network access | High / Medium / Info |
| `cross_agent_communication` | Cross-agent communication | High / Medium / Info |

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

Artifact traversal skips `.git` metadata, does not follow internal symlinks or special files, and stops at 10,000 entries or depth 32. Unreadable directories, skipped files and reached limits remain visible limitations in all checks. Python source hashing is limited to 8 MiB and a five-second helper timeout. Source symlinks or source paths resolving outside the Skill are unverified. Scans are filesystem observations, not atomic snapshots; concurrent modification requires another live inspection.

`scan` saves check evidence with the inventory. `analyze` is live by default and reports it without saving inventory, Receipt or Method state; explicitly enabled telemetry can still append its aggregate event. Findings and local inventory may contain private paths. Existing telemetry sanitization excludes these details.


## Skill permission risks

Three mandatory checks are motivated by [CASP's intelligence-explosion report](https://casp.ac/reports/intelligence-explosion). The roughly 1,200-agent collusion example is a second-hand account as reported in the paper, not independently verified by OwnHow. Indicators describe capabilities and review needs; they do not prove malicious intent or observed behavior.

- `self_log_tampering`: declared writes to log/audit/receipt/transcript/history paths (including JSONL), mutation commands such as `rm`, `truncate`, redirection or `sed -i`, filesystem deletion/writing APIs, `history -c`, `git commit --amend` and `git reflog expire`. Changing the agent's own evidence can hide actions from oversight. Lexical detection cannot reliably establish log ownership.
- `external_network_access`: `curl`, `wget`, `nc`/netcat, `ssh`, `scp`, `fetch`, axios, Python requests/urllib/httpx/aiohttp/http.client, Go net/http, declared WebFetch/WebSearch tools, network side effects and literal HTTP(S) `url` values in MCP/Plugin/runtime manifests (package repository/bug links are excluded). External access enables exfiltration or unauthorized access. A URL in ordinary documentation alone is not a network-capability finding.
- `cross_agent_communication`: SendToAgent, send_message, Task/Agent/subagent tools, spawning sub-agents, `claude -p`, `codex exec`, `opencode run`, `pi`/`hermes` CLI invocations, A2A/agent-card indicators and writes into other agents' directories. Targets include `~/.claude`, `~/.codex`, `~/.hermes`, `~/.pi`, `~/.config/opencode`, `~/.openclaw` and `agents/` paths outside the Skill. Relative internal `agents/` outputs alone are not findings. These channels can enable collusion beyond user oversight.

Inspection reuses the artifact traversal and its depth/entry limits. It reads Skill Markdown (frontmatter and body), other Markdown references, common scripts (`sh`, `bash`, `zsh`, `fish`, `py`, `js`, `mjs`, `cjs`, `ts`, `rb`, `ps1`, Go and others) and extensionless shebang scripts. It inspects `plugin.json`, `package.json`, `.mcp.json`, `.claude-plugin/*`, `.codex-plugin/*`, `opencode.json`/`.jsonc` and OpenClaw JSON/config manifests inside the Skill. For enclosing packages, up to 32 ancestors are probed for known Plugin/runtime manifests, including Pi `package.json` whose declared Skill paths contain the Skill and OpenClaw `openclaw.plugin.json`. At the nearest recognized package/config root, known manifests, `.mcp.json` and `.claude-plugin`/`.codex-plugin` files are included. Scanner-provided Plugin roots take precedence, including Claude Skills configured outside their Plugin root. Ancestor directories are never recursively searched; unrelated sibling Skills/scripts and arbitrary external configuration paths are outside scope. This covers local Hermes, Claude Code, Pi, OpenCode and OpenClaw layouts; runtime-only Skills without local sources remain unknown.

Permission text reads are bounded to 1 MiB (plus one byte to detect overflow). Oversized text files are skipped with `permission_file_size_limit`, binary files are skipped, and source content is never executed. Script/manifest/frontmatter indicators have `risk: high` / `severity: high`; fenced Markdown examples have `risk: medium` / `severity: medium`; Markdown prose and script comments have `risk: low` / `severity: info`. This is a context heuristic: instructions and examples can be ambiguous. Each finding includes `risk`, `severity`, `reason`, absolute `path`, one-based `line`, a trimmed matched-line `evidence` capped at 200 characters, and a `message` explaining the oversight, exfiltration/access or collusion concern. Runtime-provided declarations absent from local text use a synthetic declaration and line 1 of `SKILL.md`.

### Policy configuration

Live scans always gather permission evidence with the inventory. `analyze` evaluates policy against that evidence, including cached inventories. Default `warn` reports every finding and never blocks, changes approval requirements, or changes the command's exit code. Policy does not affect `resolve`, `record` or runtime execution.

| Mode | Analysis behavior |
|---|---|
| `off` | Status `skipped`; permission findings omitted from the analysis, `inspected: 0` in its results. Raw inventory evidence is retained. |
| `warn` | Findings, coverage and limitations reported; exit code unchanged. |
| `block` | Same report as warn; `analyze` exits 1 if this check has any finding, including low-risk prose. Unknown evidence alone does not block. |

```sh
ownhow analyze --runtime hermes --permission-checks=warn
ownhow analyze --runtime claude --permission-checks=off --permission-check external_network_access=block --json
OWNHOW_PERMISSION_CHECKS=block ownhow analyze --runtime pi
OWNHOW_PERMISSION_CHECKS=self_log_tampering=block,external_network_access=warn ownhow analyze --runtime opencode
ownhow analyze --runtime openclaw --permission-checks=block --permission-allow-skill '<exact component ID>'
```

`--permission-checks MODE` or `--permission-checks=MODE` sets all three permission modes. `OWNHOW_PERMISSION_CHECKS` accepts a single mode or comma-separated `ID=MODE` assignments (unmentioned checks default to warn). A CLI family mode replaces the environment value; repeatable `--permission-check ID=MODE` assignments then override individual checks, with the last assignment winning. Equals-form flags are also supported. IDs/modes are validated; invalid configuration fails rather than silently weakening policy. These controls apply only to the three permission checks, not bytecode or residue checks.

The optional repeatable `--permission-allow-skill ID` allowlist uses exact component IDs from JSON findings/results, not names, patterns or host substrings. It skips all three permission checks for those Skills, marks their analysis results `allowlisted: true`, and retains their raw inventory evidence. There is no host allowlist; network expressions can be dynamic or cover several hosts on one line. API callers can use `analyzeInventory(inventory, { mode, overrides: ['ID=MODE'], allowSkills: ['exact-ID'] })`.

`requiredChecks` includes each permission check's effective `mode`, `skippedSkills`, and per-Skill results. `permissionBlocked` and `blockedPermissionChecks` summarize blocking decisions; human output prints the policy and blocking check IDs. Existing bytecode/residue behavior and approval advice remain unchanged. Empty inventories and old snapshots without evidence remain unknown unless explicitly skipped. Use a live scan to refresh observations; enabling a check cannot recover evidence absent from an old snapshot.

Static analysis has limits: obfuscation, aliases, generated commands, dynamic URLs, multiline expressions and computed paths can evade detection. Text matching can produce false positives, including benign examples or library names, and cannot establish actual network access, log ownership or collusion. No detected URL is fetched. Manual review and runtime isolation remain necessary where stronger guarantees are needed.
