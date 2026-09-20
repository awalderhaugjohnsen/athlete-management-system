# Background worker (queue processing, KPI sync, history sync) — the hosted
# replacement for the macOS LaunchAgents in scripts/. Uses the pixi.lock-pinned
# environment so `pixi run` here matches local dev exactly.
FROM ghcr.io/prefix-dev/pixi:latest

WORKDIR /app

# Only what pixi install + the worker actually need — keeps the image (and Fly's
# build cache) from being invalidated by unrelated repo changes (web/, tests/, docs/).
COPY pixi.toml pixi.lock pyproject.toml ./
COPY core ./core
COPY services ./services
COPY cli ./cli
COPY my_training_config.yaml ./my_training_config.yaml

RUN pixi install --locked

# output.directory in my_training_config.yaml; not git-tracked (personal health data)
RUN mkdir -p /app/data

COPY scripts/fly/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
