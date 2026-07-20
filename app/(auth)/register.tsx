import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Google from "expo-auth-session/providers/google";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AuthNotice } from "@/components/auth/auth-notice";
import { useAppDispatch } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import {
  GOOGLE_ANDROID_CLIENT_ID,
  GOOGLE_IOS_CLIENT_ID,
  GOOGLE_OAUTH_REDIRECT_URI,
  GOOGLE_WEB_CLIENT_ID,
} from "@/lib/app-identity";
import { persistMobileAuthSession } from "@/lib/mobile-auth-session";
import { api } from "@/lib/api";
import {
  assertOkResponse,
  assertSuccessResponse,
  getRequestErrorMessage,
  getServerMessage,
  readServerStatus,
} from "@/lib/server-response";

WebBrowser.maybeCompleteAuthSession();

type Role = "STUDENT" | "TEACHER";
type RegisterAction = "send-code" | "verify-code" | "create-account" | "google" | null;
type SignupStep = "email" | "code" | "password";

/**
 * Account creation runs bcrypt + several DB writes + a welcome email, so on a
 * cold serverless start it comfortably outruns the api client's default 15s.
 * A client-side timeout on a request that actually succeeded is what strands
 * users on this screen, so give the signup calls real headroom.
 */
const SLOW_AUTH_TIMEOUT_MS = 45000;

