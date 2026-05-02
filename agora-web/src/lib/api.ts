const API_URL = import.meta.env.VITE_AGORA_API_URL ?? "/api";

import type {
  ApiKeyCreateResponse,
  ApiKeyMetadataResponse,
  AuthMeResponse,
  BenchmarkCatalogEntry as GeneratedBenchmarkCatalogEntry,
  BenchmarkCatalogResponse as GeneratedBenchmarkCatalogResponse,
  BenchmarkCostEstimateResponse as GeneratedBenchmarkCostEstimateResponse,
  BenchmarkDetailResponse as GeneratedBenchmarkDetailResponse,
  BenchmarkDomainPrompt as GeneratedBenchmarkDomainPrompt,
  BenchmarkItemEventsResponse as GeneratedBenchmarkItemEventsResponse,
  BenchmarkItemResponse as GeneratedBenchmarkItemResponse,
  BenchmarkPromptTemplate as GeneratedBenchmarkPromptTemplate,
  BenchmarkPromptTemplatesResponse as GeneratedBenchmarkPromptTemplatesResponse,
  BenchmarkRunRequest as GeneratedBenchmarkRunRequest,
  BenchmarkRunResponse as GeneratedBenchmarkRunResponse,
  BenchmarkRunStatusResponse as GeneratedBenchmarkRunStatusResponse,
  BenchmarkSummaryResponse as GeneratedBenchmarkSummaryResponse,
  DeliberationResultResponse,
  DeliberationRuntimeConfigResponse as GeneratedDeliberationRuntimeConfigResponse,
  ModelTelemetryResponse as GeneratedModelTelemetryResponse,
  RuntimeModelOptionResponse as GeneratedRuntimeModelOptionResponse,
  RuntimeTierConfigResponse as GeneratedRuntimeTierConfigResponse,
  TaskCreateResponse,
  TaskEvent,
  TaskStatusResponse,
} from "./api.generated";
import type {
  ReasoningPresetState,
  RuntimeTierModelOverridesPayload,
} from "./deliberationConfig";

export type {
  ApiKeyCreateResponse,
  ApiKeyMetadataResponse,
  ApiKeyScopeName,
  AuthMethodName,
  AuthMeResponse,
  FeatureFlagsResponse,
  MechanismName,
  PaymentStatusName,
  PrincipalResponse,
  TaskStatusName,
  TaskCreateResponse,
  TaskEvent,
  TaskStatusResponse,
  WorkspaceResponse,
  DeliberationResultResponse,
} from "./api.generated";

interface StreamTicketResponse {
  ticket: string;
  expires_at: string;
}

export type BenchmarkSummary = GeneratedBenchmarkSummaryResponse;

export type BenchmarkDomainName = "math" | "factual" | "reasoning" | "code" | "creative" | "demo";
export type BenchmarkPromptSourceName = "template" | "custom";

export type BenchmarkDomainPromptPayload = Partial<GeneratedBenchmarkDomainPrompt> & {
  prompt?: string | null;
  source?: BenchmarkPromptSourceName | null;
};

export type BenchmarkCostEstimatePayload = GeneratedBenchmarkCostEstimateResponse;
export type ModelTelemetryPayload = GeneratedModelTelemetryResponse;

export interface BenchmarkStagePayload {
  runs?: Array<Record<string, unknown>>;
  summary?: BenchmarkSummary;
}

export interface BenchmarkDemoReport {
  artifact?: string;
  status?: string;
  final_status?: string;
  target?: string;
  query?: string;
  mechanism?: string;
  agent_count?: number;
  stakes?: number;
  started_at?: string;
  completed_at?: string;
  run_summary?: Record<string, unknown>;
  tx_summary?: Record<string, unknown>;
  acceptance_checks?: Record<string, unknown>;
  run_result?: Record<string, unknown>;
  status_after_run?: Record<string, unknown>;
  status_after_pay?: Record<string, unknown>;
}

export type RuntimeModelOptionPayload = GeneratedRuntimeModelOptionResponse;
export type RuntimeTierConfigPayload = GeneratedRuntimeTierConfigResponse;
export type DeliberationRuntimeConfigPayload = GeneratedDeliberationRuntimeConfigResponse & {
  default_reasoning_presets: ReasoningPresetState;
};

