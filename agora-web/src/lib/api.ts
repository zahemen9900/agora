const API_URL = import.meta.env.VITE_AGORA_API_URL ?? "/api";

export type MechanismName = "debate" | "vote" | "delphi" | "moa";
export type TaskStatusName = "pending" | "in_progress" | "completed" | "failed" | "paid";
export type PaymentStatusName = "locked" | "released" | "none";
export type AuthMethodName = "jwt" | "api_key";
export type ApiKeyScopeName = "tasks:read" | "tasks:write" | "api_keys:read" | "api_keys:write";

export interface TaskCreateResponse {
  task_id: string;
  mechanism: MechanismName;
  confidence: number;
  reasoning: string;
  selector_reasoning_hash: string;
  status: TaskStatusName;
}

export interface TaskEvent {
  event: string;
  data: Record<string, unknown>;
  timestamp?: string | null;
}

export interface DeliberationResultResponse {
  task_id: string;
  mechanism: MechanismName;
  final_answer: string;
  confidence: number;
  quorum_reached: boolean;
  merkle_root: string | null;
  decision_hash: string | null;
  agent_count: number;
  agent_models_used: string[];
  total_tokens_used: number;
  latency_ms: number;
  round_count: number;
  mechanism_switches: number;
  transcript_hashes: string[];
  convergence_history: Array<Record<string, unknown>>;
  locked_claims: Array<Record<string, unknown>>;
}

export interface TaskStatusResponse {
  task_id: string;
  task_text: string;
  workspace_id: string;
  mechanism: MechanismName;
  mechanism_override: MechanismName | null;
  status: TaskStatusName;
  selector_reasoning: string;
  selector_reasoning_hash: string;
  selector_confidence: number;
  merkle_root: string | null;
  decision_hash: string | null;
  quorum_reached: boolean | null;
  agent_count: number;
  round_count: number;
  mechanism_switches: number;
  transcript_hashes: string[];
  solana_tx_hash: string | null;
  explorer_url: string | null;
  payment_amount: number;
  payment_status: PaymentStatusName;
  created_at: string;
  completed_at: string | null;
  result: DeliberationResultResponse | null;
  events: TaskEvent[];
}

export interface PrincipalResponse {
  auth_method: AuthMethodName;
  workspace_id: string;
  user_id: string | null;
  display_name: string;
  email: string;
  scopes: ApiKeyScopeName[];
  api_key_id: string | null;
}

export interface WorkspaceResponse {
  id: string;
  display_name: string;
  kind: "personal";
  owner_user_id: string;
  created_at: string;
}

export interface FeatureFlagsResponse {
  benchmarks_visible: boolean;
  api_keys_visible: boolean;
}

export interface AuthMeResponse {
  principal: PrincipalResponse;
  workspace: WorkspaceResponse;
  feature_flags: FeatureFlagsResponse;
}

export interface ApiKeyMetadataResponse {
  key_id: string;
  workspace_id: string;
  name: string;
  public_id: string;
  scopes: ApiKeyScopeName[];
  created_by_user_id: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeyCreateResponse {
  api_key: string;
  metadata: ApiKeyMetadataResponse;
}

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

function authHeaders(token: string | null): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, init);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
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
      });
    });
  }

  source.onerror = () => {
    onEvent({
      event: "error",
      data: { message: "Stream disconnected" },
    });
  };

  return {
    close: () => source.close(),
  };
}
