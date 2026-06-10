# IAM setup for the CI deploy workflow

`.github/workflows/deploy.yml` assumes the shared deploy role
`wodify-github-custom-mcp-deploy` (account `212972612334`) via GitHub OIDC.

**Trust policy: no change needed.** It already allows
`repo:WodifyLLC/*:*`, which covers this repo.

**Permission policy: needs two additions** the role doesn't have today —
pushing images to ECR and managing CloudWatch dashboards. Add this statement
block (or a separate attached policy, owner's choice):

```json
[
  {
    "Sid": "EcrLogin",
    "Effect": "Allow",
    "Action": "ecr:GetAuthorizationToken",
    "Resource": "*"
  },
  {
    "Sid": "EcrPushProductboardMcp",
    "Effect": "Allow",
    "Action": [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage"
    ],
    "Resource": "arn:aws:ecr:us-east-1:212972612334:repository/productboard-mcp"
  },
  {
    "Sid": "CloudWatchUsageDashboards",
    "Effect": "Allow",
    "Action": [
      "cloudwatch:PutDashboard",
      "cloudwatch:GetDashboard",
      "cloudwatch:DeleteDashboards",
      "cloudwatch:ListDashboards"
    ],
    "Resource": "*"
  }
]
```

Notes:

- `ecr:GetAuthorizationToken` and `cloudwatch:ListDashboards` don't support
  resource-level scoping — `"*"` is required for those.
- The ECR push statement is scoped to the `productboard-mcp` repository only.
  To let other MCP repos use the same CI pattern later, widen the resource to
  `arn:aws:ecr:us-east-1:212972612334:repository/*` (or add per-repo ARNs).
- Dashboard ARNs are account-global (`arn:aws:cloudwatch::212972612334:dashboard/*`,
  no region). Scope the dashboard actions to that pattern instead of `"*"` if
  preferred; `ListDashboards` still needs `"*"`.
- The role already has `cloudformation:*`, which covers the dashboard stack
  (`productboard-mcp-dashboard`) create/update itself — the CloudWatch actions
  above are what CloudFormation calls on the role's behalf for the
  `AWS::CloudWatch::Dashboard` resource.

Until this lands, the workflow's ECR-login step fails with `AccessDenied` —
that's the expected failure mode, nothing else in the run mutates state before
it.
