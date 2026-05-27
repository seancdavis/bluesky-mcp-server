import { AtpAgent } from "@atproto/api";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

let agentPromise: Promise<AtpAgent> | null = null;

export async function getAgent(): Promise<AtpAgent> {
  if (!agentPromise) {
    agentPromise = (async () => {
      const agent = new AtpAgent({
        service: process.env.BLUESKY_SERVICE ?? "https://bsky.social",
      });
      await agent.login({
        identifier: requireEnv("BLUESKY_IDENTIFIER"),
        password: requireEnv("BLUESKY_APP_PASSWORD"),
      });
      return agent;
    })().catch((err) => {
      agentPromise = null;
      throw err;
    });
  }
  return agentPromise;
}

const POST_URL_RE = /bsky\.app\/profile\/([^\/]+)\/post\/([^\/?#]+)/;

export async function resolvePostUri(agent: AtpAgent, input: string): Promise<string> {
  const trimmed = input.trim();
  if (trimmed.startsWith("at://")) return trimmed;
  const match = trimmed.match(POST_URL_RE);
  if (!match) {
    throw new Error(
      `Could not parse post identifier "${input}". Expected an at:// URI or a https://bsky.app/profile/<handle>/post/<rkey> URL.`,
    );
  }
  const handleOrDid = match[1]!;
  const rkey = match[2]!;
  const did = handleOrDid.startsWith("did:")
    ? handleOrDid
    : (await agent.resolveHandle({ handle: handleOrDid })).data.did;
  return `at://${did}/app.bsky.feed.post/${rkey}`;
}

export async function resolveActorDid(agent: AtpAgent, input: string): Promise<string> {
  const trimmed = input.trim().replace(/^@/, "");
  if (trimmed.startsWith("did:")) return trimmed;
  return (await agent.resolveHandle({ handle: trimmed })).data.did;
}

export function bskyUrlFromAtUri(uri: string, handle?: string): string | undefined {
  const m = uri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!m) return undefined;
  return `https://bsky.app/profile/${handle ?? m[1]}/post/${m[2]}`;
}
