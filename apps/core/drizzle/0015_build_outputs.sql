CREATE TABLE `build_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`ticket_id` text,
	`name` text NOT NULL,
	`source_path` text NOT NULL,
	`stored_path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`source_mtime` integer NOT NULL,
	`archived_at` integer NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `build_outputs_project_archived_idx` ON `build_outputs` (`project_id`,`archived_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `build_outputs_run_source_idx` ON `build_outputs` (`run_id`,`source_path`);