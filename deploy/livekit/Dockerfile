# LiveKit (open source, Apache-2.0) for Office Spaces, shaped for Railway.
# Railway has no UDP, so media runs over ICE/TCP through a Railway TCP proxy.
FROM alpine:3.22
ARG LIVEKIT_VERSION=1.13.9
RUN apk add --no-cache ca-certificates socat bind-tools iproute2 \
 && wget -qO- "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz" | tar -xz -C /usr/local/bin livekit-server \
 && livekit-server --version
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
