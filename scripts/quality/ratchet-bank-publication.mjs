#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { BANKED_BASELINES, formatBankSummary, verifyRatchetBank } from "./verify-ratchet-bank.mjs";

export const MAX_BANK_BYTES = 2 * 1024 * 1024;
const FILES = Object.values(BANKED_BASELINES);
const SHA = /^[a-f0-9]{40}$/;
const RELEASE = /^release\/v\d+\.\d+\.\d+$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function verifyBaselineShape(kind, value) {
  requireValue(isRecord(value), "Invalid baseline object");
  if (kind === "fileSize") {
    requireValue(isRecord(value.frozen) && isRecord(value.testFrozen), "Invalid frozen maps");
    for (const map of [value.frozen, value.testFrozen]) {
      requireValue(
        Object.values(map).every(
          (entry) => typeof entry !== "number" || Number.isSafeInteger(entry)
        ),
        "Invalid frozen count"
      );
    }
  } else if (kind === "complexity") {
    requireValue(Number.isSafeInteger(value.count), "Invalid complexity count");
  } else {
    requireValue(
      isRecord(value.metrics) &&
        isRecord(value.metrics.cognitiveComplexity) &&
        Number.isSafeInteger(value.metrics.cognitiveComplexity.value),
      "Invalid cognitive complexity metric"
    );
  }
  requireValue(validNumbers(value), "Baseline contains an invalid number");
}

function validNumbers(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  if (value && typeof value === "object") return Object.values(value).every(validNumbers);
  return true;
}

export function bankBranch(target) {
  requireValue(RELEASE.test(target), "Non-canonical release branch");
  return `chore/bank-ratchet-${target.slice("release/".length)}`;
}

export function checkBindings({ enabled, clientId, hasPrivateKey }) {
  if (enabled !== "true") return false;
  requireValue(Boolean(clientId) && hasPrivateKey === "true", "Missing banking App bindings");
  return true;
}

export function validateBankPayload(text, context, readBefore) {
  requireValue(Buffer.byteLength(text) <= MAX_BANK_BYTES, "Bank payload exceeds size limit");
  const payload = JSON.parse(text);
  requireValue(
    exactKeys(payload, ["version", "target", "sourceSha", "workflowSha", "files"]),
    "Invalid bank payload schema"
  );
  requireValue(payload.version === 1, "Unsupported bank payload version");
  bankBranch(payload.target);
  requireValue(SHA.test(payload.sourceSha) && SHA.test(payload.workflowSha), "Invalid source SHA");
  requireValue(
    payload.target === context.target &&
      payload.sourceSha === context.sourceSha &&
      payload.workflowSha === context.workflowSha,
    "Bank payload provenance mismatch"
  );
  requireValue(exactKeys(payload.files, FILES), "Bank payload paths are not allowlisted");
  const pairs = {};
  for (const [kind, file] of Object.entries(BANKED_BASELINES)) {
    const after = payload.files[file];
    verifyBaselineShape(kind, after);
    const before = readBefore(file);
    verifyBaselineShape(kind, before);
    pairs[kind] = { before, after };
  }
  requireValue(
    pairs.quality.before._policy?.phase !== "velocity",
    "Velocity phase pauses ratchet banking"
  );
  // Structural verification is independent of anything the measurement runner executed.
  const result = verifyRatchetBank(pairs);
  requireValue(result.ok, "Unsafe ratchet banking data");
  return { payload, result };
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

function readAt(ref, file) {
  return JSON.parse(git(["show", `${ref}:${file}`]));
}

export function verifySource(context, run = git) {
  bankBranch(context.target);
  requireValue(SHA.test(context.sourceSha) && SHA.test(context.workflowSha), "Invalid source SHA");
  requireValue(run(["rev-parse", "HEAD"]) === context.workflowSha, "Untrusted publisher checkout");
  run(["fetch", "--no-tags", "origin", `refs/heads/${context.target}`]);
  requireValue(run(["rev-parse", "FETCH_HEAD"]) === context.sourceSha, "Release branch moved");
  run(["merge-base", "--is-ancestor", context.workflowSha, context.sourceSha]);
}

export function publicationPlan({
  target,
  repository,
  sourceSha,
  expectedHead,
  existingPr,
  changed,
}) {
  const head = bankBranch(target);
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "Invalid repository");
  requireValue(SHA.test(sourceSha), "Invalid source SHA");
  requireValue(expectedHead === "" || SHA.test(expectedHead), "Invalid expected head");
  if (existingPr) {
    requireValue(
      existingPr.state === "open" &&
        existingPr.base.ref === target &&
        existingPr.head.ref === head &&
        existingPr.head.repo.full_name === repository &&
        existingPr.head.sha === expectedHead,
      "Existing banking PR does not match expected base/head"
    );
  } else {
    requireValue(expectedHead === "", "Existing banking branch has no matching PR");
  }
  return {
    action: !changed ? "noop" : existingPr ? "update" : "create",
    head,
    lease: `--force-with-lease=refs/heads/${head}:${expectedHead}`,
  };
}

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...options }).trim();
}

