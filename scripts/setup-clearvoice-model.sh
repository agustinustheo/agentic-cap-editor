#!/usr/bin/env bash
set -euo pipefail

MODEL_NAME="${1:-MossFormer2_SS_16K}"
MODEL_DIR="checkpoints/${MODEL_NAME}"

if [[ "${MODEL_NAME}" != "MossFormer2_SS_16K" ]]; then
  echo "error: unsupported model '${MODEL_NAME}'" >&2
  echo "supported: MossFormer2_SS_16K" >&2
  exit 2
fi

mkdir -p "${MODEL_DIR}"

cat > "${MODEL_DIR}/README.md" <<'EOF'
---
license: apache-2.0
---

The MossFormer2_SS_16K model weights for 16 kHz speech separation in [ClearerVoice-Studio](https://github.com/modelscope/ClearerVoice-Studio/tree/main) repo.

This model is trained on large scale datasets inclduing open-sourced and private data.

It separates mixed-speaker speeches into individual speaker's speech.
EOF

cat > "${MODEL_DIR}/.gitattributes" <<'EOF'
*.7z filter=lfs diff=lfs merge=lfs -text
*.arrow filter=lfs diff=lfs merge=lfs -text
*.bin filter=lfs diff=lfs merge=lfs -text
*.bz2 filter=lfs diff=lfs merge=lfs -text
*.ckpt filter=lfs diff=lfs merge=lfs -text
*.ftz filter=lfs diff=lfs merge=lfs -text
*.gz filter=lfs diff=lfs merge=lfs -text
*.h5 filter=lfs diff=lfs merge=lfs -text
*.joblib filter=lfs diff=lfs merge=lfs -text
*.lfs.* filter=lfs diff=lfs merge=lfs -text
*.mlmodel filter=lfs diff=lfs merge=lfs -text
*.model filter=lfs diff=lfs merge=lfs -text
*.msgpack filter=lfs diff=lfs merge=lfs -text
*.npy filter=lfs diff=lfs merge=lfs -text
*.npz filter=lfs diff=lfs merge=lfs -text
*.onnx filter=lfs diff=lfs merge=lfs -text
*.ot filter=lfs diff=lfs merge=lfs -text
*.parquet filter=lfs diff=lfs merge=lfs -text
*.pb filter=lfs diff=lfs merge=lfs -text
*.pickle filter=lfs diff=lfs merge=lfs -text
*.pkl filter=lfs diff=lfs merge=lfs -text
*.pt filter=lfs diff=lfs merge=lfs -text
*.pth filter=lfs diff=lfs merge=lfs -text
*.rar filter=lfs diff=lfs merge=lfs -text
*.safetensors filter=lfs diff=lfs merge=lfs -text
saved_model/**/* filter=lfs diff=lfs merge=lfs -text
*.tar.* filter=lfs diff=lfs merge=lfs -text
*.tar filter=lfs diff=lfs merge=lfs -text
*.tflite filter=lfs diff=lfs merge=lfs -text
*.tgz filter=lfs diff=lfs merge=lfs -text
*.wasm filter=lfs diff=lfs merge=lfs -text
*.xz filter=lfs diff=lfs merge=lfs -text
*.zip filter=lfs diff=lfs merge=lfs -text
*.zst filter=lfs diff=lfs merge=lfs -text
*tfevents* filter=lfs diff=lfs merge=lfs -text
EOF

printf 'last_best_checkpoint.pt\n' > "${MODEL_DIR}/last_best_checkpoint"

if [[ -f "${MODEL_DIR}/last_best_checkpoint.pt" ]]; then
  echo "model already present: ${MODEL_DIR}/last_best_checkpoint.pt"
  exit 0
fi

curl -L \
  --fail \
  --output "${MODEL_DIR}/last_best_checkpoint.pt" \
  "https://huggingface.co/spaces/alibabasglab/ClearVoice/resolve/main/checkpoints/MossFormer2_SS_16K/model.ckpt-59-3498143.pt?download=true"

echo "downloaded ${MODEL_DIR}/last_best_checkpoint.pt"
