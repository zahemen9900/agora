"""Source upload and metadata endpoints for task-attached files."""

from __future__ import annotations

from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from api.auth import AuthenticatedUser, get_current_user, require_scope
from api.models import (
    SourceUploadCompleteRequest,
    SourceUploadInitRequest,
    SourceUploadInitResponse,
    TaskSourceRecord,
    TaskSourceResponse,
)
from api.source_storage import (
    SourceStorageService,
    build_source_content_path,
    build_source_id,
    is_supported_source_file,
)
from api.store import TaskStore, get_store
from api.store_local import LocalTaskStore
from api.config import settings

router = APIRouter(prefix="/sources", tags=["sources"])
CurrentUser = AuthenticatedUser
_store: TaskStore | LocalTaskStore | None = None


def get_task_store() -> TaskStore | LocalTaskStore:
    global _store
    if _store is None:
        _store = get_store(
            settings.gcs_bucket if settings.gcs_bucket and settings.google_cloud_project else None,
            local_data_dir=settings.local_data_dir,
        )
    return _store


def _to_source_record(raw_source: dict[str, object], *, workspace_id: str) -> TaskSourceRecord:
    source = TaskSourceRecord.model_validate(raw_source)
    if source.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="Source not found")
    return source


@router.post("/upload-init", response_model=SourceUploadInitResponse)
@router.post("/upload-init/", response_model=SourceUploadInitResponse, include_in_schema=False)
async def upload_init(
    request: SourceUploadInitRequest,
    user: AuthenticatedUser = Depends(get_current_user),
) -> SourceUploadInitResponse:
    require_scope(user, "tasks:write")
    if request.size_bytes > settings.source_max_file_bytes:
        raise HTTPException(
            status_code=422,
            detail=f"Attached files must be at most {settings.source_max_file_bytes // (1024 * 1024)} MB.",
        )
    if not is_supported_source_file(filename=request.filename, mime_type=request.mime_type):
        raise HTTPException(
            status_code=422,
            detail=(
                "Unsupported file type. Allowed types: .py, .ts, .tsx, .js, .jsx, .json, "
                ".md, .txt, .csv, .tsv, .yaml, .yml, .xlsx, .xls, .xlsb, .parquet, "
                ".pdf, .png, .jpg, .jpeg, .webp, .gif."
            ),
        )
    store = get_task_store()
    source_id = build_source_id(
        workspace_id=user.workspace_id,
        display_name=request.filename,
        mime_type=request.mime_type,
        size_bytes=request.size_bytes,
    )
    storage = SourceStorageService(task_store=store)
    record = storage.build_source_record(
        workspace_id=user.workspace_id,
        created_by=user.user_id or f"api_key:{user.api_key_id}",
        source_id=source_id,
        display_name=request.filename,
        mime_type=request.mime_type,
        size_bytes=request.size_bytes,
    )
    return await storage.create_upload_session(workspace_id=user.workspace_id, source=record)


@router.put("/{source_id}/upload-bytes")
async def upload_bytes(
    source_id: str,
    request: Request,
    user: AuthenticatedUser = Depends(get_current_user),
) -> dict[str, str]:
    """Authenticated upload fallback when direct signed uploads are unavailable."""

    require_scope(user, "tasks:write")
    store = get_task_store()
    storage = SourceStorageService(task_store=store)
    raw_source = await store.get_source(user.workspace_id, source_id)
    if raw_source is None:
        raise HTTPException(status_code=404, detail="Source not found")
    source = _to_source_record(raw_source, workspace_id=user.workspace_id)
    payload = await request.body()
    digest = await storage.write_upload_bytes(source=source, data=payload)
    return {"source_id": source_id, "sha256": digest}


@router.post("/{source_id}/upload-complete", response_model=TaskSourceResponse)
@router.post(
    "/{source_id}/upload-complete/",
    response_model=TaskSourceResponse,
    include_in_schema=False,
)
async def upload_complete(
    source_id: str,
    request: SourceUploadCompleteRequest,
    user: AuthenticatedUser = Depends(get_current_user),
) -> TaskSourceResponse:
    require_scope(user, "tasks:write")
    store = get_task_store()
    raw_source = await store.get_source(user.workspace_id, source_id)
    if raw_source is None:
        raise HTTPException(status_code=404, detail="Source not found")
    source = _to_source_record(raw_source, workspace_id=user.workspace_id)
    storage = SourceStorageService(task_store=store)
    try:
        completed = await storage.mark_upload_complete(
            workspace_id=user.workspace_id,
            source=source,
            sha256=request.sha256,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    response = TaskSourceResponse.model_validate(completed.model_dump(mode="json"))
    response.source_url = build_source_content_path(response.source_id)
    return response


@router.get("/{source_id}", response_model=TaskSourceResponse)
@router.get("/{source_id}/", response_model=TaskSourceResponse, include_in_schema=False)
async def get_source(
    source_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
) -> TaskSourceResponse:
    require_scope(user, "tasks:read")
    store = get_task_store()
    raw_source = await store.get_source(user.workspace_id, source_id)
    if raw_source is None:
        raise HTTPException(status_code=404, detail="Source not found")
    source = _to_source_record(raw_source, workspace_id=user.workspace_id)
    response = TaskSourceResponse.model_validate(source.model_dump(mode="json"))
    if source.kind == "url" and response.source_url:
        parsed = urlparse(response.source_url)
        response.source_url = parsed.geturl()
    else:
        response.source_url = build_source_content_path(response.source_id)
    return response


@router.get("/{source_id}/content")
@router.get("/{source_id}/content/", include_in_schema=False)
async def get_source_content(
    source_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
) -> Response:
    require_scope(user, "tasks:read")
    store = get_task_store()
    raw_source = await store.get_source(user.workspace_id, source_id)
    if raw_source is None:
        raise HTTPException(status_code=404, detail="Source not found")
    source = _to_source_record(raw_source, workspace_id=user.workspace_id)
    storage = SourceStorageService(task_store=store)
    payload = await storage.read_source_bytes(source)
    return Response(
        content=payload,
        media_type=source.mime_type,
        headers={
            "Content-Disposition": f'inline; filename="{source.display_name}"',
            "Cache-Control": "private, max-age=3600",
        },
    )
