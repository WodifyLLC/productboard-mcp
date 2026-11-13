output "role_arn" {
  description = "Used as role-to-assume in .github/workflows/deploy.yml."
  value       = aws_iam_role.github_ecr_push.arn
}
