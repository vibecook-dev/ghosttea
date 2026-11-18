// The npm audit gate decides whether a branch may merge and whether a release
// may publish. It accepts an advisory only through a dated exception, so the
// ways an exception ends are pinned here: a date that has passed, a package
// whose reported vulnerable range has changed, and an advisory nothing reports
// any more.
// An audit that did not happen is pinned as a failure: a registry that does not
// answer must never read as a clean report. The exceptions file that is checked
// in is judged here too, and so are the two workflows that must run this gate
// and never the bare audit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { judgeAudit, parseExceptions, parseReport } from "../scripts/npm-audit-gate.mjs";

const root = resolve(import.meta.dirname, "..");

// What `npm audit --json` said of two packages on 2026-11-18. An advisory has its
// own range. `published` is the range npm reports for the package, which is the
// advisory read against every published version: `*` for picomatch, because no
// version is fixed.
const PICOMATCH = {
  published: "*",
  advisory: {
    source: 1247710,
    name: "picomatch",
    dependency: "picomatch",
    title: "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
    url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
    severity: "high",
    range: "<=4.0.7",
  },
};

const MINIMATCH = {
  published: "7.0.0 - 11.0.0",
  advisory: {
    source: 1244623,
    name: "minimatch",
    dependency: "minimatch",
    title: "minimatch has potential denial of service via globparts amplification",
    url: "https://github.com/advisories/GHSA-g3hv-75wg-m249",
    severity: "moderate",
    range: ">=7.0.0 <11.0.1",
  },
};

/** The same finding with its advisory changed. */
const advised = (finding, change) => ({ ...finding, advisory: { ...finding.advisory, ...change } });

/** A report in the shape `npm audit --json` gave on 2026-11-18: each finding, and what depends on picomatch. */
function report(...findings) {
  const vulnerabilities = {};
  for (const { advisory, published } of findings) {
    vulnerabilities[advisory.name] = {
      name: advisory.name,
      severity: advisory.severity,
      via: [advisory],
      range: published,
    };
  }
  if (findings.some(({ advisory }) => advisory.name === "picomatch")) {
    vulnerabilities.fdir = { name: "fdir", severity: "high", via: ["picomatch"], range: ">=5.2.1" };
    vulnerabilities.tinyglobby = { name: "tinyglobby", severity: "high", via: ["fdir", "picomatch"], range: "*" };
    vulnerabilities.vite = {
      name: "vite",
      severity: "high",
      via: ["fdir", "picomatch", "tinyglobby"],
      range: ">=6.3.0-beta.0",
    };
  }
  return { auditReportVersion: 2, vulnerabilities };
}

const EXCEPTION = {
  advisory: "GHSA-fc5q-39xc-vjpf",
  package: "picomatch",
  range: "*",
  reason: "No fixed version; development tooling only.",
  added: "2026-11-18",
  expires: "2026-12-18",
};

test("a high advisory without an exception fails the gate, named once, whatever depends on it", () => {
  const { failures, accepted } = judgeAudit(report(PICOMATCH, MINIMATCH), [], "2026-11-18");
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^GHSA-fc5q-39xc-vjpf \(picomatch\): high, <=4\.0\.7\. /);
  assert.match(failures[0], /https:\/\/github\.com\/advisories\/GHSA-fc5q-39xc-vjpf$/);
  assert.deepEqual(accepted, []);
});

test("a critical advisory fails it too, and a moderate one never does", () => {
  const critical = advised(PICOMATCH, { severity: "critical" });
  assert.equal(judgeAudit(report(critical), [], "2026-11-18").failures.length, 1);
  assert.deepEqual(judgeAudit(report(MINIMATCH), [], "2026-11-18"), { failures: [], accepted: [] });
  assert.deepEqual(judgeAudit(report(), [], "2026-11-18"), { failures: [], accepted: [] });
});

test("a dated exception accepts its advisory through its last day", () => {
  for (const today of ["2026-11-18", "2026-12-01", "2026-12-18"]) {
    const { failures, accepted } = judgeAudit(report(PICOMATCH, MINIMATCH), [EXCEPTION], today);
    assert.deepEqual(failures, [], today);
    assert.deepEqual(accepted, [{ ...EXCEPTION, severity: "high" }], today);
  }
});

test("an exception that has expired fails the gate and says what to do", () => {
  const { failures, accepted } = judgeAudit(report(PICOMATCH), [EXCEPTION], "2026-12-19");
  assert.deepEqual(accepted, []);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /the exception expired on 2026-12-18\. Bump the dependency, or renew it/);
});

test("a fixed version narrows the range npm reports for the package, and that ends the exception", () => {
  // picomatch 4.0.8 ships: the advisory still says <=4.0.7, and the package's range is no longer every version
  const patched = { ...PICOMATCH, published: "<=4.0.7" };
  const { failures, accepted } = judgeAudit(report(patched), [EXCEPTION], "2026-11-20");
  assert.deepEqual(accepted, []);
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /granted while npm reported the vulnerable range "\*" and it now reports "<=4\.0\.7"\. A fixed version may exist/,
  );
});

test("an exception is held to the package's range, never to the advisory's own wording", () => {
  // the report of 2026-11-18 as it was: the advisory says <=4.0.7, and the exception granted for * stands
  assert.deepEqual(judgeAudit(report(PICOMATCH), [EXCEPTION], "2026-11-20").failures, []);
  // the advisory is reworded and nothing is published: it still stands
  const reworded = advised(PICOMATCH, { range: "<4.0.8" });
  assert.deepEqual(judgeAudit(report(reworded), [EXCEPTION], "2026-11-20").failures, []);
  // an exception written for the advisory's own range is not one the gate accepts
  const own = { ...EXCEPTION, range: "<=4.0.7" };
  assert.equal(judgeAudit(report(PICOMATCH), [own], "2026-11-20").failures.length, 1);
});

