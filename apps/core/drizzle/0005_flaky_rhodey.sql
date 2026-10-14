ALTER TABLE `projects` ADD `app_type` text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `tech_stack` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `persona` text DEFAULT 'coder' NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `persona` text DEFAULT 'coder' NOT NULL;