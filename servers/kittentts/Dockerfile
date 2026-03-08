FROM python:3.12-slim

# Install system dependencies for espeak-ng and audio processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng \
    libespeak-ng1 \
    libsndfile1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user and ensure cache dir is writable
RUN useradd -m -s /bin/bash appuser \
    && mkdir -p /home/appuser/.cache/huggingface \
    && chown -R appuser:appuser /home/appuser/.cache

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy server code
COPY server.py .

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8881

# Start the server
CMD ["python", "server.py"]
