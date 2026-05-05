FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 go build -o /out/resource-monitor-server ./cmd/server

FROM alpine:3.20
RUN adduser -D -H appuser
USER appuser
COPY --from=build /out/resource-monitor-server /usr/local/bin/resource-monitor-server
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/resource-monitor-server"]
