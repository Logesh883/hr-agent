import type { SessionUser } from "@hr/contracts";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    accessToken: string;
    user: SessionUser & DefaultSession["user"];
  }

  interface User {
    apiUser?: SessionUser;
    accessToken?: string;
    expiresAt?: string;
  }
}

// next-auth/jwt re-exports @auth/core/jwt; augment the original declaration.
declare module "@auth/core/jwt" {
  interface JWT {
    apiUser: SessionUser;
    accessToken: string;
    expiresAt: string;
  }
}
