import { createDefaultApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";

createDefaultApp().listen(port, host, () => {
  process.stdout.write(`service listening on ${host}:${port}\n`);
});
