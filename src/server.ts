import "dotenv/config";
import express from "express";
import { authRouter } from "./routes/auth";
import { adminRouter } from "./routes/admin";
import { placesRouter } from "./routes/places";
import { schedulesRouter } from "./routes/schedules";
import { feesRouter } from "./routes/fees";
import { bookingsRouter } from "./routes/bookings";

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/places", placesRouter);
app.use("/api/schedules", schedulesRouter);
app.use("/api/fees", feesRouter);
app.use("/api/bookings", bookingsRouter);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`🚀 API CRL en http://localhost:${port}`);
});
