/**
 * Tareas programadas del proceso. Se arma de a poco: B3 registra la emisión
 * diaria; la conciliación de Mercado Pago y el barrido de reembolsos (cada 15 min) y el vencimiento
 * de holds de reservas (cada minuto). `DISABLE_CRON=true` lo apaga (tests, segundas instancias).
 */
import { liberarReservasVencidas } from "./booking-hold";
import { emitirCargos } from "./emission";
import { logger } from "./logger";
import { todayInClub } from "./payment-period";
import { syncPendingPayments } from "./payment-sync";
import { reintentarReembolsos } from "./refunds";

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

  // Red de seguridad del webhook: concilia hasta 50 liquidaciones MP pendientes de los últimos 7 días.
  Bun.cron("*/15 * * * *", async () => {
    try {
      const n = await syncPendingPayments({ limite: 50, desde: new Date(Date.now() - 7 * 24 * 3600_000) });
      if (n > 0) logger.info(`Conciliación MP: ${n} liquidaciones actualizadas`);
    } catch (error) {
      logger.error(error, "Conciliación MP falló");
    }
  });

  // Reembolsos `failed` o `pending` viejos (últimos 7 días), con la misma clave; nunca los `rejected`.
  Bun.cron("*/15 * * * *", async () => {
    try {
      const n = await reintentarReembolsos(20);
      if (n > 0) logger.info(`Reembolsos reintentados: ${n} aprobados`);
    } catch (error) {
      logger.error(error, "Reintento de reembolsos falló");
    }
  });

  // Reservas sin pagar: hold de 5 minutos (pagadas en el acto con MP, D14) y límite para cancelar (asignadas por la gestión).
  Bun.cron("* * * * *", async () => {
    const n = await liberarReservasVencidas(); // nunca lanza
    if (n > 0) logger.info(`Reservas liberadas por vencer el plazo de pago: ${n}`);
  });
}
