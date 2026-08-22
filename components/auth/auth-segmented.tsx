import { Text, TouchableOpacity, View } from "react-native";

export type AuthTab = "login" | "register";

/**
 * The Login / Register switch. Both halves are always mounted, so moving
 * between them is a state change on this screen rather than a navigation —
 * whatever the user already typed on the other side is still there when they
 * come back.
 */
export function AuthSegmented({
  value,
  onChange,
}: {
  value: AuthTab;
  onChange: (tab: AuthTab) => void;
}) {
  return (
    <View className="h-14 flex-row items-center rounded-full bg-muted p-1.5">
      {(["login", "register"] as const).map((tab) => {
        const active = value === tab;

        return (
          <TouchableOpacity
            key={tab}
            onPress={() => onChange(tab)}
            activeOpacity={0.85}
            className={`h-full flex-1 items-center justify-center rounded-full ${
              active ? "bg-primary" : ""
            }`}
          >
            <Text
              className={`text-[15px] font-semibold ${
                active ? "text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {tab === "login" ? "Login" : "Register"}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
