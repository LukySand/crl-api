
ALTER TABLE `families` ADD COLUMN `child_id` CHAR(128) NULL;

UPDATE `families` SET `child_id` = 'a0000000-0000-4000-8000-000000000008'
  WHERE `id` = 'b0000000-0000-4000-8000-000000000001' AND `child_id` IS NULL;
UPDATE `families` SET `child_id` = 'a0000000-0000-4000-8000-000000000009'
  WHERE `id` = 'b0000000-0000-4000-8000-000000000002' AND `child_id` IS NULL;

-- Cualquier otra fila vieja sin hijo conocido no es un vínculo válido.
DELETE FROM `families` WHERE `child_id` IS NULL;

ALTER TABLE `families` MODIFY COLUMN `child_id` CHAR(128) NOT NULL;
ALTER TABLE `families` ADD COLUMN `active` BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE `families` ADD COLUMN `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

CREATE UNIQUE INDEX `families_parent_id_child_id_key` ON `families`(`parent_id`, `child_id`);

ALTER TABLE `families` ADD CONSTRAINT `families_child_id_fkey` FOREIGN KEY (`child_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `users` ADD COLUMN `has_credentials` BOOLEAN NOT NULL DEFAULT true;
