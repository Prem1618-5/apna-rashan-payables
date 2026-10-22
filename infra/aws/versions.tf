terraform {
  # 1.10+ for the S3 backend's native lock file (use_lockfile), see backend.tf.
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}

# Second region, used only when enable_backup_replication = true
# (RDS automated backups copied to Hyderabad, see platform.md).
provider "aws" {
  alias  = "backup"
  region = var.backup_region

  default_tags {
    tags = local.tags
  }
}

locals {
  name = "${var.project}-${var.env}"

  tags = merge(
    {
      Project   = var.project
      Env       = var.env
      ManagedBy = "terraform"
    },
    var.extra_tags,
  )
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
