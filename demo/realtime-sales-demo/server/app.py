"""Backend for Hammer Realtime voice sales demo: wiki search + OpenAI client secrets."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path

# Ensure application loggers (sip_realtime, voice_tools, etc.) emit INFO-level lines.
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
latency_log = logging.getLogger("voice_latency")

import httpx
from fastapi import BackgroundTasks, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from hammer_office import (
    HammerAccountRequest,
    HammerOfficeError,
    address_is_hammer_placeholder,
    create_hammer_account,
    hammer_office_configured,
)
from hammer_office_session import (
    account_already_created,
    fill_hammer_account_field,
    open_hammer_account_form,
    prewarm_hammer_account_form,
)
from hubspot_lead import enrich_website_lead
from lead_zapier import (
    AgreementApprovalRequest,
    AgreementPendingRegisterRequest,
    LeadCaptureRequest,
    agreement_approval_status,
    build_zapier_payload,
    lead_channel,
    lead_webhook_configured,
    lead_webhook_env_name,
    post_lead_to_zapier,
    record_agreement_approval_request,
    verify_approval_secret,
    zapier_voice_lead_webhook_hook_id,
    zapier_voice_lead_webhook_url,
    zapier_website_lead_webhook_hook_id,
    zapier_website_lead_webhook_url,
)
from sales_chat import complete_sales_chat
from voice_call_summary import (
    VoiceCallLeadAccumulator,
    maybe_post_voice_call_summary,
    voice_call_summary_webhook_configured,
    zapier_voice_call_summary_hook_id,
)
from wiki_retrieval import ALLOWED_WIKI_FILES, WikiRetriever

try:
    from openai import InvalidWebhookSignatureError
except ImportError:  # pragma: no cover
    InvalidWebhookSignatureError = Exception  # type: ignore[misc, assignment]

from sip_realtime import get_sip_service, handle_incoming_call_safe, telephony_enabled

try:
    from outbound_telephony import (
        build_bridge_twiml,
        build_inbound_connect_twiml,
        callback_status_public,
        get_record,
        initiate_callback,
        outbound_api_public_url,
        outbound_enabled,
        record_status,
        validate_twilio_signature,
        voice_phone_disclosure,
        voice_phone_disclosure_enabled,
    )
except ImportError:  # pragma: no cover
    outbound_enabled = lambda: False  # type: ignore[assignment,misc]
    outbound_api_public_url = lambda: None  # type: ignore[assignment,misc]

_SERVER_DIR = Path(__file__).resolve().parent


def _shared_dir() -> Path:
    env_root = os.environ.get("REALTIME_SALES_REPO_ROOT", "").strip()
    if env_root:
        candidate = Path(env_root) / "demo" / "shared"
        if candidate.is_dir():
            return candidate
    return _SERVER_DIR.parent.parent / "shared"


_SHARED_DIR = _shared_dir()
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))
from site_copy import load_site_copy  # noqa: E402
DEMO_ROOT = _SERVER_DIR.parent


def _load_local_dotenv() -> None:
    """Load `server/.env` for local dev only (never Vercel/Fly — platform env is source of truth)."""
    if os.environ.get("REALTIME_SALES_SERVERLESS", "").strip() in ("1", "true", "yes"):
        return
    if os.environ.get("FLY_APP_NAME", "").strip():
        return
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    # utf-8-sig strips BOM so the first line is `OPENAI_API_KEY=...`, not `\ufeffOPENAI_API_KEY=...`
    load_dotenv(_SERVER_DIR / ".env", override=True, encoding="utf-8-sig")


_load_local_dotenv()


def _wiki_bundle_complete(wiki_dir: Path) -> bool:
    if not wiki_dir.is_dir():
        return False
    return all((wiki_dir / name).is_file() for name in ALLOWED_WIKI_FILES)


def _missing_allowlisted(wiki_dir: Path) -> list[str]:
    if not wiki_dir.is_dir():
        return [f"(missing wiki directory: {wiki_dir})"]
    return [name for name in ALLOWED_WIKI_FILES if not (wiki_dir / name).is_file()]


def _find_repo_root() -> Path:
    """Return repo root (folder that contains `wiki/`)."""

    wiki_env = os.environ.get("REALTIME_SALES_WIKI_DIR", "").strip()
    if wiki_env:
        wd = Path(wiki_env).expanduser().resolve()
        if _wiki_bundle_complete(wd):
            return wd.parent
        raise ImportError(
            f"REALTIME_SALES_WIKI_DIR={wd} is missing allowlisted files. Missing: {_missing_allowlisted(wd)}"
        )

    env_root = os.environ.get("REALTIME_SALES_REPO_ROOT", "").strip()
    if env_root:
        root = Path(env_root).expanduser().resolve()
        if _wiki_bundle_complete(root / "wiki"):
            return root
        raise ImportError(
            f"REALTIME_SALES_REPO_ROOT={root} does not have a complete wiki/. Missing: "
            f"{_missing_allowlisted(root / 'wiki')}"
        )

    # Standard layout: .../<repo>/demo/realtime-sales-demo/server  →  repo is 3 levels above `server/`
    candidates: list[Path] = [_SERVER_DIR.parent.parent.parent]
    candidates.extend(_SERVER_DIR.parents)

    seen: set[Path] = set()
    for anc in candidates:
        key = anc.resolve()
        if key in seen:
            continue
        seen.add(key)
        if _wiki_bundle_complete(key / "wiki"):
            return key

    likely_wiki = (_SERVER_DIR.parent.parent.parent / "wiki").resolve()
    miss = _missing_allowlisted(likely_wiki)
    raise ImportError(
        "Could not find a `wiki/` folder with all allowlisted markdown files "
        f"({', '.join(ALLOWED_WIKI_FILES)}).\n"
        f"First path checked: {likely_wiki}\n"
        f"Missing: {miss if miss else '(unexpected — report this)'}\n"
        "Fix: ensure those three files exist under your repo's `wiki/` folder, or set:\n"
        '  REALTIME_SALES_REPO_ROOT="C:\\\\...\\\\VibeVoice"   (folder that contains wiki\\\\)\n'
        '  REALTIME_SALES_WIKI_DIR="C:\\\\...\\\\VibeVoice\\\\wiki"   (wiki folder itself)'
    )


def _is_serverless() -> bool:
    return os.environ.get("REALTIME_SALES_SERVERLESS", "").strip() in ("1", "true", "yes")


def _uses_platform_env_for_secrets() -> bool:
    """Vercel/Fly inject secrets via process env — never read server/.env from disk there."""
    if _is_serverless():
        return True
    if os.environ.get("FLY_APP_NAME", "").strip():
        return True
    return False


def _is_production_deploy() -> bool:
    """Vercel / live site — disable debug routes and tighten health responses."""
    if _is_serverless():
        return True
    return os.environ.get("REALTIME_SALES_PRODUCTION", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def _require_non_production_debug() -> None:
    if _is_production_deploy():
        raise HTTPException(status_code=404, detail="Not found")


REPO_ROOT = _find_repo_root()
wiki_env_post = os.environ.get("REALTIME_SALES_WIKI_DIR", "").strip()
DEFAULT_WIKI_DIR = (
    Path(wiki_env_post).expanduser().resolve()
    if wiki_env_post
    else (REPO_ROOT / "wiki")
)
DEFAULT_KB_DB = REPO_ROOT / "knowledge" / "data" / "company_kb.sqlite"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
from knowledge.kb_bootstrap import ensure_kb_database  # noqa: E402
from knowledge.learning.pipeline import schedule_after_turn  # noqa: E402
WEB_DIST = DEMO_ROOT / "web" / "dist"
OPENAI_URL = "https://api.openai.com/v1/realtime/client_secrets"
OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls"


def _openai_error_detail(body: str) -> str:
    """Extract a short user-facing message from OpenAI JSON error bodies."""
    raw = (body or "").strip()
    if not raw:
        return "OpenAI request failed (empty response body)"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return raw[:500]
    if not isinstance(data, dict):
        return raw[:500]
    err = data.get("error")
    if isinstance(err, dict):
        msg = err.get("message")
        if isinstance(msg, str) and msg.strip():
            return msg.strip()
    detail = data.get("detail")
    if isinstance(detail, str) and detail.strip():
        return detail.strip()
    return raw[:500]


def _openai_api_key() -> str:
    """Resolve API key.

    Local dev: last non-empty `OPENAI_API_KEY=` in `server/.env` (canonical), else process env.
    Vercel/Fly: `OPENAI_API_KEY` process env only (sync from `server/.env` via deploy scripts).
    """
    key, _src = _openai_api_key_and_source()
    return key


def _openai_api_key_and_source() -> tuple[str, str]:
    if _uses_platform_env_for_secrets():
        key = os.environ.get("OPENAI_API_KEY", "").strip()
        src = "process_environment"
    else:
        from_file = _parse_openai_key_from_dotenv_file()
        if from_file:
            key = from_file
            src = "server/.env"
        else:
            key = os.environ.get("OPENAI_API_KEY", "").strip()
            src = "process_environment"
    key = key.lstrip("\ufeff")
    if len(key) >= 2 and key[0] == key[-1] and key[0] in "\"'":
        key = key[1:-1].strip()
    key = _sanitize_openai_secret(key)
    return key, src


def _sanitize_openai_secret(value: str) -> str:
    """Strip accidental leading/trailing characters from pasted keys (NBSP, smart quotes, CR)."""
    v = value.strip().replace("\r", "").replace("\n", "")
    allowed = frozenset(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
    )
    while v and v[0] not in allowed:
        v = v[1:]
    while v and v[-1] not in allowed:
        v = v[:-1]
    return v


def _parse_openai_key_from_dotenv_file() -> str | None:
    """Return last non-empty OPENAI_API_KEY value from `server/.env`, or None."""
    path = _SERVER_DIR / ".env"
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8-sig")
    last: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        name, _, val = line.partition("=")
        if name.strip() != "OPENAI_API_KEY":
            continue
        v = val.strip()
        if v.startswith('"') and v.endswith('"') and len(v) >= 2:
            v = v[1:-1].strip()
        elif v.startswith("'") and v.endswith("'") and len(v) >= 2:
            v = v[1:-1].strip()
        v = v.lstrip("\ufeff")
        if v:
            last = v
    return last


class WikiSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=4000)


class WikiChunk(BaseModel):
    doc_id: str
    chunk_id: int
    score: float
    text: str


class WikiSearchResponse(BaseModel):
    chunks: list[WikiChunk]


class WikiBatchSearchRequest(BaseModel):
    queries: list[str] = Field(..., min_length=1, max_length=24)


class WikiBatchSearchResponse(BaseModel):
    results: dict[str, list[WikiChunk]]


class ChatTurn(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    text: str = Field(..., min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    history: list[ChatTurn] | None = None


class ChatResponse(BaseModel):
    reply: str


class LeadCaptureResponse(BaseModel):
    ok: bool = True
    zapier_delivered: bool = False
    event: str | None = None
    agreement_email_sent: bool = False
    agreement_approval_required: bool = False


class VoiceCallSummaryRequest(BaseModel):
    """Browser end-of-call payload — ephemeral session log, not stored server-side."""

    channel: str = "browser"
    call_id: str = ""
    started_at: str = ""
    ended_at: str = ""
    interaction_summary: str = ""
    session_log: list[str] = Field(default_factory=list)
    name: str = ""
    phone: str = ""
    email: str = ""
    website: str = ""
    role: str = ""
    dealership_name: str = ""
    selected_plan: str = ""
    lot_size: str = ""
    seat_count: str = ""
    currency: str = ""
    address: str = ""
    business_type: str = ""
    product_interest: str = ""
    capture_lead_fired: bool = False
    agreement_email_sent: bool = False
    i_approve_approved: bool = False
    account_created: bool = False
    pen_challenge_skipped: bool = False
    pen_hammer_close_active: bool = False


class VoiceCallSummaryResponse(BaseModel):
    ok: bool = True
    posted: bool = False
    skipped_reason: str | None = None


class AgreementApprovalResponse(BaseModel):
    ok: bool = True
    approved: bool = False
    email: str
    approved_at: str | None = None
    pending: bool = False


class HammerCreateAccountRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=200)
    name: str = Field(..., min_length=1, max_length=120)
    legal_name: str = Field(
        default="",
        max_length=200,
        description="Optional — defaults to dealership_name from PHASE A",
    )
    display_name: str = Field(
        default="",
        max_length=200,
        description="Optional — defaults to dealership_name from PHASE A",
    )
    phone: str = Field(..., min_length=5, max_length=32)
    cell_phone: str = Field(
        default="",
        max_length=32,
        description="Optional — defaults to phone (one number for both fields)",
    )
    website: str = Field(..., min_length=4, max_length=300)
    address: str = Field(..., min_length=5, max_length=400)
    business_type: str = Field(..., min_length=1, max_length=120)
    timezone: str = Field(default="", max_length=120)
    currency: str = Field(..., min_length=3, max_length=8)
    dealership_name: str = Field(..., min_length=1, max_length=200)
    role: str = Field(..., min_length=1, max_length=64)
    selected_plan: str = Field(default="", max_length=200)
    gst_hst: str = Field(default="", max_length=64)
    qst: str = Field(default="", max_length=64)


class HammerCreateAccountResponse(BaseModel):
    ok: bool = True
    message: str
    account_url: str | None = None
    dry_run: bool = False
    configured: bool = True


class HammerOpenFormRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=200)
    dealership_name: str = Field(default="", max_length=200)
    display_name: str = Field(default="", max_length=200)
    name: str = Field(default="", max_length=120)


class HammerOpenFormResponse(BaseModel):
    ok: bool = True
    browser_open: bool = False
    prefilled: list[str] = Field(default_factory=list)
    message: str = ""


class HammerFillFieldRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=200)
    field: str = Field(..., min_length=1, max_length=64)
    value: str = Field(..., min_length=1, max_length=400)


class HammerFillFieldResponse(BaseModel):
    ok: bool = True
    field: str = ""
    message: str = ""
    timezone_set: str | None = None
    currency_set: str | None = None
    billing_country: str | None = None
    region_code: str | None = None
    is_quebec: bool | None = None
    tax_field: str | None = None
    account_created: bool = False
    account_url: str | None = None


def _hammer_raw_dir_for_retrieval() -> Path | None:
    """Optional markdown corpus under `raw/hammer-data/` (repo-relative unless overridden)."""
    override = os.environ.get("REALTIME_SALES_HAMMER_RAW_DIR", "").strip()
    if override:
        p = Path(override).expanduser().resolve()
        return p if p.is_dir() else None
    if os.environ.get("REALTIME_SALES_INCLUDE_HAMMER_RAW", "1").strip().lower() in (
        "0",
        "false",
        "no",
    ):
        return None
    p = REPO_ROOT / "raw" / "hammer-data"
    return p if p.is_dir() else None


@lru_cache(maxsize=1)
def get_retriever() -> WikiRetriever:
    wiki_dir = Path(os.environ.get("REALTIME_SALES_WIKI_DIR", str(DEFAULT_WIKI_DIR))).resolve()
    db = Path(os.environ.get("REALTIME_SALES_KB_DB", str(DEFAULT_KB_DB))).resolve()
    pb_env = os.environ.get("REALTIME_SALES_PLAYBOOK_MD", "").strip()
    playbook_md_path = Path(pb_env).expanduser().resolve() if pb_env else None
    return WikiRetriever(
        wiki_dir,
        hammer_raw_dir=_hammer_raw_dir_for_retrieval(),
        db_path=db,
        playbook_md_path=playbook_md_path,
    )


def invalidate_realtime_sales_retriever_cache() -> None:
    get_retriever.cache_clear()
    _wiki_result_cache.clear()


def _top_k() -> int:
    try:
        return max(1, min(12, int(os.environ.get("REALTIME_SALES_TOP_K", "6"))))
    except ValueError:
        return 6


def _max_tool_chars() -> int:
    try:
        return max(800, min(12000, int(os.environ.get("REALTIME_SALES_TOOL_MAX_CHARS", "4500"))))
    except ValueError:
        return 4500


def _cors_origins() -> list[str]:
    raw = os.environ.get(
        "REALTIME_SALES_CORS_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173",
    )
    return [o.strip() for o in raw.split(",") if o.strip()]


# In-memory result cache keyed by normalized query — eliminates repeated SQLite BM25 round-trips
# so search_wiki tool calls during a live call return in microseconds instead of milliseconds.
_wiki_result_cache: dict[str, list[WikiChunk]] = {}
_WIKI_RESULT_CACHE_MAX = 1024


def _elapsed_ms(started_at: float) -> int:
    return int((time.perf_counter() - started_at) * 1000)


def _wiki_chunks_for_query(retriever: WikiRetriever, query: str) -> list[WikiChunk]:
    q = query.strip()
    if not q:
        return []
    cache_key = q.lower()
    cached = _wiki_result_cache.get(cache_key)
    if cached is not None:
        latency_log.info("wiki_query cache_hit query=%r chunks=%s", q[:80], len(cached))
        return cached
    started_at = time.perf_counter()
    pairs = retriever.top_k(q, k=_top_k())
    chunks: list[WikiChunk] = []
    total = 0
    cap = _max_tool_chars()
    for c, s in pairs:
        piece = c.text.strip()
        if total + len(piece) > cap:
            break
        chunks.append(
            WikiChunk(doc_id=c.doc_id, chunk_id=c.chunk_id, score=round(float(s), 4), text=piece)
        )
        total += len(piece)
    if len(_wiki_result_cache) < _WIKI_RESULT_CACHE_MAX:
        _wiki_result_cache[cache_key] = chunks
    latency_log.info(
        "wiki_query cache_miss query=%r chunks=%s elapsed_ms=%s",
        q[:80],
        len(chunks),
        _elapsed_ms(started_at),
    )
    return chunks


def _wiki_batch_sync(queries: list[str]) -> dict[str, list[WikiChunk]]:
    retriever = get_retriever()
    out: dict[str, list[WikiChunk]] = {}
    for raw in queries:
        q = raw.strip()
        if not q or q in out:
            continue
        out[q] = _wiki_chunks_for_query(retriever, q)
    return out


def _prewarm_wiki_result_cache() -> None:
    """Run all prefetch queries through _wiki_chunks_for_query so search_wiki tool calls
    during the first live call hit the in-memory cache instead of SQLite BM25."""
    from voice_instructions import WIKI_PREFETCH_QUERIES

    started_at = time.perf_counter()
    retriever = get_retriever()
    for q in WIKI_PREFETCH_QUERIES:
        _wiki_chunks_for_query(retriever, q)
    latency_log.info("wiki_result_cache prewarmed queries=%s elapsed_ms=%s", len(WIKI_PREFETCH_QUERIES), _elapsed_ms(started_at))


@asynccontextmanager
async def _lifespan(_: FastAPI):
    if not _is_serverless():
        ensure_kb_database(REPO_ROOT)
    # Warm SQLite FTS index on every deploy (local + Vercel) so first voice lookup is not cold.
    await asyncio.to_thread(get_retriever)
    # Pre-populate the result cache so all prefetch queries return instantly on first call.
    await asyncio.to_thread(_prewarm_wiki_result_cache)
    from voice_instructions import warm_instruction_cache

    warm_instruction_cache()
    try:
        from elevenlabs_agent import prewarm_elevenlabs_session

        started_at = time.perf_counter()
        await prewarm_elevenlabs_session(get_retriever)
        latency_log.info("elevenlabs_executor startup_prewarm elapsed_ms=%s", _elapsed_ms(started_at))
    except Exception:
        latency_log.exception("elevenlabs_executor startup_prewarm failed")
    try:
        import elevenlabs_admin
        if elevenlabs_admin.elevenlabs_configured():
            started_at = time.perf_counter()
            tuned = await elevenlabs_admin.tune_agent_latency_settings()
            latency_log.info("elevenlabs_agent startup_tuning success elapsed_ms=%s tuned=%s", _elapsed_ms(started_at), tuned)
    except Exception:
        latency_log.exception("elevenlabs_agent startup_tuning failed")
    if telephony_enabled():
        webhook_secret = os.environ.get("OPENAI_WEBHOOK_SECRET", "").strip()
        key = _openai_api_key()
        if webhook_secret and key:
            svc = get_sip_service(
                api_key=key,
                webhook_secret=webhook_secret,
                get_retriever=get_retriever,
            )
            await svc.warmup()
    if _uses_platform_env_for_secrets() and (_SERVER_DIR / ".env").is_file():
        print(
            "[realtime-sales-demo] server/.env on disk is ignored on Vercel/Fly; "
            "OPENAI_API_KEY must come from platform env (sync from server/.env via deploy scripts).",
            flush=True,
        )
    key, src = _openai_api_key_and_source()
    if _is_production_deploy():
        if key:
            suf = key[-4:].encode("ascii", "backslashreplace").decode("ascii")
            print(
                f"[realtime-sales-demo] OpenAI configured for production ({src}, last4=…{suf}).",
                flush=True,
            )
        else:
            print("[realtime-sales-demo] OPENAI_API_KEY missing on server.", flush=True)
    elif key:
        suf = key[-4:].encode("ascii", "backslashreplace").decode("ascii")
        print(
            f"[realtime-sales-demo] OPENAI_API_KEY from {src}: "
            f"length={len(key)} last4=…{suf}",
            flush=True,
        )
    else:
        print("[realtime-sales-demo] OPENAI_API_KEY missing — add server/.env or set env var.", flush=True)
    yield


app = FastAPI(title="Hammer Realtime sales voice demo API", version="0.1.0", lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


_HAMMER_AGREEMENT_LOGO = _SERVER_DIR / "static" / "email" / "hammer-ai-logo.png"
_HAMMER_WORDMARK = _SERVER_DIR / "static" / "hammer-wordmark.png"


@app.get("/api/email/hammer-ai-logo.png")
def hammer_agreement_logo() -> FileResponse:
    """Public logo for agreement emails (Gmail loads this over HTTPS)."""
    if not _HAMMER_AGREEMENT_LOGO.is_file():
        raise HTTPException(status_code=404, detail="hammer-ai-logo.png not found")
    return FileResponse(
        _HAMMER_AGREEMENT_LOGO,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/branding/hammer-wordmark.png")
def hammer_wordmark_logo() -> FileResponse:
    """Hammer wordmark for admin UI and internal tools."""
    if not _HAMMER_WORDMARK.is_file():
        raise HTTPException(status_code=404, detail="hammer-wordmark.png not found")
    return FileResponse(
        _HAMMER_WORDMARK,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


def _demo_phone_public() -> dict[str, str]:
    number = os.environ.get("DEMO_PHONE_NUMBER", "").strip()
    display = os.environ.get("DEMO_PHONE_DISPLAY", "").strip() or number
    tel = os.environ.get("DEMO_PHONE_TEL", "").strip() or "".join(ch for ch in number if ch.isdigit())
    return {"number": number, "display": display, "tel": tel}


def _telephony_webhook_public_url() -> str | None:
    explicit = os.environ.get("TELEPHONY_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if explicit:
        return f"{explicit}/api/realtime/sip-webhook"
    fly_app = os.environ.get("FLY_APP_NAME", "").strip()
    if fly_app:
        return f"https://{fly_app}.fly.dev/api/realtime/sip-webhook"
    return None


def _openai_project_id() -> str:
    return os.environ.get("OPENAI_PROJECT_ID", "").strip()


def _twilio_sip_origination_uri() -> str | None:
    """Return the SIP URI that Twilio should dial when bridging a call to our AI.

    Prefers ELEVENLABS_SIP_URI when set — this routes phone calls through the
    same ElevenLabs agent and voice used for the browser demo (much better audio
    quality than OpenAI Realtime shimmer over G.711 PSTN).  Falls back to the
    OpenAI Realtime SIP endpoint so existing phone calls keep working while the
    ElevenLabs phone number is being configured in the dashboards.
    """
    el_uri = os.environ.get("ELEVENLABS_SIP_URI", "").strip()
    if el_uri:
        return el_uri
    proj = _openai_project_id()
    if not proj.startswith("proj_"):
        return None
    return f"sip:{proj}@sip.api.openai.com;transport=tls"


def _telephony_health_extra() -> dict[str, str | bool | None]:
    proj = _openai_project_id()
    el_uri = os.environ.get("ELEVENLABS_SIP_URI", "").strip()
    return {
        "openai_project_id_configured": bool(proj.startswith("proj_")),
        "twilio_sip_origination_uri": _twilio_sip_origination_uri(),
        "elevenlabs_sip_active": bool(el_uri),
        "fly_app": os.environ.get("FLY_APP_NAME", "").strip() or None,
    }


def _fetch_fly_telephony_health() -> dict:
    """Best-effort Fly telephony host check (phone path does not go through Vercel)."""
    url = os.environ.get(
        "FLY_TELEPHONY_HEALTH_URL",
        "https://hammer-voice-telephony.fly.dev/api/health",
    ).strip()
    if not url:
        return {"reachable": False, "error": "FLY_TELEPHONY_HEALTH_URL not set"}
    try:
        import httpx

        resp = httpx.get(url, timeout=10.0)
        if resp.is_success:
            data = resp.json()
            return {"reachable": True, **data}
        return {"reachable": False, "error": f"HTTP {resp.status_code}"}
    except Exception as exc:
        return {"reachable": False, "error": f"{type(exc).__name__}: {exc}"}


@app.get("/api/telephony/status")
def telephony_status() -> dict:
    """Public checklist for Call Hannah — dial number + Fly/Twilio alignment hints."""
    phone = _demo_phone_public()
    fly = _fetch_fly_telephony_health()
    issues: list[str] = []

    if not phone["number"]:
        issues.append("Set DEMO_PHONE_NUMBER on Vercel to your Twilio voice number (E.164).")
    if not fly.get("reachable"):
        issues.append(f"Fly telephony host unreachable: {fly.get('error', 'unknown')}")
    elif not fly.get("telephony_webhook_secret_configured"):
        issues.append("Fly missing OPENAI_WEBHOOK_SECRET — Hannah cannot accept SIP calls.")
    elif not fly.get("openai_configured"):
        issues.append("Fly missing OPENAI_API_KEY.")
    elif phone["number"] and fly.get("demo_phone_number") and phone["number"] != fly.get("demo_phone_number"):
        issues.append(
            f"Vercel demo_phone ({phone['number']}) differs from Fly ({fly.get('demo_phone_number')}). "
            "Sync with fly-secrets-from-env.ps1."
        )

    twilio_uri = fly.get("twilio_sip_origination_uri") if fly.get("reachable") else _twilio_sip_origination_uri()
    local_outbound = outbound_enabled()
    fly_outbound = bool(fly.get("outbound_enabled")) if fly.get("reachable") else False
    return {
        "ok": not issues,
        "dial_e164": phone["number"] or None,
        "display": phone["display"] or None,
        "tel_href": f"tel:{phone['number']}" if phone["number"] else None,
        "call_path": "Your phone → Twilio (voice number on SIP trunk) → OpenAI SIP → Fly webhook → Hannah",
        "note": "This Vercel/preview URL only shows the number to dial. Voice does not run on Vercel.",
        "fly_telephony_health_url": os.environ.get(
            "FLY_TELEPHONY_HEALTH_URL",
            "https://hammer-voice-telephony.fly.dev/api/health",
        ),
        "fly": fly,
        "twilio_sip_origination_uri": twilio_uri,
        "openai_webhook_url": fly.get("telephony_sip_webhook_url")
        or _telephony_webhook_public_url(),
        "issues": issues,
        "if_call_fails": [
            "Verizon greeting: dialed number is not your active Twilio DID on the SIP trunk.",
            "Twilio Failed / 0 sec to sip.api.openai.com: OpenAI IP allowlist + webhook on same proj_ as trunk.",
            "Ring then hang up: check OpenAI webhook delivery log and Fly logs.",
        ],
        "outbound_enabled": local_outbound or fly_outbound,
        "outbound_api_url": outbound_api_public_url()
        if local_outbound
        else (fly.get("outbound_api_url") or outbound_api_public_url()),
    }


@app.get("/api/health")
def health() -> dict:
    key, key_src = _openai_api_key_and_source()
    phone = _demo_phone_public()
    telephony = {
        "telephony_enabled": telephony_enabled(),
        "telephony_webhook_secret_configured": bool(os.environ.get("OPENAI_WEBHOOK_SECRET", "").strip()),
        "demo_phone_configured": bool(phone["number"] or phone["display"]),
        "demo_phone_display": phone["display"] or None,
        "demo_phone_number": phone["number"] or None,
        "telephony_sip_webhook_url": _telephony_webhook_public_url(),
        "outbound_enabled": outbound_enabled(),
        "outbound_api_url": outbound_api_public_url(),
        **_telephony_health_extra(),
    }
    zapier_hook = zapier_voice_lead_webhook_hook_id()
    zapier_website_hook = zapier_website_lead_webhook_hook_id()
    voice_summary_hook = zapier_voice_call_summary_hook_id()
    zapier_health = {
        "zapier_voice_lead_webhook_configured": bool(zapier_voice_lead_webhook_url()),
        "zapier_voice_lead_webhook_hook_id": zapier_hook or None,
        "zapier_website_lead_webhook_configured": bool(zapier_website_lead_webhook_url()),
        "zapier_website_lead_webhook_hook_id": zapier_website_hook or None,
        "zapier_lead_webhook_configured": bool(zapier_voice_lead_webhook_url()),
        "zapier_voice_call_summary_webhook_configured": voice_call_summary_webhook_configured(),
        "zapier_voice_call_summary_webhook_hook_id": voice_summary_hook or None,
        "zapier_approval_secret_configured": bool(
            os.environ.get("ZAPIER_APPROVAL_CALLBACK_SECRET", "").strip()
        ),
    }
    if _is_production_deploy():
        return {
            "ok": True,
            "openai_configured": bool(key),
            "openai_key_source": key_src,
            "openai_key_last4": key[-4:] if len(key) >= 4 else None,
            **zapier_health,
            **telephony,
        }
    raw = _hammer_raw_dir_for_retrieval()
    return {
        "ok": True,
        "openai_configured": bool(key),
        "wiki_dir": str(DEFAULT_WIKI_DIR),
        "hammer_raw_dir": str(raw) if raw else None,
        "kb_db_exists": DEFAULT_KB_DB.is_file(),
        **zapier_health,
        **telephony,
    }


def _agreement_logo_url_for_health() -> str:
    try:
        from hammer_agreement import agreement_logo_url_for_email

        return agreement_logo_url_for_email()
    except Exception:
        return ""


def _zapier_sample_has_html() -> bool:
    try:
        from hammer_agreement import build_agreement_email_html, resolve_agreement_pricing

        sample = resolve_agreement_pricing("Hammer Drive", "45", currency="USD")
        if not sample:
            return False
        html = build_agreement_email_html("Sample", sample, logo_src="https://example.com/logo.png")
        return bool(html and "<img" in html)
    except Exception:
        return False


@app.get("/api/debug/zapier-payload-keys")
def zapier_payload_keys() -> dict:
    """Local helper: field names sent to Zapier on voice Hammer Drive signup."""
    _require_non_production_debug()
    from lead_zapier import LeadCaptureRequest, build_zapier_payload

    sample = LeadCaptureRequest(
        name="Sample Dealer",
        phone="5125550100",
        email="sample@example.com",
        website="sampledealer.com",
        dealership_name="Sample Motors",
        role="general-manager",
        selected_plan="Hammer Drive 31-60",
        lot_size="45",
        channel="voice",
        currency="USD",
    )
    payload = build_zapier_payload(sample)
    return {
        "keys": sorted(payload.keys()),
        "agreementEmailHtml_length": len(payload.get("agreementEmailHtml", "")),
        "agreementEmailHtmlEmbedded_length": len(payload.get("agreementEmailHtmlEmbedded", "")),
    }


@app.get("/api/site_copy")
def site_copy() -> dict:
    try:
        return load_site_copy(DEFAULT_WIKI_DIR)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class TrackEventRequest(BaseModel):
    """Event posted by web/public/openai-tracker.js (page views + form submits)."""

    event: str = Field(..., max_length=50)
    source_url: str = Field(default="", max_length=2000)
    email: str = Field(default="", max_length=320)
    form_id: str = Field(default="", max_length=200)


@app.post("/api/track")
async def track_conversion(
    payload: TrackEventRequest, request: Request, background_tasks: BackgroundTasks
) -> dict:
    """Forward an ad conversion event (page view / form submit) to OpenAI Ads.

    Responds immediately; the event is sent to OpenAI in the background so
    tracking never slows down or breaks the site.
    """
    from openai_ads_tracking import send_conversion_event, tracking_configured

    if not tracking_configured():
        return {"ok": True, "tracked": False, "reason": "tracking not configured"}

    forwarded = request.headers.get("x-forwarded-for", "")
    ip_address = forwarded.split(",")[0].strip() if forwarded else (
        request.client.host if request.client else ""
    )
    background_tasks.add_task(
        send_conversion_event,
        payload.event,
        payload.source_url,
        ip_address,
        request.headers.get("user-agent", ""),
        payload.email,
    )
    return {"ok": True, "tracked": True}


def _require_hammer_local_debug() -> None:
    _require_non_production_debug()
    from hammer_office import hammer_office_debug_mode, hammer_office_runtime_is_deployed

    if hammer_office_debug_mode():
        return
    if hammer_office_runtime_is_deployed():
        raise HTTPException(
            status_code=503,
            detail="Hammer debug is disabled on cloud hosts (Fly/Vercel). Run locally.",
        )
    raise HTTPException(
        status_code=503,
        detail=(
            "Local Hammer debug not enabled — add HAMMER_OFFICE_DEBUG=1 or HAMMER_OFFICE_HEADLESS=0 "
            "to server/.env, then restart the API (or run .\\4-START-ACCOUNT-DEBUG.ps1)."
        ),
    )


class HammerDebugEmailRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=200)
    dealership: str = Field(default="Debug Motors LLC", max_length=200)
    name: str = Field(default="Jordan Smith", max_length=120)
    address: str = Field(default="1200 Congress Ave, Austin, TX 78701", max_length=400)


@app.get("/debug/hammer-account")
def hammer_account_debug_page() -> FileResponse:
    """Local control panel — watch Chromium fill Hammer Office."""
    _require_non_production_debug()
    path = _SERVER_DIR / "static" / "hammer-account-debug.html"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="hammer-account-debug.html missing")
    return FileResponse(path, media_type="text/html; charset=utf-8")


def _dashboard_asset_version() -> str:
    """Bust browser cache when dashboard HTML/CSS changes."""
    mtimes: list[int] = []
    for name in ("voice-dashboard.html", "voice-dashboard.css"):
        path = _SERVER_DIR / "static" / name
        if path.is_file():
            mtimes.append(int(path.stat().st_mtime))
    return str(max(mtimes)) if mtimes else "1"


def _voice_dashboard_css() -> FileResponse:
    path = _SERVER_DIR / "static" / "voice-dashboard.css"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="voice-dashboard.css missing")
    return FileResponse(
        path,
        media_type="text/css; charset=utf-8",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/debug/voice-dashboard.css")
def voice_dashboard_css_debug() -> FileResponse:
    _require_non_production_debug()
    return _voice_dashboard_css()


@app.get("/debug/voice-dashboard")
def voice_dashboard_page() -> FileResponse:
    """Local voice AI ops dashboard — stats, calls, settings."""
    _require_non_production_debug()
    return _voice_dashboard_html()


@app.get("/api/debug/voice/overview")
async def voice_dashboard_overview_debug() -> dict:
    _require_non_production_debug()
    from voice_dashboard_api import dashboard_overview

    return await dashboard_overview()


@app.get("/api/debug/voice/calls")
async def voice_dashboard_calls_debug(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    _require_non_production_debug()
    from voice_dashboard_api import dashboard_calls

    return await dashboard_calls(limit=limit, offset=offset)


@app.get("/api/debug/voice/calls/{call_id}")
async def voice_dashboard_call_detail_debug(call_id: str) -> dict:
    _require_non_production_debug()
    from voice_dashboard_api import dashboard_call_detail

    return await dashboard_call_detail(call_id)


@app.post("/api/debug/voice/auth")
def voice_dashboard_auth_debug(body: AdminAuthRequest) -> dict:
    _require_non_production_debug()
    if not admin_auth_configured():
        raise HTTPException(
            status_code=503,
            detail="Admin dashboard is not configured — set REALTIME_SALES_ADMIN_SECRET on the server.",
        )
    if not verify_admin_token(body.secret):
        raise HTTPException(status_code=401, detail="Invalid password")
    return {"ok": True}


@app.get("/api/debug/voice/settings")
def voice_dashboard_settings_get_debug(request: Request) -> dict:
    _require_non_production_debug()
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_settings_get

    require_admin_auth(request)
    return dashboard_settings_get()


@app.patch("/api/debug/voice/settings")
async def voice_dashboard_settings_patch_debug(request: Request) -> dict:
    _require_non_production_debug()
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import VoiceSettingsPatch, dashboard_settings_patch

    require_admin_auth(request)
    body = VoiceSettingsPatch.model_validate(await request.json())
    return dashboard_settings_patch(body)


@app.post("/api/debug/voice/settings/reset")
def voice_dashboard_settings_reset_debug(request: Request) -> dict:
    _require_non_production_debug()
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_settings_reset

    require_admin_auth(request)
    return dashboard_settings_reset()


@app.get("/api/debug/voice/elevenlabs/voices")
async def voice_dashboard_elevenlabs_voices_debug(request: Request) -> dict:
    _require_non_production_debug()
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_elevenlabs_voices

    require_admin_auth(request)
    return await dashboard_elevenlabs_voices()


@app.get("/api/debug/voice/elevenlabs/agent")
async def voice_dashboard_elevenlabs_agent_debug(request: Request) -> dict:
    _require_non_production_debug()
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_elevenlabs_agent

    require_admin_auth(request)
    return await dashboard_elevenlabs_agent()


@app.patch("/api/debug/voice/elevenlabs/agent")
async def voice_dashboard_elevenlabs_agent_patch_debug(request: Request) -> dict:
    _require_non_production_debug()
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import AgentVoicePatch, dashboard_elevenlabs_agent_patch

    require_admin_auth(request)
    body = AgentVoicePatch.model_validate(await request.json())
    return await dashboard_elevenlabs_agent_patch(body)


@app.post("/api/debug/voice/elevenlabs/tune")
async def voice_dashboard_elevenlabs_agent_tune_debug(request: Request) -> dict:
    _require_non_production_debug()
    from voice_admin_auth import require_admin_auth
    import elevenlabs_admin

    require_admin_auth(request)
    return await elevenlabs_admin.tune_agent_latency_settings()


@app.get("/api/debug/voice/calendar")
def voice_dashboard_calendar_debug(days: int = Query(14, ge=1, le=60)) -> dict:
    _require_non_production_debug()
    from voice_dashboard_api import dashboard_calendar

    return dashboard_calendar(days=days)


@app.get("/api/debug/voice/knowledge/docs")
def voice_knowledge_docs_debug() -> dict:
    _require_non_production_debug()
    from voice_knowledge_api import list_knowledge_docs

    return list_knowledge_docs(get_retriever())


@app.get("/api/debug/voice/knowledge/doc")
def voice_knowledge_doc_debug(doc_id: str = Query(...)) -> dict:
    _require_non_production_debug()
    from voice_knowledge_api import get_doc_content

    return get_doc_content(get_retriever(), doc_id)


@app.get("/api/debug/voice/knowledge/search")
def voice_knowledge_search_debug(
    q: str = Query(""),
    k: int = Query(8, ge=1, le=20),
) -> dict:
    _require_non_production_debug()
    from voice_knowledge_api import search_knowledge

    return search_knowledge(get_retriever(), q, k=k)


@app.get("/api/debug/voice/knowledge/playbook")
def voice_knowledge_playbook_debug() -> dict:
    _require_non_production_debug()
    from voice_knowledge_api import get_playbook

    return get_playbook(REPO_ROOT)


@app.post("/api/debug/voice/knowledge/playbook/entry")
async def voice_knowledge_playbook_append_debug(request: Request) -> dict:
    _require_non_production_debug()
    from voice_knowledge_api import append_playbook_entry

    body = await request.json()
    result = append_playbook_entry(
        REPO_ROOT,
        title=body.get("title", ""),
        content=body.get("content", ""),
    )
    if result.get("ok"):
        invalidate_realtime_sales_retriever_cache()
    return result


@app.delete("/api/debug/voice/knowledge/playbook/entry/{entry_id}")
def voice_knowledge_playbook_delete_debug(entry_id: str) -> dict:
    _require_non_production_debug()
    from voice_knowledge_api import delete_playbook_entry

    result = delete_playbook_entry(REPO_ROOT, entry_id)
    if result.get("ok"):
        invalidate_realtime_sales_retriever_cache()
    return result


@app.post("/api/debug/voice/knowledge/ingest/upload")
async def voice_knowledge_ingest_upload_debug(
    file: UploadFile = File(...),
    title: str = Form(""),
) -> dict:
    _require_non_production_debug()
    from knowledge_ingest import ingest_hammer_raw_upload

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    result = ingest_hammer_raw_upload(
        REPO_ROOT,
        filename=file.filename or "upload",
        data=data,
        title=title.strip() or None,
    )
    if result.get("ok"):
        invalidate_realtime_sales_retriever_cache()
        get_retriever()
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "Ingest failed"))
    return result


# ── Production admin dashboard (password-protected) ─────────────────────────

def _voice_dashboard_html() -> HTMLResponse:
    path = _SERVER_DIR / "static" / "voice-dashboard.html"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="voice-dashboard.html missing")
    version = _dashboard_asset_version()
    html = path.read_text(encoding="utf-8").replace("{{DASHBOARD_ASSET_V}}", version)
    return HTMLResponse(
        content=html,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/admin/voice/dashboard.css")
def admin_voice_dashboard_css() -> FileResponse:
    from voice_admin_auth import admin_auth_configured

    if not admin_auth_configured():
        raise HTTPException(status_code=404, detail="Not found")
    return _voice_dashboard_css()


@app.get("/admin/voice")
def admin_voice_dashboard_page() -> FileResponse:
    """Password-protected voice ops dashboard — works on production."""
    from voice_admin_auth import admin_auth_configured

    if not admin_auth_configured():
        raise HTTPException(status_code=404, detail="Not found")
    return _voice_dashboard_html()


from voice_admin_auth import AdminAuthRequest, admin_auth_configured, verify_admin_token


@app.post("/api/admin/voice/auth")
def admin_voice_auth(body: AdminAuthRequest) -> dict:
    if not admin_auth_configured():
        raise HTTPException(status_code=404, detail="Not found")
    if not verify_admin_token(body.secret):
        raise HTTPException(status_code=401, detail="Invalid password")
    return {"ok": True}


@app.get("/api/admin/voice/overview")
async def admin_voice_overview(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_overview

    require_admin_auth(request)
    return await dashboard_overview()


@app.get("/api/admin/voice/calls")
async def admin_voice_calls(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_calls

    require_admin_auth(request)
    return await dashboard_calls(limit=limit, offset=offset)


@app.get("/api/admin/voice/calls/{call_id}")
async def admin_voice_call_detail(request: Request, call_id: str) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_call_detail

    require_admin_auth(request)
    return await dashboard_call_detail(call_id)


@app.get("/api/admin/voice/settings")
def admin_voice_settings_get(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_settings_get

    require_admin_auth(request)
    return dashboard_settings_get()


@app.patch("/api/admin/voice/settings")
async def admin_voice_settings_patch(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import VoiceSettingsPatch, dashboard_settings_patch

    require_admin_auth(request)
    body = VoiceSettingsPatch.model_validate(await request.json())
    return dashboard_settings_patch(body)


@app.post("/api/admin/voice/settings/reset")
def admin_voice_settings_reset(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_settings_reset

    require_admin_auth(request)
    return dashboard_settings_reset()


@app.get("/api/admin/voice/elevenlabs/voices")
async def admin_voice_elevenlabs_voices(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_elevenlabs_voices

    require_admin_auth(request)
    return await dashboard_elevenlabs_voices()


@app.get("/api/admin/voice/elevenlabs/agent")
async def admin_voice_elevenlabs_agent(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_elevenlabs_agent

    require_admin_auth(request)
    return await dashboard_elevenlabs_agent()


@app.patch("/api/admin/voice/elevenlabs/agent")
async def admin_voice_elevenlabs_agent_patch(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import AgentVoicePatch, dashboard_elevenlabs_agent_patch

    require_admin_auth(request)
    body = AgentVoicePatch.model_validate(await request.json())
    return await dashboard_elevenlabs_agent_patch(body)


@app.post("/api/admin/voice/elevenlabs/tune")
async def admin_voice_elevenlabs_agent_tune(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    import elevenlabs_admin

    require_admin_auth(request)
    return await elevenlabs_admin.tune_agent_latency_settings()


@app.get("/api/admin/voice/calendar")
def admin_voice_calendar(
    request: Request,
    days: int = Query(14, ge=1, le=60),
) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_dashboard_api import dashboard_calendar

    require_admin_auth(request)
    return dashboard_calendar(days=days)


@app.get("/api/admin/voice/knowledge/docs")
def admin_knowledge_docs(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_knowledge_api import list_knowledge_docs

    require_admin_auth(request)
    return list_knowledge_docs(get_retriever())


@app.get("/api/admin/voice/knowledge/doc")
def admin_knowledge_doc_content(request: Request, doc_id: str = Query(...)) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_knowledge_api import get_doc_content

    require_admin_auth(request)
    return get_doc_content(get_retriever(), doc_id)


@app.get("/api/admin/voice/knowledge/search")
def admin_knowledge_search(
    request: Request,
    q: str = Query(""),
    k: int = Query(8, ge=1, le=20),
) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_knowledge_api import search_knowledge

    require_admin_auth(request)
    return search_knowledge(get_retriever(), q, k=k)


@app.get("/api/admin/voice/knowledge/playbook")
def admin_knowledge_playbook_get(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_knowledge_api import get_playbook

    require_admin_auth(request)
    return get_playbook(REPO_ROOT)


@app.post("/api/admin/voice/knowledge/playbook/entry")
async def admin_knowledge_playbook_append(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_knowledge_api import append_playbook_entry

    require_admin_auth(request)
    body = await request.json()
    result = append_playbook_entry(
        REPO_ROOT,
        title=body.get("title", ""),
        content=body.get("content", ""),
    )
    if result.get("ok"):
        invalidate_realtime_sales_retriever_cache()
    return result


@app.delete("/api/admin/voice/knowledge/playbook/entry/{entry_id}")
def admin_knowledge_playbook_delete(request: Request, entry_id: str) -> dict:
    from voice_admin_auth import require_admin_auth
    from voice_knowledge_api import delete_playbook_entry

    require_admin_auth(request)
    result = delete_playbook_entry(REPO_ROOT, entry_id)
    if result.get("ok"):
        invalidate_realtime_sales_retriever_cache()
    return result


@app.post("/api/admin/voice/knowledge/ingest")
async def admin_knowledge_ingest(request: Request) -> dict:
    from voice_admin_auth import require_admin_auth
    from knowledge_ingest import ingest_hammer_raw_from_text

    require_admin_auth(request)
    body = await request.json()
    result = ingest_hammer_raw_from_text(
        REPO_ROOT,
        filename=body.get("filename", ""),
        markdown_content=body.get("content", ""),
        title=body.get("title") or None,
    )
    if result.get("ok"):
        invalidate_realtime_sales_retriever_cache()
        get_retriever()
    return result


@app.post("/api/admin/voice/knowledge/ingest/upload")
async def admin_knowledge_ingest_upload(
    request: Request,
    file: UploadFile = File(...),
    title: str = Form(""),
) -> dict:
    from voice_admin_auth import require_admin_auth
    from knowledge_ingest import ingest_hammer_raw_upload

    require_admin_auth(request)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    result = ingest_hammer_raw_upload(
        REPO_ROOT,
        filename=file.filename or "upload",
        data=data,
        title=title.strip() or None,
    )
    if result.get("ok"):
        invalidate_realtime_sales_retriever_cache()
        get_retriever()
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "Ingest failed"))
    return result


@app.get("/api/debug/hammer/config")
def hammer_debug_config() -> dict:
    _require_hammer_local_debug()
    from hammer_debug import debug_hammer_config

    return debug_hammer_config()


@app.get("/api/debug/hammer/status")
def hammer_debug_status(email: str = Query(..., min_length=3)) -> dict:
    """Session + approval snapshot while testing voice (same email as capture_lead)."""
    _require_hammer_local_debug()
    from hammer_debug import debug_approval_status, debug_session_status

    return {
        **debug_session_status(email),
        "agreement": debug_approval_status(email),
    }


@app.get("/api/debug/hammer/approval")
def hammer_debug_approval(email: str = Query(..., min_length=3)) -> dict:
    """Check whether I approve was recorded for this email (Zapier or debug Approve)."""
    _require_hammer_local_debug()
    from hammer_debug import debug_approval_status

    return debug_approval_status(email)


@app.post("/api/debug/hammer/approve")
def hammer_debug_approve(body: HammerDebugEmailRequest) -> dict:
    _require_hammer_local_debug()
    from hammer_debug import debug_approve_email

    return debug_approve_email(body.email, dealership=body.dealership)


@app.post("/api/debug/hammer/reset-session")
def hammer_debug_reset_session(email: str = Query(..., min_length=3)) -> dict:
    """Close Chromium and clear in-memory session (use after a freeze or 500)."""
    _require_hammer_local_debug()
    from hammer_office_session import close_hammer_office_session

    close_hammer_office_session(email.strip(), force=True)
    return {"ok": True, "email": email.strip().lower(), "message": "session cleared"}


@app.post("/api/debug/hammer/open-form", response_model=HammerOpenFormResponse)
def hammer_debug_open_form(body: HammerDebugEmailRequest) -> HammerOpenFormResponse:
    _require_hammer_local_debug()
    try:
        result = open_hammer_account_form(
            body.email.strip(),
            dealership_name=body.dealership.strip(),
            display_name=body.dealership.strip(),
            name=body.name.strip(),
        )
    except HammerOfficeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logging.getLogger(__name__).exception("hammer debug open-form failed")
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc
    return HammerOpenFormResponse(
        browser_open=bool(result.get("browser_open")),
        prefilled=list(result.get("prefilled") or []),
        message=str(result.get("message", "")),
    )


@app.post("/api/debug/hammer/fill-field", response_model=HammerFillFieldResponse)
def hammer_debug_fill_field(body: HammerFillFieldRequest) -> HammerFillFieldResponse:
    _require_hammer_local_debug()
    try:
        result = fill_hammer_account_field(body.email.strip(), body.field.strip(), body.value)
    except HammerOfficeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logging.getLogger(__name__).exception("hammer debug fill-field failed")
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc
    return HammerFillFieldResponse(
        field=str(result.get("field", body.field)),
        message=str(result.get("message", "filled")),
        timezone_set=str(result["timezone_set"]) if result.get("timezone_set") else None,
        currency_set=str(result["currency_set"]) if result.get("currency_set") else None,
        billing_country=str(result["billing_country"]) if result.get("billing_country") else None,
        region_code=str(result["region_code"]) if result.get("region_code") else None,
        is_quebec=bool(result["is_quebec"]) if "is_quebec" in result else None,
        tax_field=str(result["tax_field"]) if result.get("tax_field") else None,
        account_created=bool(result.get("account_created")),
        account_url=str(result["account_url"]) if result.get("account_url") else None,
    )


@app.post("/api/debug/hammer/run-sample")
def hammer_debug_run_sample(body: HammerDebugEmailRequest) -> dict:
    _require_hammer_local_debug()
    from hammer_debug import debug_run_sample_flow
    from hammer_office_session import close_hammer_office_session

    try:
        close_hammer_office_session(body.email.strip(), force=True)
        return debug_run_sample_flow(
            body.email,
            dealership=body.dealership,
            name=body.name,
            address=body.address,
        )
    except HammerOfficeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logging.getLogger(__name__).exception("hammer debug run-sample failed")
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc


@app.post("/api/debug/hammer/close")
def hammer_debug_close(email: str = Query(..., min_length=3)) -> dict:
    _require_hammer_local_debug()
    from hammer_office_session import close_hammer_office_session

    close_hammer_office_session(email.strip(), force=True)
    return {"ok": True, "email": email.strip().lower()}


@app.get("/api/debug/openai_key_fingerprint")
def openai_key_fingerprint() -> dict:
    """Local demo helper: which key is used (length + last 4) and whether it came from server/.env."""
    _require_non_production_debug()
    key, src = _openai_api_key_and_source()
    dotenv_path = _SERVER_DIR / ".env"
    lines_named = 0
    if dotenv_path.is_file():
        text = dotenv_path.read_text(encoding="utf-8-sig")
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.split("=", 1)[0].strip() == "OPENAI_API_KEY":
                lines_named += 1
    return {
        "dotenv_path": str(dotenv_path),
        "dotenv_exists": dotenv_path.is_file(),
        "OPENAI_API_KEY_lines_in_dotenv": lines_named,
        "key_source": src,
        "note": "Last non-empty OPENAI_API_KEY= line in server/.env wins over process env.",
        "key_length": len(key),
        "key_prefix7": key[:7] if len(key) >= 7 else key,
        "key_last4": key[-4:] if len(key) >= 4 else key,
    }


@app.post("/api/wiki_search", response_model=WikiSearchResponse)
async def wiki_search(body: WikiSearchRequest) -> WikiSearchResponse:
    chunks = await asyncio.to_thread(_wiki_chunks_for_query, get_retriever(), body.query)
    return WikiSearchResponse(chunks=chunks)


@app.post("/api/wiki_search/batch", response_model=WikiBatchSearchResponse)
async def wiki_search_batch(body: WikiBatchSearchRequest) -> WikiBatchSearchResponse:
    """One round-trip for voice prefetch — retrieval runs off the event loop in a worker thread."""
    results = await asyncio.to_thread(_wiki_batch_sync, body.queries)
    return WikiBatchSearchResponse(results=results)


# ── ElevenLabs Conversational AI ─────────────────────────────────────────────
# These two endpoints replace the OpenAI Realtime voice path when ElevenLabs
# is configured (ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID in .env).
# The browser calls /api/elevenlabs/token to get a signed WebSocket URL, then
# connects via @11labs/client Conversation.startSession({ signedUrl }).
# ElevenLabs calls /api/elevenlabs/llm (OpenAI-compatible) on each user turn;
# this endpoint runs GPT-4o with Hannah's persona, wiki, and all business tools.

@app.get("/api/elevenlabs/token")
async def elevenlabs_token(source: str = Query("", max_length=80)) -> dict:
    """Return a short-lived WebRTC conversation token for browser ElevenLabs sessions."""
    from elevenlabs_agent import handle_elevenlabs_token
    started_at = time.perf_counter()
    try:
        return await handle_elevenlabs_token(get_retriever)
    finally:
        latency_log.info("elevenlabs_token route source=%r elapsed_ms=%s", source, _elapsed_ms(started_at))


@app.get("/api/elevenlabs/prewarm")
async def elevenlabs_prewarm(source: str = Query("", max_length=80)) -> dict:
    """Warm wiki + tool executor before the visitor speaks (hover/click prewarm)."""
    from elevenlabs_agent import prewarm_elevenlabs_session
    started_at = time.perf_counter()
    await prewarm_elevenlabs_session(get_retriever)
    latency_log.info("elevenlabs_prewarm route source=%r elapsed_ms=%s", source, _elapsed_ms(started_at))
    return {"ok": True}


@app.post("/api/elevenlabs/llm")
@app.post("/api/elevenlabs/chat/completions")  # alias: base=.../api/elevenlabs + path=/chat/completions
async def elevenlabs_llm(request: Request) -> StreamingResponse:
    """Custom LLM endpoint called by ElevenLabs on each user turn."""
    from elevenlabs_agent import handle_elevenlabs_llm
    started_at = time.perf_counter()
    body = await request.json()
    latency_log.info(
        "elevenlabs_llm route body_read elapsed_ms=%s messages=%s",
        _elapsed_ms(started_at),
        len(body.get("messages", []) or []),
    )
    return await handle_elevenlabs_llm(body, get_retriever)


@app.post("/api/elevenlabs/call-end")
async def elevenlabs_call_end(request: Request) -> dict:
    """
    ElevenLabs post-call webhook — fires Zapier call summary after each phone/browser call ends.

    Configure in ElevenLabs dashboard → Agents → your agent → Post-call webhook:
      URL: https://hammer-voice-telephony.fly.dev/api/elevenlabs/call-end

    Optionally set ELEVENLABS_WEBHOOK_SECRET (from dashboard) in server env for HMAC validation.
    """
    from elevenlabs_agent import handle_elevenlabs_call_end
    raw_body = await request.body()
    sig_header = request.headers.get("elevenlabs-signature")
    try:
        event = json.loads(raw_body)
    except Exception:
        raise HTTPException(400, "Invalid JSON body")
    return handle_elevenlabs_call_end(raw_body, sig_header, event)


@app.post("/api/chat", response_model=ChatResponse)
def chat(body: ChatRequest) -> ChatResponse:
    q = body.message.strip()
    key = _openai_api_key()
    if not key:
        raise HTTPException(status_code=503, detail="Server missing OPENAI_API_KEY")
    retriever = get_retriever()
    pairs = retriever.top_k(q, k=_top_k())
    history = [{"role": t.role, "text": t.text} for t in (body.history or [])]
    try:
        reply = complete_sales_chat(pairs, q, api_key=key, history=history or None)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"LLM error: {exc}") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    best_score = float(pairs[0][1]) if pairs else 0.0
    if not _is_serverless():
        schedule_after_turn(
            REPO_ROOT,
            user_text=q,
            assistant_text=reply,
            retrieval_best_score=best_score,
            channel="realtime-sales-chat",
            cache_clear=invalidate_realtime_sales_retriever_cache,
        )
    return ChatResponse(reply=reply)


def _deliver_lead_background(zapier_payload: dict[str, str], email: str, dealership: str) -> None:
    """Zapier + Hammer Office prewarm off the voice/HTTP critical path."""
    try:
        post_lead_to_zapier(zapier_payload)
        if email and dealership:
            prewarm_hammer_account_form(email, dealership_name=dealership)
    except Exception as exc:
        print(f"[realtime-sales-demo] async lead delivery failed: {exc}", flush=True)


def _lead_enrich_base_url() -> str:
    host = os.environ.get("VERCEL_PROJECT_PRODUCTION_URL", "").strip() or os.environ.get(
        "VERCEL_URL", ""
    ).strip()
    return f"https://{host}" if host else ""


def _spawn_lead_enrichment(zapier_payload: dict[str, str]) -> None:
    """Kick off HubSpot enrichment without blocking the form response.

    On Vercel the function freezes right after the response returns, so a
    background thread would die before HubSpot's search index catches up.
    Instead we invoke ourselves over HTTP (fresh lambda, up to 60s budget) and
    deliberately don't wait for the response.
    """
    from lead_zapier import approval_callback_secret

    base = _lead_enrich_base_url()
    if not _is_serverless() or not base:
        import threading

        threading.Thread(target=enrich_website_lead, args=(zapier_payload,), daemon=True).start()
        return
    try:
        with httpx.Client(
            timeout=httpx.Timeout(connect=4.0, read=1.0, write=4.0, pool=4.0)
        ) as client:
            client.post(
                f"{base}/api/lead/enrich",
                json=zapier_payload,
                headers={"X-Enrich-Secret": approval_callback_secret()},
            )
    except httpx.ReadTimeout:
        pass  # request delivered; the enrichment lambda is running
    except Exception as exc:
        print(f"[hubspot-lead] could not spawn enrichment: {exc}", flush=True)


@app.post("/api/lead/enrich")
def lead_enrich(payload: dict, request: Request) -> dict:
    """Internal: stamp the Zapier-created deal with lead + ad attribution."""
    from lead_zapier import approval_callback_secret

    secret = approval_callback_secret()
    provided = request.headers.get("X-Enrich-Secret", "")
    if secret and provided != secret:
        raise HTTPException(status_code=403, detail="bad secret")
    enrich_website_lead({k: str(v) for k, v in payload.items() if isinstance(v, (str, int, float))})
    return {"ok": True}


@app.post("/api/lead", response_model=LeadCaptureResponse)
def capture_lead(
    body: LeadCaptureRequest,
    background_tasks: BackgroundTasks,
) -> LeadCaptureResponse:
    """Website lead modal → ZAPIER_WEBSITE_LEAD_WEBHOOK_URL; voice → ZAPIER_LEAD_WEBHOOK_URL."""
    zapier_payload = build_zapier_payload(body)
    channel = lead_channel(body)
    if not lead_webhook_configured(channel):
        env_name = lead_webhook_env_name(channel)
        raise HTTPException(
            status_code=503,
            detail=f"Lead capture is not configured (set {env_name} on the server).",
        )
    # Voice uses async on long-running servers (Fly) for latency. On Vercel serverless,
    # background tasks are often killed after the response — POST to Zapier synchronously.
    async_deliver = (body.deliver_async or channel == "voice") and not _is_serverless()
    email = body.email.strip()
    dealership = (body.dealership_name or "").strip()
    if async_deliver:
        background_tasks.add_task(_deliver_lead_background, zapier_payload, email, dealership)
    else:
        try:
            post_lead_to_zapier(zapier_payload)
        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Zapier webhook returned HTTP {exc.response.status_code}",
            ) from exc
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"Could not deliver lead to Zapier: {exc}") from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Lead capture failed: {exc}") from exc
        if email and dealership:
            try:
                prewarm_hammer_account_form(email, dealership_name=dealership)
            except Exception:
                pass
    if channel == "website":
        # Zapier only creates a bare deal; stamp contact info + Google Ads
        # attribution (gclid/UTMs) onto HubSpot. Runs detached because HubSpot's
        # search index lags ~10-30s and the form response must stay fast.
        _spawn_lead_enrichment(zapier_payload)
    event = str(zapier_payload.get("event", ""))
    agreement_sent = event == "agreement_email_request"
    return LeadCaptureResponse(
        zapier_delivered=True,
        event=event,
        agreement_email_sent=agreement_sent,
        agreement_approval_required=agreement_sent,
    )


@app.post("/api/voice/browser-call-start")
async def browser_call_start(request: Request) -> dict:
    """
    Called by the browser WebRTC demo immediately on ElevenLabs onConnect.

    Registers the session in the admin dashboard so:
    - "Active Now" updates immediately (not waiting for the first user turn)
    - "LIVE ACTIVITY" shows the call_started event straight away
    - The call appears in the calls log the moment it connects

    Body: { conversation_id, scenario?, channel? }
    """
    try:
        data = await request.json()
    except Exception:
        return {"ok": False, "error": "invalid JSON"}

    call_id = str(data.get("conversation_id") or "").strip()
    if not call_id:
        return {"ok": False, "error": "conversation_id required"}

    scenario = str(data.get("scenario") or "hammer").strip().lower()
    channel = str(data.get("channel") or "elevenlabs_browser").strip()

    try:
        from voice_call_summary import VoiceCallLeadAccumulator
        from voice_dashboard_store import append_call_event, get_call, register_active_session, upsert_call_record

        register_active_session(call_id, {"scenario": scenario, "channel": channel})

        # Only emit call_started + upsert if this is genuinely new (browser may
        # retry or the ElevenLabs LLM endpoint may have already registered it).
        if get_call(call_id) is None:
            acc = VoiceCallLeadAccumulator()
            acc.call_id = call_id
            acc.channel = channel
            acc.voice_scenario = scenario
            acc.lead.call_id = call_id
            acc.lead.channel = channel
            upsert_call_record(acc.lead)
            append_call_event(
                call_id=call_id,
                event_type="call_started",
                detail={"scenario": scenario, "channel": channel},
            )
    except Exception as exc:
        logging.getLogger(__name__).exception("browser_call_start persist failed: %s", exc)

    return {"ok": True}


@app.post("/api/voice/call-summary", response_model=VoiceCallSummaryResponse)
def voice_call_summary(body: VoiceCallSummaryRequest) -> VoiceCallSummaryResponse:
    """Browser voice end — post Slack summary via Zapier when contact info was captured."""
    acc = VoiceCallLeadAccumulator()
    acc.merge_from_dict(body.model_dump())
    acc.channel = (body.channel or "browser").strip() or "browser"
    if body.call_id:
        acc.call_id = body.call_id.strip()
    if not acc.ended_at:
        from datetime import datetime, timezone

        acc.ended_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        from voice_dashboard_store import unregister_active_session, upsert_call_record

        upsert_call_record(acc)
        if acc.call_id:
            unregister_active_session(acc.call_id)
    except Exception:
        logging.getLogger(__name__).exception("voice dashboard persist failed")
    if not voice_call_summary_webhook_configured():
        return VoiceCallSummaryResponse(ok=True, posted=False, skipped_reason="webhook_not_configured")
    if not acc.should_post_summary():
        return VoiceCallSummaryResponse(ok=True, posted=False, skipped_reason="no_contact")
    posted = maybe_post_voice_call_summary(acc)
    return VoiceCallSummaryResponse(ok=True, posted=posted, skipped_reason=None if posted else "post_failed")


@app.get("/api/zapier/approval-status", response_model=AgreementApprovalResponse)
def zapier_approval_status(
    email: str = Query(..., min_length=3),
    wait: int = Query(
        0,
        ge=0,
        le=60,
        description="Seconds to poll for Gmail→Zapier lag (capped by AGREEMENT_APPROVAL_POLL_MAX_SECONDS)",
    ),
) -> AgreementApprovalResponse:
    """Voice tool: check if visitor replied I approve to the agreement email (Zap 2 callback)."""
    if not email.strip():
        raise HTTPException(status_code=400, detail="email query parameter is required")
    status = agreement_approval_status(email, wait_seconds=wait)
    approved_at = status.get("approvedAt")
    approved = bool(status.get("approved"))
    if not approved and wait > 0:
        print(
            f"[realtime-sales-demo] approval still pending for {email.strip().lower()} "
            f"(waited {wait}s) — Zap 2 must POST /api/zapier/approval (ngrok when local)",
            flush=True,
        )
    elif approved:
        print(
            f"[realtime-sales-demo] approval ok for {email.strip().lower()}",
            flush=True,
        )
    return AgreementApprovalResponse(
        approved=approved,
        email=str(status.get("email", email.strip().lower())),
        approved_at=str(approved_at) if approved_at else None,
        pending=bool(status.get("pending")),
    )


@app.get("/api/hammer/account-url")
def get_hammer_account_url(email: str = Query(..., min_length=3, max_length=120)) -> dict:
    """Read account_url from the persistent store or local database."""
    from hammer_office_session import account_already_created
    done, url = account_already_created(email)
    return {"email": email, "account_created": done, "account_url": url}


@app.post("/api/hammer/prewarm", response_model=HammerOpenFormResponse)
def hammer_prewarm(body: HammerOpenFormRequest) -> HammerOpenFormResponse:
    """Start Hammer Office browser in the background (after capture_lead, before I approve)."""
    if not hammer_office_configured():
        raise HTTPException(
            status_code=503,
            detail="Hammer Office is not configured (HAMMER_OFFICE_EMAIL / HAMMER_OFFICE_PASSWORD).",
        )
    try:
        result = prewarm_hammer_account_form(
            body.email.strip(),
            dealership_name=body.dealership_name.strip(),
            display_name=body.display_name.strip(),
            name=body.name.strip(),
        )
    except HammerOfficeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return HammerOpenFormResponse(
        browser_open=bool(result.get("ok")),
        prefilled=[],
        message=str(result.get("message", "")),
    )


@app.post("/api/hammer/open-form", response_model=HammerOpenFormResponse)
def hammer_open_form(body: HammerOpenFormRequest) -> HammerOpenFormResponse:
    """Open Hammer Office /accounts/new and pre-fill PHASE A fields; keep browser open for incremental fill."""
    if not hammer_office_configured():
        raise HTTPException(
            status_code=503,
            detail="Hammer Office is not configured (HAMMER_OFFICE_EMAIL / HAMMER_OFFICE_PASSWORD).",
        )
    try:
        result = open_hammer_account_form(
            body.email.strip(),
            dealership_name=body.dealership_name.strip(),
            display_name=body.display_name.strip(),
            name=body.name.strip(),
        )
    except HammerOfficeError as exc:
        msg = str(exc)
        if "not approved" in msg.lower():
            raise HTTPException(status_code=403, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc
    return HammerOpenFormResponse(
        browser_open=bool(result.get("browser_open")),
        prefilled=list(result.get("prefilled") or []),
        message=str(result.get("message", "")),
    )


@app.get("/api/hammer/account-status")
def hammer_account_status(email: str = Query(..., min_length=3)) -> dict:
    """Voice client: recover when fill-field HTTP timed out but Playwright submit succeeded."""
    done, url = account_already_created(email.strip())
    return {
        "email": email.strip().lower(),
        "account_created": done,
        "account_url": url,
    }


@app.post("/api/hammer/fill-field", response_model=HammerFillFieldResponse)
def hammer_fill_field(body: HammerFillFieldRequest) -> HammerFillFieldResponse:
    """Fill one Hammer Office field as the visitor answers (live browser)."""
    if not hammer_office_configured():
        raise HTTPException(status_code=503, detail="Hammer Office is not configured.")
    try:
        result = fill_hammer_account_field(body.email.strip(), body.field.strip(), body.value)
    except HammerOfficeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    tz = result.get("timezone_set")
    return HammerFillFieldResponse(
        field=str(result.get("field", body.field)),
        message=str(result.get("message", "filled")),
        timezone_set=str(tz) if tz else None,
        currency_set=str(result["currency_set"]) if result.get("currency_set") else None,
        billing_country=str(result["billing_country"]) if result.get("billing_country") else None,
        region_code=str(result["region_code"]) if result.get("region_code") else None,
        is_quebec=bool(result["is_quebec"]) if "is_quebec" in result else None,
        tax_field=str(result["tax_field"]) if result.get("tax_field") else None,
        account_created=bool(result.get("account_created")),
        account_url=str(result["account_url"]) if result.get("account_url") else None,
    )


@app.post("/api/hammer/create-account", response_model=HammerCreateAccountResponse)
def hammer_create_account(body: HammerCreateAccountRequest) -> HammerCreateAccountResponse:
    """Voice tool: create Hammer Office account after agreement email I approve is verified."""
    if not hammer_office_configured():
        raise HTTPException(
            status_code=503,
            detail=(
                "Hammer Office account creation is not configured "
                "(set HAMMER_OFFICE_EMAIL and HAMMER_OFFICE_PASSWORD on the server)."
            ),
        )
    dealership = body.dealership_name.strip()
    phone = body.phone.strip() or body.cell_phone.strip()
    address = body.address.strip()
    if address_is_hammer_placeholder(address):
        raise HTTPException(
            status_code=400,
            detail="address must be the dealer's real street address — ask on the call; do not use the form placeholder",
        )
    done, done_url = account_already_created(body.email.strip())
    if done:
        return HammerCreateAccountResponse(
            message="Hammer Office account already created",
            account_url=done_url,
        )
    req = HammerAccountRequest(
        email=body.email.strip(),
        name=body.name.strip(),
        legal_name=body.legal_name.strip() or dealership,
        display_name=body.display_name.strip() or dealership,
        phone=phone,
        cell_phone=body.cell_phone.strip() or phone,
        website=body.website.strip(),
        address=address,
        business_type=body.business_type.strip(),
        timezone=body.timezone.strip(),  # inferred from address in hammer_office when empty
        currency=body.currency.strip(),
        gst_hst=body.gst_hst.strip(),
        qst=body.qst.strip(),
        dealership_name=body.dealership_name.strip(),
        role=body.role.strip(),
        selected_plan=body.selected_plan.strip(),
    )
    try:
        result = create_hammer_account(req)
    except HammerOfficeError as exc:
        msg = str(exc)
        if "not approved" in msg.lower():
            raise HTTPException(status_code=403, detail=msg) from exc
        if "login failed" in msg.lower() or "not authenticated" in msg.lower():
            raise HTTPException(status_code=502, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Hammer Office request failed: {exc}") from exc
    print(
        "[realtime-sales-demo] hammer account:",
        json.dumps(
            {
                "email": req.email,
                "dealership": req.dealership_name,
                "dry_run": result.dry_run,
                "account_url": result.account_url,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return HammerCreateAccountResponse(
        message=result.message,
        account_url=result.account_url,
        dry_run=result.dry_run,
        configured=True,
    )


@app.post("/api/zapier/approval", response_model=AgreementApprovalResponse)
def zapier_approval_callback(
    body: AgreementApprovalRequest,
    x_zapier_secret: str | None = Header(None, alias="X-Zapier-Secret"),
) -> AgreementApprovalResponse:
    """Zap 2 (Gmail 'I approve') should POST here to confirm approval for the voice demo."""
    if not verify_approval_secret(x_zapier_secret):
        raise HTTPException(status_code=401, detail="Invalid Zapier approval callback secret")
    try:
        entry = record_agreement_approval_request(body)
    except Exception as exc:
        print(f"[realtime-sales-demo] zapier approval failed: {exc}", flush=True)
        raise HTTPException(status_code=500, detail=f"Could not record approval: {exc}") from exc
    from agreement_approvals import normalize_email

    email_key = normalize_email(body.email)
    print(
        "[realtime-sales-demo] agreement approved:",
        json.dumps({"email": email_key, **entry}, ensure_ascii=False),
        flush=True,
    )
    approved_at = entry.get("approvedAt")
    return AgreementApprovalResponse(
        approved=bool(entry.get("approved")),
        email=email_key,
        approved_at=str(approved_at) if approved_at else None,
        pending=not bool(entry.get("approved")),
    )


@app.post("/api/zapier/register-pending", response_model=AgreementApprovalResponse)
def zapier_register_pending(
    body: AgreementPendingRegisterRequest,
    x_zapier_secret: str | None = Header(None, alias="X-Zapier-Secret"),
) -> AgreementApprovalResponse:
    """Register pending agreement state (capture_lead sync from Vercel → Fly)."""
    if not verify_approval_secret(x_zapier_secret):
        raise HTTPException(status_code=401, detail="Invalid Zapier approval callback secret")
    from agreement_approvals import normalize_email, register_pending_agreement

    email_key = normalize_email(body.email)
    register_pending_agreement(
        email_key,
        dealership=body.dealership.strip(),
        selected_plan=body.selected_plan.strip(),
    )
    return AgreementApprovalResponse(
        approved=False,
        email=email_key,
        approved_at=None,
        pending=True,
    )


@app.post("/api/zapier/reset-approval", response_model=AgreementApprovalResponse)
def zapier_reset_approval(
    body: AgreementPendingRegisterRequest,
    x_zapier_secret: str | None = Header(None, alias="X-Zapier-Secret"),
) -> AgreementApprovalResponse:
    """Clear pending/approved so the same email can be retested with a fresh agreement."""
    if not verify_approval_secret(x_zapier_secret):
        raise HTTPException(status_code=401, detail="Invalid Zapier approval callback secret")
    from agreement_approvals import normalize_email, reset_agreement_approval

    email_key = normalize_email(body.email)
    reset_agreement_approval(email_key, sync_fly=False)
    return AgreementApprovalResponse(
        approved=False,
        email=email_key,
        approved_at=None,
        pending=False,
    )


class OutboundCallbackRequest(BaseModel):
    phone: str = Field(..., min_length=7, max_length=32)
    consent: bool = Field(..., description="User agreed to receive an AI voice call")


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").strip()
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return ""


async def _parse_twilio_form(request: Request) -> dict[str, str]:
    form = await request.form()
    return {k: str(v) for k, v in form.items()}


def _twilio_request_url(request: Request) -> str:
    """Reconstruct the public HTTPS URL Twilio signed.

    Behind Fly.io (and most reverse proxies) the app sees http:// internally
    while Twilio always signs the https:// URL it called.  Using the raw
    request.url therefore fails signature validation.  We rebuild the URL from
    X-Forwarded-Proto / X-Forwarded-Host if present, then fall back to the
    TELEPHONY_PUBLIC_BASE_URL env var, and finally to the raw request URL.
    """
    proto = request.headers.get("X-Forwarded-Proto", "").strip() or request.headers.get("x-forwarded-proto", "").strip()
    host = request.headers.get("X-Forwarded-Host", "").strip() or request.headers.get("x-forwarded-host", "").strip()
    if not host:
        host = request.headers.get("Host", "").strip()

    if proto and host:
        # Preserve path + query string from the original request
        path_qs = str(request.url).split("://", 1)[-1].split("/", 1)[-1]
        return f"{proto}://{host}/{path_qs}"

    # Fall back to configured public base URL + path+qs
    base = os.environ.get("TELEPHONY_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if base:
        raw = str(request.url)
        path_qs = raw.split("://", 1)[-1].split("/", 1)[-1] if "://" in raw else raw
        return f"{base}/{path_qs}"

    return str(request.url)


_twilio_logger = logging.getLogger("twilio_webhooks")


def _require_twilio_signature(request: Request, params: dict[str, str]) -> None:
    signature = request.headers.get("X-Twilio-Signature", "").strip()
    url = _twilio_request_url(request)
    _twilio_logger.debug("twilio sig check url=%s sig_present=%s", url, bool(signature))
    if not validate_twilio_signature(url, params, signature):
        _twilio_logger.warning("twilio signature FAILED url=%s", url)
        raise HTTPException(status_code=403, detail="Invalid Twilio signature")


@app.post("/api/telephony/callback")
def telephony_callback(body: OutboundCallbackRequest, request: Request) -> dict:
    """Initiate outbound call to user's phone; Twilio bridges to OpenAI SIP on answer."""
    if not outbound_enabled():
        raise HTTPException(
            status_code=503,
            detail="Outbound calling is not configured (set TWILIO_* and TWILIO_OUTBOUND_ENABLED=1 on Fly).",
        )
    sip_uri = _twilio_sip_origination_uri()
    if not sip_uri:
        raise HTTPException(
            status_code=503,
            detail="OpenAI SIP URI not configured (set OPENAI_PROJECT_ID=proj_…).",
        )
    try:
        result = initiate_callback(
            phone=body.phone,
            consent=body.consent,
            client_ip=_client_ip(request),
            sip_uri=sip_uri,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not start outbound call: {exc}") from exc
    return result


@app.get("/api/telephony/callback/{cid}")
def telephony_callback_status(cid: str) -> dict:
    data = callback_status_public(cid.strip())
    if not data:
        raise HTTPException(status_code=404, detail="Callback session not found or expired")
    return data


@app.post("/api/twilio/voice/outbound-bridge")
async def twilio_outbound_bridge(request: Request, cid: str = Query(..., min_length=8)) -> Response:
    """Twilio voice webhook — dial OpenAI SIP when callee answers."""
    started_at = time.perf_counter()
    try:
        if not outbound_enabled():
            raise HTTPException(status_code=503, detail="Outbound calling is not configured")
        params = await _parse_twilio_form(request)
        _require_twilio_signature(request, params)
        rec = get_record(cid.strip())
        if not rec:
            raise HTTPException(status_code=404, detail="Unknown callback session")
        sip_uri = _twilio_sip_origination_uri()
        if not sip_uri:
            raise HTTPException(status_code=503, detail="OpenAI SIP URI not configured")
        call_sid = params.get("CallSid", "").strip()
        if call_sid:
            record_status(cid.strip(), status="answered", twilio_call_sid=call_sid)
        twiml = build_bridge_twiml(phone=rec.phone, sip_uri=sip_uri)
        _twilio_logger.info("outbound-bridge OK cid=%s sip=%s elapsed_ms=%s", cid, sip_uri, _elapsed_ms(started_at))
        return Response(content=twiml, media_type="application/xml")
    except HTTPException:
        raise
    except Exception as exc:
        _twilio_logger.exception("outbound-bridge FAILED cid=%s: %s", cid, exc)
        raise HTTPException(status_code=500, detail=f"Bridge failed: {exc}") from exc


@app.post("/api/twilio/voice/status")
async def twilio_outbound_status(request: Request, cid: str = Query(..., min_length=8)) -> dict[str, bool]:
    """Twilio status callback for outbound UI polling."""
    try:
        params = await _parse_twilio_form(request)
        _require_twilio_signature(request, params)
        status = params.get("CallStatus", "").strip().lower()
        call_sid = params.get("CallSid", "").strip()
        if status:
            record_status(cid.strip(), status=status, twilio_call_sid=call_sid)
            _twilio_logger.info("outbound-status cid=%s status=%s sid=%s", cid, status, call_sid)
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as exc:
        _twilio_logger.exception("outbound-status FAILED cid=%s: %s", cid, exc)
        raise HTTPException(status_code=500, detail=f"Status callback failed: {exc}") from exc


@app.post("/api/twilio/voice/inbound-connect")
async def twilio_inbound_connect(request: Request) -> Response:
    """Twilio Voice URL for the demo phone number — plays disclosure then bridges to OpenAI SIP.

    Configure in Twilio Console → Phone Numbers → your number → "A call comes in":
        Webhook  POST  https://<your-fly-app>.fly.dev/api/twilio/voice/inbound-connect
    """
    started_at = time.perf_counter()
    try:
        params = await _parse_twilio_form(request)
        _require_twilio_signature(request, params)
        sip_uri = _twilio_sip_origination_uri()
        if not sip_uri:
            raise HTTPException(status_code=503, detail="OpenAI SIP URI not configured")
        twiml = build_inbound_connect_twiml(sip_uri=sip_uri)
        _twilio_logger.info(
            "inbound-connect OK from=%s sip=%s disclosure=%s elapsed_ms=%s",
            params.get("From", "?"),
            sip_uri,
            voice_phone_disclosure_enabled(),
            _elapsed_ms(started_at),
        )
        return Response(content=twiml, media_type="application/xml")
    except HTTPException:
        raise
    except Exception as exc:
        _twilio_logger.exception("inbound-connect FAILED: %s", exc)
        raise HTTPException(status_code=500, detail=f"Inbound connect failed: {exc}") from exc


@app.post("/api/realtime/sip-webhook")
async def realtime_sip_webhook(request: Request) -> dict[str, bool]:
    """OpenAI `realtime.call.incoming` webhook — accept SIP calls and run tool sideband."""
    webhook_secret = os.environ.get("OPENAI_WEBHOOK_SECRET", "").strip()
    key = _openai_api_key()
    if not webhook_secret or not key:
        raise HTTPException(
            status_code=503,
            detail="Telephony not configured (set OPENAI_API_KEY and OPENAI_WEBHOOK_SECRET).",
        )
    body = await request.body()
    try:
        service = get_sip_service(
            api_key=key,
            webhook_secret=webhook_secret,
            get_retriever=get_retriever,
        )
        event = service.unwrap_webhook(body, dict(request.headers))
    except InvalidWebhookSignatureError as exc:
        raise HTTPException(status_code=400, detail="Invalid webhook signature") from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Webhook error: {exc}") from exc
    if getattr(event, "type", None) == "realtime.call.incoming":
        # Await accept before 200 — matches OpenAI/Twilio SIP guide; sideband runs in background.
        await handle_incoming_call_safe(service, event)
    return {"ok": True}


@app.post("/api/realtime/session")
async def realtime_session() -> Response:
    try:
        return await _mint_realtime_client_secret()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Realtime session failed ({type(exc).__name__}): {exc}",
        ) from exc


