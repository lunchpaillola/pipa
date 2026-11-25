import { randomUUID } from "node:crypto";

export function staleInstance(pid) {
  const birth = {
    darwin: "darwin:Sat Jan  1 00:00:00 2000",
    linux: "linux:00000000-0000-0000-0000-000000000000:1",
    win32: "win32:1",
  }[process.platform];
  return { pid, generation: randomUUID(), birth };
}
