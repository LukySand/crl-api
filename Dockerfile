FROM oven/bun:1 AS base
WORKDIR /usr/src/app

FROM base AS install
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM base AS release
COPY --from=install /usr/src/app/node_modules node_modules
COPY . .
RUN bunx --bun prisma generate
RUN chmod +x ./entrypoint.sh
# Storage guarda en uploads/ y el server corre como `bun`, que no puede crear
# carpetas acá. Para que las fotos sobrevivan un redeploy, montale un volumen.
RUN mkdir -p uploads && chown bun:bun uploads

ENV NODE_ENV=production
USER bun
EXPOSE 3001/tcp
# entrypoint corre migrate deploy + seed y luego arranca el server
CMD ["./entrypoint.sh"]
