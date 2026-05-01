# Command Reference

All commands accept `--tenant <slug>` to scope operations to a specific tenant. All commands that send or write support `--dry-run`.

## Setup & Onboarding

### `start`
Guided onboarding — API keys, company context, framework, and goals in one flow.

```bash
orbit-gtm start
orbit-gtm start --non-interactive    # Use env vars, skip prompts (CI/automation)
```

### `setup`
Check API keys and provider connectivity without re-running onboarding.

```bash
orbit-gtm setup                      # Check current keys
orbit-gtm setup --wizard             # Interactive key-by-key setup
```

### `onboard`
Build GTM framework from LinkedIn profile and/or website (legacy path — `start` is recommended).

```bash
orbit-gtm onboard --website https://acme.com
orbit-gtm onboard --linkedin https://linkedin.com/in/jdoe --website https://acme.com
orbit-gtm onboard --knowledge docs/pitch.md docs/icp.md
```

### `configure`
Set GTM goals and configure skills based on your framework. Requires `onboard` to have run first.

```bash
orbit-gtm configure
```

### `doctor`
5-layer health check: environment, database, providers, context, framework.

```bash
orbit-gtm doctor
orbit-gtm doctor --report            # Write diagnostic report to file
```

### `test-run`
End-to-end validation: find → enrich → qualify → review.

```bash
orbit-gtm test-run --count 10
```

---

## Campaigns

### `campaign:create`
Create a campaign with A/B variant testing and scheduling.

```bash
orbit-gtm campaign:create --title "Q2 Outbound" --hypothesis "VP Eng responds to pain-point messaging"
orbit-gtm campaign:create --title "Q2 Outbound" --auto-copy --segment-id seg-01
orbit-gtm campaign:create --title "Q2 Outbound" --timezone "America/New_York" --send-window "09:00-17:00" --active-days "1,2,3,4,5"
orbit-gtm campaign:create --title "Q2 Outbound" --start-at 2026-05-01 --delay-mode business
```

| Flag | Description |
|------|-------------|
| `--title` | Campaign name |
| `--hypothesis` | What you're testing |
| `--auto-copy` | Generate voice-aware copy via Claude |
| `--segment-id` | ICP segment for voice targeting |
| `--timezone` | IANA timezone (default: Europe/Paris) |
| `--send-window` | HH:mm-HH:mm (default: 09:00-18:00) |
| `--active-days` | 1=Mon..7=Sun comma-separated (default: 1,2,3,4,5) |
| `--delay-mode` | `business` or `calendar` (default: business) |
| `--start-at` | ISO date to auto-activate (campaign starts as 'scheduled') |
| `--leads-filter` | JSON filter for leads from Unified Leads DB |
| `--dry-run` | Preview without writing |

### `campaign:track`
Poll providers, advance sequences, sync with Notion.

```bash
orbit-gtm campaign:track
orbit-gtm campaign:track --campaign-id abc123
orbit-gtm campaign:track --dry-run
```

### `campaign:schedule`
Update schedule on an existing campaign.

```bash
orbit-gtm campaign:schedule --campaign-id abc123 --send-window "10:00-16:00"
orbit-gtm campaign:schedule --campaign-id abc123 --start-at none    # Clear scheduled start
```

### `campaign:report`
Weekly intelligence report for campaigns.

```bash
orbit-gtm campaign:report
```

### `campaign:monthly-report`
Cross-campaign monthly report with intelligence synthesis.

```bash
orbit-gtm campaign:monthly-report
```

---

## Leads & Qualification

### `leads:qualify`
Run leads through the 7-gate qualification pipeline.

```bash
orbit-gtm leads:qualify --source csv --input ./leads.csv --dry-run
orbit-gtm leads:qualify --source csv --input ./leads.csv
```

| Flag | Description |
|------|-------------|
| `--source` | Input format: `csv`, `json`, or `notion` |
| `--input` | Path to input file (for csv/json) |
| `--dry-run` | Score without saving results |

### `leads:scrape-post`
Scrape likers and commenters from a LinkedIn post. Requires Unipile.

```bash
orbit-gtm leads:scrape-post --url "https://linkedin.com/feed/update/urn:li:activity:123456"
```

### `leads:import`
Import leads from CSV, JSON, or Notion into GTM-OS.

```bash
orbit-gtm leads:import --source csv --input data/leads/new-leads.csv
```

---

## LinkedIn

### `linkedin:answer-comments`
Reply to comments on your LinkedIn posts. Requires Unipile.

```bash
orbit-gtm linkedin:answer-comments --url "https://linkedin.com/feed/update/urn:li:activity:123456" --dry-run
```

---

## Email

### `email:create-sequence`
Generate an email drip sequence using Claude.

```bash
orbit-gtm email:create-sequence
```

### `email:send`
Send a multi-step sequence or a single ad-hoc message via the configured email provider. Routed through the provider registry, so any provider that advertises the `email_send` capability can serve this command (Instantly is built in; Brevo, Mailgun, and SendGrid ship as MCP templates via `provider:add`).

