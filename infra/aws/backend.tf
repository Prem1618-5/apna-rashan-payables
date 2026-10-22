# Remote state (recommended once more than one person or CI runs Terraform).
#
# Bootstrap, once, by hand (the state bucket cannot hold its own state):
#
#   aws s3api create-bucket --bucket apna-rashan-tfstate-<ACCOUNT_ID> \
#     --region ap-south-1 --create-bucket-configuration LocationConstraint=ap-south-1
#   aws s3api put-bucket-versioning --bucket apna-rashan-tfstate-<ACCOUNT_ID> \
#     --versioning-configuration Status=Enabled
#   aws s3api put-public-access-block --bucket apna-rashan-tfstate-<ACCOUNT_ID> \
#     --public-access-block-configuration \
#     BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
#
# Then uncomment the block below, put your bucket name in, and run
# `terraform init -migrate-state`. Locking uses an S3 lock file
# (use_lockfile, Terraform >= 1.10), so no DynamoDB table is needed.
#
# terraform {
#   backend "s3" {
#     bucket       = "apna-rashan-tfstate-<ACCOUNT_ID>"
#     key          = "beta/terraform.tfstate"
#     region       = "ap-south-1"
#     encrypt      = true
#     use_lockfile = true
#   }
# }
