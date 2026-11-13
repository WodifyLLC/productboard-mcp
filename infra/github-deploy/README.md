# GitHub Actions deploy role (ECR push)

IAM role that `.github/workflows/deploy.yml` assumes through GitHub OIDC (no stored AWS
keys) to push the image to ECR, in the **SharedServices** account (`212972612334`,
`us-east-1`). Pushing `:latest-arm64` is the production deploy: the EventBridge rule
from `wodify-custom-mcp-deploy` redeploys the ECS service on every push.

## What it creates
- **IAM role `productboard-mcp-github-ecr-push`**. It can only be assumed by
  workflows running on the `wodify-patched` branch of `WodifyLLC/productboard-mcp`, using the
  account's existing GitHub OIDC provider.
- **Inline policy `ecr-push-productboard-mcp`**: `ecr:GetAuthorizationToken`
  (which can't be scoped to a resource), plus push, pull and describe on the
  `productboard-mcp` ECR repository only.

It reads, but doesn't manage, the GitHub OIDC provider and the ECR repository.

## Apply
```bash
aws sso login --sso-session wodify   # provider uses the wodify-shared-services profile
terraform init
terraform plan    # expect 2 to add (role, role policy), 0 to change/destroy
terraform apply
```
State is local (this directory, gitignored), the same as `infra/token-store`.
