export function formatAuthDependencyError(message: string): string {
  const normalized = message.trim();
  if (!normalized) {
    return normalized;
  }

  if (/auth service is not configured/i.test(normalized)) {
    return `${normalized} Set AUTH_API_BASE_URL on data-service to the auth-service Railway URL, then restart or redeploy the service.`;
  }

  if (
    /auth service is unavailable/i.test(normalized) ||
    /auth service request timed out/i.test(normalized) ||
    /auth service request failed/i.test(normalized)
  ) {
    return `${normalized} Confirm AUTH_API_BASE_URL on data-service and VITE_AUTH_API_BASE_URL on frontend both point to the auth-service Railway URL.`;
  }

  return normalized;
}