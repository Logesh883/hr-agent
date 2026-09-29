"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { newPasswordSchema, PASSWORD_RULES, type LoginResponse } from "@hr/contracts";
import { KeyRound, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiRequestError, apiFetch, errorMessage } from "@/lib/api";

const formSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "The passwords don't match",
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ["newPassword"],
    message: "Choose a different password from your current one",
  });
type FormValues = z.infer<typeof formSchema>;

export function ChangePasswordForm({ forced, name }: { forced: boolean; name: string }) {
  const router = useRouter();
  const { data: session, update } = useSession();
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit({ currentPassword, newPassword }: FormValues) {
    try {
      const result = await apiFetch<LoginResponse>(session?.accessToken, "/auth/change-password", {
        method: "POST",
        body: { currentPassword, newPassword },
      });
      // The old session token stops working; switch to the new one.
      await update({ accessToken: result.accessToken, expiresAt: result.expiresAt });
      toast.success("Password changed");
      router.replace("/");
      router.refresh();
    } catch (error) {
      if (error instanceof ApiRequestError && error.issues?.some((i) => i.path === "currentPassword")) {
        form.setError("currentPassword", { message: "That password isn't right" });
      } else {
        toast.error(errorMessage(error));
      }
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="mb-2 flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <KeyRound className="size-4" />
        </div>
        <CardTitle className="text-xl">{forced ? `Welcome, ${name.split(" ")[0]}` : "Change your password"}</CardTitle>
        <CardDescription>
          {forced
            ? "You signed in with a temporary password. Choose your own password to continue."
            : "Other signed-in sessions will be signed out."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="currentPassword">{forced ? "Temporary password" : "Current password"}</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              aria-invalid={!!errors.currentPassword}
              {...form.register("currentPassword")}
            />
            {errors.currentPassword && <p className="text-sm text-destructive">{errors.currentPassword.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="newPassword">New password</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.newPassword}
              {...form.register("newPassword")}
            />
            {errors.newPassword ? (
              <p className="text-sm text-destructive">{errors.newPassword.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                At least {PASSWORD_RULES.minLength} characters, with a letter and a number.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.confirmPassword}
              {...form.register("confirmPassword")}
            />
            {errors.confirmPassword && <p className="text-sm text-destructive">{errors.confirmPassword.message}</p>}
          </div>
          {forced && (
            <Alert>
              <AlertDescription>Until you do this, nothing else in the app is available.</AlertDescription>
            </Alert>
          )}
          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="animate-spin" />}
            {forced ? "Set password and continue" : "Change password"}
          </Button>
          <div className="flex justify-between text-sm">
            {forced ? (
              <span />
            ) : (
              <Link href="/" className="text-muted-foreground hover:underline">
                Cancel
              </Link>
            )}
            <button
              type="button"
              className="text-muted-foreground hover:underline"
              onClick={() => void signOut({ redirectTo: "/login" })}
            >
              Sign out
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
