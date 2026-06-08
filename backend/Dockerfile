FROM python:3.11-slim AS base

# Prevents Python from buffering stdout/stderr (important for Docker logs)
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# System deps for psycopg2-binary and pydub (ffmpeg for audio processing)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libpq-dev \
        ffmpeg \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e ".[test]" 2>/dev/null || pip install --no-cache-dir .

# Copy application code
COPY . .

# Create data directories
RUN mkdir -p /app/data/audio /app/reviewable

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--log-level", "info"]
