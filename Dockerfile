FROM python:3.13-slim

WORKDIR /app
COPY vumon ./vumon

# hls.js (Apache-2.0) is fetched at build time so the monitor page works on a
# network with no internet access. If it's missing, the page falls back to the
# jsDelivr CDN, then to the browser's own HLS support.
ARG HLSJS_VERSION=1
ADD --chmod=644 https://cdn.jsdelivr.net/npm/hls.js@${HLSJS_VERSION}/dist/hls.min.js ./vumon/web/vendor/hls.min.js

ENV VUMON_DATA_DIR=/data \
    VUMON_PORT=8080 \
    PYTHONUNBUFFERED=1

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/api/status',timeout=4)"

LABEL org.opencontainers.image.title="vu-monitor-2000" \
      org.opencontainers.image.description="Broadcast audio level monitoring for HLS streams: digital peak and analogue VU meters, EBU R128 loudness" \
      org.opencontainers.image.source="https://github.com/haftwo/vu-monitor-2000"

CMD ["python", "-m", "vumon"]
