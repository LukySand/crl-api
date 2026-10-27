import "dotenv/config";
import { createApp } from "./app";

// ponytail: placeholder; B3 lo reemplaza por el scheduler real (respeta DISABLE_CRON).
function startScheduler() {}

const app = createApp();
const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`🚀 API CRL en http://localhost:${port}`);
});
startScheduler();
