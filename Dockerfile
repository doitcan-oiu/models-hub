# syntax=docker/dockerfile:1
FROM node:22-alpine AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY shared ./shared
COPY src ./src
RUN npm run build:frontend

FROM golang:1.27.3-alpine AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/pulsegate ./cmd/pulsegate
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/pulsegate-import ./cmd/pulsegate-import

FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata && addgroup -S -g 10001 pulsegate && adduser -S -D -H -u 10001 -G pulsegate pulsegate
WORKDIR /app
RUN mkdir -p /app/data && chown 10001:10001 /app/data
COPY --from=backend /out/pulsegate /app/pulsegate
COPY --from=backend /out/pulsegate-import /app/pulsegate-import
COPY --from=frontend /src/dist /app/dist
USER 10001:10001
ENV LISTEN_ADDR=:8787 STATIC_DIR=/app/dist DATA_DIR=/app/data TZ=Asia/Shanghai
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 CMD ["/app/pulsegate", "-healthcheck"]
ENTRYPOINT ["/app/pulsegate"]
