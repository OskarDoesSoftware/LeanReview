import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
let stopped = false;
process.stdin.resume();
process.stdin.on("end", () => {
  stopped = true;
});
while (!stopped) {
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) throw new Error("Invalid process memory table.");
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        rss: Number(match[3]) * 1024,
        name: match[4].split("/").at(-1),
      };
    });
  console.log(JSON.stringify(rows));
  if (!stopped) await new Promise((resolve) => setTimeout(resolve, 200));
}
