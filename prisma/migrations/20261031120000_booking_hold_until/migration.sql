-- AlterTable
ALTER TABLE `bookings` ADD COLUMN `hold_until` DATETIME(3) NULL;

-- Backfill: las reservas pendientes con una liquidación de MP eran las del hold de 5 minutos.
UPDATE `bookings` b
SET b.`hold_until` = DATE_ADD(b.`created_at`, INTERVAL 5 MINUTE)
WHERE b.`status` = 'Pendiente'
  AND EXISTS (
    SELECT 1
    FROM `payments` p
    JOIN `payment_transaction_items` i ON i.`payment_id` = p.`id`
    JOIN `payment_transactions` t ON t.`id` = i.`transaction_id`
    WHERE p.`booking_id` = b.`id` AND t.`method` = 'MercadoPago'
  );
