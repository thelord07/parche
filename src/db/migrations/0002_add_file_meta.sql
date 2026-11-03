CREATE TABLE `file_meta` (
	`group_id` text NOT NULL,
	`path` text NOT NULL,
	`hash` text NOT NULL,
	`title` text,
	`summary` text,
	`type` text,
	`tags_json` text,
	`work_item` text,
	`project` text,
	`conflict_of` text,
	`conflict_base` text,
	`links_json` text,
	PRIMARY KEY(`group_id`, `path`)
);
--> statement-breakpoint
CREATE INDEX `file_meta_group_idx` ON `file_meta` (`group_id`);
--> statement-breakpoint
CREATE INDEX `file_meta_conflict_idx` ON `file_meta` (`group_id`,`conflict_of`);
