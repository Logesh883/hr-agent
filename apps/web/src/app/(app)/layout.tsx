import { redirect } from "next/navigation";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/auth";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const session = await auth();
  if (!session?.accessToken) redirect("/login");

  return (
    <SessionProvider session={session}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
