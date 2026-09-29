import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/auth";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Change password" };

export default async function ChangePasswordPage() {
  const session = await auth();
  if (!session?.accessToken) redirect("/login");

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-12">
      <SessionProvider session={session}>
        <ChangePasswordForm forced={session.user.mustChangePassword} name={session.user.name} />
      </SessionProvider>
    </div>
  );
}
