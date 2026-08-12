# OwnHow MVP

OwnHow is a local-first prototype for owning and improving how AI completes work. The MVP reads Codex Plugins and Skills, explains conflicts and task selection, records outcomes, and turns explicit user corrections into Personal Method overlays.

It does not upload source files, call a model, or modify installed Plugins and Skills.

## Requirements

- Node.js 22 or newer

## Run locally

```bash
cd /Users/kl/workspace/x2v/ownhow
npm link

ownhow scan
ownhow analyze
ownhow resolve "review a merge request, fix findings, and verify the result"
```

State is stored in `~/.ownhow` by default. Use `--state PATH` for an isolated experiment and `--root PATH` to scan an explicit source.

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

## MVP boundary

- Codex Plugin and Skill sources only
- Deterministic local analysis; no LLM resolver
- Local JSON/JSONL state
- Personal Method overlays do not rewrite upstream packages
- No cloud account, marketplace, team control plane, or automatic evolution
