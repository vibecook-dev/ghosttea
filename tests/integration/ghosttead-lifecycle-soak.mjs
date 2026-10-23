import { execFileSync } from "node:child_process";

import { GhostteadHarness } from "../../bench/lib/ghosttead-client.mjs";
import { cleanEnvironment, printAndExitArgs, shellExecutable } from "../../bench/lib/shell-fixture.mjs";

const sessionsPerRound = positiveInteger("GHOSTTEA_SOAK_SESSIONS", 256);
const rounds = positiveInteger("GHOSTTEA_SOAK_ROUNDS", 1);
const warmupSessions = positiveInteger("GHOSTTEA_SOAK_WARMUP_SESSIONS", 16);
const maximumRssGrowthMiB = positiveNumber("GHOSTTEA_SOAK_MAX_RSS_GROWTH_MIB", 32);
const maximumThreadGrowth = positiveInteger("GHOSTTEA_SOAK_MAX_THREAD_GROWTH", 4);
/**
 * Windows only, and a rate rather than a total because the scheduled run churns
 * four times as many sessions as a pull request. Every round is measured
 * against the one baseline taken before the first, so the rate divides that
 * growth by every session churned since the baseline. Dividing by one round's
 * sessions instead reads the scheduled run's second round as 2.00 at the same
 * rate.
 *
 * A Windows session retains one handle after it ends, so 1.00 is the expected
 * rate on Windows: the floor, not a regression. That is not this
 * service's job object: disabling adoption entirely leaves the growth
 * unchanged at exactly one per session, and 256 sessions retain 256 handles
 * whether or not a job is ever created. It is the ConPTY session path itself,
 * measured here for the first time because this soak did not run on Windows
 * before. macOS and Linux retain nothing, so they hold to the same bound.
 *
 * The allowance sits just above the observed rate so a regression that retains
 * more than the known handle still fails.
 */
