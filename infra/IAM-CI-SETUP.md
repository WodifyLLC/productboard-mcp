# IAM setup for the CI deploy workflow

`.github/workflows/deploy.yml` assumes the shared deploy role
`wodify-github-custom-mcp-deploy` (account `212972612334`) via GitHub OIDC.

**Trust policy: no change needed.** It already allows
`repo:WodifyLLC/*:*`, which covers this repo. (Verified: the workflow's
"Configure AWS credentials (OIDC)" step succeeds today.)

**Permission policy: needs ECR push** — the role can describe repositories
but not push images. Add this statement block (or a separate attached policy,
owner's choice):

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
  }
]
```

Notes:

- `ecr:GetAuthorizationToken` doesn't support resource-level scoping — `"*"`
  is required for it.
- The push statement is scoped to the `productboard-mcp` repository only. To
  let other MCP repos use the same CI pattern later, widen the resource to
  `arn:aws:ecr:us-east-1:212972612334:repository/*` (or add per-repo ARNs).
- The CloudWatch usage dashboard needs **no CI permissions** — it's baked into
  the image and self-registered by the container at startup, which is covered
  by the ECS **task role** instead. See `IAM-TASK-ROLE.md`.

Until this lands, the workflow fails at the "Log in to ECR" step with
`AccessDenied` — that's the expected failure mode; nothing in the run mutates
state before that step.
