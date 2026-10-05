#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${2:-us-central1}"
MAX_INSTANCES="${BISCAD_MAX_INSTANCES:-2}"

gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q . || gcloud auth login
PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] || { echo "usage: ./deploy/cloudrun.sh <project-id> [region]"; exit 1; }
gcloud config set project "$PROJECT" >/dev/null
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

ADMIN_KEY="${BISCAD_ADMIN_KEY:-bsc_$(openssl rand -hex 16)}"
gcloud run deploy biscad --source . --region "$REGION" --allow-unauthenticated \
  --port 8000 --cpu 2 --memory 4Gi --concurrency 8 --timeout 300 \
  --min-instances 0 --max-instances "$MAX_INSTANCES" --cpu-boost \
  --set-env-vars "BISCAD_WORKERS=2,BISCAD_ADMIN_KEY=$ADMIN_KEY${ANTHROPIC_API_KEY:+,ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY}"

BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>/dev/null | sed 's#billingAccounts/##')"
if [ -n "$BILLING" ]; then
  gcloud services enable billingbudgets.googleapis.com >/dev/null 2>&1 || true
  gcloud billing budgets create --billing-account "$BILLING" --display-name "biscad-guard" \
    --budget-amount 5USD --threshold-rule percent=0.5 --threshold-rule percent=1.0 >/dev/null 2>&1 \
    && echo "  ✓ \$5 budget alert set on billing account $BILLING" || true
fi

URL="$(gcloud run services describe biscad --region "$REGION" --format='value(status.url)')"
echo
echo "  ✓ BISCAD is live:  $URL"
echo "    Studio:  $URL/studio.html"
echo "    MCP:     claude mcp add --transport http biscad $URL/mcp"
echo "    Admin key (unlimited): $ADMIN_KEY"
echo "    Note: storage is per-instance and resets on redeploy; mount a volume for durable documents."
