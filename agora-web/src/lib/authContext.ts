import { createContext } from "react";

import type { User } from "./auth";
import type {
  FeatureFlagsResponse,
  PrincipalResponse,
  WorkspaceResponse,
} from "./api";

export type AuthIssue = "session_expired" | "access_denied" | "workspace_missing";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  authStatus: AuthStatus;
  principal: PrincipalResponse | null;
  workspace: WorkspaceResponse | null;
  featureFlags: FeatureFlagsResponse | null;
  authIssue: AuthIssue | null;
  signIn: () => void;
  signUp: () => void;
  signOut: () => void;
  getAccessToken: () => Promise<string | null>;
}

export const AuthContext = createContext<AuthContextType | null>(null);
