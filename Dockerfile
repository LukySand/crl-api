FROM oven/bun:1 AS base
WORKDIR /usr/src/app

FROM base AS install
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM base AS release
COPY --from=install /usr/src/app/node_modules node_modules
COPY . .
RUN bunx --bun prisma generate

ENV NODE_ENV=production
USER bun
EXPOSE 3001/tcp
ENTRYPOINT ["bun", "run", "start"]
