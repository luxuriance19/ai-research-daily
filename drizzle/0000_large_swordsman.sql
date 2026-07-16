CREATE TABLE `digests` (
	`date` text PRIMARY KEY NOT NULL,
	`generated_at` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
