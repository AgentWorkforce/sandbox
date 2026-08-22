import { Daytona } from "@daytonaio/sdk";
const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY! });
const sb = await d.get(process.env.SB!);
const r = await sb.process.executeCommand(
  "echo '--INITIAL SYNC FILES'; ls -l /tmp/relayfile-initial-sync* 2>&1 | head; echo '--SYNC LOG'; tail -6 /tmp/relayfile-initial-sync.log* 2>/dev/null | tail -20; echo '--MOUNT LOG'; tail -6 /tmp/relayfile-mount.log 2>/dev/null; echo '--STATEDIR'; find /home/daytona/.relayfile-mount-state -type f 2>/dev/null | head; echo '--PHANTOM'; ls -l /home/daytona/.relayfile-mount-state/.relayfile-mount-state.json 2>&1; echo '--MIRROR FILES'; find /home/daytona/workspace -type f 2>/dev/null | wc -l; echo '--PS'; ps aux | grep -c '[r]elayfile-mount'",
  "/home/daytona", undefined, 60);
console.log(r.result);
