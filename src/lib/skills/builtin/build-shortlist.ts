/**
 * build-shortlist skill
 * Rank all scored candidates for a job brief and mark the top N as shortlisted.
 * Optionally pushes the shortlist to Notion.
 */

import type { Skill, SkillEvent, SkillContext } from '../types'
import { db } from '../../db'
import { jobBriefs, candidates } from '../../db/schema'
import { eq, and, isNotNull, desc } from 'drizzle-orm'
import type { ShortlistResult } from '../../recruitment/types'

export const buildShortlistSkill: Skill = {
  id: 'build-shortlist',
  name: 'Build Shortlist',
  version: '1.0.0',
  description:
    'Rank all scored candidates for a job brief, mark the top N as shortlisted, and optionally sync to Notion.',
  category: 'analysis',
  inputSchema: {
    type: 'object',
    properties: {
      jobBriefId: {
        type: 'string',
        description: 'ID of the job brief',
      },
      topN: {
        type: 'number',
        description: 'Number of candidates to shortlist (default: 10)',
        default: 10,
      },
      minScore: {
        type: 'number',
        description: 'Minimum fitScore to be eligible (default: 65)',
        default: 65,
      },
      syncNotion: {
        type: 'boolean',
        description: 'Push shortlist to Notion if candidates_ds is configured (default: false)',
        default: false,
      },
    },
    required: ['jobBriefId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      shortlisted: { type: 'number' },
      topScore: { type: 'number' },
      avgScore: { type: 'number' },
      candidates: { type: 'array', items: { type: 'object' } },
    },
  },
  requiredCapabilities: ['qualify'],

  async *execute(input: unknown, _context: SkillContext): AsyncIterable<SkillEvent> {
    const {
      jobBriefId,
      topN = 10,
      minScore = 65,
      syncNotion = false,
    } = input as {
      jobBriefId: string
      topN?: number
      minScore?: number
      syncNotion?: boolean
    }

    // ── 1. Load brief ─────────────────────────────────────────────────────────
    yield { type: 'progress', message: 'Loading job brief...', percent: 5 }

    const [brief] = await db.select().from(jobBriefs).where(eq(jobBriefs.id, jobBriefId))
    if (!brief) {
      yield { type: 'error', message: `Job brief not found: ${jobBriefId}` }
      return
    }

    // ── 2. Fetch all scored candidates ────────────────────────────────────────
    yield { type: 'progress', message: 'Loading scored candidates...', percent: 15 }

    const scored = await db
      .select()
      .from(candidates)
      .where(and(eq(candidates.jobBriefId, jobBriefId), isNotNull(candidates.fitScore)))
      .orderBy(desc(candidates.fitScore))

    if (scored.length === 0) {
      yield {
        type: 'error',
        message: `No scored candidates found for brief "${brief.title}". Run score-candidate first.`,
      }
      return
    }

    yield {
      type: 'progress',
      message: `${scored.length} scored candidates found. Applying threshold ≥${minScore}...`,
      percent: 30,
    }

    // ── 3. Clear previous shortlist for this brief ────────────────────────────
    await db
      .update(candidates)
      .set({ shortlisted: false, shortlistRank: null })
      .where(eq(candidates.jobBriefId, jobBriefId))

    // ── 4. Select top N above threshold ──────────────────────────────────────
    const eligible = scored.filter(c => (c.fitScore ?? 0) >= minScore)
    const selected = eligible.slice(0, topN)

    yield {
      type: 'progress',
      message: `${eligible.length} eligible (≥${minScore}) → selecting top ${selected.length}`,
      percent: 50,
    }

    // ── 5. Write shortlist to DB ──────────────────────────────────────────────
    for (let rank = 0; rank < selected.length; rank++) {
      const candidate = selected[rank]
      await db
        .update(candidates)
        .set({
          shortlisted: true,
          shortlistRank: rank + 1,
          pipelineStatus: 'Shortlisted',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(candidates.id, candidate.id))
    }

    yield { type: 'progress', message: `Shortlist written to DB.`, percent: 70 }

    // ── 6. Optionally push to Notion ──────────────────────────────────────────
    if (syncNotion) {
      yield { type: 'progress', message: 'Syncing shortlist to Notion...', percent: 78 }
      try {
        const { notionService } = await import('../../services/notion')
        const candidatesDsId = process.env.NOTION_CANDIDATES_DS
        if (!candidatesDsId) throw new Error('NOTION_CANDIDATES_DS env var not set')
        // Map candidates to a Notion-compatible shape
        const pages = selected.map((c, idx) => ({
          Name: [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown',
          Rank: idx + 1,
          Score: c.fitScore ?? 0,
          Reason: c.fitReason ?? '',
          Title: c.currentTitle ?? '',
          Company: c.currentCompany ?? '',
          Location: c.location ?? '',
          LinkedIn: c.linkedinUrl ?? '',
          Brief: brief.title,
          Status: 'Shortlisted',
        }))
        await notionService.bulkCreateLeads(candidatesDsId, pages)
        yield { type: 'progress', message: `${pages.length} candidates synced to Notion.`, percent: 90 }
      } catch (err) {
        yield {
          type: 'progress',
          message: `Notion sync skipped: ${err}`,
          percent: 90,
        }
      }
    }

    // ── 7. Build result ───────────────────────────────────────────────────────
    const scores = selected.map(c => c.fitScore ?? 0)
    const avgScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0
    const topScore = scores.length > 0 ? Math.max(...scores) : 0

    const result: ShortlistResult = {
      jobBriefId,
      total: scored.length,
      shortlisted: selected.length,
      topScore,
      avgScore,
      candidates: selected.map((c, idx) => ({
        rank: idx + 1,
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown',
        currentTitle: c.currentTitle,
        currentCompany: c.currentCompany,
        fitScore: c.fitScore ?? 0,
        fitReason: c.fitReason,
      })),
    }

    yield { type: 'result', data: result }

    yield {
      type: 'progress',
      message: `Shortlist complete. ${selected.length} candidates shortlisted for "${brief.title}" (avg score: ${avgScore}, top: ${topScore}).`,
      percent: 100,
    }
  },
}
