CREATE TABLE `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`cron_expr` text NOT NULL,
	`prompt` text NOT NULL,
	`permission_mode` text DEFAULT 'acceptEdits' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_id` text,
	`last_run_at` integer,
	`next_run_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `scheduled_jobs_project_idx` ON `scheduled_jobs` (`project_id`);