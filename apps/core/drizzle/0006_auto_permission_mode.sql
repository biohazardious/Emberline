-- `acceptEdits` used to launch agents unattended. It now keeps Claude's command approval prompts and
-- the explicit `auto` mode runs unattended, so existing scheduled jobs and live runs keep their behaviour.
UPDATE `scheduled_jobs` SET `permission_mode` = 'auto' WHERE `permission_mode` = 'acceptEdits';
--> statement-breakpoint
UPDATE `runs` SET `permission_mode` = 'auto' WHERE `permission_mode` = 'acceptEdits' AND `ended_at` IS NULL;
