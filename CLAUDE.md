# YALC GTM-OS — Claude Code Rules

## Project Identity
Open-source AI-native GTM operating system. Stack: Next.js 14, Tailwind, Drizzle + SQLite, Jotai, Anthropic SDK.

## Directory Structure
- `src/cli/index.ts` — CLI entry point, all commands registered here
- `src/lib/services/` — external integrations (Crustdata, Unipile, FullEnrich, Instantly, Notion, Firecrawl, Slack)
- `src/lib/qualification/` — 7-gate lead qualification pipeline
- `src/lib/campaign/` — campaign creation, tracking, scheduling, intelligence
- `src/lib/context/` — context adapters (e.g., markdown-folder for reading external knowledge bases)
- `src/lib/memory/` — tenant memory store, embeddings, retrieval, dream cycle
- `src/lib/framework/` — GTM framework derivation from company context
- `src/lib/agents/` — background agents, launchd integrations
- `src/app/` — Next.js web UI (chat, onboarding)
- `~/.gtm-os/` — per-tenant config, framework YAML, adapters
- `docs/` — architecture, commands, troubleshooting

## CLI
```
npx tsx src/cli/index.ts <command> [options]
```
Env loaded from `.env.local`. Use `--tenant <slug>` or `GTM_OS_TENANT` env var for multi-tenant (default: `default`).

## Security
- **NEVER display API keys, tokens, or secrets from `.env.local` in chat output.** Mask all credentials.

## Commit Rules
- Public repo — use generic, descriptive commit messages. Never use prompt-like or task-specific messages.

## Context Loading Map

Path-specific rules live in `.claude/rules/`. Claude Code auto-loads the relevant rule file when working in a matching directory.

| Rule File | Covers | Key Context |
|-----------|--------|-------------|
| `.claude/rules/enrichment.md` | `src/lib/enrichment/`, `src/lib/providers/` | Provider registry, credit tracking, StepExecutor interface |
| `.claude/rules/qualification.md` | `src/lib/qualification/` | 7-gate pipeline order, intelligence injection, gate configs |
| `.claude/rules/campaigns.md` | `src/lib/campaign/` | Message validation, rate limits, sequence timing, A/B testing |
| `.claude/rules/skills.md` | `src/lib/skills/` | Skill interface, RowBatch generator pattern, registry |

**Adding new rules:** Create a `.md` file in `.claude/rules/` with an "Applies to" header listing the directories it covers, a "Context to Load" section with key files to read, and "Hard Rules" for non-negotiable constraints.

## Persisting User Preferences

When the user expresses a durable rule, convention, or preference mid-session — phrases like "always X", "from now on", "we never Y", "remember that...", "for this project we..." — append it to the most specific matching file before continuing the task.

| What user said about | Where to save |
|---|---|
| Skill conventions, naming, validation, run patterns | `.claude/rules/skills.md` |
| Provider choices, MCP setup, credit policy, rate limits | `.claude/rules/enrichment.md` |
| Qualification gate behavior, ICP scoring, exclusion rules | `.claude/rules/qualification.md` |
| Campaign timing, message patterns, A/B testing rules | `.claude/rules/campaigns.md` |
| Repo-wide conventions, workflow, tooling | `CLAUDE.md` (this file), inserted under the most relevant section |

Write the rule in durable, generic wording — as a project rule, not a transcript. Bad: "User just said don't use HubSpot." Good: "Provider preference: do not configure HubSpot for this tenant."

If the user's preference doesn't match any of the above buckets, ask once: "Should I save this as a project rule in `<file>`?" Default to yes.

If the rule contradicts an existing line in the file, replace the old line and add a one-line `(updated YYYY-MM-DD)` annotation.

## Persisting Runtime Context (the GTM brain)

Project rules above describe how Claude Code should behave. Runtime context is different — it describes the user's company, ICP, voice, and outreach assets, and lives under `~/.gtm-os/`. When the user shares context mid-session that should land in the GTM brain, route the change through the preview/commit flow, never write directly to the live file.

