import { Daytona } from "@daytonaio/sdk";
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY! });
const sb = await d.get(process.env.SB!);
const r = await sb.process.executeCommand(
  "echo '--EXIT'; cat /tmp/relayfile-initial-sync.exit.after-0822 2>&1; echo '--TMP STATE'; ls -l /tmp/relayfile-mount-initial-sync-*.json 2>&1; echo '--LOG'; tail -8 /tmp/relayfile-initial-sync.log.after-0822 2>&1; echo '--MIRROR'; du -sh /home/daytona/workspace; find /home/daytona/workspace -type f | wc -l",
  "/home/daytona", undefined, 90);
console.log(r.result);
