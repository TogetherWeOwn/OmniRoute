import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  MAX_BANK_BYTES,
  bankBranch,
  checkBindings,
  publicationPlan,
  publishBank,
  validateBankPayload,
  verifySource,
} from "../../scripts/quality/ratchet-bank-publication.mjs";
import { BANKED_BASELINES } from "../../scripts/quality/verify-ratchet-bank.mjs";

const sourceSha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const expectedHead = "c".repeat(40);
const target = "release/v3.8.51";
const repository = "example/router";
const context = { sourceSha, workflowSha, target };
const before = {
  [BANKED_BASELINES.fileSize]: { cap: 800, frozen: { "a.ts": 1000 }, testFrozen: {} },
  [BANKED_BASELINES.complexity]: { count: 100, _comment: "preserve" },
  [BANKED_BASELINES.quality]: { metrics: { cognitiveComplexity: { value: 50 } } },
};
const fixture = () => ({ version: 1, ...context, files: structuredClone(before) });
const validate = (payload = fixture(), overrides = {}) =>
  validateBankPayload(
    JSON.stringify(payload),
    { ...context, ...overrides },
    (file: string) => before[file]
  );
const pr = () => ({
  number: 12,
  state: "open",
  base: { ref: target },
  head: { ref: bankBranch(target), sha: expectedHead, repo: { full_name: repository } },
});

test("disabled banking does not require or access App bindings", () => {
  assert.equal(checkBindings({ enabled: "false" }), false);
  assert.equal(checkBindings({}), false);
  assert.throws(
    () => checkBindings({ enabled: "true", clientId: "id", hasPrivateKey: "false" }),
    /Missing/
  );
  assert.throws(() => checkBindings({ enabled: "true", hasPrivateKey: "true" }), /Missing/);
  assert.equal(checkBindings({ enabled: "true", clientId: "id", hasPrivateKey: "true" }), true);
});

test("unchanged data is a no-op; a validated shrink is changed", () => {
  assert.equal(validate().result.changed, false);
  const payload = fixture();
  payload.files[BANKED_BASELINES.complexity].count = 90;
  assert.equal(validate(payload).result.changed, true);
});

test("real baseline schema preserves fractional coverage while banking integer counts", () => {
  const files = Object.fromEntries(
    Object.values(BANKED_BASELINES).map((file) => [file, JSON.parse(fs.readFileSync(file, "utf8"))])
  );
  // Exercise the post-velocity schema without changing any on-disk policy.
  delete files[BANKED_BASELINES.quality]._policy;
  const payload = { version: 1, ...context, files: structuredClone(files) };
  payload.files[BANKED_BASELINES.complexity].count -= 1;
  assert.equal(
    validateBankPayload(JSON.stringify(payload), context, (file) => files[file]).result.changed,
    true
  );
});

test("only canonical base branches produce a deterministic banking head", () => {
  assert.equal(bankBranch(target), "chore/bank-ratchet-v3.8.51");
  for (const branch of ["main", "release/v1.2.3/other", "--upload-pack=x", "release/v1.2.3\n"]) {
    assert.throws(() => bankBranch(branch));
  }
});

test("rejects oversized, malformed, wrong-version and extra-field data", () => {
  assert.throws(
    () => validateBankPayload(" ".repeat(MAX_BANK_BYTES + 1), context, () => ({})),
    /size/
  );
  assert.throws(() => validateBankPayload("not json", context, () => ({})));
  assert.throws(() => validate({ ...fixture(), version: 2 }), /version/);
  assert.throws(() => validate({ ...fixture(), command: "do not execute" }), /schema/);
});

test("rejects missing paths, extra paths and mismatched source/workflow SHAs", () => {
  const missing = fixture();
  delete missing.files[BANKED_BASELINES.complexity];
  assert.throws(() => validate(missing), /allowlisted/);
  const extra = fixture();
  extra.files["../../unexpected.json"] = {};
  assert.throws(() => validate(extra), /allowlisted/);
  assert.throws(() => validate(fixture(), { sourceSha: expectedHead }), /provenance/);
  assert.throws(() => validate(fixture(), { workflowSha: expectedHead }), /provenance/);
  assert.throws(() => validate({ ...fixture(), sourceSha: "--other" }), /SHA/);
});

