export const serviceName = "创客实验室工具资质闸门";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}