@app.post("/api/realtime/webrtc")
async def realtime_webrtc_proxy(request: Request) -> Response:
    """Proxy browser WebRTC SDP to OpenAI (unified /v1/realtime/calls). Avoids ek_ expiry issues."""
    key = _openai_api_key()
    if not key:
        raise HTTPException(status_code=503, detail="Server missing OPENAI_API_KEY")
    sdp_bytes = await request.body()
    if not sdp_bytes.strip():
        raise HTTPException(status_code=400, detail="SDP offer body is required")
    if not sdp_bytes.lstrip().startswith(b"v="):
        raise HTTPException(status_code=400, detail="SDP offer body must start with v=")
    session_json = json.dumps(_realtime_voice_session_dict(), ensure_ascii=False)
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            # Match OpenAI unified WebRTC: multipart with plain form fields (not file uploads).
            r = await client.post(
                OPENAI_REALTIME_CALLS_URL,
                headers={"Authorization": f"Bearer {key}"},
                data={"session": session_json},
                files={
                    "sdp": (None, sdp_bytes, "application/sdp"),
                },
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach OpenAI: {exc}") from exc
    if r.status_code >= 400:
        body = r.text[:2000]
        detail = _openai_error_detail(body)
        if "insufficient_quota" in body:
            raise HTTPException(
                status_code=402,
                detail=(
                    "OpenAI API quota exceeded for this deployment's API key. "
                    "Add billing or credits at https://platform.openai.com/settings/organization/billing "
                    "then redeploy Vercel production."
                ),
            )
        raise HTTPException(status_code=502, detail=detail)
    answer = r.content
    if answer.lstrip().startswith(b"{"):
        raise HTTPException(
            status_code=502,
            detail=f"OpenAI returned JSON instead of SDP: {answer[:500]!r}",
        )
    return Response(content=answer, media_type="application/sdp")


def _realtime_voice_session_dict() -> dict:
    from realtime_voice_config import realtime_audio_output

    model = os.environ.get("REALTIME_SALES_MODEL", "gpt-realtime-2").strip()
    return {
        "type": "realtime",
        "model": model,
        "audio": {
            "output": realtime_audio_output(),
        },
    }


async def _mint_realtime_client_secret() -> Response:
    key = _openai_api_key()
    if not key:
        raise HTTPException(status_code=503, detail="Server missing OPENAI_API_KEY")

    payload: dict = {"session": _realtime_voice_session_dict()}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                OPENAI_URL,
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach OpenAI (network): {exc}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Unexpected error calling OpenAI client_secrets: {exc}",
        ) from exc

    if r.status_code >= 400:
        body = r.text[:2000]
        if "insufficient_quota" in body:
            raise HTTPException(
                status_code=402,
                detail=(
                    "OpenAI API quota exceeded for this deployment's API key. "
                    "Add billing or credits at https://platform.openai.com/settings/organization/billing "
                    "then redeploy Vercel production."
                ),
            )
        raise HTTPException(status_code=502, detail=body)
    try:
        data = r.json()
    except ValueError as exc:
        snippet = (r.text or "")[:800]
        raise HTTPException(
            status_code=502,
            detail=f"OpenAI returned non-JSON (status {r.status_code}): {snippet}",
        ) from exc
    if "value" not in data:
        raise HTTPException(status_code=502, detail="OpenAI response missing ephemeral secret")
    try:
        body = json.dumps(data, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not serialize OpenAI client_secrets JSON: {exc}",
        ) from exc
    return Response(
        content=body.encode("utf-8"),
        media_type="application/json; charset=utf-8",
    )


