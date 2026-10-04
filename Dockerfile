FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
COPY .pnpmrc ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine
RUN apk add --no-cache mysql mysql-client supervisor bash
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
COPY .pnpmrc ./
RUN pnpm install --frozen-lockfile --prod || pnpm install --prod
COPY --from=builder /app/dist ./dist
COPY sql ./sql
COPY seed ./seed
COPY public ./public
COPY scripts ./scripts
COPY supervisord.conf /etc/supervisord.conf

# MySQL data dir
RUN mkdir -p /data/mysql /run/mysqld && \
    chown -R mysql:mysql /data/mysql /run/mysqld

ENV PORT=8080
EXPOSE 8080

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf", "-n"]
