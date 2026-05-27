import { RichText, type AppBskyFeedDefs, type AppBskyNotificationListNotifications } from "@atproto/api";
import {
  bskyUrlFromAtUri,
  getAgent,
  resolveActorDid,
  resolvePostUri,
} from "../bluesky";

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

// ── helpers ──────────────────────────────────────────────────────────────

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing required string parameter: ${key}`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function formatPostView(post: AppBskyFeedDefs.PostView): string {
  const record = post.record as { text?: string; createdAt?: string };
  const url = bskyUrlFromAtUri(post.uri, post.author.handle);
  const name = post.author.displayName
    ? `${post.author.displayName} (@${post.author.handle})`
    : `@${post.author.handle}`;
  return [
    `${name} — ${record.createdAt ?? post.indexedAt}`,
    record.text ?? "(no text)",
    `↻ ${post.repostCount ?? 0}  ♥ ${post.likeCount ?? 0}  💬 ${post.replyCount ?? 0}`,
    `uri: ${post.uri}`,
    url ? `url: ${url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatNotification(n: AppBskyNotificationListNotifications.Notification): string {
  const author = n.author.displayName
    ? `${n.author.displayName} (@${n.author.handle})`
    : `@${n.author.handle}`;
  const record = n.record as { text?: string } | undefined;
  const snippet = record?.text ? `: "${record.text.slice(0, 140)}"` : "";
  return `[${n.reason}] ${author}${snippet}\nreasonSubject: ${n.reasonSubject ?? "(none)"}\nuri: ${n.uri}\nat: ${n.indexedAt}\nisRead: ${n.isRead}`;
}

// ── tool definitions ─────────────────────────────────────────────────────

export const tools: ToolDefinition[] = [
  {
    name: "create_post",
    description: [
      "Publish a new post (or reply) to Bluesky from the authenticated account.",
      "",
      "SAFETY: Before calling this tool, show the exact post text to the user and get explicit confirmation ('yes', 'post it', etc.). Do not silently edit, shorten, or 'fix' the text without confirmation. Posts are public and effectively permanent.",
      "",
      "Text limit is 300 graphemes. Mentions (@handle) and URLs are auto-linked.",
      "",
      "To reply, pass `reply_to` as either an at:// URI or a https://bsky.app/profile/<handle>/post/<rkey> URL.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The post text. Max 300 graphemes." },
        reply_to: {
          type: "string",
          description: "Optional. AT URI or bsky.app URL of the post being replied to.",
        },
      },
      required: ["text"],
    },
    handler: async (args) => {
      const text = requireString(args, "text");
      const replyTo = optionalString(args, "reply_to");
      try {
        const agent = await getAgent();
        const rt = new RichText({ text });
        await rt.detectFacets(agent);

        let reply: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } } | undefined;
        if (replyTo) {
          const parentUri = await resolvePostUri(agent, replyTo);
          const res = await agent.getPosts({ uris: [parentUri] });
          const parent = res.data.posts[0];
          if (!parent) return fail(`Parent post not found: ${parentUri}`);
          const parentRecord = parent.record as {
            reply?: { root?: { uri: string; cid: string } };
          };
          const root = parentRecord.reply?.root ?? { uri: parent.uri, cid: parent.cid };
          reply = { root, parent: { uri: parent.uri, cid: parent.cid } };
        }

        const result = await agent.post({
          text: rt.text,
          facets: rt.facets,
          ...(reply ? { reply } : {}),
          createdAt: new Date().toISOString(),
        });
        const url = bskyUrlFromAtUri(result.uri, agent.session?.handle);
        return ok(
          `Posted.\nuri: ${result.uri}\ncid: ${result.cid}${url ? `\nurl: ${url}` : ""}`,
        );
      } catch (err) {
        return fail(`Failed to post: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "delete_post",
    description: "Delete one of your own posts. Provide the at:// URI or the bsky.app URL. Irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "AT URI or bsky.app URL of the post to delete." },
      },
      required: ["uri"],
    },
    handler: async (args) => {
      const uri = requireString(args, "uri");
      try {
        const agent = await getAgent();
        const resolved = await resolvePostUri(agent, uri);
        await agent.deletePost(resolved);
        return ok(`Deleted ${resolved}`);
      } catch (err) {
        return fail(`Failed to delete: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "get_timeline",
    description: "Fetch the authenticated account's home timeline. Returns most-recent posts first. Use `cursor` to paginate.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of posts (1-100). Default 30." },
        cursor: { type: "string", description: "Pagination cursor from a previous response." },
      },
    },
    handler: async (args) => {
      const limit = clamp(optionalNumber(args, "limit") ?? 30, 1, 100);
      const cursor = optionalString(args, "cursor");
      try {
        const agent = await getAgent();
        const res = await agent.getTimeline({ limit, cursor });
        const formatted = res.data.feed
          .map((item, i) => `--- [${i + 1}] ---\n${formatPostView(item.post)}`)
          .join("\n\n");
        const tail = res.data.cursor ? `\n\nnext_cursor: ${res.data.cursor}` : "";
        return ok((formatted || "(empty timeline)") + tail);
      } catch (err) {
        return fail(`Failed to fetch timeline: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "get_notifications",
    description: "Fetch recent notifications (likes, reposts, follows, mentions, replies, quotes) for the authenticated account.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of notifications (1-100). Default 30." },
        cursor: { type: "string", description: "Pagination cursor." },
        mark_as_seen: {
          type: "boolean",
          description: "If true, marks notifications as read after fetching. Default false.",
        },
      },
    },
    handler: async (args) => {
      const limit = clamp(optionalNumber(args, "limit") ?? 30, 1, 100);
      const cursor = optionalString(args, "cursor");
      const markAsSeen = optionalBoolean(args, "mark_as_seen") ?? false;
      try {
        const agent = await getAgent();
        const res = await agent.listNotifications({ limit, cursor });
        const formatted = res.data.notifications
          .map((n, i) => `--- [${i + 1}] ---\n${formatNotification(n)}`)
          .join("\n\n");
        if (markAsSeen) {
          await agent.updateSeenNotifications(new Date().toISOString());
        }
        const tail = res.data.cursor ? `\n\nnext_cursor: ${res.data.cursor}` : "";
        return ok((formatted || "(no notifications)") + tail);
      } catch (err) {
        return fail(`Failed to fetch notifications: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "search_posts",
    description: "Search Bluesky posts by keyword. Returns matching posts ordered by relevance (default) or latest.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Max results (1-100). Default 25." },
        sort: { type: "string", enum: ["top", "latest"], description: "Sort order. Default 'top'." },
        cursor: { type: "string", description: "Pagination cursor." },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const query = requireString(args, "query");
      const limit = clamp(optionalNumber(args, "limit") ?? 25, 1, 100);
      const sortInput = optionalString(args, "sort");
      const sort: "top" | "latest" = sortInput === "latest" ? "latest" : "top";
      const cursor = optionalString(args, "cursor");
      try {
        const agent = await getAgent();
        const res = await agent.app.bsky.feed.searchPosts({ q: query, limit, sort, cursor });
        const formatted = res.data.posts
          .map((post, i) => `--- [${i + 1}] ---\n${formatPostView(post)}`)
          .join("\n\n");
        const tail = res.data.cursor ? `\n\nnext_cursor: ${res.data.cursor}` : "";
        return ok((formatted || "(no results)") + tail);
      } catch (err) {
        return fail(`Search failed: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "search_users",
    description: "Search for Bluesky users by handle, name, or description.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Max results (1-100). Default 25." },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const query = requireString(args, "query");
      const limit = clamp(optionalNumber(args, "limit") ?? 25, 1, 100);
      try {
        const agent = await getAgent();
        const res = await agent.app.bsky.actor.searchActors({ q: query, limit });
        const formatted = res.data.actors
          .map((a) => {
            const name = a.displayName ? `${a.displayName} (@${a.handle})` : `@${a.handle}`;
            const desc = a.description ? `\n${a.description.replace(/\n+/g, " ")}` : "";
            return `${name}\ndid: ${a.did}${desc}`;
          })
          .join("\n\n");
        return ok(formatted || "(no users found)");
      } catch (err) {
        return fail(`User search failed: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "like_post",
    description: "Like a post. Accepts an at:// URI or a bsky.app URL.",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string", description: "AT URI or bsky.app URL of the post." } },
      required: ["uri"],
    },
    handler: async (args) => {
      const uri = requireString(args, "uri");
      try {
        const agent = await getAgent();
        const resolved = await resolvePostUri(agent, uri);
        const res = await agent.getPosts({ uris: [resolved] });
        const post = res.data.posts[0];
        if (!post) return fail(`Post not found: ${resolved}`);
        const like = await agent.like(post.uri, post.cid);
        return ok(`Liked ${post.uri}\nlike_uri: ${like.uri}`);
      } catch (err) {
        return fail(`Failed to like: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "unlike_post",
    description: "Remove your like from a post. Accepts the original post URI (the tool will look up your like record).",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "AT URI or bsky.app URL of the post you previously liked." },
      },
      required: ["uri"],
    },
    handler: async (args) => {
      const uri = requireString(args, "uri");
      try {
        const agent = await getAgent();
        const resolved = await resolvePostUri(agent, uri);
        const res = await agent.getPosts({ uris: [resolved] });
        const post = res.data.posts[0];
        if (!post) return fail(`Post not found: ${resolved}`);
        const likeUri = post.viewer?.like;
        if (!likeUri) return fail("You have not liked this post.");
        await agent.deleteLike(likeUri);
        return ok(`Unliked ${post.uri}`);
      } catch (err) {
        return fail(`Failed to unlike: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "repost",
    description: "Repost (boost) a post to your followers. Accepts an at:// URI or a bsky.app URL.",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string", description: "AT URI or bsky.app URL of the post." } },
      required: ["uri"],
    },
    handler: async (args) => {
      const uri = requireString(args, "uri");
      try {
        const agent = await getAgent();
        const resolved = await resolvePostUri(agent, uri);
        const res = await agent.getPosts({ uris: [resolved] });
        const post = res.data.posts[0];
        if (!post) return fail(`Post not found: ${resolved}`);
        const repost = await agent.repost(post.uri, post.cid);
        return ok(`Reposted ${post.uri}\nrepost_uri: ${repost.uri}`);
      } catch (err) {
        return fail(`Failed to repost: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "unrepost",
    description: "Remove your repost of a post. Accepts the original post URI.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "AT URI or bsky.app URL of the post you reposted." },
      },
      required: ["uri"],
    },
    handler: async (args) => {
      const uri = requireString(args, "uri");
      try {
        const agent = await getAgent();
        const resolved = await resolvePostUri(agent, uri);
        const res = await agent.getPosts({ uris: [resolved] });
        const post = res.data.posts[0];
        if (!post) return fail(`Post not found: ${resolved}`);
        const repostUri = post.viewer?.repost;
        if (!repostUri) return fail("You have not reposted this post.");
        await agent.deleteRepost(repostUri);
        return ok(`Removed repost of ${post.uri}`);
      } catch (err) {
        return fail(`Failed to unrepost: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "follow_user",
    description: "Follow a Bluesky user by handle (e.g. alice.bsky.social) or DID.",
    inputSchema: {
      type: "object",
      properties: { actor: { type: "string", description: "Handle (with or without @) or DID." } },
      required: ["actor"],
    },
    handler: async (args) => {
      const actor = requireString(args, "actor");
      try {
        const agent = await getAgent();
        const did = await resolveActorDid(agent, actor);
        const res = await agent.follow(did);
        return ok(`Followed ${did}\nfollow_uri: ${res.uri}`);
      } catch (err) {
        return fail(`Failed to follow: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "unfollow_user",
    description: "Unfollow a Bluesky user by handle or DID. (Looks up your follow record automatically.)",
    inputSchema: {
      type: "object",
      properties: { actor: { type: "string", description: "Handle (with or without @) or DID." } },
      required: ["actor"],
    },
    handler: async (args) => {
      const actor = requireString(args, "actor");
      try {
        const agent = await getAgent();
        const did = await resolveActorDid(agent, actor);
        const profile = await agent.getProfile({ actor: did });
        const followUri = profile.data.viewer?.following;
        if (!followUri) return fail(`You are not following ${did}.`);
        await agent.deleteFollow(followUri);
        return ok(`Unfollowed ${did}`);
      } catch (err) {
        return fail(`Failed to unfollow: ${(err as Error).message}`);
      }
    },
  },
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));
