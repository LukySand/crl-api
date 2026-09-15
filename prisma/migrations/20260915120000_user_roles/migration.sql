-- CreateTable
CREATE TABLE `user_roles` (
    `user_id` CHAR(128) NOT NULL,
    `role_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`user_id`, `role_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cada usuario arranca con el rol único que tenía. `role_id` queda como espejo
-- del rol principal hasta el PR de limpieza.
INSERT INTO `user_roles` (`user_id`, `role_id`) SELECT `id`, `role_id` FROM `users`;
