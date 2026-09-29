"use client";

import { PASSWORD_CHANGE_REQUIRED } from "@hr/contracts";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiRequestError } from "@/lib/api";

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  /** An expired or revoked API token ends the session; a temporary password must be replaced first. */
  function handleAuthError(error: unknown) {
    if (!(error instanceof ApiRequestError)) return;
    if (error.status === 401) void signOut({ redirectTo: "/login?expired=1" });
    if (error.code === PASSWORD_CHANGE_REQUIRED) router.replace("/change-password");
  }

  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: handleAuthError }),
        mutationCache: new MutationCache({ onError: handleAuthError }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) =>
              !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) &&
              failureCount < 2,
          },
        },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster richColors position="top-right" />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
