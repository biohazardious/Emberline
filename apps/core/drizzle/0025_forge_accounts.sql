CREATE TABLE `forge_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`server_url` text NOT NULL,
	`api_url` text NOT NULL,
	`username` text,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_accounts_server_url_idx` ON `forge_accounts` (`server_url`);