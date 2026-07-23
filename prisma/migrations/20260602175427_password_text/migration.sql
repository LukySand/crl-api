/*
  Warnings:

  - You are about to alter the column `name` on the `users` table. The data in that column could be lost. The data in that column will be cast from `VarChar(175)` to `VarChar(50)`.
  - You are about to alter the column `last_name` on the `users` table. The data in that column could be lost. The data in that column will be cast from `VarChar(175)` to `VarChar(50)`.
  - You are about to alter the column `email` on the `users` table. The data in that column could be lost. The data in that column will be cast from `VarChar(175)` to `VarChar(75)`.

*/
-- DropForeignKey
ALTER TABLE `users` DROP FOREIGN KEY `users_file_id_fkey`;

-- DropIndex
DROP INDEX `users_file_id_fkey` ON `users`;

-- AlterTable
ALTER TABLE `users` MODIFY `name` VARCHAR(50) NOT NULL,
    MODIFY `last_name` VARCHAR(50) NOT NULL,
    MODIFY `email` VARCHAR(75) NOT NULL,
    MODIFY `password` TEXT NOT NULL,
    MODIFY `file_id` INTEGER NULL;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_file_id_fkey` FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
