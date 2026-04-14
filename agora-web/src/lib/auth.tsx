import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface DemoUser {
  name: string;
  email: string;
  token: string;
}

interface AuthContextType {
  user: DemoUser | null;
  token: string | null;
  isLoading: boolean;
  signIn: () => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const STORAGE_KEY = "agora.demo.user";

function base64UrlEncode(value: string): string {
  return window.btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createDemoToken(): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: "demo-user",
      email: "demo@example.com",
      name: "Demo User",
    }),
  );
  return `${header}.${payload}.demo-signature`;
}

function buildDemoUser(): DemoUser {
  return {
    name: "Demo User",
    email: "demo@example.com",
    token: createDemoToken(),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<DemoUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        setUser(JSON.parse(stored) as DemoUser);
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }
    setIsLoading(false);
  }, []);

  const signIn = async () => {
    setIsLoading(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const demoUser = buildDemoUser();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(demoUser));
    setUser(demoUser);
    setIsLoading(false);
  };

  const signOut = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token: user?.token ?? null, isLoading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
