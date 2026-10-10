#!/usr/bin/env bash
# Shared environment. Source this file; do not execute it.
export AWS_REGION=ap-south-1
export AWS_DEFAULT_REGION=ap-south-1
export REGION=ap-south-1
export PREFIX=pantrypass
export TAG_KEY=project
export TAG_VALUE=pantrypass
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export LOTS_TABLE=${PREFIX}-lots
export EVENTS_TABLE=${PREFIX}-events
export ROLE_NAME=${PREFIX}-lambda-role
export SFN_ROLE_NAME=${PREFIX}-sfn-role
export SFN_NAME=${PREFIX}-lot-flow
ENV_FILE="$(dirname "${BASH_SOURCE[0]}")/.env.generated"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"
true
