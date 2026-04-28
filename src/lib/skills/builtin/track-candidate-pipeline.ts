/**
 * track-candidate-pipeline skill
 * Daily tracker — polls Unipile for new replies from candidates,
 * advances pipeline status, and notifies Slack on key events.
 * Mirror of the sales track-campaign skill for the recruitment pipeline.
 */

import type { Skill, SkillEvent, SkillContext } from '../types'
import { db } from '../../db'
import { candidates, jobBriefs, candidateOutreach } from '../../db/schema'
import { eq, and, isNull, lt } from 'drizzle-orm'

// Days to wait before sending next message in sequence
const DM1_DELAY_DAYS = 2
const DM2_DELAY_DAYS = 3

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24)
}

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

    // ── 7. Sequence auto-advance — queue next step for non-repliers ───────────
    yield { type: 'progress', message: 'Checking sequence auto-advance...', percent: 88 }

    let queued = 0

    // DM1: connected but no DM1 yet, connected >= DM1_DELAY_DAYS ago
    const needsDm1 = await db.select().from(candidates).where(
      and(
        jobBriefId ? eq(candidates.jobBriefId, jobBriefId) : undefined,
        eq(candidates.pipelineStatus, 'Contacted'),
        isNull(candidates.dm1SentAt),
        isNull(candidates.repliedAt),
      ) as ReturnType<typeof and>
    )
    for (const c of needsDm1) {
      if (!c.connectedAt) continue
      if (daysSince(c.connectedAt) < DM1_DELAY_DAYS) continue

      // Check there's an approved DM1 draft ready
      const [dm1Draft] = await db.select().from(candidateOutreach).where(
        and(eq(candidateOutreach.candidateId, c.id), eq(candidateOutreach.messageType, 'dm1'), eq(candidateOutreach.status, 'approved'))
      )
      if (!dm1Draft) continue

      if (!dryRun) {
        try {
          const { unipileService } = await import('../../services/unipile')
          await unipileService.sendMessage(linkedinAccountId ?? '', c.providerId, dm1Draft.content)
          await db.update(candidates).set({ dm1SentAt: new Date().toISOString() }).where(eq(candidates.id, c.id))
          await db.update(candidateOutreach).set({ status: 'sent', sentAt: new Date().toISOString() }).where(eq(candidateOutreach.id, dm1Draft.id))
          queued++
        } catch { /* non-fatal */ }
      } else {
        queued++
      }
    }

    // DM2: DM1 sent but no reply, dm1SentAt >= DM2_DELAY_DAYS ago
    const needsDm2 = await db.select().from(candidates).where(
      and(
        jobBriefId ? eq(candidates.jobBriefId, jobBriefId) : undefined,
        eq(candidates.pipelineStatus, 'Contacted'),
        isNull(candidates.dm2SentAt),
        isNull(candidates.repliedAt),
      ) as ReturnType<typeof and>
    )
    for (const c of needsDm2) {
      if (!c.dm1SentAt) continue
      if (daysSince(c.dm1SentAt) < DM2_DELAY_DAYS) continue

      const [dm2Draft] = await db.select().from(candidateOutreach).where(
        and(eq(candidateOutreach.candidateId, c.id), eq(candidateOutreach.messageType, 'dm2'), eq(candidateOutreach.status, 'approved'))
      )
      if (!dm2Draft) continue

      if (!dryRun) {
        try {
          const { unipileService } = await import('../../services/unipile')
          await unipileService.sendMessage(linkedinAccountId ?? '', c.providerId, dm2Draft.content)
          await db.update(candidates).set({ dm2SentAt: new Date().toISOString() }).where(eq(candidates.id, c.id))
          await db.update(candidateOutreach).set({ status: 'sent', sentAt: new Date().toISOString() }).where(eq(candidateOutreach.id, dm2Draft.id))
          queued++
        } catch { /* non-fatal */ }
      } else {
        queued++
      }
    }

    if (queued > 0) {
      yield {
        type: 'progress',
        message: `${dryRun ? '[DRY RUN] ' : ''}Auto-advanced ${queued} sequence step(s) (DM1/DM2).`,
        percent: 95,
      }
    }

    yield {
      type: 'result',
      data: {
        checked: contacted.length,
        newReplies,
        interested,
        advanced: dryRun ? 0 : advanced,
        sequenceQueued: dryRun ? 0 : queued,
      },
    }

    yield {
      type: 'progress',
      message: `${dryRun ? '[DRY RUN] ' : ''}Done. ${contacted.length} checked · ${newReplies} replies · ${interested} interested · ${advanced} advanced · ${queued} sequence steps sent.`,
      percent: 100,
    }
  },
}
