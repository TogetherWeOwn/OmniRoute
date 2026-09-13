import test from "node:test";
import assert from "node:assert/strict";

const {
  prepareWebSearchFallbackBody,
  supportsNativeWebSearchFallbackBypass,
  OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME,
} = await import("../../open-sse/services/webSearchFallback.ts");

const {
  prepareWebFetchFallbackBody,
  supportsNativeWebFetchFallbackBypass,
  OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME,
} = await import("../../open-sse/services/webFetchInterception.ts");

// #TOG-2391: CLIProxyAPI's Claude-executor emulation does not reliably forward a
// caller's declared tool manifest end to end. Live repro against
// cliproxy/claude-sonnet-5 (http://omniroute:20128, 2026-09-13):
//   - forcing tool_choice on any declared Anthropic server tool (web_search,
//     web_fetch, bash, code_execution) 400s with the genuine Anthropic error
//     `Tool '<name>' not found in provided tools` — the request reaches real
//     Anthropic, but not with the tool manifest this request declared.
//   - a single bogus custom tool (e.g. "qqzzmarker9988") round-trips as a
//     COMPLETELY DIFFERENT, unrelated session's real tool identity
//     ("mcp__isolate_must__album_qqzzmarker9988"), reproduced 3/3 runs — the
//     manifest reaching the model is not staged per-request.
// Forwarding native server tools untouched on this lane is unsafe. These tests
// pin the provider-exclusion guard added to both the web_search and web_fetch
// interception predicates so a future edit cannot silently re-enable bypass for
// this lane, and so a similarly-broken lane can be caught by extending
// CLIPROXY_PROVIDER_RE's pattern (or replacing it) rather than re-deriving this
// investigation from scratch.

for (const providerId of [
  "cliproxy",
  "openai-compatible-cliproxy",
  "openai-compatible-cliproxy-ffa52f1a-15aa-4797-be10-5bc3c708530d",
]) {
  test(`#TOG-2391 web_search bypass predicate: false for cliproxy provider id "${providerId}"`, () => {
    assert.equal(
      supportsNativeWebSearchFallbackBypass({
        provider: providerId,
        sourceFormat: "claude",
        targetFormat: "claude",
        nativeCodexPassthrough: false,
      }),
      false,
      "cliproxy must not get the native Claude->Claude web_search bypass"
    );
  });

  test(`#TOG-2391 web_fetch bypass predicate: false for cliproxy provider id "${providerId}" with no DB override`, () => {
    assert.equal(
      supportsNativeWebFetchFallbackBypass({
        provider: providerId,
        sourceFormat: "claude",
        targetFormat: "claude",
        nativeCodexPassthrough: false,
        interceptFetchOverride: undefined,
      }),
      false,
      "cliproxy must default to the safe web_fetch fallback even with no operator opt-in"
    );
  });
}

test("#TOG-2391 regression guard: still true for Claude -> Claude on a real Claude provider (must not overcorrect)", () => {
  assert.equal(
    supportsNativeWebSearchFallbackBypass({
      provider: "anthropic",
      sourceFormat: "claude",
      targetFormat: "claude",
      nativeCodexPassthrough: false,
    }),
    true
  );
  assert.equal(
    supportsNativeWebFetchFallbackBypass({
      provider: "anthropic",
      sourceFormat: "claude",
      targetFormat: "claude",
      nativeCodexPassthrough: false,
      interceptFetchOverride: undefined,
    }),
    true,
    "web_fetch stays opt-in (Hard Rule #20) for every provider other than cliproxy"
  );
});

test("#TOG-2391 explicit interceptSearchOverride still wins over the cliproxy default", () => {
  assert.equal(
    supportsNativeWebSearchFallbackBypass({
      provider: "cliproxy",
      sourceFormat: "claude",
      targetFormat: "claude",
      nativeCodexPassthrough: false,
      interceptSearchOverride: false,
    }),
    true,
    "an explicit operator interceptSearch:false must still force native bypass, even for cliproxy"
  );
});

test("#TOG-2391 end-to-end: web_search on cliproxy is converted to the safe function-tool fallback, not forwarded native", () => {
  const inputBody = {
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
  };
  const { body, fallback } = prepareWebSearchFallbackBody(inputBody, {
    provider: "openai-compatible-cliproxy",
    sourceFormat: "claude",
    targetFormat: "claude",
    nativeCodexPassthrough: false,
  });

  assert.equal(fallback.enabled, true);
  assert.equal(fallback.toolName, OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME);
  const tools = body.tools as Record<string, unknown>[];
  assert.ok(
    !tools.some((t) => t.type === "web_search_20250305"),
    "the native server tool type must not reach the cliproxy upstream"
  );
});

test("#TOG-2391 end-to-end: web_fetch on cliproxy is converted to the safe function-tool fallback by default", () => {
  const inputBody = {
    tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
  };
  const { body, fallback } = prepareWebFetchFallbackBody(inputBody, {
    provider: "openai-compatible-cliproxy",
    sourceFormat: "claude",
    targetFormat: "claude",
    nativeCodexPassthrough: false,
  });

  assert.equal(fallback.enabled, true);
  assert.equal(fallback.toolName, OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME);
  const tools = body.tools as Record<string, unknown>[];
  assert.ok(
    !tools.some((t) => t.type === "web_fetch_20250910"),
    "the native server tool type must not reach the cliproxy upstream"
  );
});
