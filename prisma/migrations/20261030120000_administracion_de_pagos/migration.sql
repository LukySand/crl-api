-- administracion_de_pagos: extiende el ledger de payments y agrega catalogo, plantillas, liquidaciones y reembolsos.
-- MySQL no es transaccional en DDL: NO re-ejecutar el archivo entero a ciegas. Cada paso esta guardado
-- (IF NOT EXISTS / INSERT IGNORE / WHERE) y, si falla a mitad, se reanuda desde el siguiente.
-- Estado para reanudar:
--   SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN
--     ('charge_types','recurring_templates','recurring_template_targets','payment_transactions','payment_transaction_items','refunds');
--   SHOW COLUMNS FROM payments;  -- name, deleted_at presentes? external_id sigue?
--   SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = DATABASE()
--     AND constraint_type = 'FOREIGN KEY' AND constraint_name LIKE '%concept_fkey';
-- Aplicacion y verificacion: manual (backup, db execute, migrate resolve --applied). Ver design.md, "Migracion".

-- 1. Catálogo y claves de sistema (antes de la FK)
CREATE TABLE IF NOT EXISTS `charge_types` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `key` VARCHAR(40) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT NULL,
  `suggested_amount` DECIMAL(10, 2) NULL,
  `due_rule` ENUM('Ninguna', 'DiasDesdeEmision', 'DiaDelMes') NOT NULL DEFAULT 'Ninguna',
  `due_value` SMALLINT UNSIGNED NULL,
  `system` BOOLEAN NOT NULL DEFAULT false,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `charge_types_key_key`(`key`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT IGNORE INTO charge_types (`key`, name, `system`, due_rule, updated_at) VALUES
  ('Reserva','Reserva',1,'Ninguna',NOW(3)), ('Disciplina','Cuota de disciplina',1,'DiaDelMes',NOW(3)),
  ('Socio','Cuota social',1,'DiaDelMes',NOW(3));
-- 2. payments en el lugar
ALTER TABLE payments
  MODIFY concept VARCHAR(40) NOT NULL, MODIFY period VARCHAR(10) NULL, MODIFY due_date DATE NULL,
  MODIFY status ENUM('Pendiente','EnRevision','Pagado','Anulado','Condonado') NOT NULL DEFAULT 'Pendiente',
  MODIFY method ENUM('Efectivo','Transferencia','MercadoPago','MPFueraDeApp','TarjetaConPosnet') NULL,
  ADD name VARCHAR(120) NOT NULL DEFAULT '', ADD description TEXT NULL, ADD template_id INT NULL,
  ADD created_by CHAR(128) NULL, ADD resolved_by CHAR(128) NULL, ADD resolved_reason TEXT NULL,
  ADD resolved_at DATETIME(3) NULL, ADD deleted_at DATETIME(3) NULL, ADD deleted_by CHAR(128) NULL,
  ADD deleted_reason TEXT NULL;
DROP INDEX payments_external_id_key ON payments;
ALTER TABLE payments DROP COLUMN external_id;
-- 3. Tablas nuevas
CREATE TABLE IF NOT EXISTS `recurring_templates` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `concept` VARCHAR(40) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `description` TEXT NULL,
  `amount` DECIMAL(10, 2) NULL,
  `period_mode` ENUM('DiaDelMes', 'CadaN') NOT NULL,
  `day_of_month` TINYINT UNSIGNED NULL,
  `every_n` SMALLINT UNSIGNED NULL,
  `unit` ENUM('Dias', 'Semanas', 'Meses') NULL,
  `start_date` DATE NOT NULL,
  `end_date` DATE NULL,
  `due_rule` ENUM('Ninguna', 'DiasDesdeEmision', 'DiaDelMes') NULL,
  `due_value` SMALLINT UNSIGNED NULL,
  `target_mode` ENUM('Todos', 'Disciplina', 'Lista', 'Socio') NOT NULL,
  `discipline_id` INTEGER NULL,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `created_by` CHAR(128) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `recurring_templates_active_idx`(`active`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `recurring_template_targets` (
  `template_id` INTEGER NOT NULL,
  `user_id` CHAR(128) NOT NULL,
  INDEX `recurring_template_targets_user_id_idx`(`user_id`),
  PRIMARY KEY (`template_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `payment_transactions` (
  `id` VARCHAR(191) NOT NULL,
  `user_id` CHAR(128) NOT NULL,
  `method` ENUM('Efectivo', 'Transferencia', 'MercadoPago', 'MPFueraDeApp', 'TarjetaConPosnet') NOT NULL,
  `status` ENUM('Pendiente', 'Aprobado', 'Rechazado', 'Cancelado', 'Reembolsado', 'ReembolsadoParcial', 'Contracargo', 'Anulado') NOT NULL DEFAULT 'Pendiente',
  `amount` DECIMAL(10, 2) NOT NULL,
  `registered_by` CHAR(128) NULL,
  `notes` TEXT NULL,
  `mp_payment_id` VARCHAR(64) NULL,
  `mp_preference_id` VARCHAR(64) NULL,
  `mp_status` VARCHAR(32) NULL,
  `mp_status_detail` VARCHAR(64) NULL,
  `mp_payment_method` VARCHAR(32) NULL,
  `mp_payment_type` VARCHAR(32) NULL,
  `mp_fee` DECIMAL(10, 2) NULL,
  `net_received_amount` DECIMAL(10, 2) NULL,
  `mp_last_updated` DATETIME(3) NULL,
  `checkout_url` VARCHAR(512) NULL,
  `raw` JSON NULL,
  `paid_at` DATETIME(3) NULL,
  `expires_at` DATETIME(3) NULL,
  `voided_by` CHAR(128) NULL,
  `voided_reason` TEXT NULL,
  `voided_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `payment_transactions_mp_payment_id_key`(`mp_payment_id`),
  INDEX `payment_transactions_user_id_status_idx`(`user_id`, `status`),
  INDEX `payment_transactions_status_expires_at_idx`(`status`, `expires_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `payment_transaction_items` (
  `transaction_id` VARCHAR(191) NOT NULL,
  `payment_id` VARCHAR(191) NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  INDEX `payment_transaction_items_payment_id_idx`(`payment_id`),
  PRIMARY KEY (`transaction_id`, `payment_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `refunds` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `transaction_id` VARCHAR(191) NOT NULL,
  `payment_id` VARCHAR(191) NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `reason` TEXT NULL,
  `requested_by` CHAR(128) NOT NULL,
  `income_reversal` BOOLEAN NOT NULL DEFAULT true,
  `refunded_at` DATETIME(3) NULL,
  `attempts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `last_error` VARCHAR(200) NULL,
  `resolved_by` CHAR(128) NULL,
  `resolved_note` TEXT NULL,
  `resolved_at` DATETIME(3) NULL,
  `mp_refund_id` VARCHAR(64) NULL,
  `idempotency_key` VARCHAR(160) NOT NULL,
  `raw` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `refunds_mp_refund_id_key`(`mp_refund_id`),
  UNIQUE INDEX `refunds_idempotency_key_key`(`idempotency_key`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3b. FKs (defaults de Prisma: requerida = RESTRICT/CASCADE, opcional = SET NULL/CASCADE).
--     Una por sentencia; si una ya existe, MySQL falla con "Duplicate foreign key" y se sigue
--     con la próxima.
ALTER TABLE `payments` ADD CONSTRAINT `payments_concept_fkey` FOREIGN KEY (`concept`) REFERENCES `charge_types`(`key`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `recurring_templates`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `recurring_templates` ADD CONSTRAINT `recurring_templates_concept_fkey` FOREIGN KEY (`concept`) REFERENCES `charge_types`(`key`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `recurring_templates` ADD CONSTRAINT `recurring_templates_discipline_id_fkey` FOREIGN KEY (`discipline_id`) REFERENCES `disciplines`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `recurring_template_targets` ADD CONSTRAINT `recurring_template_targets_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `recurring_templates`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `recurring_template_targets` ADD CONSTRAINT `recurring_template_targets_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `payment_transactions` ADD CONSTRAINT `payment_transactions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `payment_transaction_items` ADD CONSTRAINT `payment_transaction_items_transaction_id_fkey` FOREIGN KEY (`transaction_id`) REFERENCES `payment_transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `payment_transaction_items` ADD CONSTRAINT `payment_transaction_items_payment_id_fkey` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_transaction_id_fkey` FOREIGN KEY (`transaction_id`) REFERENCES `payment_transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_payment_id_fkey` FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Backfill de name (sólo filas sin nombre), luego se quita el default
UPDATE payments p LEFT JOIN enrollments e ON e.id = p.enrollment_id
  LEFT JOIN disciplines d ON d.id = e.discipline_id
SET p.name = CASE p.concept
  WHEN 'Reserva'    THEN CONCAT('Reserva ', DATE_FORMAT(p.due_date, '%d/%m/%Y'))
  WHEN 'Disciplina' THEN CONCAT('Cuota de ', COALESCE(d.name, 'disciplina'), ' ', COALESCE(p.period, ''))
  ELSE CONCAT('Cuota social ', COALESCE(p.period, '')) END
WHERE p.name = '';
ALTER TABLE payments ALTER COLUMN name DROP DEFAULT;
-- 5. Backfill de liquidaciones: una manual por fila Pagado (invariante de D4).
--    MercadoPago confirmado a mano en dev ⇒ MPFueraDeApp.
INSERT IGNORE INTO payment_transactions (id, user_id, method, status, amount, registered_by, paid_at, notes, updated_at)
SELECT CONCAT('mig:', id), user_id,
       CASE COALESCE(method, 'Efectivo') WHEN 'MercadoPago' THEN 'MPFueraDeApp' ELSE COALESCE(method, 'Efectivo') END,
       'Aprobado', amount, registered_by, COALESCE(paid_at, created_at), 'Migrado desde el ledger', NOW(3)
FROM payments WHERE status = 'Pagado';
INSERT IGNORE INTO payment_transaction_items (transaction_id, payment_id, amount)
SELECT CONCAT('mig:', id), id, amount FROM payments WHERE status = 'Pagado';
UPDATE payments SET method = 'MPFueraDeApp' WHERE status = 'Pagado' AND method = 'MercadoPago';
