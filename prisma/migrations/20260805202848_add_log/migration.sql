-- CreateTable
CREATE TABLE `logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `topic` VARCHAR(191) NOT NULL,
    `level` ENUM('DEBUG', 'INFO', 'ERROR') NOT NULL,
    `date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `text` VARCHAR(191) NOT NULL,
    `user_id` INTEGER NULL,
    `request_url` VARCHAR(191) NULL,
    `data` JSON NULL,
    `error` VARCHAR(191) NULL,
    `stack_trace` VARCHAR(191) NULL,
    `metadata` JSON NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
