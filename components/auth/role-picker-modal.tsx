import { useState } from "react";
import { ActivityIndicator, Modal, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useAppTheme } from "@/hooks/use-app-theme";

export type SignupRole = "STUDENT" | "TEACHER";

const OPTIONS: {
  role: SignupRole;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
}[] = [
  {
    role: "STUDENT",
    icon: "school-outline",
    title: "Student",
    description: "Post questions and get a teacher on them within minutes.",
  },
  {
    role: "TEACHER",
    icon: "person-outline",
    title: "Teacher",
    description: "Accept questions, answer live, and earn for your time.",
  },
];

/**
 * Asked once, only when Google returns an account we have never seen.
 *
 * Existing accounts already carry a role, so `/mobile/login` succeeds and this
 * never opens — which is the point of the flow: returning users go straight to
 * the feed instead of being marched through a role screen every launch.
 *
 * Centred rather than a bottom sheet, matching the other confirm dialogs in the
 * auth screens; there is no bottom inset to pad for as a result.
 */
export function RolePickerModal({
  visible,
  busy,
  error,
  onSelect,
  onDismiss,
}: {
  visible: boolean;
  busy: boolean;
  error: string | null;
  onSelect: (role: SignupRole) => void;
  onDismiss: () => void;
}) {
  const { iconColor, primaryColor } = useAppTheme();
  const [selected, setSelected] = useState<SignupRole>("STUDENT");

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      // Android back must not strand the user on a half-finished signup.
      onRequestClose={() => {
        if (!busy) onDismiss();
      }}
    >
      <View className="flex-1 items-center justify-center bg-black/55 px-6">
        <View className="w-full max-w-md rounded-[28px] border border-border bg-card px-5 py-6">
          <View className="bg-primary/10 mb-4 h-12 w-12 items-center justify-center rounded-2xl">
            <Ionicons name="people-outline" size={24} color={iconColor} />
          </View>

          <Text className="text-[22px] font-bold tracking-tight text-foreground">
            How will you use QuestionCall?
          </Text>
          <Text className="mt-2 text-[15px] leading-6 text-muted-foreground">
            Pick one to finish setting up your account.
          </Text>

          <View className="mt-5 gap-3">
            {OPTIONS.map((option) => {
              const isSelected = selected === option.role;

              return (
                <TouchableOpacity
                  key={option.role}
                  activeOpacity={0.85}
                  disabled={busy}
                  onPress={() => setSelected(option.role)}
                  className={`flex-row items-center gap-3 rounded-2xl border px-4 py-3.5 ${
                    isSelected
                      ? "bg-primary/10 border-primary"
                      : "border-border bg-background"
                  }`}
                >
                  <View
                    className={`h-10 w-10 items-center justify-center rounded-full ${
                      isSelected ? "bg-primary" : "bg-card"
                    }`}
                  >
                    <Ionicons
                      name={option.icon}
                      size={19}
                      color={isSelected ? "#FFFFFF" : iconColor}
                    />
                  </View>

                  <View className="flex-1">
                    <Text className="text-[16px] font-semibold text-card-foreground">
                      {option.title}
                    </Text>
                    <Text className="mt-0.5 text-[13px] leading-4 text-muted-foreground">
                      {option.description}
                    </Text>
                  </View>

                  <Ionicons
                    name={isSelected ? "radio-button-on" : "radio-button-off"}
                    size={20}
                    color={isSelected ? primaryColor : iconColor}
                  />
                </TouchableOpacity>
              );
            })}
          </View>

          {error ? (
            <Text className="mt-4 text-center text-[13px] leading-5 text-destructive">
              {error}
            </Text>
          ) : null}

          <TouchableOpacity
            className="mt-5 h-14 flex-row items-center justify-center rounded-full bg-primary shadow-lg"
            activeOpacity={0.85}
            disabled={busy}
            onPress={() => onSelect(selected)}
          >
            {busy ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text className="text-[16px] font-semibold text-primary-foreground">
                Continue
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
