CREATE TABLE `project_worktree_config` (
	`project_id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`sha256` text NOT NULL,
	`approved_at` integer NOT NULL,
	`approved_by` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
