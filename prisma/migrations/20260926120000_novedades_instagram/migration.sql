-- CreateTable
CREATE TABLE `instagram_config` (
    `id` INTEGER NOT NULL,
    `access_token` TEXT NULL,
    `token_updated_at` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `novedad_links` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `kind` VARCHAR(10) NOT NULL,
    `pinned` BOOLEAN NOT NULL DEFAULT false,
    `position` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `novedad_links_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Publicaciones iniciales del club (los dos primeros son los fijados del perfil).
INSERT IGNORE INTO `novedad_links` (`code`, `kind`, `pinned`, `position`) VALUES
  ('DaDYdUDRm2H', 'p',    true,  0),
  ('DJPjUj3yN-V', 'p',    true,  1),
  ('De1tgTPxIq7', 'p',    false, 2),
  ('De1sZWeRMXQ', 'p',    false, 3),
  ('DexlV10CYWc', 'reel', false, 4),
  ('DexVd8TmbmV', 'p',    false, 5),
  ('Dewmp07kQ54', 'p',    false, 6);
