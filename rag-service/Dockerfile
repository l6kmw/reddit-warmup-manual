FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/redwarm-rag .

FROM alpine:3.22
WORKDIR /app
COPY --from=build /out/redwarm-rag /app/redwarm-rag
EXPOSE 8090
ENTRYPOINT ["/app/redwarm-rag"]
