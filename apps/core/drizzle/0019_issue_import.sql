CREATE TABLE `project_settings` (
	`project_id` text PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `tickets` ADD `external_source` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `external_number` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `external_url` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `external_state` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `external_labels` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `external_synced_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_external_idx` ON `tickets` (`project_id`,`external_source`,`external_id`);