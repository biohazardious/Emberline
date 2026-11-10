CREATE TABLE `ssh_host_keys` (
	`host` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`key_type` text NOT NULL,
	`key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`trusted_at` integer NOT NULL,
	PRIMARY KEY(`host`, `port`, `key_type`)
);
--> statement-breakpoint
CREATE TABLE `ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`algorithm` text NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`private_key_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ssh_keys_scope_check" CHECK(("ssh_keys"."scope" = 'shared' and "ssh_keys"."project_id" is null) or "ssh_keys"."scope" = "ssh_keys"."project_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ssh_keys_scope_unique` ON `ssh_keys` (`scope`);--> statement-breakpoint
ALTER TABLE `projects` ADD `ssh_key_choice` text DEFAULT 'shared' NOT NULL;