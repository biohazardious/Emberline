CREATE TABLE `run_event_compactions` (
	`run_id` text PRIMARY KEY NOT NULL,
	`compacted_at` integer NOT NULL,
	`through_event_id` integer NOT NULL,
	`events_removed` integer NOT NULL,
	`tool_calls` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cached_tokens` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `runs_project_idx`;--> statement-breakpoint
CREATE INDEX `runs_project_created_idx` ON `runs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_ticket_created_idx` ON `runs` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_state_changed_idx` ON `runs` (`state`,`state_changed_at`);--> statement-breakpoint
CREATE INDEX `tickets_project_position_idx` ON `tickets` (`project_id`,`position`);