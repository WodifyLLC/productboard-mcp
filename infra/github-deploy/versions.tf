terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "wodify-shared-services" # SSO; run `aws sso login --sso-session wodify` first
  # Safety guard: terraform hard-fails if the active credentials resolve to any
  # account other than SharedServices.
  allowed_account_ids = ["212972612334"] # SharedServices
}
