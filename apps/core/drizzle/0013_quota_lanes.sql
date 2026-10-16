ALTER TABLE `quota_windows` ADD `agent` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `quota_windows` ADD `credential` text DEFAULT 'login' NOT NULL;--> statement-breakpoint
ALTER TABLE `quota_windows` ADD `pool` text DEFAULT '*' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `model` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `credential` text DEFAULT 'login' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `routes` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `route_index` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `predecessor_run_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `handed_off_to` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `handoff_count` integer DEFAULT 0 NOT NULL;