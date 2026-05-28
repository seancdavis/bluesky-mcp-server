import {
  AppBskyFeedDefs,
  RichText,
  type AppBskyNotificationListNotifications,
} from "@atproto/api";
import {
  bskyUrlFromAtUri,
  getAgent,
  resolveActorDid,
  resolvePostUri,
} from "../bluesky";
import {
  deleteStagedUpload,
  getStagedUploadMetadata,
  readStagedUpload,
} from "../uploads";
import { signUploadToken, type UploadTokenPayload } from "./upload-tokens";

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

function formatThread(thread: unknown): string {
  if (AppBskyFeedDefs.isNotFoundPost(thread)) {
    return `(post not found: ${thread.uri})`;
  }
  if (AppBskyFeedDefs.isBlockedPost(thread)) {
    return `(blocked post: ${thread.uri})`;
  }
  if (!AppBskyFeedDefs.isThreadViewPost(thread)) {
    return "(unrecognized thread node)";
  }

  const sections: string[] = [];

  const ancestors: AppBskyFeedDefs.PostView[] = [];
  let cursor: unknown = thread.parent;
  while (AppBskyFeedDefs.isThreadViewPost(cursor)) {
    ancestors.unshift(cursor.post);
    cursor = cursor.parent;
  }
  if (AppBskyFeedDefs.isNotFoundPost(cursor)) {
    sections.push(`(parent chain truncated — earliest visible parent not found: ${cursor.uri})`);
  } else if (AppBskyFeedDefs.isBlockedPost(cursor)) {
    sections.push(`(parent chain truncated — blocked post: ${cursor.uri})`);
  }
  if (ancestors.length > 0) {
    sections.push("── Parents (oldest → newest) ──");
    ancestors.forEach((p, i) => {
      sections.push(`[parent ${i + 1}]\n${formatPostView(p)}`);
    });
  }

  sections.push("── Target post ──");
  sections.push(formatPostView(thread.post));

  const replyLines: string[] = [];
  const walkReplies = (replies: unknown[] | undefined, depth: number): void => {
    if (!replies) return;
    for (const r of replies) {
      const indent = "  ".repeat(depth);
      if (AppBskyFeedDefs.isNotFoundPost(r)) {
        replyLines.push(`${indent}↳ (not found: ${r.uri})`);
        continue;
      }
      if (AppBskyFeedDefs.isBlockedPost(r)) {
        replyLines.push(`${indent}↳ (blocked: ${r.uri})`);
        continue;
      }
      if (AppBskyFeedDefs.isThreadViewPost(r)) {
        const body = formatPostView(r.post)
          .split("\n")
          .map((l) => `${indent}  ${l}`)
          .join("\n");
        replyLines.push(`${indent}↳\n${body}`);
        walkReplies(r.replies, depth + 1);
      }
    }
  };
  if (thread.replies && thread.replies.length > 0) {
    sections.push("── Replies ──");
    walkReplies(thread.replies, 0);
    sections.push(replyLines.join("\n\n"));
  }

  return sections.join("\n\n");
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
      "",
      "To attach images (up to 4), pass `images` as a list of `{ blob_key, alt }`. Obtain each `blob_key` via prepare_upload → PUT → finalize_upload. Alt text is required for accessibility — write a real description of the image, not 'image' or 'photo'.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The post text. Max 300 graphemes." },
        reply_to: {
          type: "string",
          description: "Optional. AT URI or bsky.app URL of the post being replied to.",
        },
        images: {
          type: "array",
          maxItems: 4,
          description: "Optional. Up to 4 images to attach to the post.",
          items: {
            type: "object",
            properties: {
              blob_key: {
                type: "string",
                description: "blob_key returned by finalize_upload.",
              },
              alt: {
                type: "string",
                description: "Required alt text describing the image for accessibility.",
              },
            },
            required: ["blob_key", "alt"],
          },
        },
      },
      required: ["text"],
    },
    handler: async (args) => {
      const text = requireString(args, "text");
      const replyTo = optionalString(args, "reply_to");
      const imagesRaw = Array.isArray(args.images) ? (args.images as unknown[]) : [];
      if (imagesRaw.length > 4) {
        return fail("Bluesky allows a maximum of 4 images per post.");
      }
      const imageInputs: { blob_key: string; alt: string }[] = [];
      for (const [i, entry] of imagesRaw.entries()) {
        if (!entry || typeof entry !== "object") {
          return fail(`images[${i}] must be an object with blob_key and alt.`);
        }
        const e = entry as Record<string, unknown>;
        const blobKey = typeof e.blob_key === "string" ? e.blob_key : "";
        const alt = typeof e.alt === "string" ? e.alt : "";
        if (!blobKey) return fail(`images[${i}].blob_key is required.`);
        if (!alt.trim()) {
          return fail(
            `images[${i}].alt is required — provide a real description of the image for accessibility.`,
          );
        }
        imageInputs.push({ blob_key: blobKey, alt });
      }

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

        let embed: { $type: string; [k: string]: unknown } | undefined;
        if (imageInputs.length > 0) {
          const uploaded: { image: unknown; alt: string }[] = [];
          for (const [i, input] of imageInputs.entries()) {
            const staged = await readStagedUpload(input.blob_key);
            if (!staged) {
              return fail(
                `images[${i}]: no staged upload found for blob_key ${input.blob_key}. Did you call finalize_upload?`,
              );
            }
            const res = await agent.uploadBlob(staged.bytes, {
              encoding: staged.metadata.contentType,
            });
            uploaded.push({ image: res.data.blob, alt: input.alt });
          }
          embed = {
            $type: "app.bsky.embed.images",
            images: uploaded,
          };
        }

        const result = await agent.post({
          text: rt.text,
          facets: rt.facets,
          ...(reply ? { reply } : {}),
          ...(embed ? { embed } : {}),
          createdAt: new Date().toISOString(),
        });

        for (const input of imageInputs) {
          try {
            await deleteStagedUpload(input.blob_key);
          } catch (err) {
            console.warn(
              `[MCP] failed to clean up staged blob ${input.blob_key}: ${(err as Error).message}`,
            );
          }
        }

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
    name: "get_post_thread",
    description: [
      "Fetch a post together with its parent chain and replies.",
      "",
      "Useful when something in the timeline or notifications is a reply and you need to see what it's responding to, or when you want to read the conversation under a post before engaging.",
      "",
      "Accepts an at:// URI or a https://bsky.app/profile/<handle>/post/<rkey> URL.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", description: "AT URI or bsky.app URL of the post." },
        depth: {
          type: "number",
          description: "How many levels of replies to include (0-1000). Default 6.",
        },
        parent_height: {
          type: "number",
          description: "How many ancestor levels to walk up (0-1000). Default 80.",
        },
      },
      required: ["uri"],
    },
    handler: async (args) => {
      const uri = requireString(args, "uri");
      const depth = clamp(optionalNumber(args, "depth") ?? 6, 0, 1000);
      const parentHeight = clamp(optionalNumber(args, "parent_height") ?? 80, 0, 1000);
      try {
        const agent = await getAgent();
        const resolved = await resolvePostUri(agent, uri);
        const res = await agent.getPostThread({ uri: resolved, depth, parentHeight });
        return ok(formatThread(res.data.thread));
      } catch (err) {
        return fail(`Failed to fetch thread: ${(err as Error).message}`);
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
    name: "get_profile",
    description: [
      "Fetch a detailed profile for a Bluesky user: bio, follower/following/post counts, join date, and your relationship to them (already following, blocking, etc.).",
      "",
      "Useful before calling `follow_user` to decide whether they're worth following, or to check whether you already follow / are blocked by someone before engaging.",
      "",
      "Accepts a handle (with or without @) or a DID.",
    ].join("\n"),
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
        const res = await agent.getProfile({ actor: did });
        const p = res.data;
        const name = p.displayName ? `${p.displayName} (@${p.handle})` : `@${p.handle}`;
        const counts = [
          `followers: ${p.followersCount ?? 0}`,
          `following: ${p.followsCount ?? 0}`,
          `posts: ${p.postsCount ?? 0}`,
        ].join("  ·  ");
        const viewerBits: string[] = [];
        if (p.viewer?.following) viewerBits.push("you follow them");
        if (p.viewer?.followedBy) viewerBits.push("they follow you");
        if (p.viewer?.muted) viewerBits.push("muted by you");
        if (p.viewer?.blocking) viewerBits.push("blocked by you");
        if (p.viewer?.blockedBy) viewerBits.push("they block you");
        const lines = [
          name,
          `did: ${p.did}`,
          counts,
          p.createdAt ? `joined: ${p.createdAt}` : "",
          p.description ? `\n${p.description}` : "",
          viewerBits.length > 0 ? `\nrelationship: ${viewerBits.join(", ")}` : "",
          `\nurl: https://bsky.app/profile/${p.handle}`,
        ].filter(Boolean);
        return ok(lines.join("\n"));
      } catch (err) {
        return fail(`Failed to fetch profile: ${(err as Error).message}`);
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

  {
    name: "prepare_upload",
    description: [
      "Step 1 of the image-upload flow.",
      "",
      "Returns a short-lived (5 min) signed `upload_url` and an `upload_handle`. PUT the raw file bytes to `upload_url` with a Content-Type header matching the declared `content_type`. No Authorization header is needed on the PUT — the capability is in the signed URL.",
      "",
      "Then call `finalize_upload` with the handle to obtain a stable blob key that `create_post` accepts in its `images` array.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Original filename (used for metadata)." },
        content_type: {
          type: "string",
          description: "MIME type the client will send on the PUT (e.g. image/jpeg, image/png).",
        },
        size: {
          type: "number",
          description: "Declared upper-bound byte count. The PUT is rejected if the body exceeds this.",
        },
      },
      required: ["filename", "content_type", "size"],
    },
    handler: async (args) => {
      const filename = requireString(args, "filename");
      const contentType = requireString(args, "content_type");
      const sizeRaw = optionalNumber(args, "size");
      if (sizeRaw === undefined || sizeRaw <= 0) {
        return fail("`size` must be a positive number.");
      }
      try {
        const uploadId = crypto.randomUUID();
        const exp = Math.floor(Date.now() / 1000) + 5 * 60;
        const payload: UploadTokenPayload = {
          uploadId,
          filename,
          contentType,
          size: sizeRaw,
          exp,
        };
        const token = signUploadToken(payload);
        const baseUrl = process.env.URL ?? "";
        const uploadUrl = `${baseUrl}/mcp/upload/${token}`;
        return ok(
          [
            `upload_url: ${uploadUrl}`,
            `upload_handle: ${uploadId}`,
            `expires_in: 300s`,
            "",
            `PUT the file bytes to upload_url with header "Content-Type: ${contentType}", then call finalize_upload.`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(`Failed to prepare upload: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "finalize_upload",
    description: [
      "Step 2 of the image-upload flow.",
      "",
      "Confirms that bytes for the given `upload_handle` have landed in staging, and returns a stable `blob_key` you can pass to `create_post` in its `images` array.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        upload_handle: {
          type: "string",
          description: "The upload_handle returned by prepare_upload.",
        },
      },
      required: ["upload_handle"],
    },
    handler: async (args) => {
      const handle = requireString(args, "upload_handle");
      try {
        const meta = await getStagedUploadMetadata(handle);
        if (!meta) {
          return fail(
            `No upload found for handle ${handle}. PUT the bytes to upload_url first, then retry.`,
          );
        }
        return ok(
          [
            `blob_key: ${handle}`,
            `content_type: ${meta.contentType}`,
            `filename: ${meta.filename}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(`Failed to finalize upload: ${(err as Error).message}`);
      }
    },
  },
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));
