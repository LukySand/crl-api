import express from "express";
import { authRouter } from "./routes/auth";
import { filesRouter } from "./routes/files";
import { adminRouter } from "./routes/admin";
import { placesRouter } from "./routes/places";
import { schedulesRouter } from "./routes/schedules";
import { feesRouter } from "./routes/fees";
import { bookingsRouter } from "./routes/bookings";
import { disciplinesRouter } from "./routes/disciplines";
import { enrollmentsRouter } from "./routes/enrollments";
import { socioRouter } from "./routes/socio";
import { familiesRouter } from "./routes/families";
import { paymentsRouter } from "./routes/payments";
import { reportsRouter } from "./routes/reports";
import { partnerStoresRouter } from "./routes/partner-stores";
import { novedadesRouter } from "./routes/novedades";
import { blocksRouter } from "./routes/blocks";
import { settingsRouter } from "./routes/settings";
import { chargeTypesRouter, recurringTemplatesRouter } from "./routes/charge-catalog";

// ponytail: sin listen ni cron, así los tests montan la app en un puerto libre.
export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/files", filesRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/places", placesRouter);
  app.use("/api/schedules", schedulesRouter);
  app.use("/api/fees", feesRouter);
  app.use("/api/bookings", bookingsRouter);
  app.use("/api/disciplines", disciplinesRouter);
  app.use("/api/enrollments", enrollmentsRouter);
  app.use("/api/socio", socioRouter);
  app.use("/api/families", familiesRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/partner-stores", partnerStoresRouter);
  app.use("/api/novedades", novedadesRouter);
  app.use("/api/blocks", blocksRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/charge-types", chargeTypesRouter);
  app.use("/api/recurring-templates", recurringTemplatesRouter);
  return app;
}
