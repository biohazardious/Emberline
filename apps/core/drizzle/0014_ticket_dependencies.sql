CREATE TABLE `ticket_dependencies` (
	`ticket_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`ticket_id`, `depends_on_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_dependencies_depends_on_idx` ON `ticket_dependencies` (`depends_on_id`);