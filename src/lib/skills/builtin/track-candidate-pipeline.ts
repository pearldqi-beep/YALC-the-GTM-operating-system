/**
 * track-candidate-pipeline skill
 * Daily tracker — polls Unipile for new replies from candidates,
 * advances pipeline status, and notifies Slack on key events.
 * Mirror of the sales track-campaign skill for the recruitment pipeline.
 */

import type { Skill, SkillEvent, SkillContext } from '../types'
import { db } from '../../db'
import { candidates, jobBriefs } from '../../db/schema'
import { eq, and, inArray } from 'drizzle-orm'

export const trackCandidatePipelineSkill: Skill = {
  id: 'track-candidate-pipeline',
  name: 'Track Candidate Pipeline',
  version: '1.0.0',
  description:
    'Poll Unipile for replies from candidates in active outreach. Advance pipeline statuses (Contacted → Replied → Interested), fire Slack notifications on new replies.',
  category: 'integration',
  inputSchema: {
    type: 'object',
    properties: {
      jobBriefId: {
        type: 'string',
        description: 'Specific brief to track. If omitted, tracks all active briefs.',
      },
      linkedinAccountId: {
        type: 'string',
        description: 'Unipile account ID to poll',
      },
      dryRun: {
        type: 'boolean',
        description: 'Simulate tracking without writing DB changes or sending Slack (default: false)',
        default: false,
      },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      checked: { type: 'number' },
      newReplies: { type: 'number' },
      interested: { type: 'number' },
      advanced: { type: 'number' },
    },
  },
  requiredCapabilities: ['integration'],

  async *execute(input: unknown, _context: SkillContext): AsyncIterable<SkillEvent> {
    const {
      jobBriefId,
      linkedinAccountId,
      dryRun = false,
    } = input as {
      jobBriefId?: string
      linkedinAccountId?: string
      dryRun?: boolean
    }

    yield {
      type: 'progress',
      message: dryRun ? '[DRY RUN] Tracking candidate pipeline...' : 'Tracking candidate pipeline...',
      percent: 5,
    }

    // ── 1. Load candidates in Contacted state ─────────────────────────────────
    const contactedQuery = jobBriefId
      ? and(eq(candidates.pipelineStatus, 'Contacted'), eq(candidates.jobBriefId, jobBriefId))
      : eq(candidates.pipelineStatus, 'Contacted')

    const contacted = await db.select().from(candidates).where(contactedQuery)

    yield {
      type: 'progress',
      message: `Found ${contacted.length} candidates in Contacted state.`,
      percent: 15,
    }

    if (contacted.length === 0) {
      yield { type: 'result', data: { checked: 0, newReplies: 0, interested: 0, advanced: 0 } }
      yield { type: 'progress', message: 'No contacted candidates to track.', percent: 100 }
      return
    }

    // ── 2. Poll Unipile inbox ─────────────────────────────────────────────────
    yield { type: 'progress', message: 'Polling Unipile inbox for replies...', percent: 25 }

    let inboxMessages: Array<{ linkedinUrl?: string; profileUrl?: string; message: string; sentAt: string }> = []

    try {
      const { unipileService } = await import('../../services/unipile')
      // Use listChats + getMessages to approximate an inbox poll
      const chats = await unipileService.listChats(linkedinAccountId ?? '', 50)
      for (const chat of (chats as Array<Record<string, unknown>>).slice(0, 20)) {
        const chatId = chat.id as string
        const msgs = await unipileService.getMessages(chatId, 5)
        for (const m of (msgs as Array<Record<string, unknown>>)) {
          if (m.from_me) continue // skip outbound
          inboxMessages.push({
            linkedinUrl: (chat.attendee_profile_url ?? chat.linkedin_url) as string | undefined,
            message: (m.text ?? m.body ?? '') as string,
            sentAt: (m.created_at ?? new Date().toISOString()) as string,
          })
        }
      }
    } catch {
      yield { type: 'progress', message: 'Unipile not available — using mock inbox (0 replies).', percent: 35 }
    }

    yield {
      type: 'progress',
      message: `Inbox: ${inboxMessages.length} messages in last 48h.`,
      percent: 40,
    }

    // ── 3. Match replies to candidates ────────────────────────────────────────
    const { getAnthropicClient } = await import('../../ai/client')
    const anthropic = getAnthropicClient()

    let newReplies = 0
    let interested = 0
    let advanced = 0

    for (const candidate of contacted) {
      if (!candidate.linkedinUrl && !candidate.connectSentAt) continue

      // Find messages from this candidate in the inbox
      const match = inboxMessages.find(m => {
        const url = m.linkedinUrl ?? m.profileUrl ?? ''
        return candidate.linkedinUrl && url.includes(candidate.linkedinUrl.split('/in/')[1] ?? '')
      })

      if (!match) continue

      // Already logged this reply?
      if (candidate.repliedAt) continue

      newReplies++

      // ── 4. Sentiment check — interested or not? ───────────────────────────
      let isInterested = false
      try {
        const sentimentResponse = await anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 50,
          messages: [{
            role: 'user',
            content: `Is this reply from a candidate showing genuine interest in a new role? Answer only "yes" or "no".\n\nReply: "${match.message}"`,
          }],
        })
        const answer = sentimentResponse.content
          .filter(b => b.type === 'text')
          .map(b => (b as { type: 'text'; text: string }).text)
          .join('')
          .toLowerCase()
          .trim()
        isInterested = answer.startsWith('yes')
      } catch {
        isInterested = false
      }

      if (isInterested) interested++

      // ── 5. Advance pipeline status ────────────────────────────────────────
      const newStatus = isInterested ? 'Interested' : 'Replied'

      if (!dryRun) {
        await db
          .update(candidates)
          .set({
            pipelineStatus: newStatus,
            repliedAt: match.sentAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(candidates.id, candidate.id))
        advanced++
      }

      const name = [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || 'Unknown'
      yield {
        type: 'progress',
        message: `${dryRun ? '[DRY RUN] ' : ''}${name}: ${candidate.pipelineStatus} → ${newStatus}${isInterested ? ' ⭐' : ''}`,
        percent: Math.min(40 + (newReplies / Math.max(contacted.length, 1)) * 45, 85),
      }

      // ── 6. Slack notification ─────────────────────────────────────────────
      if (!dryRun && isInterested) {
        try {
          // Load brief for context
          const [brief] = await db.select().from(jobBriefs).where(eq(jobBriefs.id, candidate.jobBriefId))
          const { sendSlackNotification } = await import('../../services/slack')
          await sendSlackNotification('reply', {
            campaignTitle: brief?.title ?? candidate.jobBriefId,
            leadName: name,
            newStatus: 'Interested',
            replyPreview: match.message.slice(0, 200),
          })
        } catch {
          // Slack not configured — silently skip
        }
      }
    }

    yield {
      type: 'result',
      data: {
        checked: contacted.length,
        newReplies,
        interested,
        advanced: dryRun ? 0 : advanced,
      },
    }

    yield {
      type: 'progress',
      message: `${dryRun ? '[DRY RUN] ' : ''}Pipeline tracked. ${contacted.length} checked · ${newReplies} new replies · ${interested} interested · ${advanced} statuses advanced.`,
      percent: 100,
    }
  },
}
