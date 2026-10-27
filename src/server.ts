import "dotenv/config";
import { createApp } from "./app";
import { startScheduler } from "./lib/scheduler";

const app = createApp();
const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`🚀 API CRL en http://localhost:${port}`);
});
startScheduler();
