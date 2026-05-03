/**
 * notifications.ts (exported as slack.ts for backward compatibility)
 *
 * Replaces the Slack webhook integration with an Notion Activity Log.
 * Every GTM-OS event creates a new page in the configured `notifications_db`
 * database so all activity is visible inside Notion alongside leads and campaigns.
 *
 * Notion database expected schema:
 *   Name         — title       — event title e.g. "💬 Lead Replied"
 *   Event        — select      — raw event key e.g. "reply"
 *   Campaign     — rich_text   — campaign title or ID
 *   Lead         — rich_text   — lead full name
 *   Old Status   — rich_text   — previous lifecycle status (where applicable)
 *   New Status   — rich_text   — new lifecycle status (where applicable)
 *   Details      — rich_text   — extra context (reply preview, variant names, signal summary…)
 *   Timestamp    — date        — ISO timestamp of the event
 *   Status       — select      — "New" | "Reviewed"
 *
 * Exported API is identical to the old slack.ts so all call sites are unchanged.
 */

import { notionService } from './notion'
import type { SlackConfig } from '../config/types'

// ── Config ───────────────────────────────────────────────────────────────────

let notificationsDbId: string | undefined
let notifyOn: string[] = [
  'reply',
  'demo_booked',
  'deal_created',
  'closed_won',
  'closed_lost',
  'campaign_completed',
  'winner_declared',
  'signal_detected',
]

/**
 * Configure which Notion database receives activity-log pages and which events
 * are recorded. Call this once during app startup from the config loader.
 */
export function setNotionNotificationsConfig(dbId: string, events?: string[]): void {
  notificationsDbId = dbId
  if (events?.length) notifyOn = events
}

/**
 * @deprecated Slack has been replaced by Notion Activity Log.
 * This function is retained so existing call sites (tracker.ts, campaigns.ts, etc.)
 * compile without changes. It is a no-op — configure notifications via
 * `setNotionNotificationsConfig()` instead.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setSlackConfig(_config: SlackConfig | undefined): void {
  // intentional no-op
}

// ── Event titles ─────────────────────────────────────────────────────────────

const EVENT_TITLES: Record<string, string> = {
  reply: '💬 Lead Replied',
  demo_booked: '📅 Demo Booked',
  deal_created: '🤝 Deal Created',
  closed_won: '🎉 Closed Won',
  closed_lost: '❌ Closed Lost',
  campaign_completed: '✅ Campaign Completed',
  winner_declared: '🏆 Variant Winner Declared',
  signal_detected: '⚡ Signal Detected',
}

// ── Main send function ────────────────────────────────────────────────────────

/**
 * Create an Activity Log entry in Notion for the given event.
 * Drop-in replacement for the old `sendSlackNotification()`.
 */
export async function sendSlackNotification(
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!notificationsDbId) return
  if (!notifyOn.includes(event)) return
  if (!notionService.isAvailable()) return

  const title = EVENT_TITLES[event] ?? `Campaign Event: ${event}`
  const campaign = String(data.campaignTitle ?? data.campaignId ?? '')
  const lead = String(data.leadName ?? '')
  const oldStatus = String(data.oldStatus ?? '')
  const newStatus = String(data.newStatus ?? '')

  // Build a human-readable details string
  const detailParts: string[] = []
  if (data.replyPreview) detailParts.push(`Reply: ${String(data.replyPreview).slice(0, 500)}`)
  if (data.signal_type) detailParts.push(`Signal type: ${data.signal_type}`)
  if (data.entity_name) detailParts.push(`Entity: ${data.entity_name}`)
  if (data.summary) detailParts.push(String(data.summary).slice(0, 500))
  if (data.text) detailParts.push(String(data.text).slice(0, 500))
  const details = detailParts.join('\n')

  try {
    await notionService.createPage(notificationsDbId, {
      Name: {
        title: [{ text: { content: title } }],
      },
      Event: {
        select: { name: event },
      },
      ...(campaign
        ? { Campaign: { rich_text: [{ text: { content: campaign } }] } }
        : {}),
      ...(lead
        ? { Lead: { rich_text: [{ text: { content: lead } }] } }
        : {}),
      ...(oldStatus
        ? { 'Old Status': { rich_text: [{ text: { content: oldStatus } }] } }
        : {}),
      ...(newStatus
        ? { 'New Status': { rich_text: [{ text: { content: newStatus } }] } }
        : {}),
      ...(details
        ? { Details: { rich_text: [{ text: { content: details } }] } }
        : {}),
      Timestamp: {
        date: { start: new Date().toISOString() },
      },
      Status: {
        select: { name: 'New' },
      },
    })
  } catch (err) {
    console.error(`[notifications] Failed to create Notion activity log entry for "${event}":`, err)
  }
}
