"""
KittenTTS OpenAI-compatible API wrapper.
Wraps the KittenTTS Python library in a FastAPI server that exposes
the same /v1/audio/speech and /v1/audio/voices endpoints as Kokoro-FastAPI.
"""

import io
import os
import logging

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("kittentts-server")

app = FastAPI(title="Voxlocal KittenTTS Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Model Loading ────────────────────────────────────────────────────

MODEL_NAME = os.environ.get("MODEL_NAME", "KittenML/kitten-tts-mini-0.8")
tts_model = None


def get_model():
    global tts_model
    if tts_model is None:
        logger.info(f"Loading KittenTTS model: {MODEL_NAME}")
        from kittentts import KittenTTS

        tts_model = KittenTTS(MODEL_NAME)
        logger.info(f"Model loaded. Available voices: {tts_model.available_voices}")
    return tts_model


# ─── Request Models ───────────────────────────────────────────────────


class SpeechRequest(BaseModel):
    model: str = "kittentts"
    input: str
    voice: str = Field(default="Jasper")
    response_format: str = Field(default="mp3")
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    stream: bool = False  # KittenTTS does not support streaming


# ─── Audio Encoding ──────────────────────────────────────────────────

SAMPLE_RATE = 24000

FORMAT_MAP = {
    "mp3": ("audio/mpeg", "mp3", "MPEG"),
    "wav": ("audio/wav", "wav", "WAV"),
    "flac": ("audio/flac", "flac", "FLAC"),
    "ogg": ("audio/ogg", "ogg", "OGG"),
}


def encode_audio(audio_array: np.ndarray, fmt: str) -> tuple[bytes, str]:
    """Encode numpy audio array to the requested format."""
    if fmt not in FORMAT_MAP:
        fmt = "mp3"

    mime, ext, sf_format = FORMAT_MAP[fmt]
    buf = io.BytesIO()

    # soundfile can write mp3 if libsndfile is compiled with mp3 support
    # Otherwise fall back to wav
    try:
        sf.write(buf, audio_array, SAMPLE_RATE, format=sf_format)
    except Exception:
        # Fallback to wav if format not supported
        buf = io.BytesIO()
        sf.write(buf, audio_array, SAMPLE_RATE, format="WAV")
        mime = "audio/wav"

    return buf.getvalue(), mime


# ─── Endpoints ────────────────────────────────────────────────────────


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.get("/v1/audio/voices")
async def list_voices():
    model = get_model()
    return {"voices": list(model.available_voices)}


@app.get("/v1/models")
async def list_models():
    return {
        "data": [
            {"id": "kittentts", "object": "model", "owned_by": "KittenML"},
        ]
    }


@app.post("/v1/audio/speech")
async def create_speech(request: SpeechRequest):
    if not request.input or not request.input.strip():
        raise HTTPException(status_code=400, detail="Input text is required")

    model = get_model()

    # Map voice name - KittenTTS uses friendly names like "Jasper", "Bella"
    voice = request.voice
    available = list(model.available_voices)

    # Try exact match first
    if voice not in available:
        # Try case-insensitive match
        voice_lower = voice.lower()
        matched = [v for v in available if v.lower() == voice_lower]
        if matched:
            voice = matched[0]
        else:
            # Default to first available
            voice = available[0] if available else "Jasper"
            logger.warning(f"Voice '{request.voice}' not found, using '{voice}'")

    try:
        logger.info(
            f"Generating speech: voice={voice}, speed={request.speed}, "
            f"text_len={len(request.input)}, format={request.response_format}"
        )

        audio = model.generate(
            request.input,
            voice=voice,
            speed=request.speed,
            clean_text=True,
        )

        if audio is None or len(audio) == 0:
            raise HTTPException(
                status_code=500, detail="TTS generation returned empty audio"
            )

        audio_bytes, mime_type = encode_audio(audio, request.response_format)

        return Response(
            content=audio_bytes,
            media_type=mime_type,
            headers={
                "Content-Disposition": f"inline; filename=speech.{request.response_format}"
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"TTS generation error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/v1/test")
async def test():
    return {"status": "ok"}


# ─── Main ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8881"))
    logger.info(f"Starting KittenTTS server on {host}:{port}")
    # Pre-load model
    get_model()
    uvicorn.run(app, host=host, port=port)
