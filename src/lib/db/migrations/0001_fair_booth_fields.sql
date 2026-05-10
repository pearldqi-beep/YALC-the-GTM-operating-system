-- Add fair/exhibition booth interaction fields to campaign_leads
-- These fields are populated by the import-badge-scans skill and
-- are injected into Gate 5 AI scoring (qualify-provider.ts).

ALTER TABLE `campaign_leads` ADD COLUMN `staff_rating` text;
--> statement-breakpoint
ALTER TABLE `campaign_leads` ADD COLUMN `demo_attended` integer DEFAULT false;
--> statement-breakpoint
ALTER TABLE `campaign_leads` ADD COLUMN `dwell_minutes` integer;
--> statement-breakpoint
ALTER TABLE `campaign_leads` ADD COLUMN `materials_collected` text;
--> statement-breakpoint
ALTER TABLE `campaign_leads` ADD COLUMN `session_attended` text;
--> statement-breakpoint
ALTER TABLE `campaign_leads` ADD COLUMN `fair_name` text;
--> statement-breakpoint
ALTER TABLE `campaign_leads` ADD COLUMN `fair_date` text;
