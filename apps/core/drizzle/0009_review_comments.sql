CREATE TABLE `review_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`file_path` text NOT NULL,
	`line` integer NOT NULL,
	`side` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`resolved_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_comments_run_idx` ON `review_comments` (`run_id`);--> statement-breakpoint
CREATE TABLE `review_file_views` (
	`run_id` text NOT NULL,
	`file_path` text NOT NULL,
	`signature` text NOT NULL,
	`viewed_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_file_views_run_file_idx` ON `review_file_views` (`run_id`,`file_path`);