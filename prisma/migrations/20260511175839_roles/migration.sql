/*
  Warnings:

  - You are about to alter the column `name` on the `roles` table. The data in that column could be lost. The data in that column will be cast from `VarChar(50)` to `Enum(EnumId(0))`.

*/
-- AlterTable
ALTER TABLE `roles` MODIFY `name` ENUM('Administrador', 'Profesor', 'Socio') NOT NULL;
