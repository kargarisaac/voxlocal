"""
Voxlocal Chat Server.
FastAPI + PydanticAI agent that chats about page content using a local Ollama LLM.
Page context is saved as files in per-session workspace directories.
"""

import json
import os
import re
import uuid
import logging
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.ollama import OllamaProvider

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voxlocal-chat")

# ─── Configuration ────────────────────────────────────────────────────

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")
MODEL_NAME = os.environ.get("MODEL_NAME", "qwen3.5:35b")
WORKSPACES_DIR = Path(os.environ.get("WORKSPACES_DIR", "/workspaces"))
MAX_HISTORY_TURNS = int(os.environ.get("MAX_HISTORY_TURNS", "50"))

# ─── App Setup ────────────────────────────────────────────────────────

app = FastAPI(title="Voxlocal Chat Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── PydanticAI Model ────────────────────────────────────────────────

model = OpenAIChatModel(
    model_name=MODEL_NAME,
    provider=OllamaProvider(base_url=OLLAMA_BASE_URL),
)

# ─── Request/Response Models ─────────────────────────────────────────


class CreateSessionRequest(BaseModel):
    content: str
    url: str = ""
    title: str = ""


class CreateSessionResponse(BaseModel):
    session_id: str
    title: str
    content_length: int


class ChatRequest(BaseModel):
    message: str
    model: Optional[str] = None


class HistoryEntry(BaseModel):
    role: str
    content: str


# ─── Think Tag Parsing ───────────────────────────────────────────────


def _partial_tag_len(text: str, tag: str) -> int:
    """Return length of a partial tag prefix match at end of text, or 0."""
    for i in range(min(len(tag) - 1, len(text)), 0, -1):
        if text.endswith(tag[:i]):
            return i
    return 0


# ─── Workspace Helpers ───────────────────────────────────────────────


def get_workspace(session_id: str) -> Path:
    workspace = WORKSPACES_DIR / session_id
    if not workspace.exists():
        raise HTTPException(status_code=404, detail="Session not found")
    return workspace


def load_history(workspace: Path) -> list[dict]:
    history_file = workspace / "history.json"
    if history_file.exists():
        return json.loads(history_file.read_text())
    return []


def save_history(workspace: Path, history: list[dict]):
    history_file = workspace / "history.json"
    history_file.write_text(json.dumps(history, indent=2))


def load_context(workspace: Path) -> str:
    context_file = workspace / "context.txt"
    if context_file.exists():
        return context_file.read_text()
    return ""


# ─── Endpoints ────────────────────────────────────────────────────────


@app.get("/health")
async def health():
    """Health check — also verifies Ollama connectivity."""
    try:
        import httpx

        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(get_ollama_native_url())
            ollama_ok = resp.status_code == 200
    except Exception:
        ollama_ok = False

    return {
        "status": "healthy",
        "ollama": "connected" if ollama_ok else "unreachable",
        "model": MODEL_NAME,
    }


def get_ollama_native_url() -> str:
    """Get the Ollama native API URL (without /v1 suffix)."""
    base = OLLAMA_BASE_URL.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    return base


@app.get("/models")
async def list_models():
    """List locally available Ollama models."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(get_ollama_native_url() + "/api/tags")
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=502, detail="Failed to fetch models from Ollama"
                )
            data = resp.json()
            models = []
            for m in data.get("models", []):
                name = m.get("name", "")
                size_bytes = m.get("size", 0)
                size_gb = round(size_bytes / (1024**3), 1)
                models.append(
                    {
                        "name": name,
                        "size": f"{size_gb}GB",
                        "parameter_size": m.get("details", {}).get(
                            "parameter_size", ""
                        ),
                        "family": m.get("details", {}).get("family", ""),
                    }
                )
            return {"models": models, "default": MODEL_NAME}
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Cannot reach Ollama: {e}")


@app.post("/sessions", response_model=CreateSessionResponse)
async def create_session(req: CreateSessionRequest):
    """Create a new chat session with page content."""
    if not req.content or not req.content.strip():
        raise HTTPException(status_code=400, detail="Content is required")

    session_id = uuid.uuid4().hex[:12]
    workspace = WORKSPACES_DIR / session_id
    workspace.mkdir(parents=True, exist_ok=True)

    # Save page context
    (workspace / "context.txt").write_text(req.content)

    # Save metadata
    meta = {"url": req.url, "title": req.title, "content_length": len(req.content)}
    (workspace / "meta.json").write_text(json.dumps(meta, indent=2))

    # Initialize empty history
    save_history(workspace, [])

    logger.info(
        f"Session {session_id} created: {req.title[:60]} ({len(req.content)} chars)"
    )

    return CreateSessionResponse(
        session_id=session_id, title=req.title, content_length=len(req.content)
    )


@app.post("/sessions/{session_id}/chat")
async def chat(session_id: str, req: ChatRequest):
    """Send a message and get a streamed response."""
    if not req.message or not req.message.strip():
        raise HTTPException(status_code=400, detail="Message is required")

    workspace = get_workspace(session_id)
    context = load_context(workspace)
    history = load_history(workspace)

    # Build the agent with page context as instructions
    instructions = (
        "You are a helpful assistant that answers questions about the following page content. "
        "Be concise and accurate. When referencing the content, be specific. "
        "If the user asks you to summarize, provide a clear structured summary.\n\n"
        "--- PAGE CONTENT ---\n"
        f"{context}\n"
        "--- END PAGE CONTENT ---"
    )

    # Use per-request model if specified, otherwise fall back to default
    chat_model = model
    if req.model and req.model != MODEL_NAME:
        chat_model = OpenAIChatModel(
            model_name=req.model,
            provider=OllamaProvider(base_url=OLLAMA_BASE_URL),
        )

    agent = Agent(model=chat_model, instructions=instructions)

    # Build message history for PydanticAI
    # We need to convert our stored history to PydanticAI message format
    # For simplicity, we'll use the agent with a combined prompt that includes history
    history_text = ""
    if history:
        # Trim to last N turns
        recent = history[-MAX_HISTORY_TURNS * 2 :]
        for entry in recent:
            role_label = "User" if entry["role"] == "user" else "Assistant"
            history_text += f"{role_label}: {entry['content']}\n\n"

    full_prompt = ""
    if history_text:
        full_prompt = (
            "Previous conversation:\n"
            + history_text
            + "User: "
            + req.message
            + "\n\nRespond to the user's latest message."
        )
    else:
        full_prompt = req.message

    async def generate_stream():
        full_response = ""
        in_think = False
        buffer = ""
        OPEN_TAG = "<think>"
        CLOSE_TAG = "</think>"

        try:
            async with agent.run_stream(full_prompt) as result:
                async for chunk in result.stream_text(delta=True):
                    full_response += chunk
                    buffer += chunk

                    while buffer:
                        if in_think:
                            close_idx = buffer.find(CLOSE_TAG)
                            if close_idx != -1:
                                think_text = buffer[:close_idx]
                                if think_text:
                                    yield f"data: {json.dumps({'think': think_text})}\n\n"
                                buffer = buffer[close_idx + len(CLOSE_TAG) :]
                                in_think = False
                                yield f"data: {json.dumps({'think_end': True})}\n\n"
                            else:
                                pl = _partial_tag_len(buffer, CLOSE_TAG)
                                if pl:
                                    safe = buffer[:-pl]
                                    if safe:
                                        yield f"data: {json.dumps({'think': safe})}\n\n"
                                    buffer = buffer[-pl:]
                                    break
                                else:
                                    yield f"data: {json.dumps({'think': buffer})}\n\n"
                                    buffer = ""
                        else:
                            open_idx = buffer.find(OPEN_TAG)
                            if open_idx != -1:
                                before = buffer[:open_idx]
                                if before:
                                    yield f"data: {json.dumps({'token': before})}\n\n"
                                buffer = buffer[open_idx + len(OPEN_TAG) :]
                                in_think = True
                                yield f"data: {json.dumps({'think_start': True})}\n\n"
                            else:
                                pl = _partial_tag_len(buffer, OPEN_TAG)
                                if pl:
                                    safe = buffer[:-pl]
                                    if safe:
                                        yield f"data: {json.dumps({'token': safe})}\n\n"
                                    buffer = buffer[-pl:]
                                    break
                                else:
                                    yield f"data: {json.dumps({'token': buffer})}\n\n"
                                    buffer = ""

            # Flush remaining buffer
            if buffer:
                if in_think:
                    yield f"data: {json.dumps({'think': buffer})}\n\n"
                    yield f"data: {json.dumps({'think_end': True})}\n\n"
                else:
                    yield f"data: {json.dumps({'token': buffer})}\n\n"

            yield "data: [DONE]\n\n"

            # Save to history (strip thinking from saved response)
            clean_response = re.sub(
                r"<think>.*?</think>", "", full_response, flags=re.DOTALL
            ).strip()
            history.append({"role": "user", "content": req.message})
            history.append({"role": "assistant", "content": clean_response})
            save_history(workspace, history)

        except Exception as e:
            logger.error(f"Chat error in session {session_id}: {e}", exc_info=True)
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/sessions/{session_id}/history")
async def get_history(session_id: str):
    """Retrieve conversation history for a session."""
    workspace = get_workspace(session_id)
    history = load_history(workspace)
    return {"session_id": session_id, "history": history}


# ─── Main ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    WORKSPACES_DIR.mkdir(parents=True, exist_ok=True)

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8882"))
    logger.info(f"Starting Voxlocal Chat Server on {host}:{port}")
    logger.info(f"Ollama: {OLLAMA_BASE_URL}, Model: {MODEL_NAME}")
    logger.info(f"Workspaces: {WORKSPACES_DIR}")
    uvicorn.run(app, host=host, port=port)
