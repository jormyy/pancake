#!/usr/bin/env bash
# Moves a release soak shard's state to the next shard: the local Supabase database and
# storage volumes (taken while the stack is stopped) and the soak's workspace evidence,
# including its checkpoint. Restore refuses existing volumes and unverified archives.
set -euo pipefail

mode="${1:?usage: soak-state.sh save|restore <state-dir>}"
dir="${2:?usage: soak-state.sh save|restore <state-dir>}"
# GNU tar and coreutils, pinned; the same commands run on CI and on a developer machine.
image='debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251'
project_id="$(sed -nE 's/^project_id = "(.+)"$/\1/p' supabase/config.toml)"
test -n "$project_id"
volumes=("supabase_db_${project_id}" "supabase_storage_${project_id}")
workspace=(tests/artifacts tests/snapshots tests/e2e-state.json tests/e2e-seed-report.md)

case "$mode" in
  save)
    mkdir -p "$dir"
    state="$(cd "$dir" && pwd)"
    for volume in "${volumes[@]}"; do
      docker volume inspect "$volume" >/dev/null
      docker run --rm -v "$volume:/volume:ro" -v "$state:/state" "$image" \
        tar --numeric-owner -C /volume -czf "/state/$volume.tgz" .
    done
    tar -czf "$state/workspace.tgz" "${workspace[@]}"
    docker run --rm -v "$state:/state" -w /state "$image" sh -c 'sha256sum -- *.tgz > SHA256SUMS'
    ;;
  restore)
    state="$(cd "$dir" && pwd)"
    docker run --rm -v "$state:/state:ro" -w /state "$image" sha256sum --check --strict SHA256SUMS
    for volume in "${volumes[@]}"; do
      if docker volume inspect "$volume" >/dev/null 2>&1; then
        echo "Volume $volume already exists; a shard must restore into a clean stack" >&2
        exit 1
      fi
      docker volume create --label "com.supabase.cli.project=$project_id" \
        --label "com.docker.compose.project=$project_id" "$volume" >/dev/null
      docker run --rm -v "$volume:/volume" -v "$state:/state:ro" "$image" \
        tar --numeric-owner -C /volume -xzf "/state/$volume.tgz"
    done
    tar -xzf "$state/workspace.tgz"
    ;;
  *)
    echo "usage: soak-state.sh save|restore <state-dir>" >&2
    exit 2
    ;;
esac
