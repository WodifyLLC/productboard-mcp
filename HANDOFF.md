# Productboard MCP Server — Handoff

**Outgoing:** Eamonn Rongione (internship ending)
**Incoming:** Anthony Reyes, Mike Schappell
**Infra owner / deploy framework:** Matt Shank

This doc is the single source of truth for operating the Productboard MCP
server. It covers what it is, where everything lives, how it's deployed, how to
push changes, and the one item still parked.

---

## What this is

An MCP (Model Context Protocol) server that lets AI assistants (Claude.ai,
Cowork, etc.) call the Productboard API. It's a hardened fork of the community
project [Enreign/productboard-mcp](https://github.com/Enreign/productboard-mcp),
deployed to Wodify's shared ECS platform and reachable at:

```
https://internal-mcp.wodify.com/productboard/mcp
```

Users connect through their MCP client, sign in with their **@wodify.com Google
account** (OAuth), and get access to the exposed tool(s). Today only
**`pb_note_list`** is exposed (see "Tool exposure" below).

---

## Where everything lives

### Code repos

| Repo | Purpose | Branch |
|---|---|---|
| [`WodifyLLC/productboard-mcp`](https://github.com/WodifyLLC/productboard-mcp) | This server (our fork) | **`wodify-patched`** ← all our work is here, NOT `main` |
| [`WodifyLLC/wodify-custom-mcp-deploy`](https://github.com/WodifyLLC/wodify-custom-mcp-deploy) | Matt's shared ECS deploy framework | `main` — our config is `services/productboard-mcp.json` |
| `Enreign/productboard-mcp` | Upstream (added as git remote `upstream`) | for pulling future upstream fixes |

**Important:** our branch is `wodify-patched`, not `main`. Local clone on
Eamonn's machine was at `C:\Users\eamonn.rongione\Documents\ProductBoardMCPServer\productboard-mcp`.

### AWS (Shared Services account `212972612334`, region `us-east-1`)

| Resource | Name |
|---|---|
| ECR repository | `productboard-mcp` (image tag `:latest`, arm64/Graviton) |
| ECS cluster | `PRODUCTBOARD-MCP-cluster` |
| ECS service | `PRODUCTBOARD-MCP-svc` |
| Task definition | `PRODUCTBOARD-MCP-task` (managed by Matt's CloudFormation stack) |
| CloudWatch log group | `/ecs/PRODUCTBOARD-MCP` |
| CloudWatch dashboard | `Productboard-MCP-Usage-Monitoring` |
| Secret — PB API token | `productboard-mcp/api-token` (Secrets Manager) |
| Secrets — Google OAuth | `gsuite-mcp/google-client-id`, `gsuite-mcp/google-client-secret` (shared with the G Suite MCP) |
| ALB | `SS-LB-PUBLIC` (shared; path-routed on `/productboard/*`) |

CloudFormation stack for the service is owned by the `wodify-custom-mcp-deploy`
framework. There's also a `productboard-mcp-dashboard` stack that may exist from
an earlier approach — the dashboard is now handled differently (see "Parked").

---

## How it's deployed (the mental model)

The `wodify-custom-mcp-deploy` framework runs one container per service behind
the shared ALB, with path-based routing. Two kinds of change:

| You changed… | What to do |
|---|---|
| **Only container code** (a tool, a bug fix) | Build + push the image to ECR `:latest`. An EventBridge rule auto-fires a Lambda that force-redeploys the ECS service on its **current task-def revision**, swapping in the new image. No workflow, no config change. |
| **Anything in `services/productboard-mcp.json`** (env var, secret, arch) | Push image if code also changed, **AND** re-run the deploy framework's GitHub Actions workflow ("Deploy MCP Service", input `productboard-mcp`). Only that workflow (via CloudFormation) mints a new task-def revision with the new env/secrets. |

**Key fact for durability:** image pushes reuse the existing task-def revision —
they never touch roles or env vars baked into it. The only thing that can reset
those is Matt's CloudFormation stack redeploying (it re-registers the task def
from his template). So any task-role / env-var changes must be committed into
his stack template to survive, not made as one-off console/CLI edits.

### Building + pushing the image (from a laptop)

```bash
# 1. Auth to AWS (SSO). In a terminal you own, this pops a browser:
aws sso login
aws sts get-caller-identity        # confirm Account == 212972612334

# 2. Log Docker into ECR
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin 212972612334.dkr.ecr.us-east-1.amazonaws.com

# 3. Build arm64 (Graviton) and push
docker buildx build --platform linux/arm64 -f Dockerfile.arm64 \
  -t 212972612334.dkr.ecr.us-east-1.amazonaws.com/productboard-mcp:latest --push .
```

There's also a `.github/workflows/deploy.yml` in this repo that does the build +
push on git push, via GitHub OIDC — but it needs an ECR-push permission added to
the shared deploy role first (see `infra/IAM-CI-SETUP.md`). Until that lands,
build from a laptop as above.

---

## Access / auth model

- **Users** authenticate via Google OAuth, restricted to `@wodify.com`
  (`ALLOWED_EMAIL_DOMAINS`). The flow is often silent — if a user has an active
  Google session with prior consent, they won't see a sign-in screen; that's
  normal, not a bug. Verify OAuth is live by curling `POST /mcp` with no token:
  it should return **401** with a `WWW-Authenticate` header.
- The **GCP OAuth client** is shared with the G Suite MCP. Its authorized
  redirect URIs must include
  `https://internal-mcp.wodify.com/productboard/google/callback` (already added).
- The **Productboard API token** (single, server-side) lives in Secrets Manager
  at `productboard-mcp/api-token`. All Productboard API calls use it regardless
  of which user is connected. To rotate: `aws secretsmanager put-secret-value
  --secret-id productboard-mcp/api-token --secret-string <new> --region us-east-1`,
  then force a redeploy.

### Hardening levers (env vars in `services/productboard-mcp.json`)

| Env var | Current | Effect |
|---|---|---|
| `PRODUCTBOARD_READ_ONLY` | `true` | Skips registering any write/delete tool, regardless of token scope. Belt-and-braces against prompt-injection-driven mutations. |
| `PRODUCTBOARD_EXPOSED_TOOLS` | `pb_note_list` | Allowlist — ONLY these tools are registered. All 21 tools ship in the image; the rest are dormant until this is widened. |

**To expose more tools:** add names (comma-separated) to
`PRODUCTBOARD_EXPOSED_TOOLS` in the service config, commit, and re-run the deploy
workflow. No image rebuild needed for that change alone. Only `pb_note_list` is
vetted so far — Clay's the one who needed it.

---

## Monitoring

**Usage dashboard:**
https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards/dashboard/Productboard-MCP-Usage-Monitoring

Built on structured per-request logs from `src/core/access-log.ts`, which emit
`user_email`, `mcp_method`, and `tool_name` for each `/mcp` call. Widgets: active
users, tool-call counts, per-user/per-tool breakdowns, activity log. Data only
exists from when usage logging shipped; widen the time range to see it.

**Tailing logs** (note the two Windows/Git-Bash gotchas):

```bash
# Git Bash rewrites /ecs/... into a Windows path — prefix with MSYS_NO_PATHCONV=1
MSYS_NO_PATHCONV=1 aws logs tail /ecs/PRODUCTBOARD-MCP --follow --region us-east-1
```

`user_email` is PII — the log group should have a deliberate retention policy
set (infra owner: Matt).

---

## Parked item (waiting on Matt)

**Dashboard-as-code / self-registration.** The dashboard definition
(`infra/cloudwatch-usage-dashboard.json`) is baked into the image, and the
server tries to self-register it at startup via `cloudwatch:PutDashboard`
(`src/core/dashboard-sync.ts`). This makes "push an image" the entire deploy —
dashboard included — but it needs the **ECS task role** to have
`cloudwatch:PutDashboard`, which Matt's framework template doesn't define yet.

- **Right now:** the dashboard was created manually (one-time `put-dashboard`),
  so it exists and works. The self-registration code runs on every boot, fails
  soft with a logged warning (`task role needs cloudwatch:PutDashboard`), and
  does not affect serving.
- **To finish it:** Matt adds the task role per **`infra/IAM-TASK-ROLE.md`**.
  Once that lands, self-registration takes over automatically (same dashboard
  name; PutDashboard is create-or-replace) and the manual step is never needed
  again.

Matt was on vacation when this was set up, hence the two-step approach. Hand him
`infra/IAM-TASK-ROLE.md` when he's back.

---

## What was done this project (commit trail on `wodify-patched`)

1. **Security hardening** of the upstream fork — patched a bearer-token log leak,
   removed `NODE_ENV=development` auth bypasses, added the read-only kill-switch.
2. **Containerized** the stdio-only server with an HTTP transport (port 8000,
   `POST /mcp` Streamable HTTP, `GET /mcp` health check) for ECS.
3. **Access logging** mirroring the G Suite MCP for observability + adoption.
4. **Google OAuth** (identity-only, `@wodify.com`-gated) protecting `/mcp`.
5. **Tool allowlist** (`PRODUCTBOARD_EXPOSED_TOOLS`) — only `pb_note_list` exposed.
6. **CloudWatch usage dashboard** + the (parked) self-registration mechanism.

`infra/` holds the dashboard JSON and the two IAM docs. `AWS-DEPLOYMENT.md` has
the original provisioning brief.

---

## Fast reference / gotchas

- Branch is **`wodify-patched`**, not `main`.
- Images are **arm64** (Graviton) — build with `--platform linux/arm64`. An amd64
  image will pull fine but fail to start (exec-format error).
- SSO tokens expire often → re-run `aws sso login`. Not a permissions problem.
- Git Bash mangles slash-prefixed `aws` args (log groups, etc.) → prefix
  `MSYS_NO_PATHCONV=1`.
- PowerShell aliases `curl` to `Invoke-WebRequest` → use `curl.exe`.
- Silent OAuth (no visible Google prompt for already-signed-in users) is expected.
- Never make task-role / env-var changes as console one-offs — they'll be wiped
  if Matt's CloudFormation stack redeploys. Commit them to his template.
