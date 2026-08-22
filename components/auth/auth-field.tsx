import { forwardRef, useState } from "react";
import {
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextInputProps,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * The boxed field used across the auth screen: a soft icon chip on the left,
 * the label sitting above the value inside the box, and an optional reveal
 * toggle on the right.
 *
 * The label lives inside the border rather than above it so a stack of these
 * reads as one block of fields instead of a list of label/input pairs.
 */
export const AuthField = forwardRef<
  TextInput,
  {
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    secure?: boolean;
  } & TextInputProps
>(function AuthField({ label, icon, secure, ...inputProps }, ref) {
  const { borderColor, primaryColor, mutedIconColor, isDark } = useAppTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  return (
    <View
      className="h-[68px] flex-row items-center rounded-2xl bg-card px-3"
      style={{
        borderWidth: 1,
        borderColor: focused ? primaryColor : borderColor,
      }}
    >
      <View
        className="mr-3 h-10 w-10 items-center justify-center rounded-full"
        style={{ backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "#F5F5F4" }}
      >
        <Ionicons name={icon} size={18} color={focused ? primaryColor : mutedIconColor} />
      </View>

      <View className="flex-1 justify-center">
        <Text className="text-[11px] font-medium text-muted-foreground">{label}</Text>
        <TextInput
          ref={ref}
          {...inputProps}
          secureTextEntry={secure && !revealed}
          onFocus={(event) => {
            setFocused(true);
            inputProps.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            inputProps.onBlur?.(event);
          }}
          className="p-0 text-[15px] font-medium text-foreground"
          style={{ paddingVertical: 2 }}
        />
      </View>

      {secure ? (
        <TouchableOpacity
          onPress={() => setRevealed((current) => !current)}
          className="h-10 w-10 items-center justify-center"
          activeOpacity={0.7}
        >
          <Ionicons
            name={revealed ? "eye-off-outline" : "eye-outline"}
            size={19}
            color={mutedIconColor}
          />
        </TouchableOpacity>
      ) : null}
    </View>
  );
});
