DROP INDEX `idx_topics_run_score`;--> statement-breakpoint
CREATE INDEX `idx_topics_run_score` ON `topics` (`run_id`,`score`,`source_count`);