function contextFromEnv(env) {
  return {
    target: env.TARGET,
    sourceSha: env.SOURCE_SHA,
    workflowSha: env.GITHUB_SHA,
  };
}

function loadPayload(file, context) {
  const stat = fs.lstatSync(file);
  requireValue(stat.isFile() && stat.size <= MAX_BANK_BYTES, "Invalid bank payload file");
  return validateBankPayload(fs.readFileSync(file, "utf8"), context, (name) =>
    readAt(context.sourceSha, name)
  );
}

export function publishBank(
  { payload, result },
  env,
  run = git,
  api = gh,
  write = fs.writeFileSync
) {
  requireValue(Boolean(env.GH_TOKEN), "Missing banking App token");
  const repository = env.GITHUB_REPOSITORY;
  const head = bankBranch(payload.target);
  const remote = run(["ls-remote", "--heads", "origin", `refs/heads/${head}`]);
  const expectedHead = remote ? remote.split(/\s+/)[0] : "";
  const prs = JSON.parse(
    api(["api", `repos/${repository}/pulls?state=open&head=${repository.split("/")[0]}:${head}`])
  );
  requireValue(Array.isArray(prs) && prs.length <= 1, "Ambiguous banking PRs");
  const plan = publicationPlan({
    target: payload.target,
    repository,
    sourceSha: payload.sourceSha,
    expectedHead,
    existingPr: prs[0],
    changed: result.changed,
  });
  if (plan.action === "noop") return plan.action;
  if (expectedHead) {
    run(["fetch", "--no-tags", "origin", `refs/heads/${head}`]);
    requireValue(run(["rev-parse", "FETCH_HEAD"]) === expectedHead, "Banking head moved");
    const base = run(["merge-base", payload.sourceSha, expectedHead]);
    const paths = run(["diff", "--name-only", base, expectedHead]).split("\n").filter(Boolean);
    requireValue(
      paths.every((file) => FILES.includes(file)),
      "Banking branch has unrelated changes"
    );
  }
  run(["checkout", "--detach", payload.sourceSha]);
  for (const file of FILES) write(file, JSON.stringify(payload.files[file], null, 2) + "\n");
  // Do not emit a new push for an already-current banking PR.
  if (expectedHead && run(["diff", expectedHead, "--", ...FILES]) === "") return "noop";
  run(["add", "--", ...FILES]);
  run([
    "-c",
    "user.name=ratchet-banking",
    "-c",
    "user.email=ratchet-banking@users.noreply.github.com",
    "commit",
    "-m",
    `chore(quality): bank ratchet shrinks measured on ${payload.target}`,
  ]);
  // Command-scoped authentication: no token URL or credential written to git config.
  const auth = Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString("base64");
  run(["push", plan.lease, "origin", `HEAD:refs/heads/${head}`], {
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const title = `chore(quality): bank ratchet shrinks (${payload.target})`;
  const body = [
    "Automated shrink-only quality baseline update. No product code changes.",
    `Measured release commit: ${payload.sourceSha}`,
    "Verified independently in a clean publisher; no caps, notes or other metrics may change.",
    formatBankSummary(result),
  ].join("\n\n");
  const data =
    plan.action === "update"
      ? { title, body }
      : {
          title,
          body,
          base: payload.target,
          head,
          draft: true,
        };
  api(
    [
      "api",
      "--method",
      plan.action === "update" ? "PATCH" : "POST",
      `repos/${repository}/pulls${plan.action === "update" ? `/${prs[0].number}` : ""}`,
      "--input",
      "-",
    ],
    { input: JSON.stringify(data) }
  );
  return plan.action;
}

function main() {
  const [mode, file] = process.argv.slice(2);
  const env = process.env;
  const context = contextFromEnv(env);
  if (mode === "prepare") {
    bankBranch(context.target);
    requireValue(
      SHA.test(context.sourceSha) && SHA.test(context.workflowSha),
      "Invalid source SHA"
    );
    const files = Object.fromEntries(
      FILES.map((name) => [name, JSON.parse(fs.readFileSync(name, "utf8"))])
    );
    const payload = { version: 1, ...context, files };
    const text = JSON.stringify(payload);
    const { result } = validateBankPayload(text, context, (name) =>
      readAt(context.sourceSha, name)
    );
    fs.writeFileSync(file, text, { flag: "wx" });
    fs.appendFileSync(env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
    return;
  }
  requireValue(mode === "validate" || mode === "publish", "Unknown publication mode");
  verifySource(context);
  const validated = loadPayload(file, context);
  if (mode === "validate") {
    fs.appendFileSync(env.GITHUB_OUTPUT, `changed=${validated.result.changed}\n`);
    return;
  }
  requireValue(
    checkBindings({
      enabled: env.BANKING_ENABLED,
      clientId: env.APP_CLIENT_ID,
      hasPrivateKey: env.HAS_APP_KEY,
    }),
    "Banking is disabled"
  );
  console.log(`Bank publication: ${publishBank(validated, env)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch {
    // Never print subprocess exceptions: they may carry authenticated git arguments/headers.
    console.error("Ratchet bank publication failed validation or publication; no retry attempted.");
    process.exitCode = 1;
  }
}
