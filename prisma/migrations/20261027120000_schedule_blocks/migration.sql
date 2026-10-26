-- CreateTable
CREATE TABLE `schedule_blocks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `place_id` INTEGER NOT NULL,
    `date_from` DATE NOT NULL,
    `date_to` DATE NOT NULL,
    `start_time` TIME(0) NULL,
    `end_time` TIME(0) NULL,
    `reason` VARCHAR(255) NOT NULL,
    `created_by` CHAR(128) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `schedule_blocks_place_id_date_from_date_to_idx`(`place_id`, `date_from`, `date_to`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `schedule_blocks` ADD CONSTRAINT `schedule_blocks_place_id_fkey`
  FOREIGN KEY (`place_id`) REFERENCES `places`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
