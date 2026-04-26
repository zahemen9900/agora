import { useQuery } from "@tanstack/react-query";

import { getDeliberationRuntimeConfig, type DeliberationRuntimeConfigPayload } from "./api";
import { useAuth } from "./useAuth";

export const runtimeConfigQueryKeys = {
  all: ["runtime-config"] as const,
  deliberation: () => [...runtimeConfigQueryKeys.all, "deliberation"] as const,
};

export function useDeliberationRuntimeConfigQuery() {
  const { authStatus, getAccessToken } = useAuth();

  return useQuery<DeliberationRuntimeConfigPayload>({
    queryKey: runtimeConfigQueryKeys.deliberation(),
    enabled: authStatus === "authenticated",
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const token = await getAccessToken();
      return getDeliberationRuntimeConfig(token);
    },
  });
}
