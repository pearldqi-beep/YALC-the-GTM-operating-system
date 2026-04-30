import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import type { Skill, SkillEvent, SkillContext } from '../types'

export interface BadgeScanRow {
  first_name: string
  last_name: string
  company: string
  title: string
  email: string
  phone?: string
  // Optional booth interaction fields from scanner systems
  staff_rating?: 'hot' | 'warm' | 'cold'
  demo_attended?: boolean
  dwell_minutes?: number
  materials_collected?: string[]
  session_attended?: string[]
  fair_name?: string
  fair_date?: string
}

// Canonical column name map — handles scanner system variations
const FIELD_ALIASES: Record<string, keyof BadgeScanRow> = {
  // name
  first_name: 'first_name', firstname: 'first_name', 'first name': 'first_name', fname: 'first_name',
  last_name: 'last_name', lastname: 'last_name', 'last name': 'last_name', lname: 'last_name',
  // company
  company: 'company', company_name: 'company', 'company name': 'company', organisation: 'company', organization: 'company', employer: 'company',
  // title
  title: 'title', job_title: 'title', 'job title': 'title', position: 'title', role: 'title',
  // contact
  email: 'email', email_address: 'email', 'email address': 'email',
  phone: 'phone', phone_number: 'phone', mobile: 'phone', telephone: 'phone',
  // booth interaction
  staff_rating: 'staff_rating', rating: 'staff_rating', interest: 'staff_rating', priority: 'staff_rating',
  demo_attended: 'demo_attended', demo: 'demo_attended', attended_demo: 'demo_attended',
  dwell_minutes: 'dwell_minutes', dwell: 'dwell_minutes', time_at_booth: 'dwell_minutes', booth_time: 'dwell_minutes',
  materials_collected: 'materials_collected', materials: 'materials_collected', collateral: 'materials_collected',
  session_attended: 'session_attended', session: 'session_attended', sessions: 'session_attended',
  fair_name: 'fair_name', fair: 'fair_name', event: 'fair_name', event_name: 'fair_name',
  fair_date: 'fair_date', event_date: 'fair_date', date: 'fair_date',
}

function normalizeHeader(h: string): keyof BadgeScanRow | null {
  const key = h.trim().toLowerCase().replace(/[^a-z0-9_\s]/g, '')
  return FIELD_ALIASES[key] ?? null
}

function parseCsvLine(line: string): string[] {
  const cols: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      cols.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  cols.push(current.trim())
  return cols
}

function normalizeRating(raw: string): 'hot' | 'warm' | 'cold' | undefined {
  const v = raw.toLowerCase().trim()
  if (['hot', 'h', '3', 'high', 'a'].includes(v)) return 'hot'
  if (['warm', 'w', '2', 'medium', 'b'].includes(v)) return 'warm'
  if (['cold', 'c', '1', 'low', 'd'].includes(v)) return 'cold'
  return undefined
}

async function parseCsv(filePath: string): Promise<{ headers: string[]; rows: string[][] }> {
  return new Promise((resolve, reject) => {
    const headers: string[] = []
    const rows: string[][] = []
    let isFirst = true

    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
    rl.on('line', line => {
      if (!line.trim()) return
      const cols = parseCsvLine(line)
      if (isFirst) {
        headers.push(...cols)
        isFirst = false
      } else {
        rows.push(cols)
      }
    })
    rl.on('close', () => resolve({ headers, rows }))
    rl.on('error', reject)
  })
}

