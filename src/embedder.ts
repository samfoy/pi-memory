/**
 * Embedding provider for semantic memory search.
 *
 * Ported from pi-session-search so both packages share one provider surface;
 * kept in-package rather than as a dependency to avoid coupling their release
 * cycles. Bedrock is the default because it needs no API key beyond the AWS
 * credential chain already present on a corporate machine, and because
 * amazon.titan-embed-text-v2:0 supports matryoshka dimension reduction.
 *
 * Replaces the @xenova/transformers backend removed in #31: no native modules,
 * no ONNX runtime, no model download. Entirely optional -- when unconfigured or
 * failing, search falls back to FTS5 BM25 exactly as it does today.
 */

export interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]>;
}

export interface EmbedderConfig {
  type: "openai" | "bedrock" | "ollama" | "mistral" | "openai-compatible";
  // OpenAI / Mistral / OpenAI-compatible
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /**
   * Opt in to sending the OpenAI `dimensions` request parameter.
   *
   * Only some embedding models support matryoshka dimension reduction. OpenAI's
   * text-embedding-3 models do; most OpenAI-compatible providers do not.
   */
  sendDimensions?: boolean;
  // Bedrock
  profile?: string;
  region?: string;
  // Ollama
  url?: string;
  // Shared
  dimensions?: number;
}

const DEFAULTS: Record<string, Partial<EmbedderConfig>> = {
  openai: { model: "text-embedding-3-small", dimensions: 512, baseUrl: "https://api.openai.com", sendDimensions: true },
  bedrock: {
    model: "amazon.titan-embed-text-v2:0",
    region: "us-east-1",
    profile: "default",
    dimensions: 512,
  },
  ollama: { model: "nomic-embed-text", url: "http://localhost:11434" },
  mistral: { model: "mistral-embed", dimensions: 1024, baseUrl: "https://api.mistral.ai", sendDimensions: false },
  "openai-compatible": { model: "text-embedding-3-small", dimensions: 512, sendDimensions: false },
};

export function createEmbedder(config: EmbedderConfig): Embedder {
  const defaults = DEFAULTS[config.type] ?? {};
  const merged = { ...defaults, ...config };

  switch (merged.type) {
    case "openai":
      return new OpenAICompatibleEmbedder(
        merged.apiKey || process.env.OPENAI_API_KEY || "",
        merged.model!,
        merged.dimensions!,
        merged.baseUrl || "https://api.openai.com",
        merged.sendDimensions ?? true
      );
    case "mistral":
      return new OpenAICompatibleEmbedder(
        merged.apiKey || process.env.MISTRAL_API_KEY || "",
        merged.model!,
        merged.dimensions!,
        merged.baseUrl || "https://api.mistral.ai",
        merged.sendDimensions ?? false
      );
    case "openai-compatible": {
      if (!merged.baseUrl) throw new Error("openai-compatible requires baseUrl");
      return new OpenAICompatibleEmbedder(
        merged.apiKey || "",
        merged.model!,
        merged.dimensions!,
        merged.baseUrl,
        merged.sendDimensions ?? false
      );
    }
    case "bedrock":
      return new BedrockEmbedder(
        merged.profile!,
        merged.region!,
        merged.model!,
        merged.dimensions!
      );
    case "ollama":
      return new OllamaEmbedder(merged.url!, merged.model!);
    default:
      throw new Error(`Unknown embedder type: ${merged.type}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function truncate(text: string, maxChars = 12000): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

async function parallelMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new Error("Aborted");
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

// ─── OpenAI-Compatible (OpenAI, Mistral, Together, Fireworks, etc.) ──

class OpenAICompatibleEmbedder implements Embedder {
  private endpoint: string;

  constructor(
    private apiKey: string,
    private model: string,
    private dimensions: number,
    baseUrl: string,
    private sendDimensions: boolean
  ) {
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/embeddings`;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]> {
    const BATCH = 100;
    const results: (number[] | null)[] = new Array(texts.length).fill(null);

    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) throw new Error("Aborted");
      const batch = texts.slice(i, i + BATCH).map((t) => truncate(t));

      const body: Record<string, unknown> = {
        input: batch,
        model: this.model,
      };
      if (this.dimensions && this.sendDimensions) {
        body.dimensions = this.dimensions;
      }

      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Embeddings API ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const json = (await res.json()) as {
        data: { embedding: number[]; index?: number }[];
      };
      for (let k = 0; k < json.data.length; k++) {
        const item = json.data[k];
        // Some providers (e.g. Gemini) omit `index` when it is 0
        // (protobuf default-value omission). Fall back to loop position.
        results[i + (item.index ?? k)] = item.embedding;
      }
    }
    return results;
  }
}

// ─── Bedrock ─────────────────────────────────────────────────────────

class BedrockEmbedder implements Embedder {
  private clientPromise: Promise<any>;

  constructor(
    profile: string,
    region: string,
    private model: string,
    private dimensions: number
  ) {
    this.clientPromise = (async () => {
      const { BedrockRuntimeClient } = await import(
        "@aws-sdk/client-bedrock-runtime"
      );
      const { fromIni } = await import("@aws-sdk/credential-providers");
      return new BedrockRuntimeClient({
        region,
        credentials: fromIni({ profile }),
      });
    })();
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]> {
    const client = await this.clientPromise;
    return parallelMap(
      texts,
      async (text) => {
        const { InvokeModelCommand } = await import(
          "@aws-sdk/client-bedrock-runtime"
        );
        const body = JSON.stringify({
          inputText: truncate(text),
          dimensions: this.dimensions,
          normalize: true,
        });
        const cmd = new InvokeModelCommand({
          modelId: this.model,
          contentType: "application/json",
          accept: "application/json",
          body: new TextEncoder().encode(body),
        });
        const res = await client.send(cmd);
        const parsed = JSON.parse(new TextDecoder().decode(res.body));
        if (!parsed.embedding) throw new Error("No embedding in response");
        return parsed.embedding;
      },
      10,
      signal
    );
  }
}

// ─── Ollama ──────────────────────────────────────────────────────────

class OllamaEmbedder implements Embedder {
  constructor(
    private url: string,
    private model: string
  ) {
    this.url = url.replace(/\/$/, "");
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const res = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: truncate(text) }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings[0];
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]> {
    return parallelMap(
      texts,
      async (text) => {
        try {
          return await this.embed(text, signal);
        } catch {
          return null;
        }
      },
      4,
      signal
    );
  }
}
