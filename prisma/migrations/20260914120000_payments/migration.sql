-- Ledger de cuotas y cobros + tipo de tarifa.
--
-- Escrita a mano y no con `prisma migrate dev`: la base de dev se armó con
-- `db push` y tiene drift, así que `migrate dev` pediría resetearla. Todo lo de
-- acá es aditivo — no borra ni modifica datos existentes.

-- ── 1. Fee.kind ──────────────────────────────────────────────────────────
-- Arranca en 'Reserva' para todas: era el único uso que Fee tenía hasta ahora.
ALTER TABLE `fees`
  ADD COLUMN `kind` ENUM('Reserva', 'Disciplina', 'Socio') NOT NULL DEFAULT 'Reserva';

-- Backfill: las tarifas que hoy usa una disciplina pasan a 'Disciplina'.
--
-- Se excluyen las que además cuelgan de un turno o de una reserva. Esas están en
-- los dos lados a la vez (el agujero que `kind` viene a cerrar: hasta ahora nada
-- impedía que una disciplina apuntara a una tarifa de cancha) y marcarlas como
-- de disciplina rompería el lado de las canchas, que es el que ya está cobrando.
-- Quedan en 'Reserva' y hay que revisarlas a mano — la consulta de abajo las lista.
UPDATE `fees` f
SET f.`kind` = 'Disciplina'
WHERE EXISTS (SELECT 1 FROM `disciplines` d WHERE d.`fee_id` = f.`id`)
  AND NOT EXISTS (SELECT 1 FROM `schedules` s WHERE s.`fee_id` = f.`id`)
  AND NOT EXISTS (SELECT 1 FROM `bookings` b WHERE b.`fee_id` = f.`id`);

-- Tarifas compartidas entre una disciplina y una cancha. Deberían dar cero en una
-- base sana; si devuelve filas, hay que crear una tarifa nueva para la disciplina
-- y repuntar `disciplines.fee_id`.
--
--   SELECT f.id, f.name, f.amount
--   FROM `fees` f
--   WHERE EXISTS (SELECT 1 FROM `disciplines` d WHERE d.`fee_id` = f.`id`)
--     AND (EXISTS (SELECT 1 FROM `schedules` s WHERE s.`fee_id` = f.`id`)
--          OR EXISTS (SELECT 1 FROM `bookings` b WHERE b.`fee_id` = f.`id`));

-- ── 2. payments ──────────────────────────────────────────────────────────
CREATE TABLE `payments` (
  `id`            VARCHAR(191) NOT NULL,
  `user_id`       CHAR(128) NOT NULL,
  `concept`       ENUM('Reserva', 'Disciplina', 'Socio') NOT NULL,

  -- Origen: exactamente uno según el concepto.
  `enrollment_id` INTEGER NULL,
  `booking_id`    CHAR(128) NULL,

  -- Snapshot de la tarifa + copia congelada del monto: repuntar una tarifa no
  -- puede repreciar el historial.
  `fee_id`        INTEGER NULL,
  `amount`        DECIMAL(10, 2) NOT NULL,

  `period`        CHAR(7) NULL,
  `due_date`      DATE NOT NULL,
  `status`        ENUM('Pendiente', 'EnRevision', 'Pagado', 'Anulado') NOT NULL DEFAULT 'Pendiente',

  `paid_at`       DATETIME(3) NULL,
  `method`        ENUM('Efectivo', 'Transferencia', 'MercadoPago') NULL,
  `file_id`       CHAR(128) NULL,
  `registered_by` CHAR(128) NULL,
  `external_id`   VARCHAR(120) NULL,
  `notes`         TEXT NULL,

  -- Clave de idempotencia de la generación mensual.
  `ref`           VARCHAR(160) NOT NULL,

  `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `payments_ref_key` ON `payments`(`ref`);
-- Uniques que aceptan muchos NULL: MySQL los ignora en un índice único, el mismo
-- comportamiento del que ya depende `bookings.active`.
CREATE UNIQUE INDEX `payments_booking_id_key` ON `payments`(`booking_id`);
CREATE UNIQUE INDEX `payments_external_id_key` ON `payments`(`external_id`);

CREATE INDEX `payments_user_id_status_idx` ON `payments`(`user_id`, `status`);
CREATE INDEX `payments_status_due_date_idx` ON `payments`(`status`, `due_date`);
CREATE INDEX `payments_concept_due_date_idx` ON `payments`(`concept`, `due_date`);

ALTER TABLE `payments` ADD CONSTRAINT `payments_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_registered_by_fkey`
  FOREIGN KEY (`registered_by`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_enrollment_id_fkey`
  FOREIGN KEY (`enrollment_id`) REFERENCES `enrollments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_booking_id_fkey`
  FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_fee_id_fkey`
  FOREIGN KEY (`fee_id`) REFERENCES `fees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_file_id_fkey`
  FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
