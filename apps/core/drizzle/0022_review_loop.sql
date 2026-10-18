PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_review_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`file_path` text NOT NULL,
	`line` integer,
	`side` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`intent` text DEFAULT 'fix' NOT NULL,
	`priority` text DEFAULT 'important' NOT NULL,
	`anchor_text` text,
	`anchor_hash` text,
	`round` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`carried_to` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`resolved_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Hand-edited: drizzle-kit selected the new columns from the old table. Only the legacy columns are copied; the new ones take their defaults.
INSERT INTO `__new_review_comments`("id", "run_id", "file_path", "line", "side", "body", "status", "created_at", "sent_at", "resolved_at") SELECT "id", "run_id", "file_path", "line", "side", "body", "status", "created_at", "sent_at", "resolved_at" FROM `review_comments`;--> statement-breakpoint
DROP TABLE `review_comments`;--> statement-breakpoint
ALTER TABLE `__new_review_comments` RENAME TO `review_comments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `review_comments_run_idx` ON `review_comments` (`run_id`);