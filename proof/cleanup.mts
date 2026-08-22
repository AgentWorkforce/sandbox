import { Daytona } from "@daytonaio/sdk";
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY! });
for (const id of (process.env.SBS ?? "").split(",").filter(Boolean)) {
  try { const sb = await d.get(id); await sb.delete(); console.log("destroyed", id); }
  catch (e) { console.log("skip", id, (e as Error).message.slice(0, 120)); }
}
const all: any = await d.list({ owner: "relayfile-mount-500" });
const items = Array.isArray(all) ? all : (all?.items ?? []);
console.log("remaining owned by relayfile-mount-500:", items.map((s: any) => `${s.id}:${s.state}`).join(", ") || "(none)");
