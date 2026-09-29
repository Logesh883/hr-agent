import { AlertCircle, Lock } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiRequestError, errorMessage } from "@/lib/api";

export function QueryError({ error }: { error: unknown }) {
  if (error instanceof ApiRequestError && error.status === 403) {
    return (
      <Alert>
        <Lock />
        <AlertTitle>No access</AlertTitle>
        <AlertDescription>Your role doesn&apos;t have permission to view this page.</AlertDescription>
      </Alert>
    );
  }
  if (error instanceof ApiRequestError && error.status === 404) {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>Not found</AlertTitle>
        <AlertDescription>This record doesn&apos;t exist or was removed.</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>Couldn&apos;t load data</AlertTitle>
      <AlertDescription>{errorMessage(error)}</AlertDescription>
    </Alert>
  );
}
