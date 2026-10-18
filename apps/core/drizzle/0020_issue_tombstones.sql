CREATE TABLE `issue_tombstones` (
	`project_id` text NOT NULL,
	`external_source` text NOT NULL,
	`external_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `external_source`, `external_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
