CREATE TABLE `quota_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer,
	`exhausted_at` integer NOT NULL,
	`resets_at` integer,
	`resume_at` integer NOT NULL,
	`source` text NOT NULL,
	`message` text,
	`run_id` text,
	`resumed_at` integer
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `title` text;