export interface BenchmarkPayload {
  runs?: Array<Record<string, unknown>>;
  summary?: BenchmarkSummary;
  pre_learning?: BenchmarkStagePayload;
  post_learning?: BenchmarkStagePayload;
  learning_updates?: BenchmarkStagePayload;
  generated_at?: string;
  demo_report?: BenchmarkDemoReport;
}

export interface AuthConfigPayload {
  workos_client_id: string;
  workos_authkit_domain: string;
  auth_issuer: string;
  auth_audience: string;
  auth_jwks_url: string;
}

export type BenchmarkRunStatusName = "queued" | "running" | "completed" | "failed";

export type BenchmarkRunStatusPayload = GeneratedBenchmarkRunStatusResponse;
export type BenchmarkCatalogEntry = GeneratedBenchmarkCatalogEntry;
export type BenchmarkCatalogPayload = GeneratedBenchmarkCatalogResponse;

export type BenchmarkRunRequestPayload = Partial<GeneratedBenchmarkRunRequest> & {
  domain_prompts?: Partial<Record<BenchmarkDomainName, BenchmarkDomainPromptPayload>>;
  reasoning_presets?: Partial<ReasoningPresetState>;
  tier_model_overrides?: RuntimeTierModelOverridesPayload;
};

export type BenchmarkRunResponsePayload = GeneratedBenchmarkRunResponse;
export type BenchmarkPromptTemplatePayload = GeneratedBenchmarkPromptTemplate;
export type BenchmarkPromptTemplatesPayload = GeneratedBenchmarkPromptTemplatesResponse & {
  domains: Record<BenchmarkDomainName, GeneratedBenchmarkPromptTemplate[]>;
};
export type BenchmarkDetailPayload = GeneratedBenchmarkDetailResponse;
export type BenchmarkItemPayload = GeneratedBenchmarkItemResponse;
export type BenchmarkItemEventsPayload = GeneratedBenchmarkItemEventsResponse;

export interface StreamHandle {
  close: () => void;
}

export type AccessTokenSupplier = () => Promise<string | null>;

const STREAM_MAX_RECONNECT_ATTEMPTS = 6;
const STREAM_RECONNECT_BASE_DELAY_MS = 500;

export class ApiRequestError extends Error {
  status: number;
  detail: unknown;
  path: string;

  constructor(status: number, message: string, path: string, detail: unknown = null) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.detail = detail;
    this.path = path;
  }
}

function authHeaders(token: string | null): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, init);
  if (!response.ok) {
    const raw = await response.text();
    let detail: unknown = null;

    if (raw) {
      try {
        detail = JSON.parse(raw) as unknown;
      } catch {
        detail = raw;
      }
    }

    const detailMessage = (
      typeof detail === "object"
      && detail !== null
      && "detail" in detail
      && typeof (detail as { detail?: unknown }).detail === "string"
    )
      ? (detail as { detail: string }).detail
      : null;

    const message = detailMessage ?? (raw || `Request failed: ${response.status}`);
    throw new ApiRequestError(response.status, message, path, detail);
  }
  return (await response.json()) as T;
}

export async function submitTask(
  taskText: string,
  agentCount: number,
  stakes: number,
  mechanismOverride: "debate" | "vote" | "delphi" | null,
  reasoningPresets: Partial<ReasoningPresetState>,
  tierModelOverrides: RuntimeTierModelOverridesPayload | undefined,
  token: string | null,
): Promise<TaskCreateResponse> {
  return requestJson<TaskCreateResponse>("/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify({
      task: taskText,
      agent_count: agentCount,
      stakes,
      mechanism_override: mechanismOverride,
      allow_offline_fallback: true,
      reasoning_presets: reasoningPresets,
      tier_model_overrides: tierModelOverrides,
    }),
  });
}

export async function listTasks(token: string | null): Promise<TaskStatusResponse[]> {
  return requestJson<TaskStatusResponse[]>("/tasks", {
    headers: authHeaders(token),
  });
}

export async function getTask(
  taskId: string,
  token: string | null,
  detailed = false,
): Promise<TaskStatusResponse> {
  return requestJson<TaskStatusResponse>(
    `/tasks/${taskId}?detailed=${detailed ? "true" : "false"}`,
    {
      headers: authHeaders(token),
    },
  );
}

