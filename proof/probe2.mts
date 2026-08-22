import { Daytona } from "@daytonaio/sdk";
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY! });
const sb = await d.get(process.env.SB!);
const r = await sb.process.executeCommand(
  "for f in /tmp/relayfile-initial-sync.exit.*; do echo \"EXIT $f -> $(cat $f)\"; done; echo '=== LOG run2'; cat /tmp/relayfile-initial-sync.log.1787430841857-1t11wtpehb9",
  "/home/daytona", undefined, 60);
console.log(r.result);
