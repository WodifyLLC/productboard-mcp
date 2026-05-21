# productboard-mcp — AWS deployment brief

Single-page reference for provisioning. Mirror of the `g-suite-mcp` deployment, scoped to this server's needs.

## What runs

A single long-lived container exposing the MCP Streamable-HTTP transport, fronted by an ALB. Single-tenant for now.

- **Image**: built from this repo's [`Dockerfile`](Dockerfile). Multi-stage on `node:20-slim`. Final image ~350 MB.
- **Container port**: `8000` (HTTP, no TLS — terminate TLS at the ALB).
- **Health check path**: `GET /healthz` returns `200 {"ok":true,"version","uptime","sessions"}`.
- **MCP endpoint**: `POST /mcp` (Streamable HTTP transport with stateful sessions).
- **Runs as UID/GID**: `10001:10001` (non-root).
- **Workload shape**: low CPU, < 256 MB RAM steady-state, very low request rate (single-user PoC).
- **Suggested task size**: 0.25 vCPU / 512 MB Fargate.

## Required AWS resources

| Resource | Notes |
|---|---|
| **ECR repository** | Name `productboard-mcp`. Standard config; lifecycle policy to keep ~10 most-recent images is fine. |
| **ECS Fargate cluster** | Reuse the same cluster as `g-suite-mcp` (different service, different task definition). |
| **ECS service** | 1 desired task. Min/max 1/1 (no autoscaling needed). |
| **ECS task definition** | Single container, port 8000, no EFS mount needed (no persistent state — bearer token is supplied via env var). Health check `curl -fsS http://127.0.0.1:8000/healthz`. |
| **ALB** | TLS termination, target group on container port 8000, health-check path `/healthz`. Can reuse the existing ALB by adding a new listener rule on a different host. |
| **Route 53 record** | e.g. `productboard-mcp.wodify.com` → ALB. |
| **Security groups** | ALB SG: inbound 443 from internet → container SG. Container SG: inbound 8000 from ALB SG only; outbound 443 anywhere (Productboard API). |

No EFS, no NAT-only-for-this-service, no Secrets-Manager-state-files. This server is stateless aside from in-memory MCP sessions.

## IAM

The ECS task **role** needs nothing service-specific — no S3, no EFS, no DynamoDB. Just whatever the cluster baseline includes.

The ECS task **execution role** needs the standard `AmazonECSTaskExecutionRolePolicy` (for pulling from ECR + writing CloudWatch logs), plus access to the AWS Secrets Manager / SSM Parameter Store secret that holds the Productboard API token.

## Task definition env vars

Required:

| Variable | Value |
|---|---|
| `PRODUCTBOARD_API_TOKEN` | Productboard bearer token. Source from Secrets Manager / SSM via the task definition's `secrets` array — do not paste inline. |

Optional (all have safe defaults baked into the image):

| Variable | Default in image | Notes |
|---|---|---|
| `PRODUCTBOARD_AUTH_TYPE` | `bearer` | Or `oauth2` if you ever wire that up. |
| `PRODUCTBOARD_READ_ONLY` | `true` | Wodify safety default. Set to `false` only when you intentionally need write/delete tools and your token has the matching scope. |
| `LOG_LEVEL` | `error` | `trace`/`debug`/`info`/`warn`/`error`/`fatal`. |
| `LOG_PRETTY` | `false` | Leave false in production. |
| `NODE_ENV` | `production` | Don't change. |
| `MCP_HTTP_HOST` | `0.0.0.0` | Leave alone. |
| `MCP_HTTP_PORT` | `8000` | Leave alone. |
| `PRODUCTBOARD_API_BASE_URL` | `https://api.productboard.com/v2` | Override only for sandbox/testing. |

## Image deploy from Eamonn's laptop

Wired up in [`scripts/deploy.mjs`](scripts/deploy.mjs). After ECR is provisioned and creds are in place locally:

```cmd
set AWS_REGION=us-east-1
set ECR_REGISTRY=<account>.dkr.ecr.us-east-1.amazonaws.com
set ECR_REPO=productboard-mcp
set ECS_CLUSTER=<cluster-name>
set ECS_SERVICE=<productboard-mcp-service>
npm run deploy:ecr
```

That builds the image, tags `:latest` and a timestamped version, pushes both, and triggers a force-new-deployment on the ECS service.

## Local container test (no AWS)

```cmd
set PRODUCTBOARD_API_TOKEN=<your-token>
npm run deploy:local
```

That starts the container on `localhost:8000`. Confirm with:

```cmd
curl http://localhost:8000/healthz
```

Logs: `docker logs -f productboard-mcp`.

## Cost estimate (single task, low traffic)

- Fargate (0.25 vCPU / 512 MB, 24x7): ~$8/month
- ALB listener rule on existing ALB: $0 (reuses what g-suite-mcp pays for)
- ECR storage (a few image versions): rounding error
- Route 53 record on existing zone: rounding error

**Total: ~$10/month if reusing the g-suite-mcp ALB; ~$25/month standalone.**

## What does NOT need provisioning

- **EFS** — no persistent state.
- **Secrets bootstrap procedure** — bearer token comes from Secrets Manager at task-start time; no in-container seeding step like g-suite-mcp's OAuth-tokens-on-EFS.
- **NAT gateway** — only if the task lives in a private subnet without VPC endpoints.
- **WAF** — single-user PoC.
- **CloudFront** — API-only workload.

## Architecture diagram

```
Cowork / claude.ai / Claude Desktop
       │
       │ HTTPS, POST /mcp
       ▼
   Route 53 (productboard-mcp.wodify.com)
       │
       ▼
   ALB (TLS termination, port 443)
       │
       │ HTTP, port 8000
       ▼
   ECS Fargate task
       └── productboard-mcp container (UID 10001)
              └── HTTPS calls to api.productboard.com/v2
                  (bearer token from Secrets Manager)
```

Stateless — no persistent volume. Sessions live in container memory only; if the task restarts, clients reconnect with a new session.