export const importBadgeScansSkill: Skill = {
  id: 'import-badge-scans',
  name: 'Import Badge Scans',
  version: '1.0.0',
  description:
    'Ingest a badge scanner CSV from a trade fair or exhibition. Normalises field names, deduplicates by email, and outputs leads ready for the qualification pipeline.',
  category: 'data',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to the badge scanner CSV file' },
      fairName: { type: 'string', description: 'Name of the fair/event (used in outreach context)' },
      fairDate: { type: 'string', description: 'Date of the fair (ISO format, e.g. 2026-05-15)' },
      defaultRating: {
        type: 'string',
        enum: ['hot', 'warm', 'cold'],
        description: 'Default staff rating for rows that have none (default: warm)',
      },
    },
    required: ['file'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      leads: { type: 'array', items: { type: 'object' } },
      total: { type: 'number' },
      dedupedCount: { type: 'number' },
      skippedCount: { type: 'number' },
    },
  },
  requiredCapabilities: [],

  async *execute(input: unknown, _context: SkillContext): AsyncIterable<SkillEvent> {
    const {
      file,
      fairName,
      fairDate,
      defaultRating = 'warm',
    } = input as {
      file: string
      fairName?: string
      fairDate?: string
      defaultRating?: 'hot' | 'warm' | 'cold'
    }

    yield { type: 'progress', message: `Reading ${file}...`, percent: 5 }

    let parsed: { headers: string[]; rows: string[][] }
    try {
      parsed = await parseCsv(file)
    } catch (err) {
      yield { type: 'error', message: `Cannot read CSV: ${err instanceof Error ? err.message : String(err)}` }
      return
    }

    const { headers, rows } = parsed
    yield { type: 'progress', message: `Parsed ${rows.length} rows, ${headers.length} columns`, percent: 15 }

    // Map column indexes to canonical field names
    const colMap: Record<number, keyof BadgeScanRow> = {}
    const unrecognised: string[] = []
    headers.forEach((h, i) => {
      const field = normalizeHeader(h)
      if (field) colMap[i] = field
      else unrecognised.push(h)
    })

    if (unrecognised.length > 0) {
      yield {
        type: 'progress',
        message: `Unrecognised columns (ignored): ${unrecognised.join(', ')}`,
        percent: 20,
      }
    }

    // Verify required columns are present
    const mappedFields = new Set(Object.values(colMap))
    const missing: string[] = []
    if (!mappedFields.has('email')) missing.push('email')
    if (!mappedFields.has('first_name') && !mappedFields.has('last_name')) missing.push('first_name / last_name')

    if (missing.length > 0) {
      yield {
        type: 'error',
        message: `CSV is missing required columns: ${missing.join(', ')}. Found: ${headers.join(', ')}`,
      }
      return
    }

    yield { type: 'progress', message: 'Normalising and deduplicating...', percent: 30 }

    const seen = new Set<string>()
    const leads: BadgeScanRow[] = []
    let skipped = 0

    for (const row of rows) {
      const raw: Partial<Record<keyof BadgeScanRow, string>> = {}
      for (const [idxStr, field] of Object.entries(colMap)) {
        const val = row[Number(idxStr)]?.trim() ?? ''
        if (val) (raw as Record<string, string>)[field] = val
      }

      const email = raw.email?.toLowerCase().trim()
      if (!email || seen.has(email)) {
        skipped++
        continue
      }
      seen.add(email)

      const rating = raw.staff_rating
        ? normalizeRating(raw.staff_rating)
        : defaultRating

      const lead: BadgeScanRow = {
        first_name: raw.first_name ?? '',
        last_name: raw.last_name ?? '',
        company: raw.company ?? '',
        title: raw.title ?? '',
        email,
        phone: raw.phone,
        staff_rating: rating,
        demo_attended: raw.demo_attended
          ? ['true', '1', 'yes', 'y'].includes(raw.demo_attended.toLowerCase())
          : false,
        dwell_minutes: raw.dwell_minutes ? parseInt(raw.dwell_minutes, 10) || undefined : undefined,
        materials_collected: raw.materials_collected
          ? raw.materials_collected.split(/[;|]+/).map(s => s.trim()).filter(Boolean)
          : [],
        session_attended: raw.session_attended
          ? raw.session_attended.split(/[;|]+/).map(s => s.trim()).filter(Boolean)
          : [],
        fair_name: fairName ?? raw.fair_name ?? '',
        fair_date: fairDate ?? raw.fair_date ?? '',
      }

      leads.push(lead)
    }

    yield {
      type: 'progress',
      message: `${leads.length} unique leads (${skipped} skipped: duplicates or missing email)`,
      percent: 80,
    }

    // Summary by rating
    const hot = leads.filter(l => l.staff_rating === 'hot').length
    const warm = leads.filter(l => l.staff_rating === 'warm').length
    const cold = leads.filter(l => l.staff_rating === 'cold').length
    const withDemo = leads.filter(l => l.demo_attended).length

    yield {
      type: 'progress',
      message: `Ratings — hot: ${hot}  warm: ${warm}  cold: ${cold}  demo attended: ${withDemo}`,
      percent: 90,
    }

    yield {
      type: 'result',
      data: {
        leads,
        total: rows.length,
        dedupedCount: leads.length,
        skippedCount: skipped,
      },
    }

    yield {
      type: 'progress',
      message: `Done. ${leads.length} leads ready for qualification pipeline.`,
      percent: 100,
    }
  },
}