test("an exception nothing matches any more fails the gate until it is removed", () => {
  for (const audited of [report(), report(MINIMATCH), report(advised(PICOMATCH, { severity: "moderate" }))]) {
    const { failures, accepted } = judgeAudit(audited, [EXCEPTION], "2026-11-20");
    assert.deepEqual(accepted, []);
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      /^GHSA-fc5q-39xc-vjpf \(picomatch\): no high or critical advisory matches this exception any more\. Remove it\.$/,
    );
  }
});

test("an exception covers one advisory for one package and nothing beside it", () => {
  const elsewhere = advised(PICOMATCH, { name: "micromatch", dependency: "micromatch" });
  const other = advised(PICOMATCH, { url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" });
  for (const advisory of [elsewhere, other]) {
    const { failures } = judgeAudit(report(advisory), [EXCEPTION], "2026-11-20");
    // the advisory itself, and the exception that no longer matches anything
    assert.equal(failures.length, 2);
  }
});

test("an exceptions file must give every field, real days, and an end within ninety days", () => {
  assert.deepEqual(parseExceptions({ exceptions: [EXCEPTION] }), [EXCEPTION]);
  assert.deepEqual(parseExceptions({ exceptions: [] }), []);
  assert.throws(() => parseExceptions({}), /must hold an `exceptions` list/);
  assert.throws(() => parseExceptions(null), /must hold an `exceptions` list/);
  for (const field of ["advisory", "package", "range", "reason", "added", "expires"]) {
    const rest = Object.fromEntries(Object.entries(EXCEPTION).filter(([key]) => key !== field));
    assert.throws(() => parseExceptions({ exceptions: [rest] }), new RegExp(`needs a non-empty \`${field}\``), field);
    assert.throws(() => parseExceptions({ exceptions: [{ ...EXCEPTION, [field]: " " }] }), /needs a non-empty/, field);
  }
  assert.throws(
    () => parseExceptions({ exceptions: [{ ...EXCEPTION, expires: "next month" }] }),
    /`expires` must be a day/,
  );
  assert.throws(
    () => parseExceptions({ exceptions: [{ ...EXCEPTION, added: "2026-13-40" }] }),
    /`added` must be a day/,
  );
  assert.throws(() => parseExceptions({ exceptions: [{ ...EXCEPTION, expires: "2027-11-18" }] }), /within 90 days/);
  assert.throws(() => parseExceptions({ exceptions: [{ ...EXCEPTION, expires: "2026-11-17" }] }), /within 90 days/);
  assert.doesNotThrow(() => parseExceptions({ exceptions: [{ ...EXCEPTION, expires: "2027-02-16" }] }));
});

test("an audit that did not happen fails the gate: no report, an error, or an exit npm does not use for one", () => {
  const clean = JSON.stringify(report());
  const found = JSON.stringify(report(PICOMATCH));
  assert.deepEqual(parseReport(clean, 0), report());
  assert.deepEqual(parseReport(found, 1), report(PICOMATCH));
  // the registry did not answer: npm prints an error, or nothing at all
  assert.throws(
    () => parseReport("", 1, "npm error network"),
    /did not answer with a report \(status 1\): npm error network/,
  );
  assert.throws(() => parseReport("<html>502 Bad Gateway</html>", 1), /did not answer with a report/);
  assert.throws(
    () => parseReport('{"error":{"code":"ENOTFOUND","summary":"request failed"}}', 1),
    /npm audit failed \(status 1\).*ENOTFOUND/,
  );
  assert.throws(() => parseReport('{"message":"audit endpoint returned an error"}', 1), /npm audit failed/);
  // a report-shaped answer that is not the audit's
  assert.throws(() => parseReport("{}", 0), /npm audit failed/);
  assert.throws(() => parseReport("null", 0), /npm audit failed/);
  assert.throws(() => parseReport('{"auditReportVersion":2,"vulnerabilities":null}', 0), /npm audit failed/);
  assert.throws(() => parseReport('{"auditReportVersion":1,"vulnerabilities":{}}', 0), /npm audit failed/);
  // npm was killed, or failed in a way it has no report for
  assert.throws(() => parseReport(clean, null), /npm audit failed \(status null\)/);
  assert.throws(() => parseReport(clean, 2), /npm audit failed \(status 2\)/);
});

test("the exceptions file that is checked in is one the gate accepts", () => {
  const exceptions = parseExceptions(JSON.parse(readFileSync(resolve(root, "npm-audit-exceptions.json"), "utf8")));
  for (const exception of exceptions) {
    assert.match(exception.advisory, /^GHSA(-[0-9a-z]{4}){3}$/, exception.advisory);
    assert.ok(exception.reason.length >= 40, `${exception.advisory}: the reason says why it is safe to wait`);
  }
});

test("both workflows and the publishing guide run this gate, never the bare audit", () => {
  for (const file of [
    ".github/workflows/desktop-release-gates.yml",
    ".github/workflows/publish-release.yml",
    "PUBLISHING.md",
  ]) {
    const text = readFileSync(resolve(root, file), "utf8");
    assert.match(text, /npm run audit:npm/, file);
    assert.doesNotMatch(text, /npm audit --audit-level/, file);
  }
  const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts["audit:npm"], "node scripts/npm-audit-gate.mjs");
  assert.match(scripts["test:desktop"], /npm run test:npm-audit-gate/);
});
