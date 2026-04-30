/**
 * Fair catalog context loader.
 *
 * Wires a fair/exhibition catalog directory into a tenant's memory layer
 * via the existing markdown-folder adapter. Writes/merges the tenant's
 * adapters.yaml so the adapter picks up the catalog on next sync.
 *
 * Usage:
 *   await loadFairCatalog('default', 'hannover-messe-2026', '/path/to/catalog')
 *
 * The catalog directory should contain markdown files — exhibitor list,
 * visitor profile, session schedule, floor plan, etc. Any .md file in the
 * directory is eligible.
 *
 * After calling this function, run:
 *   yalc-gtm context:sync   (or the adapter will sync on next watch trigger)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { tenantConfigDir } from '../tenant/index.js'

interface AdapterEntry {
  id: string
  enabled?: boolean
  base_dir?: string
  paths?: string[]
  [key: string]: unknown
}

interface AdaptersYaml {
  adapters: AdapterEntry[]
}

export interface FairCatalogConfig {
  tenantId: string
  fairSlug: string       // e.g. "hannover-messe-2026"
  catalogPath: string    // absolute path to the catalog markdown directory
}

export interface LoadFairCatalogResult {
  configPath: string
  fairSlug: string
  catalogPath: string
  isNew: boolean         // true = added, false = updated existing entry
}

/**
 * Register a fair catalog directory with the markdown-folder adapter.
 * Safe to call multiple times — updates in place if already registered.
 */
export async function loadFairCatalog(
  tenantId: string,
  fairSlug: string,
  catalogPath: string,
): Promise<LoadFairCatalogResult> {
  const configDir = tenantConfigDir(tenantId)
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })

  const configPath = join(configDir, 'adapters.yaml')

  // Load existing adapters.yaml or start fresh
  let parsed: AdaptersYaml = { adapters: [] }
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8')
      const loaded = yaml.load(raw) as AdaptersYaml | null
      if (loaded?.adapters && Array.isArray(loaded.adapters)) {
        parsed = loaded
      }
    } catch {
      // malformed YAML — overwrite
    }
  }

  // Find or create the markdown-folder adapter entry
  let entry = parsed.adapters.find(a => a.id === 'markdown-folder')
  let isNew = false

  if (!entry) {
    entry = {
      id: 'markdown-folder',
      enabled: true,
      base_dir: catalogPath,
      paths: ['**/*.md'],
    }
    parsed.adapters.push(entry)
    isNew = true
  } else {
    // Update base_dir to the fair catalog path. If they want to keep
    // previous sources they can add multiple adapters entries in future.
    entry.base_dir = catalogPath
    entry.paths = entry.paths ?? ['**/*.md']
    entry.enabled = true
  }

  writeFileSync(configPath, yaml.dump(parsed), 'utf-8')

  return { configPath, fairSlug, catalogPath, isNew }
}

/**
 * Returns the expected catalog path convention for a given fair slug.
 * Creates the directory if it does not exist.
 */
export function fairCatalogDir(fairSlug: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
  const dir = join(home, '.gtm-os', 'contexts', fairSlug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
