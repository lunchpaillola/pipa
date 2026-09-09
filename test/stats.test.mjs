import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateStats } from "../scripts/stats.mjs";

const header = "# Pipa download statistics\n\nThese are npm package downloads for `@usepipa/pipa`, not installs, users, active users, or conversions.\n\n| Date (UTC) | Cumulative npm downloads | Change since prior snapshot |\n| --- | ---: | ---: |\n";

test("creates, appends, catches up, and preserves safe statistics history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipa-stats-"));
  const statsPath = path.join(directory, "STATS.md");
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => ({
      package: "@usepipa/pipa",
      downloads: url.includes("2020-01-01")
        ? [{ day: "2025-03-08", downloads: 4 }, { day: "2025-03-09", downloads: 6 }]
        : [{ day: "2025-03-10", downloads: 8 }],
    }),
  });

  await updateStats({ statsPath, date: new Date("2025-03-10T12:00:00Z"), fetchImpl });
  assert.equal(await readFile(statsPath, "utf8"), `${header}| 2025-03-09 | 10 | n/a |\n`);

  await updateStats({ statsPath, date: new Date("2025-03-11T12:00:00Z"), fetchImpl });
  assert.equal(await readFile(statsPath, "utf8"), `${header}| 2025-03-09 | 10 | n/a |\n| 2025-03-10 | 18 | 8 |\n`);

  const unchanged = await readFile(statsPath, "utf8");
  await updateStats({ statsPath, date: new Date("2025-03-11T12:00:00Z"), fetchImpl });
  assert.equal(await readFile(statsPath, "utf8"), unchanged);
});

test("fails closed when source data or existing history is invalid", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipa-stats-"));
  const statsPath = path.join(directory, "STATS.md");
  const existing = `${header}| 2025-03-09 | 10 | n/a |\n`;
  await writeFile(statsPath, existing);

  await assert.rejects(
    updateStats({
      statsPath,
      date: new Date("2025-03-11T12:00:00Z"),
      fetchImpl: async () => ({ ok: true, json: async () => ({ package: "@usepipa/pipa", downloads: [{ day: "2025-03-09", downloads: 10 }] }) }),
    }),
    /missing requested dates/u,
  );
  assert.equal(await readFile(statsPath, "utf8"), existing);

  await writeFile(statsPath, "");
  await assert.rejects(
    updateStats({
      statsPath,
      date: new Date("2025-03-11T12:00:00Z"),
      fetchImpl: async () => ({ ok: true, json: async () => ({ package: "@usepipa/pipa", downloads: [{ day: "2025-03-08", downloads: 8 }, { day: "2025-03-10", downloads: 3 }] }) }),
    }),
    /missing requested dates/u,
  );

  await writeFile(statsPath, `${header}| 2025-02-30 | 10 | n/a |\n`);
  await assert.rejects(updateStats({ statsPath, fetchImpl: async () => ({ ok: false }) }), /Invalid STATS.md date/u);

  await writeFile(statsPath, "bad history");
  await assert.rejects(updateStats({ statsPath, date: new Date("2025-03-11T12:00:00Z"), fetchImpl: async () => ({ ok: false }) }), /Invalid STATS.md/u);
  assert.equal(await readFile(statsPath, "utf8"), "bad history");
});