test("rejects malformed nested baseline shapes rather than treating them as map removals", () => {
  for (const value of [null, [], "", 5]) {
    const payload = fixture();
    payload.files[BANKED_BASELINES.fileSize].frozen = value;
    assert.throws(() => validate(payload), /frozen maps/);
  }
  const payload = fixture();
  delete payload.files[BANKED_BASELINES.fileSize].testFrozen;
  assert.throws(() => validate(payload), /frozen maps/);
});

test("missing installation token stops before git, API or file writes", () => {
  const unexpected = () => assert.fail("No side effects without a token");
  assert.throws(
    () =>
      publishBank(
        { payload: fixture(), result: { changed: true } },
        {},
        unexpected,
        unexpected,
        unexpected
      ),
    /Missing banking App token/
  );
});

test("rejects raises, changed notes, new entries and negative/fractional numbers", () => {
  for (const value of [101, -1, 1.5]) {
    const payload = fixture();
    payload.files[BANKED_BASELINES.complexity].count = value;
    assert.throws(() => validate(payload));
  }
  const note = fixture();
  note.files[BANKED_BASELINES.complexity]._comment = "changed";
  assert.throws(() => validate(note), /Unsafe/);
  const added = fixture();
  added.files[BANKED_BASELINES.fileSize].frozen["new.ts"] = 10;
  assert.throws(() => validate(added), /Unsafe/);
});

test("velocity phase refuses publication even for otherwise-safe shrinks", () => {
  const payload = fixture();
  payload.files[BANKED_BASELINES.quality]._policy = { phase: "velocity" };
  assert.throws(
    () =>
      validateBankPayload(JSON.stringify(payload), context, (file: string) =>
        file === BANKED_BASELINES.quality ? payload.files[file] : before[file]
      ),
    /Velocity/
  );
});

test("source verification pins the checkout, current release SHA and trusted ancestry", () => {
  const calls: string[][] = [];
  verifySource(context, (args: string[]) => {
    calls.push(args);
    return args[1] === "HEAD" ? workflowSha : args[1] === "FETCH_HEAD" ? sourceSha : "";
  });
  assert.deepEqual(calls.at(-1), ["merge-base", "--is-ancestor", workflowSha, sourceSha]);
  assert.throws(() => verifySource(context, () => expectedHead), /checkout/);
  assert.throws(
    () =>
      verifySource(context, (args: string[]) => (args[1] === "HEAD" ? workflowSha : expectedHead)),
    /moved/
  );
  assert.throws(
    () =>
      verifySource(context, (args: string[]) => {
        if (args[0] === "merge-base") throw new Error("not an ancestor");
        return args[1] === "HEAD" ? workflowSha : sourceSha;
      }),
    /ancestor/
  );
});

test("create and update plans use explicit empty/exact expected-head leases", () => {
  const base = { target, repository, sourceSha, changed: true };
  const create = publicationPlan({ ...base, expectedHead: "", existingPr: null });
  assert.equal(create.action, "create");
  assert.equal(create.lease, `--force-with-lease=refs/heads/${create.head}:`);
  const update = publicationPlan({ ...base, expectedHead, existingPr: pr() });
  assert.equal(update.action, "update");
  assert.equal(update.lease, `--force-with-lease=refs/heads/${update.head}:${expectedHead}`);
  assert.equal(publicationPlan({ ...base, changed: false, expectedHead: "" }).action, "noop");
});

test("rejects mismatched PR base, head, repository, SHA, closed PR and orphan branch", () => {
  const input = { target, repository, sourceSha, expectedHead, changed: true };
  const mutations = [
    (p) => {
      p.base.ref = "main";
    },
    (p) => {
      p.head.ref = "other";
    },
    (p) => {
      p.head.repo.full_name = "other/router";
    },
    (p) => {
      p.head.sha = sourceSha;
    },
    (p) => {
      p.state = "closed";
    },
  ];
  for (const mutate of mutations) {
    const existingPr = pr();
    mutate(existingPr);
    assert.throws(() => publicationPlan({ ...input, existingPr }), /base\/head/);
  }
  assert.throws(() => publicationPlan({ ...input, existingPr: null }), /no matching PR/);
});

