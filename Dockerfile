# syntax=docker/dockerfile:1
# Deployment image for the Phonic + LiveKit voice agent (LiveKit Cloud build).
# Based on the official LiveKit Node.js Dockerfile template:
# https://docs.livekit.io/agents/ops/deployment/builds/
#
# Use the official Node.js v24 base image.
# Node 24 is required in practice: this agent runs TypeScript directly using
# Node's built-in type stripping (no build step), which needs Node >= 22.18.
# See README.md "Requirements".
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS base

# Install ca-certificates (the system CA bundle used for TLS), then clean the apt
# cache. Required by the LiveKit SDK: the native Rust core reads the system trust
# store at runtime, which the slim base image doesn't ship. Without it,
# Room.connect() fails with "failed to retrieve region info".
# --no-install-recommends keeps the image minimal.
RUN apt-get update -qq && apt-get install --no-install-recommends -y ca-certificates && rm -rf /var/lib/apt/lists/*

# --- Build stage ---
# Install dependencies and prepare the application.
FROM base AS build

# Create a new directory for our application code
# And set it as the working directory
WORKDIR /app

# Copy just the dependency files first, for more efficient layer caching
COPY package.json package-lock.json ./

# Install dependencies with npm ci for reproducible builds from the lockfile.
# (This project uses npm + package-lock.json rather than the pnpm shown in the
# LiveKit template; the rest of the template is unchanged.)
RUN npm ci

# Copy all remaining application files into the container
# This includes source code, configuration files, and dependency specifications
# (Excludes files specified in .dockerignore)
COPY . .

# Remove dev dependencies (TypeScript, @types/node) for a leaner production image.
# They are not needed at runtime because Node strips the TypeScript types itself.
RUN npm prune --omit=dev

# --- Production stage ---
# Build tooling is not included in the final image.
FROM base

# Create a non-privileged user that the app will run under.
# See https://docs.docker.com/build/building/best-practices/#user
ARG UID=10001
RUN adduser \
    --disabled-password \
    --gecos "" \
    --home "/app" \
    --shell "/sbin/nologin" \
    --uid "${UID}" \
    appuser

WORKDIR /app

# Copy the built application with correct ownership in a single layer
# This avoids expensive recursive chown operations on node_modules
COPY --from=build --chown=appuser:appuser /app /app

# Switch to the non-privileged user for all subsequent operations
USER appuser

# Set Node.js to production mode
ENV NODE_ENV=production

# Run the application.
# The "start" command tells the worker to connect to LiveKit and begin waiting
# for jobs. package.json maps `npm start` to `node src/main.ts start`.
# LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET and PHONIC_API_KEY are NOT
# baked into the image; LiveKit Cloud injects them as runtime secrets.
CMD ["npm", "start"]
