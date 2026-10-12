CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`number` integer NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 1 NOT NULL,
	`position` real NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_project_number_idx` ON `tickets` (`project_id`,`number`);--> statement-breakpoint
ALTER TABLE `runs` ADD `ticket_id` text REFERENCES tickets(id) ON DELETE set null;