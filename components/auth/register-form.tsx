import { useEffect, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import { AuthField } from "@/components/auth/auth-field";
import { AuthNotice } from "@/components/auth/auth-notice";
import { AuthSocialBlock } from "@/components/auth/auth-social";
import { useAppDispatch } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import { isGoogleSignInConfigured } from "@/lib/google-signin";
import { persistMobileAuthSession } from "@/lib/mobile-auth-session";
import {
  assertOkResponse,
  assertSuccessResponse,
  getRequestErrorMessage,
  getServerMessage,
  readServerStatus,
} from "@/lib/server-response";

type Role = "STUDENT" | "TEACHER";
type RegisterAction = "send-code" | "verify-code" | "create-account" | null;
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

export function RegisterForm({
  initialRole = "STUDENT",
  initialReferralCode = "",
}: {
  initialRole?: Role;
  initialReferralCode?: string;
}) {
  const dispatch = useAppDispatch();
  const { iconColor } = useAppTheme();

  const [role, setRole] = useState<Role>(initialRole);
  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [password, setPassword] = useState("");
  const [referralCode, setReferralCode] = useState(initialReferralCode);
  const [step, setStep] = useState<SignupStep>("email");
  const [loadingAction, setLoadingAction] = useState<RegisterAction>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (initialReferralCode) {
      setReferralCode(initialReferralCode);
    }
  }, [initialReferralCode]);

  useEffect(() => {
    setRole(initialRole);
  }, [initialRole]);

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
        { email: normalizedEmail, name: buildDisplayNameFromEmail(normalizedEmail) },
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
        { email: normalizedEmail, code: verificationCode.trim() },
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

  const submitLabel =
    step === "email" ? "Send code" : step === "code" ? "Verify code" : "Create account";

  return (
    <View className="gap-3">
      {/* Role first: it changes what the account *is*, and it is also what lets
          the Google button below skip its own role sheet. */}
      <View className="h-14 flex-row items-center rounded-2xl border border-border bg-card p-1.5">
        {(["STUDENT", "TEACHER"] as const).map((option) => {
          const active = role === option;

          return (
            <TouchableOpacity
              key={option}
              onPress={() => setRole(option)}
              activeOpacity={0.85}
              className={`h-full flex-1 flex-row items-center justify-center gap-2 rounded-xl ${
                active ? "bg-primary" : ""
              }`}
            >
              <Ionicons
                name={option === "STUDENT" ? "school-outline" : "person-outline"}
                size={17}
                color={active ? "#FFFFFF" : iconColor}
              />
              <Text
                className={`text-[14px] font-semibold ${
                  active ? "text-primary-foreground" : "text-muted-foreground"
                }`}
              >
                {option === "STUDENT" ? "Student" : "Teacher"}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* The email box stays visible through every step, so the address being
          verified is never off-screen; editing it rewinds to step one. */}
      <AuthField
        label="Email Address"
        icon="mail-outline"
        value={email}
        onChangeText={handleEmailChange}
        placeholder="you@example.com"
        placeholderTextColor="#A8A29E"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
      />

      {step === "code" ? (
        <View className="gap-1">
          <AuthField
            label="Verification Code"
            icon="keypad-outline"
            value={verificationCode}
            onChangeText={setVerificationCode}
            placeholder="000000"
            placeholderTextColor="#A8A29E"
            keyboardType="number-pad"
            autoComplete="one-time-code"
            maxLength={6}
          />
          <TouchableOpacity
            onPress={handleSendCode}
            disabled={loadingAction === "send-code"}
            className="self-end py-1"
            activeOpacity={0.7}
          >
            <Text className="text-[13px] font-semibold text-primary">Resend code</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {step === "password" ? (
        <>
          <AuthField
            label="Password"
            icon="lock-closed-outline"
            secure
            value={password}
            onChangeText={setPassword}
            placeholder="At least 8 characters"
            placeholderTextColor="#A8A29E"
            autoComplete="new-password"
          />
          <AuthField
            label="Referral Code (optional)"
            icon="gift-outline"
            value={referralCode}
            onChangeText={setReferralCode}
            placeholder="Enter referral code"
            placeholderTextColor="#A8A29E"
            autoCapitalize="characters"
          />
        </>
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
        className="mt-1 h-14 items-center justify-center rounded-full bg-primary"
        activeOpacity={0.85}
      >
        {loadingAction !== null ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text className="text-[16px] font-semibold text-primary-foreground">
            {submitLabel}
          </Text>
        )}
      </TouchableOpacity>

      <View className="pt-3">
        {/* The role toggle above already answered the question the sheet would
            ask, so `presetRole` skips it. Sign-in is still tried first, so
            picking Google with an existing account signs in instead of failing
            with "already registered". */}
        <AuthSocialBlock
          presetRole={role}
          referralCode={referralCode}
          disabled={loadingAction !== null}
          onError={(message) => setFormError(message || null)}
          configured={isGoogleSignInConfigured}
          unavailableNote="Google sign-up is not configured yet."
        />
      </View>
    </View>
  );
}
