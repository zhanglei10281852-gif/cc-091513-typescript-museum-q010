import { createApp } from "./http/app.js";
import { healthPayload, serviceName } from "./http/service-info.js";
import { LabService } from "./service/lab-service.js";
import { JsonStore } from "./store/store.js";

export { createApp, healthPayload, serviceName, LabService, JsonStore };

/**
 * 生产引导：JSON 数据落到 .runtime/store.json，
 * 返回已装配好的 HTTP 服务。
 */
export function createDefaultApp(): ReturnType<typeof createApp> {
  const store = new JsonStore(process.env.STORE_FILE ?? ".runtime/store.json");
  const service = new LabService(store);
  return createApp(service);
}
