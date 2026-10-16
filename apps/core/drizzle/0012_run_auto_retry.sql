ALTER TABLE `runs` ADD `auto_retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `auto_retry_at` integer;