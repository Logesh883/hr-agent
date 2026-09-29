import type { LoginResponse, SessionUser } from "@hr/contracts";
import { loginRequestSchema } from "@hr/contracts";
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const SESSION_MAX_AGE = Number(process.env.JWT_EXPIRES_IN_SECONDS ?? 28800);

class InvalidCredentials extends CredentialsSignin {
  code = "invalid_credentials";
}

class ApiUnavailable extends CredentialsSignin {
  code = "api_unavailable";
}

/**
 * Auth.js holds the session; the NestJS API is the identity provider.
 * The API's access token is stored in the (encrypted) session cookie and sent
 * as a bearer token on every API call. RBAC is enforced by the API.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = loginRequestSchema.safeParse(credentials);
        if (!parsed.success) throw new InvalidCredentials();

        let res: Response;
        try {
          res = await fetch(`${API_URL}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(parsed.data),
          });
        } catch {
          throw new ApiUnavailable();
        }
        if (res.status === 401 || res.status === 400) throw new InvalidCredentials();
        if (!res.ok) throw new ApiUnavailable();

        const login = (await res.json()) as LoginResponse;
        return {
          id: login.user.id,
          name: login.user.name,
          email: login.user.email,
          apiUser: login.user,
          accessToken: login.accessToken,
          expiresAt: login.expiresAt,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user?.apiUser && user.accessToken && user.expiresAt) {
        token.apiUser = user.apiUser;
        token.accessToken = user.accessToken;
        token.expiresAt = user.expiresAt;
      }
      // After a password change the API issues a new token. Trust only what the
      // API says about it, never user details sent from the browser.
      if (trigger === "update" && typeof session?.accessToken === "string") {
        const res = await fetch(`${API_URL}/auth/me`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        }).catch(() => null);
        if (res?.ok) {
          token.apiUser = (await res.json()) as SessionUser;
          token.accessToken = session.accessToken;
          if (typeof session.expiresAt === "string") token.expiresAt = session.expiresAt;
        }
      }
      // End the session when the API token expires.
      if (!token.expiresAt || Date.parse(token.expiresAt) <= Date.now()) {
        return null;
      }
      return token;
    },
    session({ session, token }) {
      session.accessToken = token.accessToken;
      session.user = { ...session.user, ...token.apiUser };
      return session;
    },
    /** Used by proxy.ts for the optimistic redirect to /login. */
    authorized({ auth }) {
      return !!auth?.accessToken;
    },
  },
});
