import "dotenv/config";
import express from "express";
import { authRouter } from "./routes/auth";
import { filesRouter } from "./routes/files";

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);
app.use("/api/files", filesRouter);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`🚀 API CRL en http://localhost:${port}`);
});
