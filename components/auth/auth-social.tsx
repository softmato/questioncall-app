import { Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { GoogleContinueButton } from "@/components/auth/google-continue-button";
import type { SignupRole } from "@/components/auth/role-picker-modal";
import { useAppTheme } from "@/hooks/use-app-theme";

/** The "Or" rule plus every third-party option, shared by both auth tabs. */
export function AuthSocialBlock({
  presetRole,
  referralCode,
  disabled,
  onError,
  configured,
  unavailableNote,
}: {
  presetRole?: SignupRole;
  referralCode?: string;
  disabled?: boolean;
  onError: (message: string) => void;
  configured: boolean;
  unavailableNote: string;
}) {
  const { iconColor } = useAppTheme();

  return (
    <View className="gap-4">
      <View className="flex-row items-center gap-3">
        <View className="h-px flex-1 bg-border" />
        <Text className="text-[13px] text-muted-foreground">Or</Text>
        <View className="h-px flex-1 bg-border" />
      </View>

      {configured ? (
        <GoogleContinueButton
          variant="secondary"
          label="Google"
          presetRole={presetRole}
          referralCode={referralCode}
          disabled={disabled}
          onError={onError}
        />
      ) : (
        <View className="opacity-60">
          <TouchableOpacity
            disabled
            className="h-14 flex-row items-center justify-center gap-2 rounded-full border border-border bg-card"
            activeOpacity={0.85}
          >
            <Ionicons name="logo-google" size={19} color={iconColor} />
            <Text className="text-[16px] font-semibold text-card-foreground">Google</Text>
          </TouchableOpacity>
          <Text className="px-2 pt-2 text-center text-[12px] text-muted-foreground">
            {unavailableNote}
          </Text>
        </View>
      )}
    </View>
  );
}
