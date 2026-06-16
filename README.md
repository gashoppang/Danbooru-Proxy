# Danbooru Proxy

Danbooru-only WARP egress proxy for Prompt Smith.

This service is intended to run on a small server where Cloudflare WARP is enabled. Prompt Smith calls this service over HTTPS, and this service forwards only approved Danbooru API paths to `https://danbooru.donmai.us`.

## Why This Exists

Prompt Smith should not run WARP on the main application server because it can change unrelated outbound traffic such as PostgreSQL/RDS connections. This proxy isolates WARP to Danbooru API egress.

```text
Prompt Smith main server
  -> HTTPS + bearer token
  -> Danbooru Proxy server
      -> WARP
      -> danbooru.donmai.us
```

## API

```text
GET /health
GET /v1/danbooru/fetch?path=/tags.json%3Fsearch%5Bname_matches%5D%3Dcat*%26limit%3D5
Authorization: Bearer <DANBOORU_EGRESS_TOKEN>
```

The `path` value must be a relative Danbooru API path. Absolute URLs are rejected.

Allowed upstream paths:

- `/tags.json`
- `/tag_aliases.json`
- `/wiki_pages.json`
- `/posts.json`
- `/related_tag.json`
- `/tag_implications.json`

HTML challenge pages or any non-JSON upstream response are returned as `502` errors instead of being forwarded as a successful API response.

## Environment

Copy `.env.example` and set a long random token.

```env
DANBOORU_EGRESS_HOST=0.0.0.0
DANBOORU_EGRESS_PORT=8787
DANBOORU_EGRESS_TOKEN=replace-with-a-long-random-secret
DANBOORU_EGRESS_TIMEOUT_MS=15000
DANBOORU_EGRESS_RATE_LIMIT_WINDOW_MS=60000
DANBOORU_EGRESS_RATE_LIMIT_MAX=600
```

The server loads `.env` automatically at startup.

## Build

```bash
npm install
npm run build
npm test
```

## Run

```bash
node dist/server.js
```

On the WARP server, verify that WARP is active before running production traffic:

```bash
curl https://www.cloudflare.com/cdn-cgi/trace
```

The trace should include `warp=on`.

## Prompt Smith Configuration

Configure the main Prompt Smith server to use this proxy:

```env
DANBOORU_TRANSPORT=egress
DANBOORU_EGRESS_BASE_URL=https://danbooru-egress.example.com
DANBOORU_EGRESS_TOKEN=replace-with-the-same-secret
```

## Security Notes

- Do not expose this as a generic `?url=` open proxy.
- Keep the bearer token private.
- Put this service behind HTTPS.
- Prefer firewall or reverse-proxy IP allowlists when possible.
- Keep WARP isolated to this server so database traffic from the main Prompt Smith server is unaffected.
