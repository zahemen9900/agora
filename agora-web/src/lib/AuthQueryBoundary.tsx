import { useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "./useAuth";

export function AuthQueryBoundary({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { authStatus, workspace } = useAuth();
  const previousWorkspaceIdRef = useRef<string | null>(null);
  const hasAuthenticatedRef = useRef(false);

  useEffect(() => {
    const workspaceId = workspace?.id ?? null;

    if (authStatus !== "authenticated") {
      if (hasAuthenticatedRef.current || previousWorkspaceIdRef.current !== null) {
        queryClient.clear();
      }
      previousWorkspaceIdRef.current = null;
      hasAuthenticatedRef.current = false;
      return;
    }

    if (
      previousWorkspaceIdRef.current !== null
      && previousWorkspaceIdRef.current !== workspaceId
    ) {
      queryClient.clear();
    }

    previousWorkspaceIdRef.current = workspaceId;
    hasAuthenticatedRef.current = true;
  }, [authStatus, queryClient, workspace?.id]);

  return <>{children}</>;
}
