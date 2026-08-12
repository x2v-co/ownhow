# OwnHow MVP

OwnHow is a local-first prototype for owning and improving how AI completes work. The MVP reads active Codex, Hermes, Claude Code, Pi, OpenCode, and OpenClaw methods, explains conflicts and task selection, records outcomes, and turns explicit user corrections into Personal Method overlays.

It does not upload source files, call a model, or modify installed Plugins and Skills.

## Requirements

- Node.js 22 or newer

## Install

Install the CLI directly from this repository:

```bash
npm install --global github:x2v-co/ownhow#v0.4.1
ownhow --help
```

Add the OwnHow marketplace and install the Codex Plugin (optional):

```bash
codex plugin marketplace add x2v-co/ownhow --ref v0.4.1
codex plugin add ownhow@x2v
```

Start a new Codex chat after installing the Plugin. The Plugin provides the governance workflow; the `ownhow` CLI performs local scanning and stores approved personal state.

### Hermes

Install the standalone Hermes Skill into the active Hermes profile:

```bash
hermes skills install https://raw.githubusercontent.com/x2v-co/ownhow/v0.4.1/skills/ownhow-governance/SKILL.md --yes
```

The CLI discovers active Hermes skills under `~/.hermes/skills` automatically, following Hermes' archive, support-directory, platform, environment, disabled-skill, symlink, and duplicate-name discovery rules. Use `--runtime hermes` to keep analysis scoped to Hermes, or `--root PATH` for a custom `HERMES_HOME`/profile.

### Claude Code

Add the OwnHow marketplace and install the Claude Code Plugin:

```bash
claude plugin marketplace add x2v-co/ownhow
claude plugin install ownhow@x2v --scope user
```

Start a new Claude Code session after installation. OwnHow follows Claude Code's active discovery state: personal and project Skills, directory symlinks, `skillOverrides: off`, enabled skills-directory Plugins, and the selected installed version of marketplace Plugins. Plugin Skills retain Claude Code's `plugin:skill` namespace. Use `--runtime claude` to scope analysis to Claude Code.

The static inventory includes project Skills active at session startup. Claude Code can add nested `.claude/skills` later when a session first reads or edits files under that directory; a future session-aware adapter will model those dynamic additions.

### Pi

Install OwnHow as a Pi Package:

```bash
pi install git:github.com/x2v-co/ownhow@v0.4.1
```

OwnHow follows Pi's project trust gate, project-over-user precedence, `.pi` and `.agents` discovery, settings filters, symlink deduplication, and Package-contributed Skills. Use `--runtime pi` for Pi-only analysis.

### OpenCode

Install the standalone Skill in OpenCode's global Skill directory:

```bash
git clone --branch v0.4.1 --depth 1 https://github.com/x2v-co/ownhow.git ~/.local/share/ownhow
ln -s ~/.local/share/ownhow/skills/ownhow-governance ~/.config/opencode/skills/ownhow-governance
```

OwnHow uses `opencode debug skill` as the authoritative live inventory when OpenCode is available, including external compatibility Skills, configured paths, remote Skills, and duplicate-name resolution. Use `--runtime opencode` for OpenCode-only analysis.

### OpenClaw

Install the standalone Skill globally:

```bash
git clone --branch v0.4.1 --depth 1 https://github.com/x2v-co/ownhow.git ~/.local/share/ownhow
openclaw skills install ~/.local/share/ownhow/skills/ownhow-governance --global --as ownhow-governance
```

OwnHow uses OpenClaw's eligible Skill report and loaded Plugin registry, retaining bundled Skills even when they have no separately discoverable path. Use `--runtime openclaw` for OpenClaw-only analysis.

## Run from source

```bash
git clone https://github.com/x2v-co/ownhow.git
cd ownhow
npm link

ownhow analyze --runtime all
ownhow resolve "review a merge request, fix findings, and verify the result" --runtime hermes
ownhow analyze --runtime claude
ownhow analyze --runtime pi
ownhow analyze --runtime opencode
ownhow analyze --runtime openclaw
```

`analyze` and `resolve` scan the live installation without writing state. Run `ownhow scan` when you explicitly want to save a snapshot, or pass `--cached` to analyze or resolve that snapshot. State is stored in `~/.ownhow` by default. Use `--state PATH` for an isolated experiment, `--root PATH` to scan an explicit source, and `--runtime codex|hermes|claude|pi|opencode|openclaw|all` to select the runtime.

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
| `scan` | Build a read-only inventory of active Plugins and Skills |
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

- Active Codex, Hermes, Claude Code, Pi, OpenCode, and OpenClaw method sources
- Deterministic local analysis; no LLM resolver
- Local JSON/JSONL state
- Personal Method overlays do not rewrite upstream packages
- No cloud account, hosted registry, team control plane, or automatic evolution
- Hermes' autonomous skill editing is not automatically trusted or converted into an OwnHow Personal Method; it must enter through Receipt → Proposal → explicit approval → Overlay.

## Privacy and security

OwnHow state can reveal private workflows and local filesystem paths. Do not commit or upload `~/.ownhow`, real inventories, receipts, corrections, proposals, or Personal Methods. See [SECURITY.md](SECURITY.md) for the disclosure and test-data policy.

## Contributing

OwnHow is in an evidence-gathering MVP phase. Reproducible selection failures, synthetic fixtures, and focused resolver or safety fixes are more useful than broad platform features. See [CONTRIBUTING.md](CONTRIBUTING.md).
