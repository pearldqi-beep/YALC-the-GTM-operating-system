/**
 * draft-candidate-outreach skill
 * Generate personalised LinkedIn DM or email for each shortlisted candidate.
 * Uses the candidate's profile + job brief context via Claude.
 * Writes drafts to candidate_outreach table. Does NOT send unless --send is set.
 */

import type { Skill, SkillEvent, SkillContext } from '../types'
import { db } from '../../db'
import { jobBriefs, candidates, candidateOutreach } from '../../db/schema'
import { eq, and } from 'drizzle-orm'

const WRITER_MODEL = 'claude-sonnet-4-5'

// Character limits enforced by LinkedIn
const CONNECT_NOTE_LIMIT = 300
const DM_LIMIT = 1000

export const draftCandidateOutreachSkill: Skill = {
  id: 'draft-candidate-outreach',
  name: 'Draft Candidate Outreach',
  version: '1.0.0',
  description:
    'Generate personalised LinkedIn DMs or emails for shortlisted candidates. Creates drafts in the database. Use --send flag to dispatch via Unipile / Instantly.',
  category: 'outreach',
  inputSchema: {
    type: 'object',
    properties: {
      jobBriefId: {
        type: 'string',
        description: 'ID of the job brief',
      },
      channel: {
        type: 'string',
        enum: ['linkedin_dm', 'email'],
        description: 'Outreach channel',
        default: 'linkedin_dm',
      },
      messageType: {
        type: 'string',
        enum: ['connect_note', 'dm1', 'dm2', 'email1', 'email2'],
        description: 'Which message in the sequence to draft',
        default: 'connect_note',
      },
      send: {
        type: 'boolean',
        description: 'If true, send approved messages via Unipile/Instantly. Default: false (draft only)',
        default: false,
      },
      linkedinAccountId: {
        type: 'string',
        description: 'Unipile account ID to send from (required when send=true + channel=linkedin_dm)',
      },
    },
    required: ['jobBriefId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      drafted: { type: 'number' },
      sent: { type: 'number' },
      skipped: { type: 'number' },
    },
  },
  requiredCapabilities: ['content', 'outreach'],

  async *execute(input: unknown, _context: SkillContext): AsyncIterable<SkillEvent> {
    const {
      jobBriefId,
      channel = 'linkedin_dm',
      messageType = 'connect_note',
      send = false,
      linkedinAccountId,
    } = input as {
      jobBriefId: string
      channel?: 'linkedin_dm' | 'email'
      messageType?: 'connect_note' | 'dm1' | 'dm2' | 'email1' | 'email2'
      send?: boolean
      linkedinAccountId?: string
    }

    // ── 1. Load brief ─────────────────────────────────────────────────────────
    yield { type: 'progress', message: 'Loading brief and shortlisted candidates...', percent: 5 }

    const [brief] = await db.select().from(jobBriefs).where(eq(jobBriefs.id, jobBriefId))
    if (!brief) {
      yield { type: 'error', message: `Job brief not found: ${jobBriefId}` }
      return
    }

    // ── 2. Load shortlisted candidates ────────────────────────────────────────
    const shortlisted = await db
      .select()
      .from(candidates)
      .where(and(eq(candidates.jobBriefId, jobBriefId), eq(candidates.shortlisted, true)))

    if (shortlisted.length === 0) {
      yield { type: 'error', message: `No shortlisted candidates found. Run build-shortlist first.` }
      return
    }

    yield {
      type: 'progress',
      message: `Drafting ${messageType} for ${shortlisted.length} candidates via ${channel}...`,
      percent: 10,
    }

    const { getAnthropicClient } = await import('../../ai/client')
    const anthropic = getAnthropicClient()

    const charLimit = messageType === 'connect_note' ? CONNECT_NOTE_LIMIT : DM_LIMIT
    const isEmail = channel === 'email'

    const channelInstructions = isEmail
      ? `Write a brief, collegial cold email (subject + body, under 150 words). No corporate buzzwords.`
      : messageType === 'connect_note'
        ? `Write a LinkedIn connection note (max ${charLimit} characters). Must be human, specific, no job pitch.`
        : `Write a LinkedIn DM (max ${charLimit} characters). One paragraph. Reference their specific background.`

    let drafted = 0
    let sent = 0
    let skipped = 0

    for (const candidate of shortlisted) {
      // Skip if this exact message was already sent
      if (messageType === 'connect_note' && candidate.connectSentAt) { skipped++; continue }
      if (messageType === 'dm1' && candidate.dm1SentAt) { skipped++; continue }
      if (messageType === 'dm2' && candidate.dm2SentAt) { skipped++; continue }

      const name = [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || 'the candidate'

      const prompt = `You are a recruiter writing to a passive candidate. Do NOT mention you are recruiting or reference a job opening upfront — open with something specific to their background.

Candidate:
  Name: ${name}
  Current title: ${candidate.currentTitle ?? 'unknown'}
  Company: ${candidate.currentCompany ?? 'unknown'}
  Headline: ${candidate.headline ?? 'none'}
  Location: ${candidate.location ?? 'unknown'}
  Fit score: ${candidate.fitScore ?? '?'}/100
  Fit reason: ${candidate.fitReason ?? 'strong profile match'}

Brief context (do NOT reveal directly):
  Role type: ${brief.title}
  Skills valued: ${(brief.skills as string[])?.join(', ')}
  Location: ${brief.location} (${brief.remotePolicy})
  Client sector: ${brief.clientName ?? 'innovative scale-up'}

Task: ${channelInstructions}

Rules:
- Never say "exciting opportunity" or "I came across your profile"
- Be specific about ONE thing from their background
- End with a soft, non-pressuring call to action
- Return ONLY the message text${isEmail ? ' (format: "Subject: ...\n\n<body>"' : ''}, no explanation`

      let content = ''
      try {
        const response = await anthropic.messages.create({
          model: WRITER_MODEL,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
        })
        content = response.content
          .filter(b => b.type === 'text')
          .map(b => (b as { type: 'text'; text: string }).text)
          .join('')
          .trim()

        // Enforce char limit for LinkedIn
        if (!isEmail && content.length > charLimit) {
          content = content.slice(0, charLimit - 1)
        }
      } catch (err) {
        yield { type: 'progress', message: `Failed to draft for ${name}: ${err}`, percent: 0 }
        skipped++
        continue
      }

      // Save draft to DB
      await db.insert(candidateOutreach).values({
        candidateId: candidate.id,
        jobBriefId,
        channel: channel as 'linkedin_dm' | 'email',
        messageType: messageType as 'connect_note' | 'dm1' | 'dm2' | 'email1' | 'email2',
        content,
        status: 'draft',
      })

      drafted++

      // ── 3. Optionally send ─────────────────────────────────────────────────
      if (send) {
        try {
          if (channel === 'linkedin_dm' && candidate.linkedinUrl) {
            // ── LinkedIn send via Unipile ────────────────────────────────────
            const { unipileService } = await import('../../services/unipile')
            if (messageType === 'connect_note') {
              await unipileService.sendConnection(
                linkedinAccountId!,
                candidate.providerId,
                content,
              )
              await db
                .update(candidates)
                .set({ connectSentAt: new Date().toISOString(), pipelineStatus: 'Contacted' })
                .where(eq(candidates.id, candidate.id))
            } else {
              await unipileService.sendMessage(
                linkedinAccountId!,
                candidate.providerId,
                content,
              )
              const field = messageType === 'dm1'
                ? { dm1SentAt: new Date().toISOString() }
                : { dm2SentAt: new Date().toISOString() }
              await db.update(candidates)
                .set({ ...field, pipelineStatus: 'Contacted' })
                .where(eq(candidates.id, candidate.id))
            }
            await db
              .update(candidateOutreach)
              .set({ status: 'sent', sentAt: new Date().toISOString() })
              .where(and(eq(candidateOutreach.candidateId, candidate.id), eq(candidateOutreach.messageType, messageType)))
            sent++

          } else if (channel === 'email' && candidate.email) {
            // ── Email send via Instantly ─────────────────────────────────────
            const { instantlyService } = await import('../../services/instantly')
            if (!instantlyService.isAvailable()) {
              yield { type: 'progress', message: `Instantly not configured — email skipped for ${name}`, percent: 0 }
            } else {
              // Parse subject + body from Claude output (format: "Subject: ...\n\n<body>")
              const subjectMatch = content.match(/^Subject:\s*(.+)/i)
              const subject = subjectMatch ? subjectMatch[1].trim() : `Reaching out — ${brief?.title ?? 'opportunity'}`
              const body = content.replace(/^Subject:.+\n\n?/i, '').trim()

              // Each candidate gets their own one-shot Instantly campaign
              const campaignTitle = `[Recruit] ${name} — ${brief?.title ?? jobBriefId} — ${messageType}`
              const campaign = await instantlyService.createCampaign({
                name: campaignTitle,
                sequences: [{ subject, body, delay_days: 0 }],
              })
              await instantlyService.addLeadsToCampaign(campaign.id, [{
                email: candidate.email,
                first_name: candidate.firstName ?? '',
                last_name: candidate.lastName ?? '',
                company_name: candidate.currentCompany ?? '',
                custom_variables: { personalization: content.slice(0, 500) },
              }])

              const emailField = messageType === 'email1'
                ? { email1SentAt: new Date().toISOString() }
                : { emailRepliedAt: undefined } // email2 — track separately
              await db.update(candidates)
                .set({ ...emailField, pipelineStatus: 'Contacted' })
                .where(eq(candidates.id, candidate.id))
              await db
                .update(candidateOutreach)
                .set({ status: 'sent', sentAt: new Date().toISOString() })
                .where(and(eq(candidateOutreach.candidateId, candidate.id), eq(candidateOutreach.messageType, messageType)))
              sent++
            }
          }
        } catch (err) {
          yield { type: 'progress', message: `Send failed for ${name}: ${err}`, percent: 0 }
        }
      }

      const pct = Math.min(10 + (drafted / shortlisted.length) * 85, 95)
      yield {
        type: 'progress',
        message: `Drafted${send ? '/sent' : ''} for ${name} (${drafted}/${shortlisted.length})`,
        percent: pct,
      }
    }

    yield {
      type: 'result',
      data: { drafted, sent, skipped },
    }

    yield {
      type: 'progress',
      message: `Done. ${drafted} drafted · ${sent} sent · ${skipped} skipped.`,
      percent: 100,
    }
  },
}
