import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: process.env.CHROME, args: ["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"] });
async function who(email: string, name: string, cam: boolean) {
  const p = await (await b.newContext({ viewport: { width: 1200, height: 760 }, permissions: ["camera","microphone"] })).newPage();
  await p.goto(`http://localhost:5173/auth/dev?email=${email}&name=${encodeURIComponent(name)}`);
  if (!cam) await p.getByRole("button", { name: "Camera off" }).click();
  await p.getByRole("button", { name: "Join Space" }).click();
  await p.waitForFunction(() => (window as any).__es?.state?.me);
  await p.keyboard.press("c");
  return p;
}
const z = await who("admin@example.com", "Alex Admin", false);
const a = await who("morgan@example.com", "Morgan Lee", false);
const t = await who("riley@example.com", "Riley Park", true);
await z.evaluate(() => { const e = (window as any).__es; e.camera.zoom = 1.25; e.jump({ x: 1630, y: 1060 }); });
await a.evaluate(() => (window as any).__es.jump({ x: 1500, y: 1120 }));
await t.evaluate(() => (window as any).__es.jump({ x: 1760, y: 1110 }));
await z.waitForTimeout(1500);
await a.evaluate(() => (window as any).__es.walk({ x: 1300, y: 1230 }));
await z.waitForTimeout(450);
await z.screenshot({ path: "/tmp/es-walk.png" });
await b.close();
