/**
 * Tareas programadas del proceso. Se arma de a poco: B3 registra la emisión
 * diaria; la conciliación de Mercado Pago y el vencimiento de holds se suman en
 * sus slices. `DISABLE_CRON=true` lo apaga (tests, segundas instancias).
 */
import { emitirCargos } from "./emission";
import { logger } from "./logger";
import { todayInClub } from "./payment-period";

export function startScheduler(): void {
  if (process.env.DISABLE_CRON === "true") return;

  // 06:00 en el huso del proceso; "hoy" se calcula siempre contra el reloj del club.
  Bun.cron("0 6 * * *", async () => {
    try {
      const r = await emitirCargos({ hoy: todayInClub() });
      logger.info(`Emisión diaria: ${r.generadas} generadas de ${r.candidatas} candidatas`);
    } catch (error) {
      logger.error(error, "Emisión diaria falló");
    }
  });
}