const maximumHandlesPerSession = positiveNumber("GHOSTTEA_SOAK_MAX_HANDLES_PER_SESSION", 1.25);
// How long to let the service finish releasing what the churn used before
// measuring it. A slower machine is still draining well past a fixed delay.
const settleTimeoutMs = positiveInteger("GHOSTTEA_SOAK_SETTLE_TIMEOUT_MS", 30_000);

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processSample(pid) {
  if (process.platform === "win32") {
    // Handles are the Windows-specific leak signal that matters most here: the
    // service creates a fresh named pipe instance for every connection, so a
    // handle that outlives its connection would show up as steady growth.
    const sampled = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${pid}; "$([math]::Round($p.WorkingSet64 / 1KB)) $($p.Threads.Count) $($p.HandleCount)"`,
      ],
      { encoding: "utf8" },
    ).trim();
    const [rssKiB, threads, handles] = sampled.split(/\s+/).map(Number);
    if (![rssKiB, threads, handles].every(Number.isFinite)) {
      throw new Error(`Unable to sample process ${pid}: ${sampled}`);
    }
    return { rssKiB, threads, handles };
  }

  const rssOutput = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
  }).trim();
  const rssKiB = Number(rssOutput);
  const threads =
    process.platform === "darwin"
      ? execFileSync("ps", ["-M", "-p", String(pid)], { encoding: "utf8" })
          .trim()
          .split("\n").length - 1
      : Number(
          execFileSync("ps", ["-o", "nlwp=", "-p", String(pid)], {
            encoding: "utf8",
          }).trim(),
        );
  if (!Number.isFinite(rssKiB) || !Number.isFinite(threads)) {
    throw new Error(`Unable to sample process ${pid}`);
  }
  return { rssKiB, threads };
}

/**
 * Sample a settled process.
 *
 * Teardown is asynchronous, so a machine still working through the churn
 * reports resources that are about to be released. Wait until the readings stop
 * falling before measuring, rather than assuming a fixed delay was enough.
 */
async function stableProcessSample(pid) {
  // Sampling costs a process on Windows, so check twice a second rather than
  // four times.
  const deadline = Date.now() + settleTimeoutMs;
  let previous = processSample(pid);
  let stoppedFalling = 0;
  while (Date.now() < deadline && stoppedFalling < 3) {
    await delay(500);
    const next = processSample(pid);
    // Only a falling reading means teardown is still in progress. Growth is not
    // waited out: that is the regression these guardrails exist to report.
    const falling =
      next.rssKiB < previous.rssKiB || next.threads < previous.threads || (next.handles ?? 0) < (previous.handles ?? 0);
    stoppedFalling = falling ? 0 : stoppedFalling + 1;
    previous = next;
  }

  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    samples.push(processSample(pid));
    await delay(100);
  }
  const sample = {
    rssKiB: Math.min(...samples.map((entry) => entry.rssKiB)),
    threads: Math.min(...samples.map((entry) => entry.threads)),
  };
  if (samples.every((entry) => entry.handles !== undefined)) {
    sample.handles = Math.min(...samples.map((entry) => entry.handles));
  }
  return sample;
}

async function waitForSessionExit(harness, sessionId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await harness.request("list-sessions");
    if (response.type !== "sessions") throw new Error("ghosttead returned an unexpected session list");
    if (!response.sessions.some((session) => session.id === sessionId)) return;
    await delay(10);
  }
  throw new Error(`session ${sessionId} did not leave the registry after natural exit`);
}

async function churnSession(harness, label) {
  const marker = `ghosttea-lifecycle-${label}`;
  const ownerId = `ghosttea-lifecycle-owner-${label}`;
  const created = await harness.request("create-session", {
    options: {
      executable: shellExecutable,
      args: printAndExitArgs(marker),
      environment: cleanEnvironment(),
      cols: 80,
      rows: 24,
      persistence: "keep-until-exit",
      programKind: "application",
      ownerId,
    },
  });
  if (created.type !== "session-created") throw new Error("ghosttead returned an unexpected create-session response");

  harness.setFrameSubscriptions([created.session.handle]);
  const viewId = `lifecycle-view-${label}`;
  const attached = await harness.request("attach-session", { sessionId: created.session.id, viewId });
  if (attached.type !== "view-attached") throw new Error("ghosttead returned an unexpected attach-session response");
  await harness.waitForMarker(created.session.handle, marker);
  await waitForSessionExit(harness, created.session.id);
  harness.setFrameSubscriptions([]);

  const closed = await harness.request("close-session-owner", { ownerId });
  if (closed.type !== "ok") throw new Error("ghosttead rejected lifecycle-owner closure");
}

async function churn(harness, count, prefix) {
  for (let index = 0; index < count; index += 1) {
    await churnSession(harness, `${prefix}-${index}`);
  }
}

if (!["darwin", "linux", "win32"].includes(process.platform)) {
  throw new Error(`ghosttead lifecycle soak does not support ${process.platform}`);
}

const harness = await GhostteadHarness.start();
try {
  if (!harness.pid) throw new Error("ghosttead lifecycle soak requires a directly spawned ghosttead process");
  await churn(harness, warmupSessions, "warmup");
  await delay(500);
  const baseline = await stableProcessSample(harness.pid);
  const maximumRssGrowthKiB = maximumRssGrowthMiB * 1024;

  for (let round = 0; round < rounds; round += 1) {
    await churn(harness, sessionsPerRound, `round-${round}`);
    await delay(750);
    const current = await stableProcessSample(harness.pid);
    const liveSessions = (await harness.request("list-sessions")).sessions?.length ?? null;
    const rssGrowthKiB = current.rssKiB - baseline.rssKiB;
    const threadGrowth = current.threads - baseline.threads;
    const measuredSessions = (round + 1) * sessionsPerRound;
    console.log(
      JSON.stringify({
        round: round + 1,
        sessions: sessionsPerRound,
        measuredSessions,
        baseline,
        current,
        liveSessions,
        rssGrowthMiB: Number((rssGrowthKiB / 1024).toFixed(2)),
        threadGrowth,
        handlesPerSession:
          current.handles === undefined
            ? null
            : Number(((current.handles - baseline.handles) / measuredSessions).toFixed(2)),
      }),
    );
    if (threadGrowth > maximumThreadGrowth) {
      throw new Error(
        `ghosttead retained ${threadGrowth} threads after lifecycle churn; allowed growth is ${maximumThreadGrowth}`,
      );
    }
    if (rssGrowthKiB > maximumRssGrowthKiB) {
      throw new Error(
        `ghosttead RSS grew ${(rssGrowthKiB / 1024).toFixed(2)} MiB after lifecycle churn; allowed growth is ${maximumRssGrowthMiB} MiB`,
      );
    }
    if (current.handles !== undefined) {
      const handlesPerSession = (current.handles - baseline.handles) / measuredSessions;
      if (handlesPerSession > maximumHandlesPerSession) {
        // Whether the registry still holds the sessions separates a retained
        // session object, which would keep every handle it owns, from an
        // operating-system handle outliving a session that was already dropped.
        const live = await harness.request("list-sessions");
        throw new Error(
          `ghosttead retained ${handlesPerSession.toFixed(2)} handles per session across ` +
            `${measuredSessions} sessions; allowed is ${maximumHandlesPerSession}. ` +
            `${live.sessions?.length ?? "?"} session(s) remain in the registry.`,
        );
      }
    }
  }

  console.log(`ghosttead lifecycle soak passed (${rounds * sessionsPerRound} measured sessions)`);
} finally {
  harness.dispose();
}
