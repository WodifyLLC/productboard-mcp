# Task role for dashboard self-registration (for Matt)

productboard-mcp bakes its CloudWatch usage dashboard into the container image
and self-registers it at startup with `cloudwatch:PutDashboard`
(`src/core/dashboard-sync.ts`). That makes "push an image" the entire deploy —
code, ECS rollout (via the existing EventBridge auto-redeploy), and dashboard
all ride the same artifact.

**The one missing piece:** the `wodify-custom-mcp-deploy` CloudFormation
template defines an execution role but **no task role**, so containers have no
AWS API permissions at runtime. Until a task role with `PutDashboard` exists,
the server logs this warning at startup and serves traffic normally:

```
usage dashboard sync failed — continuing without it
hint: task role needs cloudwatch:PutDashboard — see infra/IAM-TASK-ROLE.md
```

## Suggested template change (ecs-mcp-template.json)

Add a per-service task role and reference it from the task definition:

```json
"TaskRole": {
  "Type": "AWS::IAM::Role",
  "Properties": {
    "RoleName": "",
    "AssumeRolePolicyDocument": {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Principal": { "Service": "ecs-tasks.amazonaws.com" },
          "Action": "sts:AssumeRole"
        }
      ]
    },
    "Policies": [
      {
        "PolicyName": "usage-dashboard-self-registration",
        "PolicyDocument": {
          "Version": "2012-10-17",
          "Statement": [
            {
              "Effect": "Allow",
              "Action": "cloudwatch:PutDashboard",
              "Resource": "arn:aws:cloudwatch::212972612334:dashboard/*"
            }
          ]
        }
      }
    ]
  }
}
```

And in `TaskDefinition.Properties`:

```json
"TaskRoleArn": { "Fn::GetAtt": ["TaskRole", "Arn"] }
```

(The deploy script would set `RoleName` to `{serviceName}-task-role`, same
pattern as the other named resources.)

Notes:

- Dashboard ARNs are account-global and region-less:
  `arn:aws:cloudwatch::<account>:dashboard/<name>`. The `dashboard/*` scope
  lets any service using the framework self-register its own dashboard;
  tighten to `dashboard/Productboard-MCP-*` if preferred.
- This is additive and safe for existing services: a task role with only
  `PutDashboard` grants nothing else, and services that never call AWS APIs
  are unaffected.
- Rollout: after the template change, re-run the **Deploy MCP Service**
  workflow for `productboard-mcp`. The next task boot creates/updates the
  dashboard automatically.