function buildDisplayNameFromEmail(email: string) {
  const localPart = email.split("@")[0] ?? "";
  const cleaned = localPart.replace(/[._-]+/g, " ").trim();

  if (!cleaned) {
    return "User";
  }

  return cleaned
    .split(/\s+/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export default function RegisterScreen() {
  const params = useLocalSearchParams<{ ref?: string; role?: string }>();
  const dispatch = useAppDispatch();
  const insets = useSafeAreaInsets();
  const { statusBarStyle, backgroundColor, iconColor } = useAppTheme();

  const initialRole: Role = params.role === "TEACHER" ? "TEACHER" : "STUDENT";
  const [role, setRole] = useState<Role>(initialRole);
  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [referralCode, setReferralCode] = useState(params.ref ?? "");
  const [step, setStep] = useState<SignupStep>("email");
  const [loadingAction, setLoadingAction] = useState<RegisterAction>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isGoogleConfirmOpen, setIsGoogleConfirmOpen] = useState(false);

  const isGoogleConfigured =
    Platform.OS === "android"
      ? Boolean(GOOGLE_ANDROID_CLIENT_ID)
      : Platform.OS === "ios"
        ? Boolean(GOOGLE_IOS_CLIENT_ID)
        : Boolean(GOOGLE_WEB_CLIENT_ID);

  const [request, response, promptGoogleSignIn] = Google.useIdTokenAuthRequest({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    androidClientId: GOOGLE_ANDROID_CLIENT_ID,
    iosClientId: GOOGLE_IOS_CLIENT_ID,
    redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
    scopes: ["openid", "profile", "email"],
    selectAccount: true,
  });

  useEffect(() => {
    if (params.ref) {
      setReferralCode(params.ref);
    }
  }, [params.ref]);

  useEffect(() => {
    if (params.role === "TEACHER" || params.role === "STUDENT") {
      setRole(params.role);
    }
  }, [params.role]);

  function resetVerificationState(nextEmail: string) {
    setEmail(nextEmail);
    setVerificationCode("");
    setPassword("");
    setStep("email");
    setFormError(null);
    setSuccessMessage(null);
  }

  function handleEmailChange(value: string) {
    if (step !== "email") {
      resetVerificationState(value);
      return;
    }

    setEmail(value);
  }

  async function handleSendCode() {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setFormError("Please enter your email first.");
      return;
    }

    setLoadingAction("send-code");
    setFormError(null);
    setSuccessMessage(null);

    try {
      const res = await api.post(
        "/auth/verify-email/send",
        {
          email: normalizedEmail,
          name: buildDisplayNameFromEmail(normalizedEmail),
        },
        readServerStatus,
      );

      assertSuccessResponse(res, "Failed to send verification code.");

      setStep("code");
      setSuccessMessage("Verification code sent. Check your inbox.");
    } catch (err: any) {
      setFormError(
        getRequestErrorMessage(
          err,
          "Failed to send verification code. Please try again.",
        ),
      );
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleVerifyCode() {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setFormError("Please enter your email first.");
      return;
    }

    if (verificationCode.trim().length < 6) {
      setFormError("Please enter the 6-digit verification code.");
      return;
    }

    setLoadingAction("verify-code");
    setFormError(null);
    setSuccessMessage(null);

    try {
      const res = await api.post(
        "/auth/verify-email/confirm",
        {
          email: normalizedEmail,
          code: verificationCode.trim(),
        },
        readServerStatus,
      );

      assertSuccessResponse(res, "Failed to verify code. Please try again.");

      setStep("password");
      setSuccessMessage("Email verified. Choose a password to finish.");
    } catch (err: any) {
      setFormError(
        getRequestErrorMessage(err, "Failed to verify code. Please try again."),
      );
    } finally {
      setLoadingAction(null);
    }
  }

  /**
   * Sign the brand-new account in and drop the user straight into the app.
   *
   * By the time this runs the account definitely exists, so a transient failure
   * must never dead-end the user on the signup screen telling them to go log in
   * manually. Network errors and 5xx get retried; a 4xx is a definitive answer
   * from the server and is surfaced as-is.
   */
  async function signInAndEnterApp(normalizedEmail: string, accountPassword: string) {
    const MAX_ATTEMPTS = 3;
    let lastMessage = "Signing you in failed. Please try again.";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let status: number | null = null;

      try {
        const res = await api.post(
          "/mobile/login",
          { email: normalizedEmail, password: accountPassword },
          { ...readServerStatus, timeout: SLOW_AUTH_TIMEOUT_MS },
        );

        status = res.status;
        assertOkResponse(res, lastMessage);

        const session = await persistMobileAuthSession(dispatch, res.data);
        router.replace(session.isSuspended ? "/suspended" : "/(tabs)/feed");
        return;
      } catch (err: any) {
        lastMessage = getRequestErrorMessage(err, lastMessage);

        // A definitive 4xx (suspended, deleted, bad password) won't change on a
        // retry — stop and report it. `status === null` means the request never
        // completed at all (timeout / offline), which is worth another try.
        const isRetriable = status === null || status >= 500;
        if (!isRetriable || attempt === MAX_ATTEMPTS) {
          const failure = new Error(lastMessage) as Error & {
            credentialsRejected?: boolean;
          };
          failure.credentialsRejected = !isRetriable;
          throw failure;
        }

        await new Promise((resolve) => setTimeout(resolve, attempt * 800));
      }
    }
  }

  async function completeSignup() {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setFormError("Please enter your email first.");
      return;
    }

    if (!password.trim() || password.trim().length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }

    if (step !== "password") {
      setFormError("Please verify your email before creating the account.");
      return;
    }

    setLoadingAction("create-account");
    setFormError(null);
    setSuccessMessage(null);

    try {
      const registerRes = await api.post(
        "/auth/register",
        {
          name: buildDisplayNameFromEmail(normalizedEmail),
          email: normalizedEmail,
          password,
          role,
          // The server re-verifies this OTP before creating the account, so the
          // /verify-email/confirm step above cannot be skipped.
          code: verificationCode.trim(),
          referralCode: referralCode.trim() || undefined,
        },
        { ...readServerStatus, timeout: SLOW_AUTH_TIMEOUT_MS },
      );

      // 409 means the email is already taken. That happens legitimately when a
      // previous attempt timed out client-side but succeeded on the server, so
      // try signing in with the password just entered: if it matches, this is
      // that same half-finished signup and the user belongs in the app. If it
      // doesn't, sign-in fails and the "already exists" message stands.
      const isExistingAccount = registerRes.status === 409;
      if (!isExistingAccount) {
        assertOkResponse(registerRes, "Registration failed. Please try again.");
      }

      try {
        await signInAndEnterApp(normalizedEmail, password);
      } catch (err: any) {
        // The email was taken by a *different* account, not by a timed-out
        // attempt of this one — report that rather than "invalid password".
        if (isExistingAccount && err?.credentialsRejected) {
          throw new Error(
            getServerMessage(
              registerRes.data,
              "An account already exists with that email address.",
            ),
          );
        }

        throw err;
      }
    } catch (err: any) {
      setFormError(getRequestErrorMessage(err, "Registration failed. Please try again."));
    } finally {
      setLoadingAction(null);
    }
  }

  const handleGoogleSignup = useCallback(
    async (googleIdToken: string) => {
      setFormError(null);
      setSuccessMessage(null);

      try {
        const res = await api.post(
          "/mobile/register",
          {
            googleIdToken,
            role,
            referralCode: referralCode.trim() || undefined,
          },
          { ...readServerStatus, timeout: SLOW_AUTH_TIMEOUT_MS },
        );

        assertOkResponse(res, "Google sign-up failed. Please try again.");

        const session = await persistMobileAuthSession(dispatch, res.data);
        router.replace(session.isSuspended ? "/suspended" : "/(tabs)/feed");
      } catch (err: any) {
        setFormError(
          getRequestErrorMessage(err, "Google sign-up failed. Please try again."),
        );
      } finally {
        setLoadingAction(null);
      }
    },
    [dispatch, referralCode, role],
  );

  useEffect(() => {
    if (response?.type === "success") {
      const googleIdToken = response.params.id_token;
      if (!googleIdToken) {
        setFormError("Google sign-up did not return an ID token.");
        setLoadingAction(null);
        return;
      }

      void handleGoogleSignup(googleIdToken);
      return;
    }

    if (response && response.type !== "opened") {
      setLoadingAction(null);
    }
  }, [handleGoogleSignup, response]);

  async function handleGoogleSignupPress() {
    if (!isGoogleConfigured) {
      setFormError("Google sign-up is not configured yet.");
      return;
    }

    if (!request) {
      setFormError("Google sign-in is still preparing. Try again in a moment.");
      return;
    }

    setIsGoogleConfirmOpen(true);
  }

  async function confirmGoogleSignup() {
    setIsGoogleConfirmOpen(false);
    setFormError(null);
    setSuccessMessage(null);
    setLoadingAction("google");

    const result = await promptGoogleSignIn();
    if (result.type !== "success") {
      setLoadingAction(null);
    }
  }

  const stepHelperText =
    step === "email"
      ? "Add your email. We will send a verification code to confirm it is yours."
      : step === "code"
        ? "Enter the verification code from your inbox to continue."
        : "Set a password you can remember, and keep it strong.";

  return (
    <View className="flex-1 bg-background">
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
      >
        <View
          className="flex-1 px-6 pt-14"
          style={{ paddingBottom: Math.max(insets.bottom + 24, 40) }}
        >
          <View className="flex-row items-center gap-3">
            <TouchableOpacity
              onPress={() => router.back()}
              className="h-11 w-11 items-center justify-center rounded-full border border-border bg-card"
              activeOpacity={0.85}
            >
              <Ionicons name="arrow-back" size={20} color={iconColor} />
            </TouchableOpacity>

            <View className="h-11 w-11 items-center justify-center rounded-2xl border border-border bg-card">
              <Image
                source={require("../../assets/images/logo.png")}
                style={{ width: 28, height: 28 }}
                resizeMode="contain"
              />
            </View>

            <View className="flex-1">
              <Text className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                QuestionCall
              </Text>
            </View>
          </View>

          <Text className="mt-5 text-[30px] font-bold tracking-tight text-foreground">
            Create account
          </Text>

          <Text className="mt-2 text-[15px] leading-6 text-muted-foreground">
            {stepHelperText}
          </Text>

          {referralCode.trim() ? (
            <View className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
              <Text className="text-sm font-medium text-foreground">
                Referral code detected. Bonus questions will apply after signup.
              </Text>
            </View>
          ) : null}

          <View className="mt-5 flex-1">
            <View className="gap-4">
              <View>
                <Text className="mb-2 ml-1 text-sm font-medium text-foreground">
                  I am a
                </Text>
                <View className="flex-row rounded-2xl border border-border bg-card p-1">
                  <TouchableOpacity
                    onPress={() => setRole("STUDENT")}
                    className={`flex-1 flex-row items-center justify-center gap-2 rounded-xl py-3 ${
                      role === "STUDENT" ? "bg-primary" : ""
                    }`}
                    activeOpacity={0.85}
                  >
                    <Ionicons
                      name="school-outline"
                      size={18}
                      color={role === "STUDENT" ? "#FFFFFF" : iconColor}
                    />
                    <Text
                      className={`text-[15px] font-semibold ${
                        role === "STUDENT"
                          ? "text-primary-foreground"
                          : "text-muted-foreground"
                      }`}
                    >
                      Student
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => setRole("TEACHER")}
                    className={`flex-1 flex-row items-center justify-center gap-2 rounded-xl py-3 ${
                      role === "TEACHER" ? "bg-primary" : ""
                    }`}
                    activeOpacity={0.85}
                  >
                    <Ionicons
                      name="person-outline"
                      size={18}
                      color={role === "TEACHER" ? "#FFFFFF" : iconColor}
                    />
                    <Text
                      className={`text-[15px] font-semibold ${
                        role === "TEACHER"
                          ? "text-primary-foreground"
                          : "text-muted-foreground"
                      }`}
                    >
                      Teacher
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {step === "email" ? (
                <View>
                  <Text className="mb-2 ml-1 text-sm font-medium text-foreground">
                    Email
                  </Text>
                  <TextInput
                    value={email}
                    onChangeText={handleEmailChange}
                    placeholder="you@example.com"
                    placeholderTextColor="#6B7280"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoComplete="email"
                    className="rounded-2xl border border-border bg-card px-5 py-4 text-[15px] text-foreground"
                  />
                </View>
              ) : null}

              {step === "code" ? (
                <View>
                  <Text className="mb-2 ml-1 text-sm font-medium text-foreground">
                    Verification code
                  </Text>
                  <TextInput
                    value={verificationCode}
                    onChangeText={setVerificationCode}
                    placeholder="000000"
                    placeholderTextColor="#6B7280"
                    keyboardType="number-pad"
                    autoCapitalize="none"
                    autoComplete="one-time-code"
                    maxLength={6}
                    className="rounded-2xl border border-border bg-card px-5 py-4 text-[15px] text-foreground"
                  />
                  <TouchableOpacity
                    onPress={handleSendCode}
                    disabled={loadingAction === "send-code"}
                    className="mt-2 items-center py-2"
                    activeOpacity={0.85}
                  >
                    <Text className="text-sm font-semibold text-primary">
                      Resend code
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              {step === "password" ? (
                <View>
                  <Text className="mb-2 ml-1 text-sm font-medium text-foreground">
                    Password
                  </Text>
                  <View className="relative">
                    <TextInput
                      value={password}
                      onChangeText={setPassword}
                      placeholder="At least 8 characters"
                      placeholderTextColor="#6B7280"
                      secureTextEntry={!showPassword}
                      autoComplete="new-password"
                      className="rounded-2xl border border-border bg-card px-5 py-4 pr-12 text-[15px] text-foreground"
                    />
                    <TouchableOpacity
                      onPress={() => setShowPassword((current) => !current)}
                      className="absolute right-3 top-1/2 h-8 w-8 -translate-y-4 items-center justify-center rounded-full"
                      activeOpacity={0.85}
                    >
                      <Ionicons
                        name={showPassword ? "eye-off-outline" : "eye-outline"}
                        size={18}
                        color={iconColor}
                      />
                    </TouchableOpacity>
                  </View>

                  <Text className="mb-2 ml-1 mt-4 text-sm font-medium text-foreground">
                    Referral code{" "}
                    <Text className="text-xs text-muted-foreground">(optional)</Text>
                  </Text>
                  <TextInput
                    value={referralCode}
                    onChangeText={setReferralCode}
                    placeholder="Enter referral code"
                    placeholderTextColor="#6B7280"
                    autoCapitalize="characters"
                    className="rounded-2xl border border-border bg-card px-5 py-4 text-[15px] text-foreground"
                  />
                </View>
              ) : null}

              <AuthNotice tone="error" message={formError} />
              <AuthNotice tone="success" message={successMessage} />

              <TouchableOpacity
                onPress={
                  step === "email"
                    ? handleSendCode
                    : step === "code"
                      ? handleVerifyCode
                      : completeSignup
                }
                disabled={loadingAction !== null}
                className="items-center rounded-full bg-primary py-4 shadow-lg"
                activeOpacity={0.85}
              >
                {loadingAction === "send-code" ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : loadingAction === "verify-code" ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : loadingAction === "create-account" ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text className="text-[16px] font-semibold text-primary-foreground">
                    {step === "email"
                      ? "Send code"
                      : step === "code"
                        ? "Verify code"
                        : "Create account"}
                  </Text>
                )}
              </TouchableOpacity>
            </View>

            <View className="mt-8 gap-4">
              <View className="flex-row items-center gap-3">
                <View className="h-px flex-1 bg-border" />
                <Text className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  or
                </Text>
                <View className="h-px flex-1 bg-border" />
              </View>

              {isGoogleConfigured ? (
                <TouchableOpacity
                  onPress={handleGoogleSignupPress}
                  disabled={loadingAction !== null || !request}
                  className="flex-row items-center justify-center gap-2 rounded-full border border-border bg-card py-4 shadow-sm"
                  activeOpacity={0.85}
                >
                  {loadingAction === "google" ? (
                    <ActivityIndicator color={iconColor} />
                  ) : (
                    <Ionicons name="logo-google" size={20} color={iconColor} />
                  )}
                  <Text className="text-[16px] font-semibold text-card-foreground">
                    Continue with Google
                  </Text>
                </TouchableOpacity>
              ) : (
                <View className="opacity-60">
                  <TouchableOpacity
                    disabled
                    className="flex-row items-center justify-center gap-2 rounded-full border border-border bg-card py-4 shadow-sm"
                    activeOpacity={0.85}
                  >
                    <Ionicons name="logo-google" size={20} color={iconColor} />
                    <Text className="text-[16px] font-semibold text-card-foreground">
                      Continue with Google
                    </Text>
                  </TouchableOpacity>
                  <Text className="px-2 pt-2 text-center text-xs text-muted-foreground">
                    Google sign-up is not configured yet.
                  </Text>
                </View>
              )}

              <View className="items-center">
                <Text className="text-sm text-muted-foreground">
                  Already have an account?{" "}
                  <Text
                    className="font-bold text-foreground"
                    onPress={() => router.replace("/(auth)/login")}
                  >
                    Sign in
                  </Text>
                </Text>
              </View>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Modal
        transparent
        animationType="fade"
        visible={isGoogleConfirmOpen}
        onRequestClose={() => setIsGoogleConfirmOpen(false)}
      >
        <View className="flex-1 items-center justify-center bg-black/55 px-6">
          <View className="w-full max-w-md rounded-[28px] border border-border bg-card px-5 py-6">
            <View className="bg-primary/10 mb-4 h-12 w-12 items-center justify-center rounded-2xl">
              <Ionicons name="logo-google" size={24} color={iconColor} />
            </View>
            <Text className="text-[22px] font-bold tracking-tight text-foreground">
              Continue as {role === "STUDENT" ? "Student" : "Teacher"}?
            </Text>
            <Text className="mt-2 text-[15px] leading-6 text-muted-foreground">
              This will create your account with Google and sign you in right away.
            </Text>

            <View className="bg-muted/30 mt-4 rounded-2xl border border-border px-4 py-3">
              <Text className="text-sm font-semibold text-foreground">Selected role</Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                {role === "STUDENT" ? "Student" : "Teacher"}
              </Text>
            </View>

            <View className="mt-5 flex-row gap-3">
              <Pressable
                onPress={() => setIsGoogleConfirmOpen(false)}
                className="flex-1 items-center rounded-full border border-border bg-background py-3.5"
              >
                <Text className="text-[15px] font-semibold text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmGoogleSignup}
                className="flex-1 items-center rounded-full bg-primary py-3.5"
              >
                <Text className="text-[15px] font-semibold text-primary-foreground">
                  Continue
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
