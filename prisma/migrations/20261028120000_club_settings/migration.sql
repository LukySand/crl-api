-- CreateTable
CREATE TABLE `club_settings` (
    `id` INTEGER NOT NULL,
    `cancel_hours_before` INTEGER NOT NULL DEFAULT 10,
    `days_ahead_member` INTEGER NOT NULL DEFAULT 21,
    `days_ahead_admin` INTEGER NOT NULL DEFAULT 183,
    `payment_due_day` INTEGER NOT NULL DEFAULT 10,
    `updated_by` CHAR(128) NULL,
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
