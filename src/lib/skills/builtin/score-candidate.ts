/**
 * score-candidate skill
 * Score passive candidates against a job brief using Claude Opus.
 * Produces a 0–100 fitScore with a per-dimension breakdown and prose reason.
 */

import type { Skill, SkillEvent, SkillContext } from '../types'
import { db } from '../../db'
import { jobBriefs, candidates } from '../../db/schema'
import { eq, and, isNull } from 'drizzle-orm'
import type { FitBreakdown } from '../../recruitment/types'

const SCORER_MODEL = 'claude-opus-4-5'

export const scoreCandidateSkill: Skill = {
  id: 'score-candidate',
  name: 'Score Candidates',
  version: '1.0.0',
  description:
    'Score passive candidates against a job brief using Claude Opus. Produces a 0–100 fit score with skill, seniority, location, and openness breakdowns. Updates candidates in the database.',
  category: 'analysis',
  inputSchema: {
    type: 'object',
    properties: {
      jobBriefId: {
        type: 'string',
        description: 'ID of the job brief to score candidates against',
      },
      candidateIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific candidate IDs to score. If omitted, scores all unscored candidates for the brief.',
      },
      batchSize: {
        type: 'number',
        description: 'How many candidates to score per Claude call (default: 5)',
        default: 5,
      },
    },
    required: ['jobBriefId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      scored: { type: 'number' },
      avgScore: { type: 'number' },
      topScore: { type: 'number' },
      passedThreshold: { type: 'number' },
    },
  },
  requiredCapabilities: ['qualify'],

  async *execute(input: unknown, _context: SkillContext): AsyncIterable<SkillEvent> {
    const {
      jobBriefId,
      candidateIds,
      batchSize = 5,
    } = input as {
      jobBriefId: string
      candidateIds?: string[]
      batchSize?: number
    }

    // ── 1. Load brief ─────────────────────────────────────────────────────────
    yield { type: 'progress', message: 'Loading job brief...', percent: 3 }

    const [brief] = await db.select().from(jobBriefs).where(eq(jobBriefs.id, jobBriefId))
    if (!brief) {
      yield { type: 'error', message: `Job brief not found: ${jobBriefId}` }
      return
    }

    // ── 2. Load candidates to score ───────────────────────────────────────────
    yield { type: 'progress', message: 'Loading candidates...', percent: 6 }

    let toScore = await db
      .select()
      .from(candidates)
      .where(
        candidateIds?.length
          ? and(eq(candidates.jobBriefId, jobBriefId))
          : and(eq(candidates.jobBriefId, jobBriefId), isNull(candidates.fitScore))
      )

    if (candidateIds?.length) {
      toScore = toScore.filter(c => candidateIds.includes(c.id))
    }

    if (toScore.length === 0) {
      yield { type: 'progress', message: 'No candidates to score.', percent: 100 }
      yield { type: 'result', data: { scored: 0, avgScore: 0, topScore: 0, passedThreshold: 0 } }
      return
    }

    yield {
      type: 'progress',
      message: `Scoring ${toScore.length} candidates against "${brief.title}"...`,
      percent: 10,
    }

    // ── 3. Build brief context once ───────────────────────────────────────────
    const briefContext = [
      `Role: ${brief.title}`,
      `Seniority: ${brief.seniority}`,
      `Location: ${brief.location} (${brief.remotePolicy} policy)`,
      `Required skills: ${(brief.skills as string[])?.join(', ') || 'none specified'}`,
      `Nice-to-have: ${(brief.niceToHaveSkills as string[])?.join(', ') || 'none'}`,
      brief.salaryMin ? `Salary: ${brief.salaryCurrency} ${brief.salaryMin}–${brief.salaryMax ?? '?'}` : '',
      `Open signals to look for: ${(brief.openSignals as string[])?.join(', ') || 'open to work, exploring opportunities'}`,
    ].filter(Boolean).join('\n')

    // ── 4. Score in batches ───────────────────────────────────────────────────
    const { getAnthropicClient } = await import('../../ai/client')
    const anthropic = getAnthropicClient()

    const allScores: number[] = []
    let scoredCount = 0

    for (let i = 0; i < toScore.length; i += batchSize) {
      const batch = toScore.slice(i, i + batchSize)

      const candidateBlocks = batch.map((c, idx) => {
        const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown'
        return [
          `Candidate ${idx + 1}: ${name}`,
          `  Current title: ${c.currentTitle ?? 'unknown'}`,
          `  Company: ${c.currentCompany ?? 'unknown'}`,
          `  Headline: ${c.headline ?? 'none'}`,
          `  Location: ${c.location ?? 'unknown'}`,
        ].join('\n')
      }).join('\n\n')

      const prompt = `You are a senior technical recruiter scoring passive candidates for a job brief.

JOB BRIEF:
${briefContext}

CANDIDATES TO SCORE:
${candidateBlocks}

Score EACH candidate on four dimensions (0–25 points each, total 0–100):
- skills (0–25): How well does their background match the required skills?
- seniority (0–25): How well does their level match the brief seniority?
- location (0–25): Does their location fit the remote policy and target location?
- openness (0–25): Do their headline or title suggest career openness?

Return a JSON array with one object per candidate IN ORDER:
[
  {
    "skills": <number>,
    "seniority": <number>,
    "location": <number>,
    "openness": <number>,
    "total": <number>,
    "reason": "<one concise sentence explaining the fit>"
  }
]

Rules:
- Be calibrated — scores should range meaningfully (not all 70+)
- "reason" must be specific to THIS candidate's profile, not generic
- Return ONLY the JSON array, no markdown fences`

      let parsed: Array<{ skills: number; seniority: number; location: number; openness: number; total: number; reason: string }> = []

      try {
        const response = await anthropic.messages.create({
          model: SCORER_MODEL,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        })

        const text = response.content
          .filter(b => b.type === 'text')
          .map(b => (b as { type: 'text'; text: string }).text)
          .join('')

        parsed = JSON.parse(text.trim())
      } catch (err) {
        yield {
          type: 'progress',
          message: `Batch ${Math.floor(i / batchSize) + 1} parse error — defaulting to score 50. ${err}`,
          percent: Math.min(10 + (scoredCount / toScore.length) * 80, 88),
        }
        parsed = batch.map(() => ({
          skills: 12, seniority: 12, location: 13, openness: 13, total: 50,
          reason: 'Could not parse score — defaulted to 50.',
        }))
      }

      // ── 5. Persist scores ─────────────────────────────────────────────────
      for (let j = 0; j < batch.length; j++) {
        const candidate = batch[j]
        const score = parsed[j] ?? { skills: 12, seniority: 12, location: 13, openness: 13, total: 50, reason: 'Scoring error.' }

        const breakdown: FitBreakdown = {
          skills: score.skills,
          seniority: score.seniority,
          location: score.location,
          openness: score.openness,
        }

        await db
          .update(candidates)
          .set({
            fitScore: score.total,
            fitReason: score.reason,
            fitBreakdown: breakdown,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(candidates.id, candidate.id))

        allScores.push(score.total)
        scoredCount++
      }

      const pct = Math.min(10 + (scoredCount / toScore.length) * 85, 95)
      yield {
        type: 'progress',
        message: `Scored ${scoredCount}/${toScore.length} candidates...`,
        percent: pct,
      }
    }

    // ── 6. Summary ────────────────────────────────────────────────────────────
    const avgScore = allScores.length > 0
      ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
      : 0
    const topScore = allScores.length > 0 ? Math.max(...allScores) : 0
    const threshold = 65
    const passedThreshold = allScores.filter(s => s >= threshold).length

    yield {
      type: 'result',
      data: { scored: scoredCount, avgScore, topScore, passedThreshold },
    }

    yield {
      type: 'progress',
      message: `Scoring complete. ${scoredCount} candidates scored · avg ${avgScore} · top ${topScore} · ${passedThreshold} passed threshold (≥${threshold}).`,
      percent: 100,
    }
  },
}
