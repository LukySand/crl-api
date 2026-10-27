/**
 * Preload de `bun test`: corre ANTES que cualquier import de los tests.
 *
 * `src/lib/prisma.ts` lee `DATABASE_URL` al importarse, así que el cambio va acá y no
 * en un `beforeAll`. Sin `DATABASE_URL_TEST` NO se aborta (los tests puros de `src/lib`
 * no necesitan base): se apunta a un destino inválido, así nada puede tocar la de dev.
 */
const testUrl = process.env.DATABASE_URL_TEST;

if (testUrl && testUrl === process.env.DATABASE_URL) {
  console.error(
    "\n❌ DATABASE_URL_TEST apunta a la MISMA base que DATABASE_URL.\n" +
      "   Los tests truncan tablas. Apuntá la de test a otra base (puerto 3307).\n",
  );
  process.exit(1);
}

process.env.DATABASE_URL =
  testUrl ?? "mysql://sin-base-de-test:invalido@127.0.0.1:1/sin_base_de_test";
