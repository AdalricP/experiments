#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
USER_NAME="${1:?usage: HF_TOKEN=... ./deploy/huggingface.sh <hf-username> [space-name]}"
SPACE="${2:-biscad}"
: "${HF_TOKEN:?set HF_TOKEN}"
pip install -q -U huggingface_hub
python3 - "$USER_NAME" "$SPACE" <<'PY'
import os, sys, shutil, tempfile
from huggingface_hub import HfApi
user, space = sys.argv[1], sys.argv[2]
repo = f"{user}/{space}"
api = HfApi(token=os.environ["HF_TOKEN"])
api.create_repo(repo, repo_type="space", space_sdk="docker", exist_ok=True)
tmp = tempfile.mkdtemp()
for d in ("server", "web"):
    shutil.copytree(d, os.path.join(tmp, d), ignore=shutil.ignore_patterns("__pycache__", "node_modules"))
df = open("Dockerfile").read().replace("PORT=8000", "PORT=7860").replace("EXPOSE 8000", "EXPOSE 7860")
open(os.path.join(tmp, "Dockerfile"), "w").write(df)
shutil.copy("deploy/huggingface/README.md", os.path.join(tmp, "README.md"))
api.upload_folder(folder_path=tmp, repo_id=repo, repo_type="space", commit_message="deploy BISCAD")
if os.environ.get("BISCAD_ADMIN_KEY"):
    api.add_space_secret(repo, "BISCAD_ADMIN_KEY", os.environ["BISCAD_ADMIN_KEY"])
print(f"\n  ✓ pushed. Building now: https://huggingface.co/spaces/{repo}")
print(f"    Live in ~5 min at: https://{user.lower()}-{space.lower()}.hf.space\n")
PY
