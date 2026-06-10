# infra/

AWS resources for the productboard MCP server that are managed outside the
`wodify-custom-mcp-deploy` CloudFormation stack (which owns the ECR repo, ECS
service, ALB wiring, etc.). Keep these definitions here so they're reproducible
and editable via PR rather than only living in the AWS console.

## `cloudwatch-usage-dashboard.json`

The CloudWatch dashboard **`Productboard-MCP-Usage-Monitoring`** — adoption
metrics built on the per-request structured logs in CloudWatch Logs group
`/ecs/PRODUCTBOARD-MCP` (the `user_email` / `mcp_method` / `tool_name` fields
emitted by `src/core/access-log.ts`).

Widgets: active-user / tool-call / request KPIs, daily-active-users and
daily-tool-calls trends, tool-calls-per-user and tool-popularity bars,
by-tool and by-user usage tables, request-type pie, user×tool table, and a
recent-tool-calls activity log.

### Recreate or update the dashboard

After editing the JSON, push it to CloudWatch (account 212972612334, us-east-1):

```bash
aws cloudwatch put-dashboard \
  --dashboard-name Productboard-MCP-Usage-Monitoring \
  --region us-east-1 \
  --dashboard-body file://infra/cloudwatch-usage-dashboard.json
```

`put-dashboard` is create-or-replace: it overwrites the entire dashboard body,
so this file is the single source of truth. A successful run returns
`"DashboardValidationMessages": []`.

Alternatively, manage it as a CloudFormation stack (drift-detectable):

```bash
node scripts/build-dashboard-stack.mjs
aws cloudformation deploy \
  --stack-name productboard-mcp-dashboard \
  --template-file infra/cloudwatch-usage-dashboard.cfn.json \
  --region us-east-1
```

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
- If you add/rename log fields in `access-log.ts`, update the queries here to match.
- `user_email` is PII — the `/ecs/PRODUCTBOARD-MCP` log group should have a
  deliberate retention set (infra owner: Matt).
