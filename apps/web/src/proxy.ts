// Optimistic check only: redirects signed-out visitors to /login.
// Real authorization happens in the API on every request.
export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|login|_next/static|_next/image|favicon.ico).*)"],
};
