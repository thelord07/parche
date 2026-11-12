CREATE TABLE `secret_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`path` text NOT NULL,
	`hash` text NOT NULL,
	`kind` text NOT NULL,
	`fingerprint` text NOT NULL,
	`found_at` text NOT NULL,
	`resolved_at` text,
	`acknowledged_at` text,
	`acknowledged_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_findings_path_kind_fp_idx` ON `secret_findings` (`group_id`,`path`,`kind`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `secret_findings_open_idx` ON `secret_findings` (`group_id`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `secret_findings_ack_idx` ON `secret_findings` (`group_id`,`acknowledged_at`);--> statement-breakpoint
CREATE TABLE `secret_scan_state` (
	`group_id` text NOT NULL,
	`path` text NOT NULL,
	`hash` text NOT NULL,
	`scanned_at` text NOT NULL,
	PRIMARY KEY(`group_id`, `path`)
);
