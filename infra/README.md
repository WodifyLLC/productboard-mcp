# infra/

AWS-facing definitions that ship **inside the container image** plus the IAM
notes for the pieces other people own. Keep these in the repo so they're
reproducible and editable via PR rather than only living in the AWS console.

## `cloudwatch-usage-dashboard.json`

The CloudWatch dashboard **`Productboard-MCP-Usage-Monitoring`** — adoption
metrics built on the per-request structured logs in CloudWatch Logs group
`/ecs/PRODUCTBOARD-MCP` (the `user_email` / `mcp_method` / `tool_name` fields
emitted by `src/core/access-log.ts`).

Widgets: active-user / tool-call / request KPIs, daily-active-users and
daily-tool-calls trends, tool-calls-per-user and tool-popularity bars,
by-tool and by-user usage tables, request-type pie, user×tool table, and a
recent-tool-calls activity log.

### How it deploys — no manual step

This file is `COPY`'d into the image (see Dockerfile) and the server
self-registers it at startup via `cloudwatch:PutDashboard`
(`src/core/dashboard-sync.ts`). **Deploying an image IS the dashboard
deployment**: edit this JSON, push the image, and the next task boot syncs
the dashboard. Failures are non-fatal (warn-and-continue) so a missing IAM
permission never blocks serving.

Runtime controls:

| Env var | Default | Meaning |
|---|---|---|
| `USAGE_DASHBOARD_SYNC` | `true` | Set `false` to disable the startup sync |
| `USAGE_DASHBOARD_NAME` | `Productboard-MCP-Usage-Monitoring` | Dashboard name to write |

Prerequisite: the ECS task role needs `cloudwatch:PutDashboard` — see
`IAM-TASK-ROLE.md` (owner: Matt). Until it lands, startup logs a warning and
the dashboard simply doesn't materialize.

### View it

https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards/dashboard/Productboard-MCP-Usage-Monitoring

### Notes

- Data only exists from when per-request usage logging shipped (the
  `mcp_method` / `tool_name` access-log enrichment). Earlier requests logged
  `user_email`/`path` but not the per-tool breakdown.
- Widen the time range (top-right) to a day/week to see meaningful data.
- Today productboard-mcp exposes only `pb_note_list` (via
  `PRODUCTBOARD_EXPOSED_TOOLS`), so the tool-popularity widgets will show a
  single bar until the allowlist is widened — the dashboard already handles
  multiple tools the moment more are exposed.
- If you add/rename log fields in `access-log.ts`, update the queries here to
  match.
- `user_email` is PII — the `/ecs/PRODUCTBOARD-MCP` log group should have a
  deliberate retention set (infra owner: Matt).

## `IAM-CI-SETUP.md`

Permissions the shared GitHub-OIDC deploy role needs so CI can push images.

## `IAM-TASK-ROLE.md`

The ECS task-role addition (Matt's framework template) that lets the container
self-register the dashboard.
