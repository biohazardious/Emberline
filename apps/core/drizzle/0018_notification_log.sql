CREATE TABLE `notification_log` (
	`occurrence` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`sent_at` integer NOT NULL,
	`outcome` text NOT NULL
);
