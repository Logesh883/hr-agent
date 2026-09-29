"use client";

import type { Permission } from "@hr/contracts";
import { useSession } from "next-auth/react";
import { useCallback } from "react";

export function useAccessToken(): string | undefined {
  return useSession().data?.accessToken;
}

export function useCurrentUser() {
  return useSession().data?.user;
}

/**
 * UI-only permission check, used to hide actions the user can't perform.
 * The API enforces the same permissions on every request.
 */
export function useCan(): (permission: Permission) => boolean {
  const permissions = useSession().data?.user.permissions;
  return useCallback(
    (permission: Permission) => permissions?.includes(permission) ?? false,
    [permissions],
  );
}
