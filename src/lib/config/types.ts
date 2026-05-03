export interface NotionConfig {
  campaigns_ds: string
  leads_ds: string
  variants_ds: string
  parent_page: string
  /** Optional: database ID for the Activity Log / notifications feed. */
  notifications_db?: string
  /** Optional: database ID for dedup review pages. Falls back to notifications_db if omitted. */
  dedup_review_db?: string
}

export interface UnipileConfig {
  daily_connect_limit: number
  sequence_timing: {
    connect_to_dm1_days: number
    dm1_to_dm2_days: number
  }
  rate_limit_ms: number
}

export interface LinkedInConfig {
  /** Provider id resolved against the registry for any `linkedin_send` step. */
  provider: string
}

export interface EmailConfig {
  /** Provider id resolved against the registry for any `email_send` step. */
  provider: string
}

export interface QualificationConfig {
  rules_path: string
  exclusion_path: string
  disqualifiers_path: string
  cache_ttl_days: number
}

export interface CrustdataConfig {
  max_results_per_query: number
}

export interface FullEnrichConfig {
  poll_interval_ms: number
  poll_timeout_ms: number
}

/** @deprecated Slack has been replaced by Notion Activity Log notifications. */
export interface SlackConfig {
  webhook_url: string
  notify_on: string[]
}

export interface GTMOSConfig {
  notion: NotionConfig
  unipile: UnipileConfig
  qualification: QualificationConfig
  crustdata?: CrustdataConfig
  fullenrich?: FullEnrichConfig
  /** @deprecated Use notion.notifications_db instead. Retained for config backward compatibility. */
  slack?: SlackConfig
  /** Outbound email channel selection (registry provider id). */
  email?: EmailConfig
  /** Outbound LinkedIn channel selection (registry provider id). */
  linkedin?: LinkedInConfig
}