export async function runTask(taskId: string, token: string | null): Promise<DeliberationResultResponse> {
  return requestJson<DeliberationResultResponse>(`/tasks/${taskId}/run`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

export async function startTaskRun(taskId: string, token: string | null): Promise<TaskStatusResponse> {
  return requestJson<TaskStatusResponse>(`/tasks/${taskId}/run-async`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

export async function releaseTaskPayment(
  taskId: string,
  token: string | null,
): Promise<{ released: boolean; tx_hash: string }> {
  return requestJson<{ released: boolean; tx_hash: string }>(`/tasks/${taskId}/pay`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

export async function getBenchmarks(
  token: string | null,
  includeDemo = true,
  overviewMode: "latest" | "aggregate_recent" | "aggregate_all" = "latest",
): Promise<BenchmarkPayload> {
  const params = new URLSearchParams();
  if (includeDemo) {
    params.set("include_demo", "true");
  }
  if (overviewMode !== "latest") {
    params.set("aggregate", "true");
    params.set("aggregate_window", overviewMode === "aggregate_all" ? "all" : "recent_20");
  }
  const path = params.size > 0 ? `/benchmarks?${params.toString()}` : "/benchmarks";
  return requestJson<BenchmarkPayload>(path, {
    headers: authHeaders(token),
  });
}

export async function getAuthMe(token: string): Promise<AuthMeResponse> {
  return requestJson<AuthMeResponse>("/auth/me", {
    headers: authHeaders(token),
  });
}

export async function getAuthConfig(): Promise<AuthConfigPayload> {
  return requestJson<AuthConfigPayload>("/auth/config");
}

export async function listApiKeys(token: string): Promise<ApiKeyMetadataResponse[]> {
  return requestJson<ApiKeyMetadataResponse[]>("/api-keys", {
    headers: authHeaders(token),
  });
}

export async function createApiKey(
  token: string,
  name: string,
): Promise<ApiKeyCreateResponse> {
  return requestJson<ApiKeyCreateResponse>("/api-keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify({ name }),
  });
}

export async function revokeApiKey(
  token: string,
  keyId: string,
): Promise<ApiKeyMetadataResponse> {
  return requestJson<ApiKeyMetadataResponse>(`/api-keys/${keyId}/revoke`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

export async function getBenchmarkCatalog(
  token: string | null,
  limit = 25,
): Promise<BenchmarkCatalogPayload> {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 25;
  return requestJson<BenchmarkCatalogPayload>(`/benchmarks/catalog?limit=${normalizedLimit}`, {
    headers: authHeaders(token),
  });
}

export async function getBenchmarkPromptTemplates(
  token: string | null,
): Promise<BenchmarkPromptTemplatesPayload> {
  return requestJson<BenchmarkPromptTemplatesPayload>("/benchmarks/prompt-templates", {
    headers: authHeaders(token),
  });
}

export async function getDeliberationRuntimeConfig(
  token: string | null,
): Promise<DeliberationRuntimeConfigPayload> {
  return requestJson<DeliberationRuntimeConfigPayload>("/benchmarks/runtime-config", {
    headers: authHeaders(token),
  });
}

export async function getBenchmarkDetail(
  token: string | null,
  benchmarkId: string,
): Promise<BenchmarkDetailPayload> {
  return requestJson<BenchmarkDetailPayload>(`/benchmarks/${encodeURIComponent(benchmarkId)}`, {
    headers: authHeaders(token),
  });
}

export async function getBenchmarkItem(
  token: string | null,
  benchmarkId: string,
  itemId: string,
): Promise<BenchmarkItemPayload> {
  return requestJson<BenchmarkItemPayload>(
    `/benchmarks/${encodeURIComponent(benchmarkId)}/items/${encodeURIComponent(itemId)}`,
    {
      headers: {
        ...authHeaders(token),
      },
    },
  );
}

export async function getBenchmarkItemEvents(
  token: string | null,
  benchmarkId: string,
  itemId: string,
): Promise<BenchmarkItemEventsPayload> {
  return requestJson<BenchmarkItemEventsPayload>(
    `/benchmarks/${encodeURIComponent(benchmarkId)}/items/${encodeURIComponent(itemId)}/events`,
    {
      headers: {
        ...authHeaders(token),
      },
    },
  );
}

export async function triggerBenchmarkRun(
  token: string,
  payload: BenchmarkRunRequestPayload = {},
): Promise<BenchmarkRunResponsePayload> {
  return requestJson<BenchmarkRunResponsePayload>("/benchmarks/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify(payload),
  });
}

export async function getBenchmarkRunStatus(
  token: string,
  runId: string,
): Promise<BenchmarkRunStatusPayload> {
  return requestJson<BenchmarkRunStatusPayload>(`/benchmarks/runs/${runId}`, {
    headers: authHeaders(token),
  });
}

export async function stopBenchmarkRun(
  token: string,
  runId: string,
): Promise<BenchmarkRunStatusPayload> {
  return requestJson<BenchmarkRunStatusPayload>(`/benchmarks/runs/${runId}/stop`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

export async function streamBenchmarkRun(
  runId: string,
  tokenSupplier: AccessTokenSupplier,
  onEvent: (event: TaskEvent) => void,
): Promise<StreamHandle> {
  const eventTypes = [
    "queued",
    "started",
    "domain_progress",
    "mechanism_selected",
    "agent_output",
    "agent_output_delta",
    "cross_examination",
    "cross_examination_delta",
    "delphi_feedback",
    "delphi_finalize",
    "thinking_delta",
    "usage_delta",
    "convergence_update",
    "mechanism_switch",
    "quorum_reached",
    "provider_retrying",
    "artifact_created",
    "failed",
    "error",
    "complete",
  ];

  let source: EventSource | null = null;
  let closed = false;
  let sawTerminalEvent = false;
  let reconnectAttempts = 0;
  let reconnectTimer: number | null = null;
  const seenSignatures = new Set<string>();

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const closeSource = () => {
    if (source) {
      source.close();
      source = null;
    }
  };

  const emitStreamError = (message: string) => {
    onEvent({ event: "error", data: { message }, timestamp: null });
  };

  const requestStreamTicket = async (): Promise<StreamTicketResponse> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await tokenSupplier();
      try {
        return await requestJson<StreamTicketResponse>(`/benchmarks/runs/${runId}/stream-ticket`, {
          method: "POST",
          headers: authHeaders(token),
        });
      } catch (error) {
        lastError = error;
        if (error instanceof ApiRequestError && error.status === 401 && attempt === 0) {
          continue;
        }
        throw error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error("Failed to request benchmark stream ticket");
  };

  const scheduleReconnect = (reason: string) => {
    if (closed || sawTerminalEvent) {
      return;
    }
    closeSource();
    reconnectAttempts += 1;
    if (reconnectAttempts > STREAM_MAX_RECONNECT_ATTEMPTS) {
      emitStreamError(`Benchmark stream disconnected: ${reason}`);
      return;
    }
    const delayMs = Math.min(8_000, STREAM_RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1));
    clearReconnectTimer();
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const handleEventMessage = (eventType: string, event: Event) => {
    if (!hasStringMessageData(event)) {
      if (eventType === "error") {
        // Native EventSource transport errors also surface as an "error" event
        // without payload data. Let `source.onerror` own reconnect behavior.
        return;
      }
      emitStreamError(`Benchmark stream payload missing data for ${eventType}`);
      return;
    }
    const rawData = event.data.trim();
    if (!rawData) {
      if (eventType === "error") {
        // Treat empty error payloads as transport noise instead of terminal run failures.
        return;
      }
      emitStreamError(`Benchmark stream payload missing data for ${eventType}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      if (eventType === "error") {
        sawTerminalEvent = true;
        closeSource();
        clearReconnectTimer();
        onEvent({
          event: "error",
          data: { message: rawData },
          timestamp: null,
        });
        return;
      }
      emitStreamError(`Benchmark stream payload parse failure for ${eventType}`);
      return;
    }
    const normalized = normalizeStreamEventPayload(parsed);
    if (!normalized) {
      if (eventType === "error") {
        sawTerminalEvent = true;
        closeSource();
        clearReconnectTimer();
      }
      emitStreamError(`Benchmark stream payload shape mismatch for ${eventType}`);
      return;
    }
    const signature = eventSignature(eventType, normalized.payload, normalized.timestamp);
    if (seenSignatures.has(signature)) {
      return;
    }
    seenSignatures.add(signature);
    onEvent({
      event: eventType,
      data: normalized.payload,
      timestamp: normalized.timestamp,
    });
    if (eventType === "complete" || eventType === "failed" || eventType === "error") {
      sawTerminalEvent = true;
      closeSource();
      clearReconnectTimer();
    }
  };

  const connect = async () => {
    if (closed || sawTerminalEvent) {
      return;
    }
    let ticketResponse: StreamTicketResponse;
    try {
      ticketResponse = await requestStreamTicket();
    } catch (error) {
      const message =
        error instanceof ApiRequestError ? error.message : "Failed to request benchmark stream ticket";
      scheduleReconnect(message);
      return;
    }

    const url = new URL(`${API_URL}/benchmarks/runs/${runId}/stream`, window.location.origin);
    url.searchParams.set("ticket", ticketResponse.ticket);

    closeSource();
    source = new EventSource(url.toString());
    for (const eventType of eventTypes) {
      source.addEventListener(eventType, (event) => {
        handleEventMessage(eventType, event);
      });
    }
    source.onerror = () => {
      if (closed || sawTerminalEvent) {
        return;
      }
      scheduleReconnect("connection error");
    };
    reconnectAttempts = 0;
  };

  await connect();

  return {
    close: () => {
      closed = true;
      clearReconnectTimer();
      closeSource();
    },
  };
}

export async function verifyMerkleRoot(
  transcriptHashes: string[],
  expectedRoot: string | null,
): Promise<boolean> {
  if (!expectedRoot) {
    return false;
  }
  const recomputed = await buildMerkleRoot(transcriptHashes);
  return recomputed === expectedRoot;
}

export async function buildMerkleRoot(transcriptHashes: string[]): Promise<string> {
  if (transcriptHashes.length === 0) {
    return sha256Hex("");
  }

  let layer = [...transcriptHashes];
  while (layer.length > 1) {
    const nextLayer: string[] = [];
    for (let index = 0; index < layer.length; index += 2) {
      const left = layer[index];
      const right = layer[index + 1] ?? left;
      nextLayer.push(await sha256Hex(left + right));
    }
    layer = nextLayer;
  }
  return layer[0];
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeStreamEventPayload(
  rawPayload: unknown,
): { payload: Record<string, unknown>; timestamp: string | null } | null {
  const root = asRecord(rawPayload);
  if (!root) {
    return null;
  }

  const timestamp = typeof root.timestamp === "string" ? root.timestamp : null;

  // New envelope shape from backend stream endpoint.
  const envelopePayload = asRecord(root.payload);
  if (envelopePayload) {
    return { payload: envelopePayload, timestamp };
  }

  // Legacy envelope shape fallback.
  const legacyPayload = asRecord(root.data);
  if (legacyPayload && "timestamp" in root) {
    return { payload: legacyPayload, timestamp };
  }

  // Older direct event payloads.
  return { payload: root, timestamp };
}

function eventSignature(
  eventType: string,
  payload: Record<string, unknown>,
  timestamp: string | null,
): string {
  return `${eventType}:${timestamp ?? ""}:${JSON.stringify(payload)}`;
}

function hasStringMessageData(event: Event): event is MessageEvent<string> {
  return typeof (event as MessageEvent<unknown>).data === "string";
}

export async function streamDeliberation(
  taskId: string,
  tokenSupplier: AccessTokenSupplier,
  onEvent: (event: TaskEvent) => void,
): Promise<StreamHandle> {
  const eventTypes = [
    "mechanism_selected",
    "agent_output",
    "agent_output_delta",
    "cross_examination",
    "cross_examination_delta",
    "delphi_feedback",
    "delphi_finalize",
    "thinking_delta",
    "usage_delta",
    "provider_retrying",
    "convergence_update",
    "mechanism_switch",
    "quorum_reached",
    "receipt_committed",
    "payment_released",
    "error",
    "complete",
  ];

  let source: EventSource | null = null;
  let closed = false;
  let sawTerminalEvent = false;
  let reconnectAttempts = 0;
  let reconnectTimer: number | null = null;
  const seenSignatures = new Set<string>();

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const closeSource = () => {
    if (source) {
      source.close();
      source = null;
    }
  };

  const emitStreamError = (message: string) => {
    onEvent({
      event: "error",
      data: { message },
      timestamp: null,
    });
  };

  const requestStreamTicket = async (): Promise<StreamTicketResponse> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await tokenSupplier();
      try {
        return await requestJson<StreamTicketResponse>(`/tasks/${taskId}/stream-ticket`, {
          method: "POST",
          headers: authHeaders(token),
        });
      } catch (error) {
        lastError = error;
        if (error instanceof ApiRequestError && error.status === 401 && attempt === 0) {
          continue;
        }
        throw error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error("Failed to request task stream ticket");
  };

  const scheduleReconnect = (reason: string) => {
    if (closed || sawTerminalEvent) {
      return;
    }

    closeSource();
    reconnectAttempts += 1;
    if (reconnectAttempts > STREAM_MAX_RECONNECT_ATTEMPTS) {
      emitStreamError(`Stream disconnected: ${reason}`);
      return;
    }

    const delayMs = Math.min(
      8_000,
      STREAM_RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1),
    );
    clearReconnectTimer();
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const handleEventMessage = (eventType: string, event: Event) => {
    if (!hasStringMessageData(event)) {
      // Native EventSource transport errors also use the "error" event type
      // but do not include payload data. Let `source.onerror` handle reconnects.
      if (eventType === "error") {
        return;
      }
      emitStreamError(`Stream payload missing data for ${eventType}`);
      return;
    }

    const message = event;
    const rawData = message.data.trim();
    if (rawData.length === 0) {
      if (eventType === "error") {
        // Empty error payloads generally come from the transport layer. Keep the
        // stream reconnect path alive instead of marking the run terminal.
        return;
      }
      emitStreamError(`Stream payload missing data for ${eventType}`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      if (eventType === "error") {
        // Some server/edge layers emit plain-text error payloads.
        sawTerminalEvent = true;
        closeSource();
        clearReconnectTimer();
        onEvent({
          event: "error",
          data: { message: rawData },
          timestamp: null,
        });
        return;
      }
      emitStreamError(`Stream payload parse failure for ${eventType}`);
      return;
    }

    const normalized = normalizeStreamEventPayload(parsed);
    if (!normalized) {
      if (eventType === "error") {
        sawTerminalEvent = true;
        closeSource();
        clearReconnectTimer();
      }
      emitStreamError(`Stream payload shape mismatch for ${eventType}`);
      return;
    }

    const signature = eventSignature(eventType, normalized.payload, normalized.timestamp);
    if (seenSignatures.has(signature)) {
      return;
    }
    seenSignatures.add(signature);

    onEvent({
      event: eventType,
      data: normalized.payload,
      timestamp: normalized.timestamp,
    });

    if (eventType === "complete" || eventType === "error") {
      sawTerminalEvent = true;
      closeSource();
      clearReconnectTimer();
    }
  };

  const connect = async () => {
    if (closed || sawTerminalEvent) {
      return;
    }

    let ticketResponse: StreamTicketResponse;
    try {
      ticketResponse = await requestStreamTicket();
    } catch (error) {
      const message =
        error instanceof ApiRequestError ? error.message : "Failed to request stream ticket";
      scheduleReconnect(message);
      return;
    }

    const url = new URL(`${API_URL}/tasks/${taskId}/stream`, window.location.origin);
    url.searchParams.set("ticket", ticketResponse.ticket);

    closeSource();
    source = new EventSource(url.toString());

    for (const eventType of eventTypes) {
      source.addEventListener(eventType, (event) => {
        handleEventMessage(eventType, event);
      });
    }

    source.onerror = () => {
      if (closed || sawTerminalEvent) {
        return;
      }
      scheduleReconnect("connection error");
    };

    reconnectAttempts = 0;
  };

  await connect();

  return {
    close: () => {
      closed = true;
      clearReconnectTimer();
      closeSource();
    },
  };
}
