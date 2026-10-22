#!/usr/bin/env bash
# Build the image, push it to ECR, roll it out on ECS and wait until stable.
#
#   infra/scripts/deploy.sh                 build + deploy the current commit
#   infra/scripts/deploy.sh --tag <sha>     redeploy an image already in ECR (rollback)
#
# Settings come from the environment, or from `terraform output` in infra/aws:
#   AWS_REGION, ECR_REPOSITORY_URL, ECS_CLUSTER, ECS_SERVICE
#   IMAGE_TAG_LIVE   tag the task definition runs (Terraform var.image_tag, default "latest")
#   PLATFORMS        buildx platforms (default linux/arm64, what Fargate runs)
#
# Needs: aws CLI v2, docker with buildx (QEMU for arm64 on an x86 machine), git.
set -euo pipefail

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

DEPLOY_TAG=""
ALLOW_DIRTY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) DEPLOY_TAG="${2:?--tag needs a value}"; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=true; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="$REPO_ROOT/infra/aws"

tf_out() {
  command -v terraform >/dev/null 2>&1 || return 1
  terraform -chdir="$TF_DIR" output -raw "$1" 2>/dev/null
}

AWS_REGION="${AWS_REGION:-$(tf_out aws_region || echo ap-south-1)}"
ECR_REPOSITORY_URL="${ECR_REPOSITORY_URL:-$(tf_out ecr_repository_url || true)}"
ECS_CLUSTER="${ECS_CLUSTER:-$(tf_out ecs_cluster_name || true)}"
ECS_SERVICE="${ECS_SERVICE:-$(tf_out ecs_service_name || true)}"
IMAGE_TAG_LIVE="${IMAGE_TAG_LIVE:-$(tf_out image_tag || echo latest)}"
PLATFORMS="${PLATFORMS:-linux/arm64}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

for v in ECR_REPOSITORY_URL ECS_CLUSTER ECS_SERVICE; do
  if [[ -z "${!v}" ]]; then
    echo "Missing $v. Set it, or run from a machine where 'terraform output' works in infra/aws." >&2
    exit 1
  fi
done

REGISTRY="${ECR_REPOSITORY_URL%%/*}"
REPO_NAME="${ECR_REPOSITORY_URL#*/}"

echo "==> Logging in to $REGISTRY"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

if [[ -z "$DEPLOY_TAG" ]]; then
  # ---- Build and push a new image tagged with the git commit ----------------
  cd "$REPO_ROOT"
  if [[ "$ALLOW_DIRTY" != true ]] && [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree has uncommitted changes. Commit first, or pass --allow-dirty." >&2
    exit 1
  fi
  DEPLOY_TAG="$(git rev-parse --short=12 HEAD)"
  [[ "$ALLOW_DIRTY" == true && -n "$(git status --porcelain)" ]] && DEPLOY_TAG="$DEPLOY_TAG-dirty"

  echo "==> Building $ECR_REPOSITORY_URL:$DEPLOY_TAG for $PLATFORMS"
  docker buildx build \
    --platform "$PLATFORMS" \
    --provenance=false \
    --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
    --tag "$ECR_REPOSITORY_URL:$DEPLOY_TAG" \
    --push \
    "$REPO_ROOT"
else
  echo "==> Redeploying existing image $ECR_REPOSITORY_URL:$DEPLOY_TAG"
fi

# ---- Point the live tag at DEPLOY_TAG (no rebuild, no re-upload) ------------
get_manifest() { # tag field -> prints value or "None"
  aws ecr batch-get-image --repository-name "$REPO_NAME" --image-ids imageTag="$1" \
    --query "images[0].$2" --output text 2>/dev/null || echo None
}

put_tag() { # manifest media-type tag
  local out
  if ! out="$(aws ecr put-image --repository-name "$REPO_NAME" --image-tag "$3" \
        --image-manifest "$1" --image-manifest-media-type "$2" 2>&1 >/dev/null)"; then
    [[ "$out" == *ImageAlreadyExistsException* ]] && return 0
    echo "$out" >&2
    return 1
  fi
}

MANIFEST="$(get_manifest "$DEPLOY_TAG" imageManifest)"
MEDIA_TYPE="$(get_manifest "$DEPLOY_TAG" imageManifestMediaType)"
if [[ -z "$MANIFEST" || "$MANIFEST" == "None" ]]; then
  echo "Image tag $DEPLOY_TAG not found in $REPO_NAME." >&2
  exit 1
fi

# Remember what the live tag points at now, to restore it if the rollout fails.
PREV_MANIFEST="$(get_manifest "$IMAGE_TAG_LIVE" imageManifest)"
PREV_MEDIA_TYPE="$(get_manifest "$IMAGE_TAG_LIVE" imageManifestMediaType)"

restore_live_tag() {
  if [[ -n "$PREV_MANIFEST" && "$PREV_MANIFEST" != "None" ]]; then
    echo "==> Restoring $IMAGE_TAG_LIVE to the previous image" >&2
    put_tag "$PREV_MANIFEST" "$PREV_MEDIA_TYPE" "$IMAGE_TAG_LIVE" || true
  fi
}

echo "==> Tagging $DEPLOY_TAG as $IMAGE_TAG_LIVE"
put_tag "$MANIFEST" "$MEDIA_TYPE" "$IMAGE_TAG_LIVE"

# ---- Roll out ------------------------------------------------------------------
echo "==> Starting deployment on $ECS_CLUSTER/$ECS_SERVICE"
DEPLOYMENT_ID="$(aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
  --force-new-deployment \
  --query "service.deployments[?status=='PRIMARY'].id | [0]" --output text)"
echo "    deployment $DEPLOYMENT_ID"

echo "==> Waiting for the service to become stable (up to ~10 min)"
if ! aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE"; then
  echo "Service did not become stable. Recent events:" >&2
  aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
    --query 'services[0].events[:10].[createdAt,message]' --output text >&2
  restore_live_tag
  exit 1
fi

# The circuit breaker may have rolled back to the previous release.
read -r PRIMARY_ID ROLLOUT_STATE < <(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
  --query "services[0].deployments[?status=='PRIMARY'] | [0].[id, rolloutState]" --output text)
if [[ "$PRIMARY_ID" != "$DEPLOYMENT_ID" || "$ROLLOUT_STATE" != "COMPLETED" ]]; then
  echo "Deployment $DEPLOYMENT_ID did not complete (primary: $PRIMARY_ID, state: $ROLLOUT_STATE)." >&2
  echo "ECS rolled back to the previous release. Check logs: aws logs tail /ecs/$ECS_SERVICE --since 30m" >&2
  restore_live_tag
  exit 1
fi

echo "==> Deployed $DEPLOY_TAG"
