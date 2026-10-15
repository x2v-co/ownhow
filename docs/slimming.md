# Skill-library slimming and explicit selection

Large libraries can make relevant Skills harder for an Agent to load. [Lost in
Implicit Routing (arXiv:2610.18522)](https://arxiv.org/abs/2610.18522) studies this
failure and explicit preselection as a mitigation. OwnHow provides a local,
reviewable selection workflow; its suggestions do not guarantee equivalent
capabilities or task success.

## Inspect without changing anything

```bash
ownhow slim --runtime hermes
ownhow slim --runtime codex --max-tokens 4000 --unused-days 30 --json
```

Analysis uses the existing scanner, analyzer, and local receipts. The default
limits are 4,000 estimated tokens and 30 days. Both options must be positive
numbers. Each Skill has flags, usage evidence, token estimates, a suggested
selection decision, and reasons:

- **Unused:** the latest dated usage evidence is older than the window. Evidence
  can be host-reported `lifecycle.actualUsed: true` at the inventory timestamp or
  a local receipt referencing the Skill's exact ID in `plan.primary` or
  `plan.augment`. A receipt with `actualUsed: false` does not establish use.
  Retrospective resolution needs `governance.actualUsed: true`; saved-plan and
  legacy receipts provide a dated association. Imported receipts, other
  runtimes, malformed dates, and future dates do not count. With no usable
  evidence, usage stays **unknown**, never unused. A single host report of
  `actualUsed: false` does not establish inactivity over the whole window.
- **Overlapping:** existing analyzer semantic overlap, duplicate-name, or
  duplicate-registration findings. Informational findings remain routing hints;
  overlap does not prove interchangeable behavior. Cross-runtime copies are
  considered independently.
- **Oversized:** the full `SKILL.md` or its description exceeds the token limit.
  Estimates are `ceil(UTF-8 bytes / 4)`, not model-specific counts. If the file is
  unavailable, the report marks the full-file estimate unknown and measures only
  the description. Referenced files are outside this estimate.

Without an allowlist, a conservative greedy suggestion favors recently used
Skills, then smaller Skills, retaining one representative of overlapping
candidates. It proposes excluding stale Skills and retains unique Skills with
unknown usage. Oversize alone suggests shortening content, without dropping a
unique capability. Each decision has a reason; this is not an optimal set-cover
calculation. When an explicit allowlist exists, it determines the suggested set
and flags remain visible for review.

Like `analyze`, analysis accepts `--root`, `--cached`, `--fast`,
`--session-manifest`, and `--state`. Cached analysis uses the snapshot's usage
timestamp but reads current `SKILL.md` files when available. Analysis never saves
an inventory or automatically creates an allowlist.

## Select names explicitly

```bash
ownhow slim allow research reviewer --runtime hermes
ownhow slim deny reviewer --runtime hermes
ownhow slim list --runtime hermes
ownhow resolve "research customer onboarding" --runtime hermes
```

`allow` adds exact, case-sensitive names; `deny` removes names. These commands
explicitly edit `<state>/slim/allowlists.json` without scanning or changing Skill
files. The first edit starts from an empty set, including a first `deny`. A
missing runtime entry leaves selection unrestricted; an empty array selects no
Skills. Names may be added before installation. Use Claude's full `plugin:skill`
name for namespaced Skills. A name selects all copies with that name; use runtime
precedence or runtime configuration to distinguish duplicate installations.

`resolve` filters both primary and augment candidates before scoring, including
live, cached, and fast inventories. Each runtime's list is independent, including
with `--runtime all`. Existing behavior is preserved for runtimes without a
list. Recording an already saved execution plan preserves that historical plan.
`slim list` without a runtime shows all lists; allow/deny/apply/restore require
one concrete runtime. `OWNHOW_RUNTIME` and `--state` work as for other commands.

## Apply and restore runtime visibility

```bash
ownhow slim apply --runtime hermes          # prints the planned changes
ownhow slim apply --runtime hermes --write  # explicitly moves unselected Skills
ownhow slim restore --runtime hermes        # previews restoration
ownhow slim restore --runtime hermes --write
```

Apply requires an existing explicit allowlist and a live filesystem scan.
Suggestions are never applied automatically. `--cached`, `--fast`, and
`--session-manifest` are rejected for apply. Both apply and restore default to a
dry run; only the boolean `--write` flag enables their writes. No deletion
command or deletion option is supported, and no Skill files are deleted.

| Installation | Runtime enforcement |
|---|---|
| Hermes standalone immediate children of `$HERMES_HOME/skills` (default `~/.hermes/skills`) | Reversible directory move |
| Codex standalone immediate children of `~/.codex/skills` | Reversible directory move |
| Claude standalone immediate children of personal/project `.claude/skills` | Reversible directory move |
| Shared `.agents/skills`, Plugins, nested/custom roots, directory symlinks, Pi, OpenCode, OpenClaw, Skywork | `unsupported`; allowlist and manual instructions are printed |

Supported moves place the entire directory, including support files, in
`<runtime-directory>/.ownhow-disabled/<unique-id>`, outside its Skills discovery
root. OwnHow also excludes `.ownhow-disabled` from recursive discovery. Links,
aliased paths, shared source registrations, and containing directories of other
discovered Skills are not moved. Mixed installations report `enforcement:
"unsupported"` with separate supported changes and unsupported entries; `--write`
applies only the listed supported changes. Review the printed allowlist against
the runtime's settings when manual enforcement is needed. The resolver filter
works even when runtime enforcement is unsupported.

Move journals under `<state>/slim/moves/<runtime>/` preserve intent before each
move. Keep the same state directory for restoration. Restore recovers interrupted
moves and refuses to overwrite an existing destination; resolve a path conflict
before retrying. It retains the allowlist, so use `slim allow <name...>` if a
restored Skill should also become a resolver candidate. Refresh or restart the
runtime after applying or restoring to update session visibility.
