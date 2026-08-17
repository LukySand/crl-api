-- AlterTable
ALTER TABLE `fees` ADD COLUMN `category` ENUM('Reserva', 'CuotaSocio', 'Disciplina', 'Donacion', 'Otro') NOT NULL DEFAULT 'Otro';

-- Backfill: las tarifas que ya cuelgan de un turno o de una reserva son de
-- alquiler de espacio. El resto queda en 'Otro' y se reclasifica a mano.
UPDATE `fees` f
SET f.`category` = 'Reserva'
WHERE EXISTS (SELECT 1 FROM `schedules` s WHERE s.`fee_id` = f.`id`)
   OR EXISTS (SELECT 1 FROM `bookings` b WHERE b.`fee_id` = f.`id`);
