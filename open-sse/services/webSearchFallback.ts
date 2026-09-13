import { FORMATS } from "../translator/formats.ts";

export const OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME = "omniroute_web_search";
// Prefix match — Anthropic sends date-suffixed variants (web_search_20250305, …).
// The other two detectors (openai-responses/helpers.ts, webSearchRouting.ts) already
// use /^web_search/ prefix matching; this aligns the fallback detector with them.
const WEB_SEARCH_TOOL_TYPES = /^web_search/;
const SEARCH_CONTEXT_DEFAULTS: Record<string, number> = {
  low: 5,
  medium: 8,
  high: 10,
};

type JsonRecord = Record<string, unknown>;
type WebSearchFallbackBody = JsonRecord & {
  tools?: unknown;
  tool_choice?: unknown;
};

export interface WebSearchFallbackPlan {
  enabled: boolean;
  toolName: string | null;
  convertedToolCount: number;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function isBuiltInWebSearchTool(tool: unknown): tool is JsonRecord {
  const toolRecord = toRecord(tool);
  const toolType = typeof toolRecord.type === "string" ? toolRecord.type : "";
  return WEB_SEARCH_TOOL_TYPES.test(toolType) && !toolRecord.function;
}

function isBuiltInWebSearchToolChoice(toolChoice: unknown): boolean {
  const choice = toRecord(toolChoice);
  const toolType = typeof choice.type === "string" ? choice.type : "";
  return WEB_SEARCH_TOOL_TYPES.test(toolType);
}

function buildFallbackDescription(tool: JsonRecord): string {
  const externalWebAccess = tool.external_web_access !== false;
  const contextSize =
    typeof tool.search_context_size === "string"
      ? tool.search_context_size.trim().toLowerCase()
      : "";
  const defaultMaxResults = SEARCH_CONTEXT_DEFAULTS[contextSize] || SEARCH_CONTEXT_DEFAULTS.medium;
  const accessMode = externalWebAccess ? "public web" : "configured search index";

  return [
    `Search the ${accessMode} for recent, factual information and return cited results.`,
    "Use this when the answer depends on current events, external documents, or fresh facts.",
    `If max_results is omitted, prefer about ${defaultMaxResults} results.`,
  ].join(" ");
}

function buildFallbackParameters(tool: JsonRecord): JsonRecord {
  const contextSize =
    typeof tool.search_context_size === "string"
      ? tool.search_context_size.trim().toLowerCase()
      : "";
  const defaultMaxResults = SEARCH_CONTEXT_DEFAULTS[contextSize] || SEARCH_CONTEXT_DEFAULTS.medium;

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "The web search query to execute.",
      },
      search_type: {
        type: "string",
        enum: ["web", "news"],
        description: "Use 'news' for recent headlines or reporting; otherwise use 'web'.",
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: defaultMaxResults,
        description: "Maximum number of results to retrieve.",
      },
      country: {
        type: "string",
        description: "Optional 2-letter country code for localization, e.g. US or BR.",
      },
      language: {
        type: "string",
        description: "Optional language code such as en or pt-BR.",
      },
      time_range: {
        type: "string",
        enum: ["any", "day", "week", "month", "year"],
        description: "Optional recency filter.",
      },
      filters: {
        type: "object",
        additionalProperties: false,
        properties: {
          include_domains: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of domains to include.",
          },
          exclude_domains: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of domains to exclude.",
          },
        },
      },
    },
    required: ["query"],
  };
}

function buildFallbackTool(tool: JsonRecord, targetFormat?: string | null): JsonRecord {
  const name = OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME;
  const description = buildFallbackDescription(tool);
  const parameters = buildFallbackParameters(tool);

  // Responses API expects FLAT function tools ({ type, name, parameters }), whereas
  // Chat Completions expects NESTED ({ type, function: { name, parameters } }). On the
  // Responses→Responses passthrough path nothing flattens the injected tool, so a nested
  // shape reaches the upstream as `tools[0].function.name` and is rejected with
  // "Missing required parameter: 'tools[0].name'." (issue #2390).
  if (targetFormat === FORMATS.OPENAI_RESPONSES) {
    return { type: "function", name, description, parameters };
  }

  return {
    type: "function",
    function: { name, description, parameters },
  };
}

// Providers whose endpoint advertises Claude/Anthropic format but do NOT reliably forward
// Anthropic's typed server tools (web_search_20250305, …) end to end. For these the
// Claude -> Claude bypass below must NOT apply: forwarding the native server tool either
// 400s upstream (MiniMax: `invalid params, function name or parameters is empty (2013)`,
// #4481) or is silently dropped in transit, so the built-in web-search tool has to be
// converted to the omniroute_web_search function fallback — which these models accept as
// a normal function tool.
//
// `cliproxy` added for #TOG-2391: CLIProxyAPI's Claude-executor emulation does not
// preserve the caller's declared tool manifest end to end (live repro: a forced
// `tool_choice` on any declared Anthropic server tool — web_search, web_fetch, bash,
// code_execution — 400s with the genuine Anthropic error `Tool '<name>' not found in
// provided tools`; a bogus custom tool name round-tripped as a DIFFERENT session's real
// tool identity, confirming the manifest reaching the model is not the one this request
// declared). Bypassing native passthrough for this provider is safer than trusting it to
// forward server tools correctly. Equivalent immediate mitigation without a code deploy:
// set `interceptSearch: true` for provider "cliproxy" in the `interception_rules`
// key_value table (src/lib/db/interceptionRules.ts) — this code-level default is the
// durable safety net in case that operator config is ever absent, reset, or the provider
// alias changes.
const CLAUDE_FORMAT_PROVIDERS_WITHOUT_SERVER_TOOLS = new Set(["minimax"]);

