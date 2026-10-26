-- Red de seguridad: a cualquier usuario que todavía no tenga sus roles en la
-- tabla nueva se los copia desde `role_id` antes de borrar la columna. Si ya
-- están (lo normal, lo hizo la migración de user_roles), no inserta nada.
INSERT INTO `user_roles` (`user_id`, `role_id`)
SELECT u.`id`, u.`role_id` FROM `users` u
WHERE NOT EXISTS (SELECT 1 FROM `user_roles` ur WHERE ur.`user_id` = u.`id`);

-- DropForeignKey
ALTER TABLE `users` DROP FOREIGN KEY `users_role_id_fkey`;

-- DropIndex
DROP INDEX `users_role_id_fkey` ON `users`;

-- AlterTable
ALTER TABLE `users` DROP COLUMN `role_id`;
