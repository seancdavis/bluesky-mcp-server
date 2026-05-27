import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RichText, AppBskyFeedDefs, AppBskyNotificationListNotifications } from "@atproto/api";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getAgent,
  resolvePostUri,
  resolveActorDid,
  bskyUrlFromAtUri,
} from "./bluesky.js";

const ok = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
});

const fail = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

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

export function setupMCPServer(): McpServer {
  const server = new McpServer({
    name: "bluesky-mcp-server",
    version: "0.1.0",
  });

  server.tool(
    "create_post",
    [
      "Publish a new post (or reply) to Bluesky from the authenticated account.",
      "",
      "SAFETY: Before calling this tool, show the exact post text to the user and get explicit confirmation ('yes', 'post it', etc.). Do not silently edit, shorten, or 'fix' the text without confirmation. Posts are public and effectively permanent.",
      "",
      "Text limit is 300 graphemes. Mentions (@handle) and URLs are auto-linked.",
      "",
      "To reply, pass `reply_to` as either an at:// URI or a https://bsky.app/profile/<handle>/post/<rkey> URL.",
    ].join("\n"),
    {
      text: z.string().min(1).max(3000).describe("The post text. Max 300 graphemes per Bluesky."),
      reply_to: z
        .string()
        .optional()
        .describe("Optional. AT URI or bsky.app URL of the post being replied to."),
    },
    async ({ text, reply_to }): Promise<CallToolResult> => {
      try {
        const agent = await getAgent();
        const rt = new RichText({ text });
        await rt.detectFacets(agent);

        let reply: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } } | undefined;
        if (reply_to) {
          const parentUri = await resolvePostUri(agent, reply_to);
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
  );

  server.tool(
    "delete_post",
    "Delete one of your own posts. Provide the at:// URI or the bsky.app URL. Irreversible.",
    {
      uri: z.string().describe("AT URI or bsky.app URL of the post to delete."),
    },
    async ({ uri }): Promise<CallToolResult> => {
      try {
        const agent = await getAgent();
        const resolved = await resolvePostUri(agent, uri);
        await agent.deletePost(resolved);
        return ok(`Deleted ${resolved}`);
      } catch (err) {
        return fail(`Failed to delete: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    "get_timeline",
    "Fetch the authenticated account's home timeline. Returns most-recent posts first. Use `cursor` to paginate.",
    {
      limit: z.number().int().min(1).max(100).default(30).describe("Number of posts to fetch (1-100)."),
      cursor: z.string().optional().describe("Pagination cursor from a previous response."),
    },
    async ({ limit, cursor }): Promise<CallToolResult> => {
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
  );

  server.tool(
    "get_notifications",
    "Fetch recent notifications (likes, reposts, follows, mentions, replies, quotes) for the authenticated account.",
    {
      limit: z.number().int().min(1).max(100).default(30).describe("Number of notifications (1-100)."),
      cursor: z.string().optional().describe("Pagination cursor."),
      mark_as_seen: z
        .boolean()
        .default(false)
        .describe("If true, marks notifications as read after fetching."),
    },
    async ({ limit, cursor, mark_as_seen }): Promise<CallToolResult> => {
      try {
        const agent = await getAgent();
        const res = await agent.listNotifications({ limit, cursor });
        const formatted = res.data.notifications
          .map((n, i) => `--- [${i + 1}] ---\n${formatNotification(n)}`)
          .join("\n\n");
        if (mark_as_seen) {
          await agent.updateSeenNotifications(new Date().toISOString());
        }
        const tail = res.data.cursor ? `\n\nnext_cursor: ${res.data.cursor}` : "";
        return ok((formatted || "(no notifications)") + tail);
      } catch (err) {
        return fail(`Failed to fetch notifications: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    "search_posts",
    "Search Bluesky posts by keyword. Returns matching posts ordered by relevance (default) or latest.",
    {
      query: z.string().min(1).describe("Search query."),
      limit: z.number().int().min(1).max(100).default(25).describe("Max results (1-100)."),
      sort: z.enum(["top", "latest"]).default("top").describe("Sort order."),
      cursor: z.string().optional().describe("Pagination cursor."),
    },
    async ({ query, limit, sort, cursor }): Promise<CallToolResult> => {
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
  );

  server.tool(
    "search_users",
    "Search for Bluesky users by handle, name, or description.",
    {
      query: z.string().min(1).describe("Search query."),
      limit: z.number().int().min(1).max(100).default(25).describe("Max results (1-100)."),
    },
    async ({ query, limit }): Promise<CallToolResult> => {
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
  );

  server.tool(
    "like_post",
    "Like a post. Accepts an at:// URI or a bsky.app URL.",
    { uri: z.string().describe("AT URI or bsky.app URL of the post.") },
    async ({ uri }): Promise<CallToolResult> => {
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
  );

  server.tool(
    "unlike_post",
    "Remove your like from a post. Accepts the original post URI (the tool will look up your like record).",
    { uri: z.string().describe("AT URI or bsky.app URL of the post you previously liked.") },
    async ({ uri }): Promise<CallToolResult> => {
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
  );

  server.tool(
    "repost",
    "Repost (boost) a post to your followers. Accepts an at:// URI or a bsky.app URL.",
    { uri: z.string().describe("AT URI or bsky.app URL of the post.") },
    async ({ uri }): Promise<CallToolResult> => {
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
  );

  server.tool(
    "unrepost",
    "Remove your repost of a post. Accepts the original post URI.",
    { uri: z.string().describe("AT URI or bsky.app URL of the post you reposted.") },
    async ({ uri }): Promise<CallToolResult> => {
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
  );

  server.tool(
    "follow_user",
    "Follow a Bluesky user by handle (e.g. alice.bsky.social) or DID.",
    { actor: z.string().describe("Handle (with or without @) or DID.") },
    async ({ actor }): Promise<CallToolResult> => {
      try {
        const agent = await getAgent();
        const did = await resolveActorDid(agent, actor);
        const res = await agent.follow(did);
        return ok(`Followed ${did}\nfollow_uri: ${res.uri}`);
      } catch (err) {
        return fail(`Failed to follow: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    "unfollow_user",
    "Unfollow a Bluesky user by handle or DID. (Looks up your follow record automatically.)",
    { actor: z.string().describe("Handle (with or without @) or DID.") },
    async ({ actor }): Promise<CallToolResult> => {
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
  );

  return server;
}
