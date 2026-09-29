"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { loginRequestSchema, type LoginRequest } from "@hr/contracts";
import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

const DEMO_PASSWORD = "Password123!";
const demoAccounts = [
  { email: "admin@hr.local", role: "Admin", note: "Full access" },
  { email: "hr@hr.local", role: "HR Operations", note: "Manage employees and departments" },
  { email: "manager@hr.local", role: "Manager", note: "Read-only directory" },
  { email: "employee@hr.local", role: "Employee", note: "Departments only" },
];

const signInErrors: Record<string, string> = {
  invalid_credentials: "Invalid email or password.",
  api_unavailable: "Can't reach the HR API. Is it running?",
};

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(
    searchParams.get("expired") ? "Your session expired. Please sign in again." : null,
  );

  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: "", password: "" },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: LoginRequest) {
    setError(null);
    const result = await signIn("credentials", { ...values, redirect: false });
    if (result?.error) {
      setError(signInErrors[result.code ?? ""] ?? "Sign in failed. Please try again.");
      return;
    }
    const callbackUrl = searchParams.get("callbackUrl");
    router.replace(callbackUrl?.startsWith("/") ? callbackUrl : "/");
    router.refresh();
  }

  function fillDemoAccount(email: string) {
    form.setValue("email", email, { shouldValidate: true });
    form.setValue("password", DEMO_PASSWORD, { shouldValidate: true });
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="mb-2 flex size-9 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
          HR
        </div>
        <CardTitle className="text-xl">Sign in to HR Operations</CardTitle>
        <CardDescription>Use your work account or one of the demo accounts below.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              aria-invalid={!!errors.email}
              {...form.register("email")}
            />
            {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              {...form.register("password")}
            />
            {errors.password && (
              <p className="text-sm text-destructive">{errors.password.message}</p>
            )}
          </div>
          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="animate-spin" />}
            Sign in
          </Button>
        </form>

        <div className="space-y-3">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            Demo accounts · password {DEMO_PASSWORD}
            <Separator className="flex-1" />
          </div>
          <div className="grid gap-2">
            {demoAccounts.map((account) => (
              <button
                key={account.email}
                type="button"
                onClick={() => fillDemoAccount(account.email)}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
              >
                <span>
                  <span className="font-medium">{account.role}</span>
                  <span className="block text-xs text-muted-foreground">{account.note}</span>
                </span>
                <span className="text-xs text-muted-foreground">{account.email}</span>
              </button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