// #TOG-2391: matches the "cliproxy" alias itself, the static node-type id
// ("openai-compatible-cliproxy"), and any UUID-suffixed connection id derived from it
// ("openai-compatible-cliproxy-<uuid>", per src/lib/db/providerNodeSelect.ts's
// nodeTypeFromId stripping convention) — the runtime `provider` string at this call site
// was not confirmed to be the bare alias vs. a concrete node/connection id, so match all
// three shapes rather than guessing one and silently missing the other two.
const CLIPROXY_PROVIDER_RE = /^(cliproxy|openai-compatible-cliproxy)(-[0-9a-f-]{36})?$/i;

function isProviderWithoutReliableServerTools(provider: string | null | undefined): boolean {
  if (!provider) return false;
  if (CLAUDE_FORMAT_PROVIDERS_WITHOUT_SERVER_TOOLS.has(provider)) return true;
  return CLIPROXY_PROVIDER_RE.test(provider);
}

export function supportsNativeWebSearchFallbackBypass({
  provider,
  sourceFormat,
  targetFormat,
  nativeCodexPassthrough,
  interceptSearchOverride,
}: {
  provider?: string | null;
  sourceFormat?: string | null;
  targetFormat?: string | null;
  nativeCodexPassthrough: boolean;
  // Per-model rule (#3384) — resolveInterceptSearch() in src/lib/db/interceptionRules.ts.
  // true = force interception (never bypass); false = force native bypass; undefined =
  // fall through to the native-bypass defaults below.
  interceptSearchOverride?: boolean;
}): boolean {
  if (typeof interceptSearchOverride === "boolean") {
    return !interceptSearchOverride;
  }
  // Native Codex (OpenAI Responses) passthrough: the upstream runs web search itself.
  if (nativeCodexPassthrough) return true;
  // Gemini target: the Gemini translator maps built-in web search to googleSearch natively.
  if (targetFormat === FORMATS.GEMINI) return true;
  // Claude -> Claude passthrough: the Anthropic Messages upstream (e.g. a Claude
  // subscription driven by Claude Code) natively runs web_search_20250305. Forward the
  // native tool untouched instead of rewriting it to omniroute_web_search. Mirrors the
  // Codex/Gemini bypasses so every native-web-search provider is treated symmetrically.
  if (sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.CLAUDE) {
    // …except Anthropic-compatible providers that don't actually implement server tools.
    if (isProviderWithoutReliableServerTools(provider)) return false;
    return true;
  }
  return false;
}

export function prepareWebSearchFallbackBody<T extends WebSearchFallbackBody>(
  body: T,
  options: {
    provider?: string | null;
    sourceFormat?: string | null;
    targetFormat?: string | null;
    nativeCodexPassthrough: boolean;
    interceptSearchOverride?: boolean;
  }
): { body: T; fallback: WebSearchFallbackPlan } {
  const tools = Array.isArray(body.tools) ? body.tools : null;
  if (!tools || tools.length === 0) {
    return {
      body,
      fallback: { enabled: false, toolName: null, convertedToolCount: 0 },
    };
  }

  const builtInSearchTools = tools.filter(isBuiltInWebSearchTool);
  if (builtInSearchTools.length === 0) {
    return {
      body,
      fallback: { enabled: false, toolName: null, convertedToolCount: 0 },
    };
  }

  if (supportsNativeWebSearchFallbackBypass(options)) {
    return {
      body,
      fallback: { enabled: false, toolName: null, convertedToolCount: 0 },
    };
  }

  const toolNames = new Set<string>();
  const preservedTools = tools.filter((tool) => {
    if (isBuiltInWebSearchTool(tool)) return false;
    const toolRecord = toRecord(tool);
    const functionRecord = toRecord(toolRecord.function);
    const name =
      typeof functionRecord.name === "string"
        ? functionRecord.name
        : typeof toolRecord.name === "string"
          ? toolRecord.name
          : "";
    if (name.trim().length > 0) {
      toolNames.add(name.trim());
    }
    return true;
  });

  const isResponsesTarget = options.targetFormat === FORMATS.OPENAI_RESPONSES;

  if (!toolNames.has(OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME)) {
    preservedTools.unshift(
      buildFallbackTool(toRecord(builtInSearchTools[0]), options.targetFormat)
    );
  }

  const nextBody: T = {
    ...body,
    tools: preservedTools as T["tools"],
  };

  if (isBuiltInWebSearchToolChoice(body.tool_choice)) {
    // Match the injected tool shape: flat for Responses API, nested for Chat Completions.
    nextBody.tool_choice = (
      isResponsesTarget
        ? { type: "function", name: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME }
        : { type: "function", function: { name: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME } }
    ) as T["tool_choice"];
  }

  return {
    body: nextBody,
    fallback: {
      enabled: true,
      toolName: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME,
      convertedToolCount: builtInSearchTools.length,
    },
  };
}
