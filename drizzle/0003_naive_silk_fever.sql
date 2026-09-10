CREATE TABLE `knowledge_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`kind` enum('document','faq') NOT NULL,
	`title` varchar(240) NOT NULL,
	`question` longtext,
	`content` longtext NOT NULL,
	`storageKey` varchar(500),
	`storageUrl` varchar(700),
	`mimeType` varchar(160),
	`fileName` varchar(255),
	`fileSize` int,
	`enabled` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `knowledge_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ai_agents` MODIFY COLUMN `personality` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_agents` MODIFY COLUMN `instructions` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_agents` MODIFY COLUMN `guardrails` longtext NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_agents` MODIFY COLUMN `blockedPhrases` longtext NOT NULL;