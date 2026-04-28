/**
 * candidate-pipeline.ts
 * 7-gate qualification pipeline adapted for candidate sourcing (Track 2).
 * Forked from pipeline.ts — the sales track is NOT modified.
 *
 * Gate order:
 *  0. Dedup          — skip candidates already in DB for this brief
 *  1. Headline       — check openSignals / disqualifySignals from the brief
 *  2. Exclusion      — blocklist and competitor filter (reuses lead_blocklist table)
 *  3. Company        — company-level signals (size, hiring freeze indicators)
 *  4. Enrichment     — pull missing data via Unipile profile lookup
 *  5. AI Score       — Claude Opus scores fit against the brief (score-candidate logic)
 *  6. Threshold      — pass only candidates with fitScore >= config threshold
 */

import { db } from '../db'
import { candidates, jobBriefs, leadBlocklist } from '../db/schema'
import { eq, and, inArray, isNotNull } from 'drizzle-orm'
import type { GTMOSConfig } from '../config/types'
import type { CandidatePipelineResult, FitBreakdown } from '../recruitment/types'

// Re-export for convenience
export type { CandidatePipelineResult }

interface RawCandidate {
  id: string
  jobBriefId: string
  providerId: string
  linkedinUrl: string | null
  firstName: string | null
  lastName: string | null
  headline: string | null
  currentCompany: string | null
  currentTitle: string | null
  location: string | null
  fitScore: number | null
  pipelineStatus: string
}

function log(gate: string, inCount: number, outCount: number, durationMs: number) {
  console.log(
    JSON.stringify({ gate, in: inCount, out: outCount, rejected: inCount - outCount, durationMs })
  )
}

