import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const header = "# Pipa download statistics\n\nThese are npm package downloads for `@usepipa/pipa`, not installs, users, active users, or conversions.\n\n| Date (UTC) | Cumulative npm downloads | Change since prior snapshot |\n| --- | ---: | ---: |\n";
const packageName = "@usepipa/pipa";

export async function updateStats({ statsPath = new URL("../STATS.md", import.meta.url), date = new Date(), fetchImpl = fetch } = {}) {
  const existing = await readFile(statsPath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const rows = parseStats(existing);
  const target = targetDate(rows, date);
  if (rows.some((row) => row.date === target)) return false;

  const start = rows.length ? nextDate(rows.at(-1).date) : "2020-01-01";
  const response = await fetchImpl(`https://api.npmjs.org/downloads/range/${start}:${target}/${packageName}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`npm downloads request failed with status ${response.status ?? "unknown"}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("npm downloads response was not valid JSON");
  }
  const downloads = validateDownloads(payload, target);
  const previous = rows.at(-1)?.cumulative;
  const addedDownloads = downloads.reduce((total, entry) => total + entry.downloads, 0);
  const change = previous === undefined ? "n/a" : addedDownloads;
  const cumulative = (previous ?? 0) + addedDownloads;

  await writeFile(statsPath, `${existing || header}| ${target} | ${cumulative} | ${change} |\n`);
  return true;
}

function parseStats(content) {
  if (!content) return [];
  if (!content.startsWith(header)) throw new Error("Invalid STATS.md header");

  const rows = content.slice(header.length).trimEnd().split("\n").filter(Boolean).map((line) => {
    const match = /^\| (\d{4}-\d{2}-\d{2}) \| (\d+) \| (n\/a|\d+) \|$/u.exec(line);
    if (!match) throw new Error("Invalid STATS.md row");
    return { date: match[1], cumulative: Number(match[2]), change: match[3] };
  });
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (index === 0 && row.change !== "n/a") throw new Error("Invalid STATS.md first row");
    if (index > 0 && (row.change === "n/a" || row.cumulative - rows[index - 1].cumulative !== Number(row.change))) throw new Error("Invalid STATS.md change");
    if (index > 0 && row.date <= rows[index - 1].date) throw new Error("Invalid STATS.md date order");
  }
  return rows;
}

function targetDate(rows, date) {
  const completed = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - 1)).toISOString().slice(0, 10);
  if (!rows.length) return completed;
  const next = new Date(`${rows.at(-1).date}T00:00:00Z`);
  const dateAfterLastRow = nextDate(next.toISOString().slice(0, 10));
  return dateAfterLastRow < completed ? dateAfterLastRow : completed;
}

function nextDate(date) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function validateDownloads(payload, target) {
  if (payload?.package !== packageName || !Array.isArray(payload.downloads)) throw new Error("Invalid npm downloads response");
  const downloads = payload.downloads.filter((entry) => entry?.day <= target);
  if (!downloads.some((entry) => entry.day === target)) throw new Error("npm downloads response is missing target date");
  if (downloads.some((entry) => !/^\d{4}-\d{2}-\d{2}$/u.test(entry?.day) || !Number.isSafeInteger(entry.downloads) || entry.downloads < 0)) {
    throw new Error("Invalid npm downloads response");
  }
  return downloads;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const changed = await updateStats();
  process.stdout.write(changed ? "Updated STATS.md\n" : "STATS.md is already current\n");
}
