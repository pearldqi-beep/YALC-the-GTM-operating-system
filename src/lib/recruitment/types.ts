/**
 * Track 2 — Candidate Sourcing
 * Domain types for the recruitment pipeline.
 * Counterpart to src/lib/framework/types.ts (sales) and src/lib/campaign/types.ts.
 */

// ─── Enums ────────────────────────────────────────────────────────────────────

export type SeniorityLevel =
  | 'junior'
  | 'mid'
  | 'senior'
  | 'staff'
  | 'principal'
  | 'director'
  | 'vp'
  | 'c-level'

export type RemotePolicy = 'remote' | 'hybrid' | 'onsite'

export type JobBriefStatus = 'draft' | 'active' | 'paused' | 'filled' | 'cancelled'

export type CandidatePipelineStatus =
  | 'Sourced'
  | 'Contacted'
  | 'Replied'
  | 'Interested'
  | 'Shortlisted'
  | 'Interviewing'
  | 'Placed'

export type CandidateSource = 'crustdata' | 'unipile_search' | 'csv' | 'manual'

export type OutreachChannel = 'linkedin_dm' | 'email'

export type OutreachMessageType = 'connect_note' | 'dm1' | 'dm2' | 'email1' | 'email2'

export type OutreachStatus = 'draft' | 'approved' | 'sent' | 'replied' | 'failed'

// ─── Crustdata seniority mapping ──────────────────────────────────────────────
// Map our SeniorityLevel to Crustdata's expected strings
export const SENIORITY_TO_CRUSTDATA: Record<SeniorityLevel, string> = {
  junior: 'Entry',
  mid: 'Senior',        // Crustdata has no explicit "mid" — map to Senior-
  senior: 'Senior',
  staff: 'Senior',
  principal: 'Director',
  director: 'Director',
  vp: 'Vice President',
  'c-level': 'CXO',
}

// ─── Core domain types ────────────────────────────────────────────────────────

/** A job brief — the sourcing brief for one open role */
export interface JobBrief {
  id: string
  tenantId: string
  title: string
  seniority: SeniorityLevel
  skills: string[]            // required skills
  niceToHaveSkills: string[]
  location: string
  remotePolicy: RemotePolicy
  salaryMin: number | null
  salaryMax: number | null
  salaryCurrency: string
  openSignals: string[]       // LinkedIn headline/bio phrases indicating openness
  disqualifySignals: string[] // Hard-stop phrases — fail headline gate if matched
  clientName: string | null
  status: JobBriefStatus
  notionPageId: string | null
  createdAt: string
  updatedAt: string
}

/** Claude's per-dimension fit scores (25 pts each, total = 100) */
export interface FitBreakdown {
  skills: number     // 0–25: required skills coverage
  seniority: number  // 0–25: seniority level match
  location: number   // 0–25: location / remote policy fit
  openness: number   // 0–25: openness signals detected in profile
}

/** A sourced passive candidate, scoped to a job brief */
export interface Candidate {
  id: string
  tenantId: string
  jobBriefId: string
  providerId: string
  linkedinUrl: string | null
  firstName: string | null
  lastName: string | null
  headline: string | null
  currentCompany: string | null
  currentTitle: string | null
  location: string | null
  email: string | null
  // Fit scoring — set by score-candidate skill
  fitScore: number | null       // 0–100 composite
  fitReason: string | null      // prose from Claude Opus
  fitBreakdown: FitBreakdown | null
  // Pipeline
  pipelineStatus: CandidatePipelineStatus
  shortlisted: boolean
  shortlistRank: number | null
  // Outreach timestamps (LinkedIn)
  connectSentAt: string | null
  connectedAt: string | null
  dm1SentAt: string | null
  dm2SentAt: string | null
  repliedAt: string | null
  // Outreach timestamps (Email)
  email1SentAt: string | null
  emailRepliedAt: string | null
  // Meta
  source: CandidateSource
  rawData: Record<string, unknown> | null
  notionPageId: string | null
  createdAt: string
  updatedAt: string
}

/** A generated outreach message for a candidate */
export interface CandidateOutreachMessage {
  id: string
  tenantId: string
  candidateId: string
  jobBriefId: string
  channel: OutreachChannel
  messageType: OutreachMessageType
  content: string
  status: OutreachStatus
  sentAt: string | null
  repliedAt: string | null
  createdAt: string
}

// ─── Pipeline result types ────────────────────────────────────────────────────

export interface CandidatePipelineResult {
  jobBriefId: string
  sourced: number
  deduped: number       // removed as duplicates
  failedHeadline: number
  failedExclusion: number
  failedCompany: number
  enriched: number
  scored: number
  passedThreshold: number
  saved: number
  durationMs: number
}

export interface ShortlistResult {
  jobBriefId: string
  total: number
  shortlisted: number
  topScore: number
  avgScore: number
  candidates: Array<{
    rank: number
    id: string
    name: string
    currentTitle: string | null
    currentCompany: string | null
    fitScore: number
    fitReason: string | null
  }>
}
