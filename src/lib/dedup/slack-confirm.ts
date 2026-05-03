/**
 * notion-confirm.ts (exported as slack-confirm.ts for backward compatibility)
 *
 * When a fuzzy dedup match has confidence in the configurable range (default 60–80%),
 * creates a Notion review page so a human can decide what to do.
 *
 * Replaces the old Slack reaction-based flow. The reviewer opens Notion, reads the
 * duplicate details, and sets the Decision property to one of:
 *   Merge | Keep Both | Skip
 *
 * Notion database expected schema (dedup_review_db or notifications_db):
 *   Name        — title    — "Duplicate Review: <lead name>"
 *   Confidence  — number   — match confidence percentage
 *   New Lead    — rich_text
 *   Matched With — rich_text
 *   Match Type  — select
 *   Source      — select
 *   Decision    — select   — "Pending" | "Merge" | "Keep Both" | "Skip"
 *   Resolved At — date
 *   Lead ID     — rich_text — internal ID for resolveTimeout lookup
 */

import { notionService } from '../services/notion'
import type { LeadRecord, DedupMatch, SlackConfirmAction, SlackConfirmResult } from './types'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SlackConfirmOptions {
  /** @deprecated webhookUrl is no longer used. Configure Notion via setDedupReviewDb(). */
  webhookUrl?: string
  channel?: string
  timeoutMs?: number
  defaultAction?: SlackConfirmAction
}

// ─── Config ───────────────────────────────────────────────────────────────────

let dedupReviewDbId: string | undefined

export function setDedupReviewDb(dbId: string): void {
  dedupReviewDbId = dbId
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatLeadName(lead: LeadRecord): string {
  const first = lead.first_name ?? lead.firstName ?? ''
  const last = lead.last_name ?? lead.lastName ?? ''
  return `${first} ${last}`.trim() || 'Unknown'
}

function formatLeadEmail(lead: LeadRecord): string {
  return lead.email ?? ''
}

function formatMatchSource(match: DedupMatch): string {
  const sourceLabels: Record<string, string> = {
    campaign_active: 'Active Campaign',
    campaign_replied: 'Replied Lead',
    crm: 'CRM',
    blocklist: 'Blocklist',
    notion: 'Notion',
    csv: 'Imported CSV',
  }
  return sourceLabels[match.matchedSource] || match.matchedSource
}

// ─── Build Notion properties (kept for testability) ──────────────────────────

export function buildConfirmationBlocks(
  lead: LeadRecord,
  match: DedupMatch,
): Record<string, unknown> {
  const leadName = formatLeadName(lead)
  const leadEmail = formatLeadEmail(lead)
  const matchSource = formatMatchSource(match)

  return {
    Name: {
      title: [{ text: { content: `Duplicate Review: ${leadName}` } }],
    },
    Confidence: {
      number: match.confidence,
    },
    'New Lead': {
      rich_text: [
        { text: { content: leadName + (leadEmail ? ` (${leadEmail})` : '') } },
      ],
    },
    'Matched With': {
      rich_text: [{ text: { content: match.matchedField } }],
    },
    'Match Type': {
      select: { name: match.matcher.replace(/_/g, ' ') },
    },
    Source: {
      select: { name: matchSource },
    },
    Decision: {
      select: { name: 'Pending' },
    },
    'Lead ID': {
      rich_text: [{ text: { content: lead.id ?? '' } }],
    },
  }
}

// ─── Send Confirmation ────────────────────────────────────────────────────────

/**
 * Creates a Notion dedup-review page for a human to action.
 * The reviewer opens Notion and sets the Decision field to Merge / Keep Both / Skip.
 */
export async function sendConfirmation(
  lead: LeadRecord,
  match: DedupMatch,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options: SlackConfirmOptions = {},
): Promise<void> {
  if (!dedupReviewDbId) {
    console.log(`[dedup] No dedup_review_db configured — skipping Notion review page for ${formatLeadName(lead)}`)
    return
  }

  if (!notionService.isAvailable()) {
    console.log(`[dedup] Notion not available — skipping review page for ${formatLeadName(lead)}`)
    return
  }

  const properties = buildConfirmationBlocks(lead, match)

  try {
    await notionService.createPage(dedupReviewDbId, properties)
    console.log(`[dedup] Notion review page created for ${formatLeadName(lead)} (${match.confidence}% confidence)`)
  } catch (err) {
    console.error(`[dedup] Failed to create Notion review page: ${err instanceof Error ? err.message : err}`)
  }
}

// ─── Resolve Pending (batch) ──────────────────────────────────────────────────

/**
 * For leads pending review, apply the default action after timeout.
 * In a full implementation this would query Notion for pages where Decision !== 'Pending'
 * and action them. For now, applies the safe default after timeout.
 */
export function resolveTimeout(
  pendingLeadIds: string[],
  defaultAction: SlackConfirmAction = 'keep_both',
): SlackConfirmResult[] {
  return pendingLeadIds.map(id => ({
    leadId: id,
    action: defaultAction,
    respondedAt: new Date().toISOString(),
  }))
}
