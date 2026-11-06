# The sandbox scripts/claude-contract/run.mjs runs in: tmux to drive real
# Claude Code sessions, strace and openssl for the TLS mock of
# api.anthropic.com, and pinned Claude Code versions under /opt/claude/<v>.
FROM node:22-bookworm
RUN apt-get update -qq && apt-get install -y -qq tmux strace openssl procps >/dev/null && rm -rf /var/lib/apt/lists/*
ARG VERSIONS="2.1.311 2.1.318 2.1.319"
# Install scripts run here on purpose: Claude Code's postinstall links its
# platform-native binary, and with --ignore-scripts `claude` refuses to start.
# This image is a throwaway test sandbox; nothing from it ships.
RUN for v in $VERSIONS; do npm install --silent --prefix /opt/claude/$v @anthropic-ai/claude-code@$v; done