| When user says... | Save to (in `_preview/`) |
|---|---|
| "my voice is...", "tone should be..." | `voice/tone-of-voice.md` |
| "my ICP is...", "we sell to..." | `company_context.yaml` (`icp.*` fields) |
| "qualify a lead like X", "score this kind of lead..." | `qualification_rules.md` |
| "my outreach should...", "connect note should say..." | `campaign_templates.yaml` |
| "monitor this signal", "watch for X" | `search_queries.txt` |
| "we compete with X" | `company_context.yaml` (`icp.competitors`) |
| "our segment is...", "primary segment description..." | `icp/segments.yaml` |

Hard rule: **runtime context modifications must go through `_preview/` and a commit step.** Never write directly to `~/.gtm-os/<live-file>`. Use `yalc-gtm start --regenerate <section>` to refresh a section, then `yalc-gtm start --commit-preview` (optionally with `--discard <section>`) to promote it. If the user asks for an immediate edit, write the change into `_preview/` and tell them to review + commit.

For per-tenant runs (`--tenant acme`), substitute `~/.gtm-os/tenants/acme/_preview/<file>`.

## Second Brain Context
For Earleads-specific client context (ICP, playbooks, battlecards), read from the Second Brain workspace configured as `additionalDirectory`. Client files: `01_Projects/Clients/Active/{ClientName}/`.

## Planned: Trade Fair & Exhibition Vertical

A phased customization to adapt the system for exhibitors at trade fairs and exhibitions (all goods and services types). The use case: badge-scanned visitors are leads; exhibitors want post-fair outreach to reach new customers or new markets.

### Phase 1 — Core MVP (~1.5 days)
- **`import-badge-scans` skill**: ingest scanner CSV (name, company, title, email, phone), normalize, dedup by email, feed qualification pipeline
- **Name+company enrichment entry point**: extend FullEnrich provider for reverse lookup (name + company → LinkedIn profile), since fair leads have no LinkedIn URL
- **Booth interaction fields on lead schema**: `staffRating` (hot/warm/cold), `demoAttended`, `dwellMinutes`, `materialsCollected`, `sessionAttended` — Drizzle migration + wire into Gate 5 AI scoring prompt
- **`fair_followup` sequence template**: day-0 connect+note, day-1 DM, day-4 DM, day-10 email; warm tone; `[Fair]` / `[Product shown]` placeholders
- **`fair_mode` voice preset**: warm, event-referencing tone — no cold-outreach framing

### Phase 2 — Intelligence loop (~0.5 days)
- **Fair catalog context loader**: drop fair catalog markdown into `~/.gtm-os/contexts/<fair>/`, load via existing `markdown-folder` adapter
- **Fair-scoped intelligence expiry**: set `expiresAt` (18 months) on intelligence entries sourced from a fair campaign — small change in `tracker.ts`
- **Post-fair intelligence report**: extend `intelligence-report.ts` to segment by booth interaction type (demo vs. passerby)

### Phase 3 — Multi-exhibitor (~1 day)
- **`fair:setup --exhibitor <slug>` CLI command**: creates tenant slug, copies fair context, sets ICP from exhibitor product category
- **Shared fair context across tenants**: single fair catalog loaded once, referenced by all exhibitor tenants
- **Validation across goods/services types**: gate configs tested for B2B machinery, consumer goods, professional services

### Key Design Decisions (do not re-derive)
- Sequence default timing shifts to day-0 for first touch (warm lead, not cold)
- Booth interaction `staffRating: hot` overrides a weak headline score in Gate 5
- Intelligence `expiresAt` set explicitly for fair-derived entries (18 months), not left to 365-day dream cycle default
- Business card OCR deferred (large effort, not MVP scope)
- Multi-tenant isolation already works — Phase 3 is onboarding UX only
