#!/usr/bin/env bash
# Put app secret values into AWS Secrets Manager. Values are typed hidden,
# never echoed, never passed on the command line (so not visible in `ps`).
#
#   infra/scripts/put-secrets.sh                      prompt for every secret
#   infra/scripts/put-secrets.sh GEMINI_API_KEY_1     only this one (e.g. key rotation)
#
# SESSION_SECRET and DATA_ENCRYPTION_KEY: press Enter to generate a random value.
# The secrets must already exist (terraform apply creates them).
#
# Env: AWS_REGION (default ap-south-1), SECRET_PREFIX (default from terraform
# output, else apna-rashan/beta), GEMINI_API_KEY_COUNT (default: what exists).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="$REPO_ROOT/infra/aws"

tf_out() {
  command -v terraform >/dev/null 2>&1 || return 1
  terraform -chdir="$TF_DIR" output -raw "$1" 2>/dev/null
}

AWS_REGION="${AWS_REGION:-$(tf_out aws_region || echo ap-south-1)}"
SECRET_PREFIX="${SECRET_PREFIX:-$(tf_out secret_prefix || echo apna-rashan/beta)}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

ALL=(SESSION_SECRET DATA_ENCRYPTION_KEY SEED_OWNER_PIN GEMINI_API_KEY_1 GEMINI_API_KEY_2 GEMINI_API_KEY_3)
if [[ $# -gt 0 ]]; then NAMES=("$@"); else NAMES=("${ALL[@]}"); fi

TMP_DIR="$(mktemp -d)"
chmod 700 "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

secret_exists() {
  aws secretsmanager describe-secret --secret-id "$1" >/dev/null 2>&1
}

has_value() {
  aws secretsmanager list-secret-version-ids --secret-id "$1" \
    --query "Versions[?contains(VersionStages, 'AWSCURRENT')] | length(@)" --output text 2>/dev/null \
    | grep -q '^1$'
}

read_hidden() { # prompt -> REPLY (never echoed)
  local first second
  IFS= read -r -s -p "$1: " first; echo
  IFS= read -r -s -p "  again to confirm: " second; echo
  if [[ "$first" != "$second" ]]; then
    echo "  values did not match" >&2
    return 1
  fi
  REPLY="$first"
}

random_value() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64
  fi
}

put_value() { # secret-id value
  local f="$TMP_DIR/value"
  (umask 077 && printf '%s' "$2" >"$f")
  aws secretsmanager put-secret-value --secret-id "$1" \
    --secret-string "file://$f" >/dev/null
  rm -f "$f"
}

echo "Region: $AWS_REGION   Prefix: $SECRET_PREFIX/"
for name in "${NAMES[@]}"; do
  id="$SECRET_PREFIX/$name"
  echo
  if ! secret_exists "$id"; then
    echo "$name: no secret '$id' (not created by Terraform, e.g. gemini_api_key_count is lower). Skipping."
    continue
  fi

  existing=false
  if has_value "$id"; then existing=true; fi

  if [[ "$existing" == true && $# -eq 0 ]]; then
    read -r -p "$name already has a value. Replace it? [y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] || { echo "  kept"; continue; }
  fi

  if [[ "$name" == DATA_ENCRYPTION_KEY && "$existing" == true ]]; then
    echo "  WARNING: data already encrypted with the old key cannot be read with a new one."
    read -r -p "  Type REPLACE to continue: " ans
    [[ "$ans" == REPLACE ]] || { echo "  kept"; continue; }
  fi

  value=""
  case "$name" in
    SESSION_SECRET|DATA_ENCRYPTION_KEY)
      read_hidden "$name (Enter = generate random)" || continue
      value="$REPLY"
      if [[ -z "$value" ]]; then value="$(random_value)"; echo "  generated a random value"; fi
      if [[ "$name" == SESSION_SECRET && ${#value} -lt 32 ]]; then
        echo "  must be at least 32 characters; not saved" >&2; continue
      fi
      ;;
    SEED_OWNER_PIN)
      read_hidden "$name (digits only)" || continue
      value="$REPLY"
      if ! [[ "$value" =~ ^[0-9]{4,8}$ ]]; then
        echo "  PIN must be 4-8 digits; not saved" >&2; continue
      fi
      ;;
    *)
      read_hidden "$name" || continue
      value="$REPLY"
      if [[ -z "$value" ]]; then echo "  empty; not saved"; continue; fi
      ;;
  esac

  put_value "$id" "$value"
  value=""
  REPLY=""
  echo "  saved $name"
done

echo
echo "Done. Running tasks read secrets only at start; redeploy to apply:"
echo "  infra/scripts/deploy.sh --tag <current tag>   (or: aws ecs update-service --force-new-deployment ...)"
