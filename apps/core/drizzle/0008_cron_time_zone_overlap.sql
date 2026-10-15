ALTER TABLE `scheduled_jobs` ADD `time_zone` text;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `overlap_policy` text DEFAULT 'skip' NOT NULL;