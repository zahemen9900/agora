const API_URL = import.meta.env.VITE_AGORA_API_URL ?? "/api";

import type {
  ApiKeyCreateResponse,
  ApiKeyMetadataResponse,
  AuthMeResponse,
  DeliberationResultResponse,
  TaskCreateResponse,
  TaskEvent,
  TaskStatusResponse,
} from "./api.generated";

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

export interface BenchmarkSummary {
  per_mode: Record<string, Record<string, number>>;
  per_category: Record<string, Record<string, Record<string, number>>>;
}

export interface BenchmarkPayload {
  runs?: Array<Record<string, unknown>>;
  summary?: BenchmarkSummary;
  pre_learning?: { summary: BenchmarkSummary };
  post_learning?: { summary: BenchmarkSummary };
}

export interface StreamHandle {
  close: () => void;
}

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
  token: string | null,
): Promise<TaskCreateResponse> {
  return requestJson<TaskCreateResponse>("/tasks/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify({
      task: taskText,
      agent_count: agentCount,
      stakes,
    }),
  });
}

export async function listTasks(token: string | null): Promise<TaskStatusResponse[]> {
  return requestJson<TaskStatusResponse[]>("/tasks/", {
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

export async function releaseTaskPayment(
  taskId: string,
  token: string | null,
): Promise<{ released: boolean; tx_hash: string }> {
  return requestJson<{ released: boolean; tx_hash: string }>(`/tasks/${taskId}/pay`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

export async function getBenchmarks(token: string | null): Promise<BenchmarkPayload> {
  return requestJson<BenchmarkPayload>("/benchmarks", {
    headers: authHeaders(token),
  });
}

export async function getAuthMe(token: string): Promise<AuthMeResponse> {
  return requestJson<AuthMeResponse>("/auth/me", {
    headers: authHeaders(token),
  });
}

export async function listApiKeys(token: string): Promise<ApiKeyMetadataResponse[]> {
  return requestJson<ApiKeyMetadataResponse[]>("/api-keys/", {
    headers: authHeaders(token),
  });
}

export async function createApiKey(
  token: string,
  name: string,
): Promise<ApiKeyCreateResponse> {
  return requestJson<ApiKeyCreateResponse>("/api-keys/", {
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

export async function streamDeliberation(
  taskId: string,
  token: string | null,
  onEvent: (event: TaskEvent) => void,
): Promise<StreamHandle> {
  const ticketResponse = await requestJson<StreamTicketResponse>(
    `/tasks/${taskId}/stream-ticket`,
    {
      method: "POST",
      headers: authHeaders(token),
    },
  );
  const url = new URL(`${API_URL}/tasks/${taskId}/stream`, window.location.origin);
  url.searchParams.set("ticket", ticketResponse.ticket);

  const source = new EventSource(url.toString());
  const eventTypes = [
    "mechanism_selected",
    "agent_output",
    "cross_examination",
    "convergence_update",
    "mechanism_switch",
    "quorum_reached",
    "receipt_committed",
    "payment_released",
    "error",
    "complete",
  ];

  for (const eventType of eventTypes) {
    source.addEventListener(eventType, (event) => {
      const message = event as MessageEvent<string>;
      onEvent({
        event: eventType,
        data: JSON.parse(message.data) as Record<string, unknown>,
        timestamp: null,
      });
    });
  }

  source.onerror = () => {
    onEvent({
      event: "error",
      data: { message: "Stream disconnected" },
      timestamp: null,
    });
  };

  return {
    close: () => source.close(),
  };
}
