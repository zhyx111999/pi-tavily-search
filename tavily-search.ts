import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TAVILY_API_URL = "https://api.tavily.com/search";
const RETRYABLE_STATUS_CODES = new Set([401, 408, 429, 432, 500, 502, 503, 504]);
const REQUEST_TIMEOUT_MS = 120_000;
let nextKeyIndex = 0;

// Read on every request so changing the private key file does not require a reload.
function loadApiKeys(): string[] {
  const configPath = join(getAgentDir(), "tavily-api-keys.json");
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    // JSON parser errors can contain secret input; never forward them to the model.
    throw new Error(`Cannot read Tavily key configuration: ${configPath}`);
  }

  if (!config || typeof config !== "object" || !("apiKeys" in config)) {
    throw new Error("Tavily key configuration must contain an apiKeys array");
  }
  const keys = config.apiKeys;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((key) => typeof key === "string" && key.trim())) {
    throw new Error("Tavily apiKeys must be a non-empty array of non-empty strings");
  }
  return [...new Set(keys.map((key: string) => key.trim()))];
}

class TavilyHttpError extends Error {
  constructor(readonly status: number, body: string) {
    const safeBody = body.replace(/tvly-[A-Za-z0-9_-]+/g, "[REDACTED]").slice(0, 1000);
    super(`Tavily HTTP ${status}: ${safeBody}`);
  }
}

const searchDepth = StringEnum(["basic", "advanced", "fast", "ultra-fast"] as const);
const topic = StringEnum(["general", "news", "finance"] as const);
const timeRange = StringEnum(["day", "week", "month", "year", "d", "w", "m", "y"] as const);
const answerMode = Type.Union([Type.Boolean(), StringEnum(["basic", "advanced"] as const)]);
const rawContentMode = Type.Union([Type.Boolean(), StringEnum(["markdown", "text"] as const)]);

const tavilySearch = defineTool({
  name: "tavily_search",
  label: "Tavily Search",
  description:
    "Search the live web with Tavily. Returns ranked sources and optional answers, raw content, images, favicons, and usage data.",
  promptSnippet: "Search the live web with Tavily using its full Search API",
  promptGuidelines: [
    "Use tavily_search when current web information, documentation, facts, or sources are needed.",
    "Use tavily_search include_domains or exclude_domains to constrain source selection when appropriate.",
    "Use tavily_search include_raw_content only when the answer needs page text beyond snippets.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "The search query." }),
    search_depth: Type.Optional(searchDepth),
    chunks_per_source: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    max_results: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    topic: Type.Optional(topic),
    time_range: Type.Optional(timeRange),
    start_date: Type.Optional(Type.String({ description: "Start date in YYYY-MM-DD format." })),
    end_date: Type.Optional(Type.String({ description: "End date in YYYY-MM-DD format." })),
    include_answer: Type.Optional(answerMode),
    include_raw_content: Type.Optional(rawContentMode),
    include_images: Type.Optional(Type.Boolean()),
    include_image_descriptions: Type.Optional(Type.Boolean()),
    include_favicon: Type.Optional(Type.Boolean()),
    include_domains: Type.Optional(Type.Array(Type.String())),
    exclude_domains: Type.Optional(Type.Array(Type.String())),
    country: Type.Optional(Type.String({ description: "Country code used to boost local results." })),
    auto_parameters: Type.Optional(Type.Boolean()),
    exact_match: Type.Optional(Type.Boolean()),
    include_usage: Type.Optional(Type.Boolean()),
    safe_search: Type.Optional(Type.Boolean()),
  }),

  async execute(_toolCallId, params, signal, onUpdate) {
    const query = params.query.trim();
    if (!query) throw new Error("Tavily query must not be empty");
    if (signal?.aborted) throw new Error("Tavily search cancelled");

    const apiKeys = loadApiKeys();
    const startIndex = nextKeyIndex % apiKeys.length;
    nextKeyIndex = (startIndex + 1) % apiKeys.length;
    const payload = Object.fromEntries(
      Object.entries({ ...params, query }).filter(([, value]) => value !== undefined),
    );
    let lastError: unknown;

    // Each request visits every configured key at most once, even under concurrency.
    for (let attempt = 0; attempt < apiKeys.length; attempt += 1) {
      if (signal?.aborted) throw new Error("Tavily search cancelled");
      const keyIndex = (startIndex + attempt) % apiKeys.length;
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      try {
        onUpdate?.({ content: [{ type: "text", text: `Searching Tavily (attempt ${attempt + 1})...` }] });
        const response = await fetch(TAVILY_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKeys[keyIndex]}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
          signal: requestSignal,
        });
        const body = await response.text();
        if (!response.ok) throw new TavilyHttpError(response.status, body);

        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          data = body;
        }
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: data,
        };
      } catch (error) {
        if (signal?.aborted) throw new Error("Tavily search cancelled");
        if (error instanceof TavilyHttpError) {
          if (!RETRYABLE_STATUS_CODES.has(error.status)) throw error;
          lastError = error;
        } else {
          lastError = new Error(timeoutSignal.aborted ? "Tavily request timed out" : "Tavily network request failed");
        }
      }

      if (attempt + 1 < apiKeys.length) {
        try {
          await delay(500, undefined, { signal });
        } catch {
          throw new Error("Tavily search cancelled");
        }
      }
    }

    throw new Error(`Tavily search failed after ${apiKeys.length} key attempts: ${String(lastError)}`);
  },
});

export default function tavilyExtension(pi: ExtensionAPI) {
  pi.registerTool(tavilySearch);
}