function publicationHarness({
  existing = false,
  pushFails = false,
  changed = true,
  same = false,
  paths = BANKED_BASELINES.complexity,
} = {}) {
  const calls: { args: string[]; options: Record<string, unknown> }[] = [];
  const writes: string[] = [];
  const result = { changed, lowered: [["count", 100, 90]], removed: [] };
  const env = { GH_TOKEN: "offline-fixture", GITHUB_REPOSITORY: repository };
  const run = (args: string[], options = {}) => {
    calls.push({ args, options });
    if (args[0] === "ls-remote")
      return existing ? `${expectedHead}\trefs/heads/${bankBranch(target)}` : "";
    if (args[0] === "rev-parse") return expectedHead;
    if (args[0] === "merge-base") return sourceSha;
    if (args[0] === "diff") return args[1] === "--name-only" ? paths : same ? "" : "changed";
    if (args[0] === "push" && pushFails) throw new Error("lease rejected");
    return "";
  };
  const api = (args: string[], options = {}) => {
    calls.push({ args, options });
    return args.includes("--method") ? "{}" : JSON.stringify(existing ? [pr()] : []);
  };
  const execute = () =>
    publishBank({ payload: fixture(), result }, env, run, api, (file: string) => writes.push(file));
  return { calls, writes, execute };
}

test("offline publisher creates a draft PR and updates an existing PR using PATCH", () => {
  for (const existing of [false, true]) {
    const h = publicationHarness({ existing });
    assert.equal(h.execute(), existing ? "update" : "create");
    assert.deepEqual(h.writes.sort(), Object.values(BANKED_BASELINES).sort());
    const push = h.calls.find((call) => call.args[0] === "push");
    assert.ok(push);
    assert.equal(
      push.args[1],
      `--force-with-lease=refs/heads/${bankBranch(target)}:${existing ? expectedHead : ""}`
    );
    assert.ok(!push.args.join(" ").includes("offline-fixture"));
    const authEnv = push.options.env as Record<string, string>;
    assert.equal(authEnv.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
    const request = h.calls.find((call) => call.args.includes("--method"));
    assert.ok(request);
    assert.equal(request.args[2], existing ? "PATCH" : "POST");
    const body = JSON.parse(request.options.input as string);
    assert.equal(existing ? body.draft : body.draft === true, existing ? undefined : true);
    assert.ok(!h.calls.some((call) => call.args[0] === "config"));
  }
});

test("no-op and already-current PRs emit no push or PR write", () => {
  for (const options of [{ changed: false }, { existing: true, same: true }]) {
    const h = publicationHarness(options);
    assert.equal(h.execute(), "noop");
    assert.ok(!h.calls.some((call) => call.args[0] === "push" || call.args.includes("--method")));
  }
});

test("failed lease and unrelated branch changes stop before a PR mutation", () => {
  for (const options of [{ pushFails: true }, { existing: true, paths: "src/unrelated.ts" }]) {
    const h = publicationHarness(options);
    assert.throws(h.execute);
    assert.ok(!h.calls.some((call) => call.args.includes("--method")));
  }
});

test("workflow keeps measurement credential-free and publisher guarded with current-repo App scope", () => {
  const text = fs.readFileSync(".github/workflows/nightly-release-green.yml", "utf8");
  const measurement = text
    .split("  bank-ratchet-shrinks:")[1]
    .split("  publish-ratchet-shrinks:")[0];
  const publisher = text.split("  publish-ratchet-shrinks:")[1].split("  baseline-headroom:")[0];
  assert.match(measurement, /vars\.RATCHET_BANKING_ENABLED == 'true'/);
  assert.match(publisher, /vars\.RATCHET_BANKING_ENABLED == 'true'/);
  assert.doesNotMatch(measurement, /secrets\.|GH_TOKEN|contents: write|pull-requests: write/);
  assert.doesNotMatch(publisher, /npm-ci-retry|cache:|npm install|npm ci/);
  assert.match(measurement, /phase === "velocity"/);
  assert.match(measurement, /echo "changed=false"/);
  assert.match(measurement, /persist-credentials: false/);
  assert.match(publisher, /persist-credentials: false/);
  assert.ok(
    publisher.indexOf("Independently validate") < publisher.indexOf("Mint current-repository")
  );
  assert.match(publisher, /create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/);
  assert.match(publisher, /permission-contents: write/);
  assert.match(publisher, /permission-pull-requests: write/);
  assert.doesNotMatch(publisher, /owner:|repositories:|skip-token-revoke:/);
  assert.match(publisher, /node-version: "24"/);
  assert.doesNotMatch(measurement + publisher, /workflow_dispatch.*gh|git push --force /);
});
