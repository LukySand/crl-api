-- Postulaciones de sponsors (issue #82). Tabla nueva, nada que backfillear.
-- `logo_file_id` apunta a `files` con ON DELETE SET NULL: borrar un logo no se
-- lleva la postulación, que es el registro del acuerdo.
-- CreateTable
CREATE TABLE `sponsor_applications` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `business_name` VARCHAR(150) NOT NULL,
    `contact_name` VARCHAR(100) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `phone` VARCHAR(30) NOT NULL,
    `sector` VARCHAR(100) NOT NULL,
    `contribution` VARCHAR(100) NOT NULL,
    `message` TEXT NOT NULL,
    `status` ENUM('Pendiente', 'Aprobada', 'Rechazada', 'Finalizada') NOT NULL DEFAULT 'Pendiente',
    `rejection_reason` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewed_at` DATETIME(3) NULL,
    `reviewed_by` VARCHAR(36) NULL,
    `logo_file_id` VARCHAR(191) NULL,
    `user_id` VARCHAR(191) NULL,

    INDEX `sponsor_applications_status_created_at_idx`(`status`, `created_at`),
    INDEX `sponsor_applications_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sponsor_applications` ADD CONSTRAINT `sponsor_applications_logo_file_id_fkey` FOREIGN KEY (`logo_file_id`) REFERENCES `files`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sponsor_applications` ADD CONSTRAINT `sponsor_applications_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
