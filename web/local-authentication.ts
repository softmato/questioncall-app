/**
 * `expo-local-authentication` for the PWA. A browser has no fingerprint or face
 * unlock, so the wallet gate reports "unavailable" and opens — exactly what it
 * does on a phone without biometrics (hooks/use-biometric-gate.ts).
 */
export enum AuthenticationType {
  FINGERPRINT = 1,
  FACIAL_RECOGNITION = 2,
  IRIS = 3,
}

export const hasHardwareAsync = async () => false;

export const isEnrolledAsync = async () => false;

export const supportedAuthenticationTypesAsync = async (): Promise<
  AuthenticationType[]
> => [];

export const authenticateAsync = async (_options?: unknown) => ({
  success: true as const,
});
