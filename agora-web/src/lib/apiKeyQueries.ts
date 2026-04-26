import {
  useMutation,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";

import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyCreateResponse,
  type ApiKeyMetadataResponse,
} from "./api";
import { useAuth } from "./useAuth";

export const apiKeyQueryKeys = {
  all: ["api-keys"] as const,
  list: () => [...apiKeyQueryKeys.all, "list"] as const,
};

export interface CreateApiKeyInput {
  name: string;
}

export interface RevokeApiKeyInput {
  keyId: string;
}

export function addApiKeyToListCache(
  queryClient: QueryClient,
  key: ApiKeyMetadataResponse,
): void {
  queryClient.setQueryData<ApiKeyMetadataResponse[] | undefined>(
    apiKeyQueryKeys.list(),
    (current) => {
      if (!current) {
        return current;
      }
      return [key, ...current.filter((entry) => entry.key_id !== key.key_id)];
    },
  );
}

export function updateApiKeyListCache(
  queryClient: QueryClient,
  key: ApiKeyMetadataResponse,
): void {
  queryClient.setQueryData<ApiKeyMetadataResponse[] | undefined>(
    apiKeyQueryKeys.list(),
    (current) => {
      if (!current) {
        return current;
      }
      return current.map((entry) => (entry.key_id === key.key_id ? key : entry));
    },
  );
}

export function useApiKeyListQuery() {
  const { authStatus, getAccessToken } = useAuth();

  return useQuery<ApiKeyMetadataResponse[], Error>({
    queryKey: apiKeyQueryKeys.list(),
    enabled: authStatus === "authenticated",
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Missing access token");
      }
      return listApiKeys(token);
    },
  });
}

export function useCreateApiKeyMutation() {
  const { getAccessToken } = useAuth();

  return useMutation<ApiKeyCreateResponse, Error, CreateApiKeyInput>({
    mutationFn: async ({ name }) => {
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Missing access token");
      }
      return createApiKey(token, name.trim());
    },
  });
}

export function useRevokeApiKeyMutation() {
  const { getAccessToken } = useAuth();

  return useMutation<ApiKeyMetadataResponse, Error, RevokeApiKeyInput>({
    mutationFn: async ({ keyId }) => {
      const token = await getAccessToken();
      if (!token) {
        throw new Error("Missing access token");
      }
      return revokeApiKey(token, keyId);
    },
  });
}