```bash
# Single ad-hoc send through the default provider
orbit-gtm email:send --to lead@example.com --subject "Quick question" --body "Hi there"

# Send through a different provider for this invocation
orbit-gtm email:send --provider brevo --to lead@example.com --body "Hi there"

# Sequence mode (campaign + leads CSV)
orbit-gtm email:send --campaign-name "Q2 Outbound" --source ./leads.csv --sequence ./sequence.yaml
```

| Flag | Description |
|------|-------------|
| `--provider <name>` | Override the configured email provider for this send. Defaults to `email.provider` in `~/.orbit-gtm/config.yaml`, falling back to `instantly`. |
| `--to`, `--subject`, `--body` | Single-message ad-hoc send (no sequence required). |
| `--campaign-name`, `--source`, `--sequence` | Sequence mode. `--source` is a CSV/JSON of qualified leads. |
| `--generate-from <url>` | Generate a sequence from a target company URL instead of `--sequence`. |
| `--save-sequence <path>` | Save the generated sequence to YAML for reuse. |
| `--from <accountId>` | Email sending account id (provider-specific). |
| `--dry-run` | Preview without sending. |

---

## Providers

### `provider:list`
List every registered provider (built-in plus any MCP templates loaded from `~/.orbit-gtm/mcp/`) with status and capabilities. Providers missing required env vars show as `needs API key`; providers that error out at runtime show as `unreachable`.

```bash
orbit-gtm provider:list
```

### `provider:add`
Copy a shipped MCP template into `~/.orbit-gtm/mcp/` so it loads on the next CLI invocation. Templates include CRM (`hubspot`, `apollo`, `peopledatalabs`, `zoominfo`) and email (`brevo`, `mailgun`, `sendgrid`).

```bash
orbit-gtm provider:add --mcp brevo
```

The command prints which env vars the template references and which are already set.

### `provider:test`
Run the provider's health check (and, for MCP providers, list discovered tools).

```bash
orbit-gtm provider:test brevo
orbit-gtm provider:test instantly
```

### `provider:remove`
Delete an MCP provider config from `~/.orbit-gtm/mcp/`. The provider stops loading on the next invocation.

```bash
orbit-gtm provider:remove brevo
```

---

## Notion Integration

### `notion:sync`
Bidirectional sync between GTM-OS SQLite and Notion databases. Requires Notion key + database IDs in config.

```bash
orbit-gtm notion:sync
```

### `notion:bootstrap`
One-time import of existing Notion data into GTM-OS.

```bash
orbit-gtm notion:bootstrap
```

---

## Orchestration

### `orchestrate`
Describe what you want in natural language. Claude decomposes it into skills and executes.

```bash
orbit-gtm orchestrate "find 10 SaaS companies in Berlin with 50-200 employees"
orbit-gtm orchestrate "research our top 3 competitors and compare their positioning"
orbit-gtm orchestrate "find VP Engineering at companies using React, qualify them, and create a campaign"
```

---

## Background Agents

### `agent:create`
Interactive wizard to create a background agent configuration.

```bash
orbit-gtm agent:create
```

### `agent:run`
Run a background agent immediately.

```bash
orbit-gtm agent:run --agent daily-linkedin-scraper --post-url "https://linkedin.com/..."
orbit-gtm agent:run --agent my-custom-agent
```

### `agent:install`
Install an agent as a macOS launchd service for automatic scheduling.

```bash
orbit-gtm agent:install --agent my-custom-agent
```

### `agent:list`
List all agents with their last run status.

```bash
orbit-gtm agent:list
```

---

## Skills Marketplace

### `skills:browse`
Browse available skills in the marketplace.

```bash
orbit-gtm skills:browse
```

### `skills:search`
Search for skills by keyword.

```bash
orbit-gtm skills:search "email"
```

### `skills:install`
Install a skill from GitHub or local path.

```bash
orbit-gtm skills:install --github user/repo
orbit-gtm skills:install --local ./my-skill
```

### `skills:info`
Show detailed information about a skill.

```bash
orbit-gtm skills:info qualify-leads
```

---

## Memory & Context (Multi-Tenant)

### `tenant:onboard`
Onboard a new tenant with interactive interview or context adapter.

```bash
orbit-gtm tenant:onboard --tenant acme
orbit-gtm tenant:onboard --tenant acme --adapter markdown-folder
orbit-gtm tenant:onboard --tenant acme --no-scrape
```

### `framework:derive`
Derive a GTM framework from the tenant's memory state.

```bash
orbit-gtm framework:derive --tenant acme
```

### `memory:retrieve`
Search the tenant's memory store using hybrid retrieval.

```bash
orbit-gtm memory:retrieve --query "what are our main competitors" --tenant acme
orbit-gtm memory:retrieve --query "ICP pain points" --top-k 5
```

### `memory:dream`
Run the memory lifecycle — generate clusters, promote insights, archive stale nodes, rebuild indexes.

```bash
orbit-gtm memory:dream --tenant acme
orbit-gtm memory:dream --incremental
```

### `context:sync`
Run context adapters to sync external data into memory.

```bash
orbit-gtm context:sync --tenant acme
```

### `context:watch`
Long-lived daemon that watches for context changes and syncs automatically.

```bash
orbit-gtm context:watch --tenant acme
```

---

## Results & Review

### `results:review`
Review and provide feedback on qualification results. Feeds the intelligence store.

```bash
orbit-gtm results:review --result-set rs-abc123
```
