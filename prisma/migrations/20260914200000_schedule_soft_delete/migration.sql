-- Baja lógica de turnos (Schedule).
--
-- El DELETE hacía un borrado duro y rebotaba contra la foreign key de bookings.
-- Como las reservas canceladas conservan su fila (active = null, para no perder
-- el historial), una sola reserva cancelada vieja volvía el turno ineliminable
-- para siempre.
--
-- EL ORDEN DE ESTAS SENTENCIAS IMPORTA, por dos razones distintas:
--
--  1. El backfill va ANTES de tocar los índices. Si no, las filas existentes
--     quedan con active = NULL: invisibles en todo el producto y además exentas
--     del control de unicidad.
--
--  2. El índice nuevo se crea ANTES de borrar el viejo. `schedules.place_id`
--     tiene una foreign key y el único índice que la sostenía era el viejo
--     (place_id es su columna más a la izquierda). Borrarlo primero deja la FK
--     sin índice y MySQL corta con el error 1553, "Cannot drop index needed in
--     a foreign key constraint". El índice nuevo también arranca con place_id,
--     así que una vez creado la FK queda cubierta y recién ahí se puede borrar
--     el viejo.

-- 1. La columna nace nullable: null = dado de baja.
ALTER TABLE `schedules` ADD COLUMN `active` TINYINT(1) NULL;

-- 2. Todo lo que ya existía está vivo. Ningún turno puede desaparecer del
--    producto por esta migración.
UPDATE `schedules` SET `active` = 1 WHERE `active` IS NULL;

-- 3. El unique nuevo incluye `active`: MySQL ignora los NULL en índices únicos,
--    así que conviven muchos turnos muertos y uno solo vivo por (espacio, día,
--    hora de inicio).
CREATE UNIQUE INDEX `schedules_place_id_day_of_week_start_time_active_key`
  ON `schedules` (`place_id`, `day_of_week`, `start_time`, `active`);

-- 4. Recién ahora, con la FK ya cubierta por el índice nuevo.
DROP INDEX `schedules_place_id_day_of_week_start_time_key` ON `schedules`;