_EMAIL_ASSETS_DIR = _SERVER_DIR / "static" / "email"
if _EMAIL_ASSETS_DIR.is_dir():
    app.mount("/email", StaticFiles(directory=str(_EMAIL_ASSETS_DIR)), name="email_assets")

if not _is_serverless() and (WEB_DIST / "index.html").is_file():
    # Do NOT mount StaticFiles at "/" — that handler rejects POST and returns 405 for
    # /api/chat (the browser hits the same origin when using the built SPA). Serve
    # Vite output explicitly: /assets/* static files, everything else GET → index.html.
    _assets = WEB_DIST / "assets"
    if _assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(_assets)), name="spa_assets")

    @app.get("/")
    def spa_index() -> FileResponse:
        return FileResponse(WEB_DIST / "index.html")

    @app.get("/{full_path:path}")
    def spa_history_fallback(full_path: str) -> FileResponse:
        """Deep links / refresh: serve real files under dist/ when present, else SPA shell."""
        candidate = (WEB_DIST / full_path).resolve()
        root = WEB_DIST.resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            return FileResponse(WEB_DIST / "index.html")
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(WEB_DIST / "index.html")

else:

    @app.get("/")
    def dev_stub() -> dict:
        return {
            "message": "API only — run Vite in web/ (npm run dev) or build (npm run build) then restart server.",
            "health": "/api/health",
        }