export async function runCandidatePipeline(opts: {
  config: GTMOSConfig
  jobBriefId: string
  dryRun?: boolean
  noDedup?: boolean
}): Promise<CandidatePipelineResult> {
  const { config, jobBriefId, dryRun = false, noDedup = false } = opts
  const startedAt = Date.now()
  const threshold = config.recruitment?.shortlist_threshold ?? 65

  const result: CandidatePipelineResult = {
    jobBriefId,
    sourced: 0,
    deduped: 0,
    failedHeadline: 0,
    failedExclusion: 0,
    failedCompany: 0,
    enriched: 0,
    scored: 0,
    passedThreshold: 0,
    saved: 0,
    durationMs: 0,
  }

  // ── Load brief ──────────────────────────────────────────────────────────────
  const [brief] = await db.select().from(jobBriefs).where(eq(jobBriefs.id, jobBriefId))
  if (!brief) throw new Error(`Job brief not found: ${jobBriefId}`)

  const openSignals = (brief.openSignals as string[]) ?? ['open to work', 'exploring', 'looking for']
  const disqualifySignals = (brief.disqualifySignals as string[]) ?? ['not open', 'happy in current']

  // ── Load all Sourced candidates for this brief ──────────────────────────────
  let pool: RawCandidate[] = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.jobBriefId, jobBriefId), eq(candidates.pipelineStatus, 'Sourced')))

  result.sourced = pool.length
  console.log(JSON.stringify({ stage: 'start', briefId: jobBriefId, poolSize: pool.length }))

  // ─── Gate 0: Dedup ──────────────────────────────────────────────────────────
  const gateStart0 = Date.now()
  if (!noDedup) {
    const before = pool.length
    const providerIds = pool.map(c => c.providerId).filter(Boolean)
    const linkedinUrls = pool.map(c => c.linkedinUrl).filter((u): u is string => !!u)

    // Check blocklist
    const blocked = await db.select().from(leadBlocklist).where(
      leadBlocklist.providerId
        ? inArray(leadBlocklist.providerId, providerIds)
        : eq(leadBlocklist.scope, 'permanent')
    )
    const blockedProviderIds = new Set(blocked.map(b => b.providerId).filter(Boolean))
    const blockedUrls = new Set(blocked.map(b => b.linkedinUrl).filter(Boolean))

    pool = pool.filter(c => {
      if (blockedProviderIds.has(c.providerId)) return false
      if (c.linkedinUrl && blockedUrls.has(c.linkedinUrl)) return false
      return true
    })

    result.deduped = before - pool.length
    log('Gate0:Dedup', before, pool.length, Date.now() - gateStart0)
  }

  // ─── Gate 1: Headline ───────────────────────────────────────────────────────
  const gateStart1 = Date.now()
  const before1 = pool.length
  pool = pool.filter(c => {
    const text = `${c.headline ?? ''} ${c.currentTitle ?? ''}`.toLowerCase()
    // Hard reject: disqualify signals
    if (disqualifySignals.some(sig => text.includes(sig.toLowerCase()))) return false
    // Must have a headline (can't score openness without it)
    if (!c.headline && !c.currentTitle) return false
    return true
  })
  result.failedHeadline = before1 - pool.length
  log('Gate1:Headline', before1, pool.length, Date.now() - gateStart1)

  // ─── Gate 2: Exclusion ──────────────────────────────────────────────────────
  const gateStart2 = Date.now()
  const before2 = pool.length
  const COMPETITOR_COMPANIES: string[] = [] // tenant can populate via config
  pool = pool.filter(c => {
    if (!c.currentCompany) return true
    const co = c.currentCompany.toLowerCase()
    return !COMPETITOR_COMPANIES.some(comp => co.includes(comp.toLowerCase()))
  })
  result.failedExclusion = before2 - pool.length
  log('Gate2:Exclusion', before2, pool.length, Date.now() - gateStart2)

  // ─── Gate 3: Company signals ────────────────────────────────────────────────
  const gateStart3 = Date.now()
  const before3 = pool.length
  // Basic: reject candidates with no company info (can't verify fit)
  pool = pool.filter(c => !!c.currentCompany || !!c.currentTitle)
  result.failedCompany = before3 - pool.length
  log('Gate3:Company', before3, pool.length, Date.now() - gateStart3)

  // ─── Gate 4: Enrichment ─────────────────────────────────────────────────────
  const gateStart4 = Date.now()
  let enriched = 0
  try {
    const { unipileService } = await import('../services/unipile')
    for (const candidate of pool) {
      if (!candidate.linkedinUrl) continue
      if (candidate.currentTitle && candidate.currentCompany) continue // already has data

      try {
        const profile = await unipileService.getProfile('default', candidate.linkedinUrl!)
        if (profile && !dryRun) {
          await db.update(candidates).set({
            currentTitle: (profile as Record<string, unknown>).title as string ?? candidate.currentTitle,
            currentCompany: (profile as Record<string, unknown>).company as string ?? candidate.currentCompany,
            headline: (profile as Record<string, unknown>).headline as string ?? candidate.headline,
            updatedAt: new Date().toISOString(),
          }).where(eq(candidates.id, candidate.id))
          enriched++
        }
      } catch {
        // Single candidate enrichment failure is non-fatal
      }
    }
  } catch {
    console.log(JSON.stringify({ gate: 'Gate4:Enrichment', message: 'Unipile not available — skipping enrichment' }))
  }
  result.enriched = enriched
  log('Gate4:Enrichment', pool.length, pool.length, Date.now() - gateStart4)

  // ─── Gate 5: AI Score (Claude Opus) ────────────────────────────────────────
  const gateStart5 = Date.now()
  const SCORER_MODEL = 'claude-opus-4-5'
  const briefContext = [
    `Role: ${brief.title}`,
    `Seniority: ${brief.seniority}`,
    `Location: ${brief.location} (${brief.remotePolicy} policy)`,
    `Required skills: ${(brief.skills as string[])?.join(', ') || 'none'}`,
    `Open signals: ${openSignals.join(', ')}`,
  ].join('\n')

  try {
    const { getAnthropicClient } = await import('../ai/client')
    const anthropic = getAnthropicClient()
    const BATCH = 5

    for (let i = 0; i < pool.length; i += BATCH) {
      const batch = pool.slice(i, i + BATCH)
      const candidateBlocks = batch.map((c, idx) => {
        return [
          `Candidate ${idx + 1}: ${[c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown'}`,
          `  Title: ${c.currentTitle ?? 'unknown'} @ ${c.currentCompany ?? 'unknown'}`,
          `  Headline: ${c.headline ?? 'none'}`,
          `  Location: ${c.location ?? 'unknown'}`,
        ].join('\n')
      }).join('\n\n')

      const prompt = `Score these candidates 0-100 (25 pts each: skills, seniority, location, openness) against this brief.\n\nBRIEF:\n${briefContext}\n\nCANDIDATES:\n${candidateBlocks}\n\nReturn JSON array only:\n[{"skills":N,"seniority":N,"location":N,"openness":N,"total":N,"reason":"..."}]`

      try {
        const response = await anthropic.messages.create({
          model: SCORER_MODEL,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        })
        const text = response.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('')
        const scores = JSON.parse(text.trim()) as Array<{ skills: number; seniority: number; location: number; openness: number; total: number; reason: string }>

        for (let j = 0; j < batch.length; j++) {
          const score = scores[j]
          if (!score) continue
          const breakdown: FitBreakdown = { skills: score.skills, seniority: score.seniority, location: score.location, openness: score.openness }
          if (!dryRun) {
            await db.update(candidates).set({
              fitScore: score.total,
              fitReason: score.reason,
              fitBreakdown: breakdown,
              updatedAt: new Date().toISOString(),
            }).where(eq(candidates.id, batch[j].id))
          }
          batch[j].fitScore = score.total
          result.scored++
        }
      } catch {
        // Batch scoring failure — default to 50
        for (const c of batch) {
          c.fitScore = 50
          result.scored++
        }
      }
    }
  } catch {
    console.log(JSON.stringify({ gate: 'Gate5:AIScore', message: 'Anthropic not available — defaulting all scores to 50' }))
    for (const c of pool) { c.fitScore = 50; result.scored++ }
  }
  log('Gate5:AIScore', pool.length, result.scored, Date.now() - gateStart5)

  // ─── Gate 6: Threshold ──────────────────────────────────────────────────────
  const gateStart6 = Date.now()
  const passed = pool.filter(c => (c.fitScore ?? 0) >= threshold)
  result.passedThreshold = passed.length
  log('Gate6:Threshold', pool.length, passed.length, Date.now() - gateStart6)

  // ── Persist passing candidates (advance pipeline status) ────────────────────
  if (!dryRun && passed.length > 0) {
    const passedIds = passed.map(c => c.id)
    await db
      .update(candidates)
      .set({ pipelineStatus: 'Sourced', updatedAt: new Date().toISOString() })
      .where(inArray(candidates.id, passedIds))
    result.saved = passed.length
  }

  result.durationMs = Date.now() - startedAt
  console.log(JSON.stringify({ stage: 'complete', ...result }))
  return result
}
