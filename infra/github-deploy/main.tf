# IAM role GitHub Actions assumes (via OIDC, no stored AWS keys) to push this
# repo's image to ECR. Pushing :latest-arm64 IS the deploy: the EventBridge
# rule from wodify-custom-mcp-deploy redeploys the ECS service on every push.
#
# Scope:
#   - Trust: only workflows running on the `wodify-patched` branch of
#     WodifyLLC/productboard-mcp. PRs, other branches and other repos can't
#     assume it.
#   - Permissions: ECR login, plus push/pull on the productboard-mcp
#     repository only. No ECS, IAM, secrets or any other service.

locals {
  github_repo   = "WodifyLLC/productboard-mcp"
  ecr_repo_name = "productboard-mcp"
  tags = {
    Project   = "productboard-mcp"
    Owner     = "matt.shank"
    ManagedBy = "terraform"
  }
}

# The account's GitHub OIDC provider already exists (shared by other repos'
# deploy roles); look it up rather than managing it here.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_ecr_repository" "app" {
  name = local.ecr_repo_name
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${local.github_repo}:ref:refs/heads/wodify-patched"]
    }
  }
}

resource "aws_iam_role" "github_ecr_push" {
  name                 = "productboard-mcp-github-ecr-push"
  description          = "GitHub Actions (wodify-patched branch of ${local.github_repo}) pushes the image to ECR"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
  tags                 = local.tags
}

data "aws_iam_policy_document" "push" {
  statement {
    sid       = "EcrAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # this action has no resource-level scoping
  }
  statement {
    sid = "EcrPushPullThisRepo"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [data.aws_ecr_repository.app.arn]
  }
}

resource "aws_iam_role_policy" "push" {
  name   = "ecr-push-productboard-mcp"
  role   = aws_iam_role.github_ecr_push.id
  policy = data.aws_iam_policy_document.push.json
}
