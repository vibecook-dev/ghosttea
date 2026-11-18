// The npm half of the dependency audit, with dated exceptions.
//
// `npm audit --audit-level=high` cannot accept one advisory. So a high advisory
// with no fixed version turns every branch and every release red until upstream
// ships, whatever the code does: picomatch's GHSA-fc5q-39xc-vjpf, where every
// published version is affected, did exactly that on 2026-11-18. cargo's half
// has always had an answer (`.cargo/audit.toml`); this is the npm one.
//
// The gate runs the same audit and fails on any high or critical advisory that
// `npm-audit-exceptions.json` does not name. An exception is narrow and cannot
// outlive its reason. It names one advisory for one package, at the vulnerable
// range npm reported for that package when it was granted, and it carries a
// date. It fails the gate once that date has passed, once that range changes (a
// fixed version may exist: bump instead) and once nothing reports the advisory
// any more (remove it).
//
// The report gives two ranges, and an exception is held to the package's. The
// advisory's own (`<=4.0.7`) is its author's wording, and need not change when
// a fix ships. The package's (`*`) is npm's reading of the advisory against
// every published version, and is what `npm audit` prints beside the package's
// name. It narrows the day a fixed version is published.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BLOCKING = new Set(["high", "critical"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 90;
const FIELDS = ["advisory", "package", "range", "reason", "added", "expires"];

/**
 * The exceptions a parsed `npm-audit-exceptions.json` holds. Throws on anything
 * it cannot vouch for: a missing reason, a day that is not one, or an exception
 * written to last longer than `MAX_DAYS`.
 */
export function parseExceptions(document) {
  if (!Array.isArray(document?.exceptions)) throw new Error("npm-audit-exceptions.json must hold an `exceptions` list");
  return document.exceptions.map((entry, index) => {
    for (const field of FIELDS) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`exception ${index + 1} needs a non-empty \`${field}\``);
      }
    }
    for (const field of ["added", "expires"]) {
      if (!DAY.test(entry[field]) || Number.isNaN(Date.parse(entry[field]))) {
        throw new Error(`exception ${index + 1} (${entry.advisory}): \`${field}\` must be a day, YYYY-MM-DD`);
      }
    }
    const days = (Date.parse(entry.expires) - Date.parse(entry.added)) / 86_400_000;
    if (days < 0 || days > MAX_DAYS) {
      throw new Error(
        `exception ${index + 1} (${entry.advisory}): it must expire within ${MAX_DAYS} days of the day it was added`,
      );
    }
    return { ...entry };
  });
}

/**
 * The report `npm audit --json` printed, or a throw. npm exits 0 when it finds
 * nothing and 1 when it finds anything, and prints a version 2 report either
 * way. Anything else is no audit at all (the registry did not answer, the lock
 * could not be read, npm was killed) and must never read as a clean one.
 */
export function parseReport(stdout, status, stderr = "") {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`npm audit did not answer with a report (status ${status}): ${stderr}`);
  }
  const audited =
    report?.auditReportVersion === 2 && typeof report.vulnerabilities === "object" && report.vulnerabilities !== null;
  if ((status !== 0 && status !== 1) || report?.error || !audited) {
    throw new Error(`npm audit failed (status ${status}): ${JSON.stringify(report?.error ?? report)}`);
  }
  return report;
}

/**
 * The advisories a report names, one per advisory, whatever depends on them.
 * `affected` is the advisory's own range; `published` is the range npm reports
 * for the package the advisory is filed against.
 */
function advisories(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      // A string names another vulnerable package, and that package reports its own advisory.
      if (typeof via !== "object" || via === null || typeof via.url !== "string") continue;
      found.set(via.url, {
        id: via.url.slice(via.url.lastIndexOf("/") + 1),
        package: via.name,
        severity: via.severity,
        affected: via.range,
        published: vulnerability.range,
        title: via.title,
        url: via.url,
      });
    }
  }
  return [...found.values()];
}

/**
 * Judge an `npm audit --json` report against the exceptions, as of `today`
 * (`YYYY-MM-DD`). `failures` are the lines that fail the gate; `accepted` are
 * the exceptions it relied on.
 */
export function judgeAudit(report, exceptions, today) {
  const failures = [];
  const accepted = [];
  const used = new Set();
  for (const advisory of advisories(report)) {
    if (!BLOCKING.has(advisory.severity)) continue;
    const name = `${advisory.id} (${advisory.package})`;
    const exception = exceptions.find((entry) => entry.advisory === advisory.id && entry.package === advisory.package);
    if (!exception) {
      failures.push(`${name}: ${advisory.severity}, ${advisory.affected}. ${advisory.title}. ${advisory.url}`);
      continue;
    }
    used.add(exception);
    if (exception.range !== advisory.published) {
      failures.push(
        `${name}: the exception was granted while npm reported the vulnerable range ` +
          `${JSON.stringify(exception.range)} and it now reports ${JSON.stringify(advisory.published)}. A fixed ` +
          `version may exist: bump the dependency and remove the exception. If none does, renew it for the new range.`,
      );
    } else if (exception.expires < today) {
      failures.push(
        `${name}: the exception expired on ${exception.expires}. Bump the dependency, or renew it with today's reason.`,
      );
    } else {
      accepted.push({ ...exception, severity: advisory.severity });
    }
  }
  for (const exception of exceptions) {
    if (used.has(exception)) continue;
    failures.push(
      `${exception.advisory} (${exception.package}): no high or critical advisory matches this exception any more. Remove it.`,
    );
  }
  return { failures, accepted };
}

// Importable for tests; audits when run directly.
if (process.argv[1] === import.meta.filename) {
  const root = resolve(import.meta.dirname, "..");
  const exceptions = parseExceptions(JSON.parse(readFileSync(resolve(root, "npm-audit-exceptions.json"), "utf8")));
  // npm exits 1 when it finds anything at all. The report on stdout is the answer either way.
  const audit = spawnSync("npm", ["audit", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const report = parseReport(audit.stdout, audit.status, audit.stderr);
  const { failures, accepted } = judgeAudit(report, exceptions, new Date().toISOString().slice(0, 10));
  const counts = report.metadata?.vulnerabilities ?? {};
  console.log(
    `npm audit: ${counts.total ?? 0} findings (${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ` +
      `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low).`,
  );
  for (const exception of accepted) {
    console.log(
      `Accepted until ${exception.expires}: ${exception.advisory} (${exception.package}, ${exception.severity}). ${exception.reason}`,
    );
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log("No high or critical advisory outside the dated exceptions.");
}
