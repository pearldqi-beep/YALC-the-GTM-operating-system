/**
 * source-candidates skill
 * Search Crustdata (800M+ profiles) for passive candidates matching a job brief.
 * Mirrors find-people.ts but is brief-driven and writes to the candidates table.
 */

import type { Skill, SkillEvent, SkillContext } from '../types'
import { db } from '../../db'
import { jobBriefs, candidates } from '../../db/schema'
import { eq, and } from 'drizzle-orm'
import { SENIORITY_TO_CRUSTDATA } from '../../recruitment/types'

export const sourceCandidatesSkill: Skill = {
  id: 'source-candidates',
  name: 'Source Candidates',
  version: '1.0.0',
  description:
    'Search 800M+ LinkedIn profiles via Crustdata to find passive candidates matching a job brief. Calculates credit cost BEFORE executing and requires approval. Saves results to the candidates table.',
  category: 'research',
  inputSchema: {
    type: 'object',
    properties: {
      jobBriefId: {
        type: 'string',
        description: 'ID of the job brief to source candidates for',
      },
      limit: {
        type: 'number',
        description: 'Max candidates to retrieve (default: 100, max: 1000)',
        default: 100,
      },
      supplementWithLinkedIn: {
        type: 'boolean',
        description: 'Also search Unipile LinkedIn (no extra Crustdata credits). Default: false.',
        default: false,
      },
    },
    required: ['jobBriefId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      candidatesFound: { type: 'number' },
      candidatesSaved: { type: 'number' },
      estimatedCredits: { type: 'number' },
      actualCredits: { type: 'number' },
      balanceAfter: { type: 'number' },
    },
  },
  requiredCapabilities: ['search'],

  estimatedCost(input: unknown) {
    const { limit = 100 } = input as { limit?: number }
    return Math.max(3, Math.ceil(limit / 100) * 3)
  },

  async *execute(input: unknown, _context: SkillContext): AsyncIterable<SkillEvent> {
    const {
      jobBriefId,
      limit = 100,
      supplementWithLinkedIn = false,
    } = input as {
      jobBriefId: string
      limit?: number
      supplementWithLinkedIn?: boolean
    }

    // ── 1. Load the job brief ────────────────────────────────────────────────
    yield { type: 'progress', message: 'Loading job brief...', percent: 3 }

    const [brief] = await db.select().from(jobBriefs).where(eq(jobBriefs.id, jobBriefId))

    if (!brief) {
      yield { type: 'error', message: `Job brief not found: ${jobBriefId}` }
      return
    }

    const skills = (brief.skills as string[]) ?? []
    const crustdataSeniority = SENIORITY_TO_CRUSTDATA[brief.seniority as keyof typeof SENIORITY_TO_CRUSTDATA]
    const titles = [brief.title, ...skills.slice(0, 2)] // title + top 2 skills as title hints

    yield {
      type: 'progress',
      message: `Brief loaded: "${brief.title}" · ${brief.seniority} · ${brief.location}`,
      percent: 5,
    }

    // ── 2. Pre-flight credit check ───────────────────────────────────────────
    const { crustdataService, estimateCost } = await import('../../services/crustdata')

    if (!crustdataService.isAvailable()) {
      yield { type: 'error', message: 'CRUSTDATA_API_KEY is not set.' }
      return
    }

    yield { type: 'progress', message: 'Checking credit balance...', percent: 8 }

    const balance = await crustdataService.checkCredits()
    const estimate = estimateCost('people_search_db', { resultCount: limit })

    yield {
      type: 'progress',
      message: `Credit estimate: ${estimate.breakdown}. Balance: ${balance} credits.`,
      percent: 10,
    }

    // ── 3. Approval gate ─────────────────────────────────────────────────────
    yield {
      type: 'approval_needed',
      title: `Crustdata Search — ${brief.title} (${brief.seniority})`,
      description: [
        `Brief: ${brief.title} · ${brief.seniority} · ${brief.location}`,
        `Skills filter: ${skills.join(', ') || 'none'}`,
        `Limit: ${limit} candidates`,
        `Estimated cost: ~${estimate.credits} credits (${estimate.breakdown})`,
        `Current balance: ${balance} credits`,
        `Balance after: ~${balance - estimate.credits} credits`,
        '',
        'Strategy: DB search only (cheapest). Unipile supplement: ' + (supplementWithLinkedIn ? 'yes' : 'no'),
      ].join('\n'),
      payload: { estimatedCredits: estimate.credits, balance, jobBriefId },
    }

    // ── 4. Execute Crustdata DB search ───────────────────────────────────────
    yield {
      type: 'progress',
      message: `Searching Crustdata for ${brief.title} candidates...`,
      percent: 20,
    }

    const maxLimit = Math.min(limit, 1000)
    const allPeople: Record<string, unknown>[] = []
    let totalCount = 0
    let totalActualCredits = 0
    let finalBalance = balance
    let cursor: string | null = null

    do {
      const tracked = await crustdataService.searchPeople({
        titles,
        seniorityLevels: crustdataSeniority ? [crustdataSeniority] : undefined,
        location: brief.location,
        limit: maxLimit,
        cursor,
      })

      totalActualCredits += tracked.actualCost
      finalBalance = tracked.balanceAfter

      for (const person of tracked.result.people) {
        allPeople.push(person as unknown as Record<string, unknown>)
      }
      totalCount = tracked.result.totalCount
      cursor = tracked.result.nextCursor

      const pct = Math.min(20 + (allPeople.length / Math.max(totalCount, 1)) * 55, 75)
      yield {
        type: 'progress',
        message: `Found ${allPeople.length}${totalCount > 0 ? ` of ~${totalCount}` : ''} candidates · credits used: ${totalActualCredits}`,
        percent: pct,
      }
    } while (cursor && allPeople.length < maxLimit)

    // ── 5. Optional Unipile supplement ───────────────────────────────────────
    if (supplementWithLinkedIn && allPeople.length < limit) {
      yield { type: 'progress', message: 'Supplementing via Unipile LinkedIn search...', percent: 78 }
      try {
        const { unipileService } = await import('../../services/unipile')
        const extra = await unipileService.searchLinkedIn(
          'default', // accountId — will use first available account
          `${brief.title} ${skills.slice(0, 3).join(' ')}`,
          limit - allPeople.length,
        )
        for (const p of extra) allPeople.push(p as Record<string, unknown>)
        yield {
          type: 'progress',
          message: `Unipile added ${extra.length} additional profiles. Total: ${allPeople.length}`,
          percent: 82,
        }
      } catch {
        yield { type: 'progress', message: 'Unipile supplement skipped (not configured).', percent: 82 }
      }
    }

    // ── 6. Dedup against existing candidates for this brief ──────────────────
    yield { type: 'progress', message: 'Deduplicating against existing candidates...', percent: 85 }

    const existing = await db
      .select({ providerId: candidates.providerId, linkedinUrl: candidates.linkedinUrl })
      .from(candidates)
      .where(eq(candidates.jobBriefId, jobBriefId))

    const existingProviderIds = new Set(existing.map(c => c.providerId).filter(Boolean))
    const existingLinkedInUrls = new Set(existing.map(c => c.linkedinUrl).filter(Boolean))

    const newPeople = allPeople.filter(p => {
      const pid = (p.id ?? p.member_id ?? p.provider_id) as string | undefined
      const url = (p.linkedin_url ?? p.linkedinUrl ?? p.profile_url) as string | undefined
      if (pid && existingProviderIds.has(pid)) return false
      if (url && existingLinkedInUrls.has(url)) return false
      return true
    })

    yield {
      type: 'progress',
      message: `Dedup: ${allPeople.length} found → ${newPeople.length} new (${allPeople.length - newPeople.length} already in DB)`,
      percent: 88,
    }

    // ── 7. Save to candidates table ──────────────────────────────────────────
    yield { type: 'progress', message: `Saving ${newPeople.length} candidates...`, percent: 90 }

    let saved = 0
    for (const person of newPeople) {
      const pid = ((person.id ?? person.member_id ?? person.provider_id ?? '') as string)
      const linkedinUrl = ((person.linkedin_url ?? person.linkedinUrl ?? person.profile_url ?? null) as string | null)

      await db.insert(candidates).values({
        jobBriefId,
        providerId: pid || `manual-${crypto.randomUUID()}`,
        linkedinUrl,
        firstName: (person.first_name ?? person.firstName ?? null) as string | null,
        lastName: (person.last_name ?? person.lastName ?? null) as string | null,
        headline: (person.headline ?? person.title ?? null) as string | null,
        currentCompany: (person.company ?? person.current_company ?? null) as string | null,
        currentTitle: (person.job_title ?? person.current_title ?? person.title ?? null) as string | null,
        location: (person.location ?? person.city ?? null) as string | null,
        email: (person.email ?? null) as string | null,
        pipelineStatus: 'Sourced',
        source: 'crustdata',
        rawData: person,
      }).onConflictDoNothing()
      saved++
    }

    // ── 8. Final report ──────────────────────────────────────────────────────
    yield {
      type: 'result',
      data: {
        candidatesFound: allPeople.length,
        candidatesSaved: saved,
        estimatedCredits: estimate.credits,
        actualCredits: totalActualCredits,
        balanceAfter: finalBalance,
        jobBriefId,
      },
    }

    yield {
      type: 'progress',
      message: [
        `Done. ${saved} candidates saved for brief "${brief.title}".`,
        `Credits: estimated=${estimate.credits} actual=${totalActualCredits} balance=${finalBalance}`,
      ].join(' '),
      percent: 100,
    }
  },
}
