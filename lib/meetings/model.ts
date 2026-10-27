/**
 * AIC OS's model access. Meetings never hold a provider key: completions go
 * through Apollo's gateway (OpenAI-compatible, text only), which meters
 * budget, enforces rate limits and audits the call. When the gateway is not
 * configured, callers fall back to deterministic logic and say so.
 */

export interface CarlaModel {
  readonly name: string;
  complete(input: { purpose: string; system: string; prompt: string }): Promise<string>;
}

export class GatewayError extends Error {
  constructor(readonly status: number) {
    super(`apollo gateway ${status}`);
  }
}

export class ApolloGatewayModel implements CarlaModel {
  readonly name = "carla:apollo-gateway";
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly f: typeof fetch = fetch
  ) {}

  async complete(input: { purpose: string; system: string; prompt: string }) {
    const res = await this.f(`${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", "x-aic-purpose": input.purpose },
      body: JSON.stringify({
        model: "carla",
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new GatewayError(res.status);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  }
}

export function modelFromEnv(): CarlaModel | null {
  const url = process.env.APOLLO_GATEWAY_URL;
  const token = process.env.APOLLO_RUNTIME_TOKEN;
  return url && token ? new ApolloGatewayModel(url, token) : null;
}

/**
 * Wraps third-party text (emails, transcripts, notes) so the model treats it
 * as material to read, not instructions. The tag cannot be closed from inside.
 */
export function untrusted(label: string, text: string): string {
  const safe = text.replaceAll("</untrusted", "<\\/untrusted");
  return `<untrusted source="${label}">\n${safe}\n</untrusted>`;
}
