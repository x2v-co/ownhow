# OwnHow MVP

OwnHow is a local-first prototype for owning and improving how AI completes work. The MVP reads Codex and Hermes Skills (plus Codex Plugins), explains conflicts and task selection, records outcomes, and turns explicit user corrections into Personal Method overlays.

It does not upload source files, call a model, or modify installed Plugins and Skills.

## Requirements

- Node.js 22 or newer

## Install

Install the CLI directly from this repository:

```bash
npm install --global github:x2v-co/ownhow#v0.2.0
ownhow --help
```

Add the OwnHow marketplace and install the Codex Plugin (optional):

```bash
codex plugin marketplace add x2v-co/ownhow --ref v0.2.0
codex plugin add ownhow@x2v
```

Start a new Codex chat after installing the Plugin. The Plugin provides the governance workflow; the `ownhow` CLI performs local scanning and stores approved personal state.

### Hermes

Install the standalone Hermes Skill into the active Hermes profile:

```bash
hermes skills install https://raw.githubusercontent.com/x2v-co/ownhow/v0.2.0/skills/ownhow-governance/SKILL.md --yes
```

The CLI discovers Hermes skills under `~/.hermes/skills` automatically. Use `--runtime hermes` to keep analysis scoped to Hermes, or `--root PATH` for a custom `HERMES_HOME`/profile.

## Run from source

```bash
git clone https://github.com/x2v-co/ownhow.git
cd ownhow
npm link

ownhow analyze --runtime all
ownhow resolve "review a merge request, fix findings, and verify the result" --runtime hermes
```

`analyze` and `resolve` scan the live installation without writing state. Run `ownhow scan` when you explicitly want to save a snapshot, or pass `--cached` to analyze or resolve that snapshot. State is stored in `~/.ownhow` by default. Use `--state PATH` for an isolated experiment, `--root PATH` to scan an explicit source, and `--runtime codex|hermes|all` to select the runtime.

## Personal Method loop

Record a real outcome and the correction you had to repeat:

```bash
ownhow record "review a merge request, fix findings, and verify the result" \
  --outcome failure \
  --correction "Run focused tests before asking for another review"

ownhow propose
```

Review the proposal under `~/.ownhow/proposals/`. Applying it is always explicit:

```bash
ownhow apply proposal-123
ownhow resolve "review a merge request, fix findings, and verify the result"
```

The second resolve includes the Personal Method correction. The original Plugin and Skill remain unchanged.

## Commands

| Command | Purpose |
|---|---|
| `scan` | Build a read-only inventory of Codex Plugins and Skills |
| `analyze` | Detect duplicate names, semantic overlap, write collisions, missing metadata, and risk surfaces |
| `resolve <task>` | Produce a deterministic task plan with selection reasons and approval risks |
| `record <task>` | Save a local receipt with outcome and optional correction |
| `propose` | Create a reviewable Personal Method proposal from a corrected receipt |
| `apply <id>` | Explicitly apply a proposal as a local overlay |
| `status` | Show local inventory, receipt, and method counts |

Add `--json` to any command for structured output.

## Verify

```bash
npm test
npm run verify
```

## Runtime support and MVP boundary

- Codex Plugin and Skill sources, plus Hermes `~/.hermes/skills`
- Deterministic local analysis; no LLM resolver
- Local JSON/JSONL state
- Personal Method overlays do not rewrite upstream packages
- No cloud account, hosted registry, team control plane, or automatic evolution
- Hermes' autonomous skill editing is not automatically trusted or converted into an OwnHow Personal Method; it must enter through Receipt → Proposal → explicit approval → Overlay.

## Privacy and security

OwnHow state can reveal private workflows and local filesystem paths. Do not commit or upload `~/.ownhow`, real inventories, receipts, corrections, proposals, or Personal Methods. See [SECURITY.md](SECURITY.md) for the disclosure and test-data policy.

## Contributing

OwnHow is in an evidence-gathering MVP phase. Reproducible selection failures, synthetic fixtures, and focused resolver or safety fixes are more useful than broad platform features. See [CONTRIBUTING.md](CONTRIBUTING.md).
