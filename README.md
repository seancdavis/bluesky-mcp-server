# Bluesky MCP Server

A personal, single-user [Model Context Protocol](https://modelcontextprotocol.io/) server for
[Bluesky](https://bsky.app) / [AT Protocol](https://atproto.com), deployable to
[Netlify Functions](https://docs.netlify.com/functions/overview/).

The server gives Claude (or any MCP client) tools to read your timeline and notifications, search
Bluesky, post and reply, like and repost, and follow people — using your account via an app
password.

The endpoint is locked to a single bearer token, so only you (or whichever client you give the
token to) can call it.

## Tools

| Tool | Purpose |
| --- | --- |
| `create_post` | Publish a new post or reply, with optional image attachments. |
| `delete_post` | Delete one of your own posts. |
| `get_timeline` | Fetch your home timeline. |
| `get_notifications` | Likes, replies, mentions, follows, reposts, quotes. |
| `get_post_thread` | Fetch a post with its parent chain and replies. |
| `search_posts` | Keyword search across Bluesky. |
| `search_users` | Find users by handle, name, or description. |
| `get_profile` | Fetch a user's profile with bio, counts, and your relationship to them. |
| `like_post` / `unlike_post` | Like / remove like. |
| `repost` / `unrepost` | Repost / remove repost. |
| `follow_user` / `unfollow_user` | Follow / unfollow by handle or DID. |
| `prepare_upload` / `finalize_upload` | Two-step presigned-URL flow for attaching images to posts. |

### Attaching images to a post

Bluesky stores images as blobs on the user's PDS, not as URLs. To attach images to a post, the
client uploads bytes through this server in three steps:

1. **`prepare_upload`** — call with `filename`, `content_type`, and `size`. Get back a short-lived
   (5-minute) `upload_url` and an `upload_handle`.
2. **PUT the raw bytes** to `upload_url` with header `Content-Type: <content_type>`. No
   Authorization header is needed — the capability is in the signed URL.
3. **`finalize_upload`** — call with the `upload_handle`. Get back a stable `blob_key`.

Then call `create_post` with `images: [{ blob_key, alt }]`. Alt text is required for
accessibility. Up to 4 images per post (Bluesky's limit).

## Setup

### 1. Install

```bash
git clone <this-repo>
cd bluesky-mcp-server
npm install
```

### 2. Get a Bluesky app password

Go to **https://bsky.app/settings/app-passwords** and create a new app password. Copy it
immediately — you won't see it again.

> ⚠️ Use an **app password**, not your account password. App passwords can be revoked individually
> and are the standard pattern for programmatic access to Bluesky.

### 3. Generate a bearer token

This is the secret that gates access to your MCP endpoint.

```bash
openssl rand -hex 32
```

Store it somewhere safe — Claude Desktop's config will need it.

### 4. Configure environment variables

Copy `.env.example` to `.env` and fill in:

```
BLUESKY_IDENTIFIER=yourhandle.bsky.social
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
MCP_BEARER_TOKEN=<the hex string from step 3>
MCP_UPLOAD_SIGNING_SECRET=<another hex string, e.g. `openssl rand -hex 32`>
```

`MCP_UPLOAD_SIGNING_SECRET` is the HMAC key used to sign presigned upload URLs for the image
attachment flow. It is independent of `MCP_BEARER_TOKEN` and should be a separate random secret.

For production deploys, set the same variables in Netlify:

```bash
npx netlify env:set BLUESKY_IDENTIFIER yourhandle.bsky.social
npx netlify env:set BLUESKY_APP_PASSWORD xxxx-xxxx-xxxx-xxxx
npx netlify env:set MCP_BEARER_TOKEN <token>
npx netlify env:set MCP_UPLOAD_SIGNING_SECRET <upload-secret>
```

### 5. Run locally

```bash
npm run dev
```

The MCP endpoint will be available at `http://localhost:8888/mcp`.

### 6. Deploy

```bash
npm run deploy
```

Netlify will return your production URL, e.g. `https://your-site.netlify.app`. Your MCP endpoint is
at `https://your-site.netlify.app/mcp`.

## Connecting Claude Desktop

Claude Desktop talks to MCP servers over stdio. Use the
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge to connect to this server over
HTTP.

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent
on Windows:

```json
{
  "mcpServers": {
    "bluesky": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://your-site.netlify.app/mcp",
        "--header",
        "Authorization: Bearer YOUR_BEARER_TOKEN"
      ]
    }
  }
}
```

Restart Claude Desktop. The Bluesky tools should appear in the tools menu (🔌 icon).

> The bearer token sits in plaintext in this config file. Treat the file like any other secret on
> your machine. Revoke and regenerate the token if you suspect it has leaked — set a new
> `MCP_BEARER_TOKEN` in Netlify and update Claude's config.

## Safety guard

The `create_post` tool's description instructs Claude to show you the exact post text and wait for
explicit confirmation before publishing. This is a soft guard at the model level, not a hard
guarantee. If Claude is misbehaving, revoke its app password at
**bsky.app/settings/app-passwords**.

## Project layout

```
netlify/
  functions/
    mcp.ts                 # Netlify v2 function — mounts /mcp, bearer auth, drives the SDK transport
    mcp-upload.ts          # PUT-only endpoint for raw bytes (signed URL auth, no bearer)
  lib/
    bluesky.ts             # AtpAgent singleton, URI/handle resolution helpers
    uploads.ts             # Netlify Blobs staging store for in-flight image uploads
    mcp/
      bearer.ts            # Constant-time bearer-token check
      server.ts            # Builds a low-level MCP Server, registers tools/list + tools/call
      tools.ts             # Plain registry of Bluesky tool definitions
      upload-tokens.ts     # HMAC-SHA256 signed tokens for presigned uploads
```

The server uses the official MCP SDK's `StreamableHTTPServerTransport` in stateless
mode (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), bridged onto
Netlify's Web `Request`/`Response` via `fetch-to-node`. A fresh server + transport
is created per request — no session state. Note that the transport requires the
client's `Accept` header to list **both** `application/json` and `text/event-stream`,
or it answers `406 Not Acceptable`.

## License

MIT
