CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`ts` integer NOT NULL,
	`source` text NOT NULL,
	`type` text NOT NULL,
	`state` text,
	`payload` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_events_run_idx` ON `run_events` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`agent` text NOT NULL,
	`state` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`permission_mode` text DEFAULT 'default' NOT NULL,
	`branch` text,
	`worktree_path` text NOT NULL,
	`ptyd_session_id` text,
	`agent_session_id` text,
	`transcript_path` text,
	`hook_token_hash` text NOT NULL,
	`last_event` text,
	`state_changed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_project_idx` ON `runs` (`project_id`);