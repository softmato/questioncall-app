import { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppTheme } from "@/hooks/use-app-theme";
import {
  confirmCallSetupItem,
  fixCallSetupItem,
  useCallSetup,
  type CallSetupItem,
} from "@/lib/call-setup";

const OK_COLOR = "#16a34a";
const WARN_COLOR = "#d97706";

/** Permission prompts say "Allow"; everything else is a trip to a settings screen. */
const PROMPTS = new Set(["notifications", "microphone", "camera"]);

export default function CallSetupScreen() {
  const insets = useSafeAreaInsets();
  const {
    statusBarStyle,
    backgroundColor,
    cardColor,
    borderColor,
    primaryColor,
    mutedIconColor,
    isDark,
  } = useAppTheme();
  const textColor = isDark ? "#f1f5f9" : "#0f172a";

  const { items, issues, refresh } = useCallSetup();
  const [busy, setBusy] = useState<string | null>(null);
  // Manual steps offer "Done" only after their settings screen was opened.
  const [opened, setOpened] = useState<Set<string>>(new Set());

  const handleFix = async (item: CallSetupItem) => {
    setBusy(item.id);
    try {
      await fixCallSetupItem(item.id);
      if (item.manual) setOpened((prev) => new Set(prev).add(item.id));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const handleConfirm = async (item: CallSetupItem) => {
    await confirmCallSetupItem(item.id);
    refresh();
  };

  const allSet = items !== null && issues === 0;

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      {/* Header */}
      <View
        style={{
          paddingTop:
            Platform.OS === "ios"
              ? Math.max(insets.top, 44)
              : (StatusBar.currentHeight ?? 0) + 8,
          paddingBottom: 12,
          paddingHorizontal: 16,
          backgroundColor,
          borderBottomWidth: 0.5,
          borderBottomColor: borderColor,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={isDark ? "#fff" : "#111"} />
        </TouchableOpacity>
        <Text style={{ fontSize: 20, fontWeight: "700", color: textColor }}>
          Call setup
        </Text>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
      >
        {items === null ? (
          <ActivityIndicator color={primaryColor} style={{ marginTop: 48 }} />
        ) : items.length === 0 ? (
          <Text style={{ fontSize: 15, color: mutedIconColor, lineHeight: 22 }}>
            Your phone handles incoming calls on its own. There is nothing to set up.
          </Text>
        ) : (
          <>
            {/* ── Summary ───────────────────────────────────── */}
            <View
              style={{
                backgroundColor: `${allSet ? OK_COLOR : WARN_COLOR}12`,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: `${allSet ? OK_COLOR : WARN_COLOR}35`,
                padding: 16,
                flexDirection: "row",
                gap: 12,
                marginBottom: 16,
              }}
            >
              <Ionicons
                name={allSet ? "checkmark-circle" : "alert-circle"}
                size={28}
                color={allSet ? OK_COLOR : WARN_COLOR}
              />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 17, fontWeight: "700", color: textColor }}>
                  {allSet
                    ? "You're all set"
                    : `${issues} ${issues === 1 ? "step" : "steps"} left`}
                </Text>
                <Text
                  style={{
                    fontSize: 13,
                    color: mutedIconColor,
                    marginTop: 4,
                    lineHeight: 19,
                  }}
                >
                  {allSet
                    ? "Calls will ring even when QuestionCall is closed or your phone is locked."
                    : "Until these are done, calls may not reach you when QuestionCall is closed or your phone is locked."}
                </Text>
              </View>
            </View>

            {/* ── Steps ─────────────────────────────────────── */}
            <View
              style={{
                backgroundColor: cardColor,
                borderRadius: 16,
                borderWidth: 1,
                borderColor,
                overflow: "hidden",
                marginBottom: 16,
              }}
            >
              {items.map((item, index) => {
                const statusColor = item.ok
                  ? OK_COLOR
                  : item.required
                    ? WARN_COLOR
                    : mutedIconColor;
                const isBusy = busy === item.id;
                return (
                  <View key={item.id}>
                    {index > 0 ? (
                      <View
                        style={{
                          height: 0.5,
                          backgroundColor: borderColor,
                          marginHorizontal: 16,
                        }}
                      />
                    ) : null}
                    <View style={{ flexDirection: "row", padding: 16 }}>
                      <View
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          backgroundColor: `${statusColor}18`,
                          alignItems: "center",
                          justifyContent: "center",
                          marginRight: 12,
                        }}
                      >
                        <Ionicons name={item.icon as any} size={18} color={statusColor} />
                      </View>

                      <View style={{ flex: 1 }}>
                        <View
                          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                        >
                          <Text
                            style={{
                              flex: 1,
                              fontSize: 16,
                              fontWeight: "600",
                              color: textColor,
                            }}
                          >
                            {item.title}
                          </Text>
                          {item.ok ? (
                            <Ionicons
                              name="checkmark-circle"
                              size={20}
                              color={OK_COLOR}
                            />
                          ) : (
                            <Text
                              style={{
                                fontSize: 12,
                                fontWeight: "600",
                                color: statusColor,
                              }}
                            >
                              {item.required ? "Needed" : "Optional"}
                            </Text>
                          )}
                        </View>
                        <Text
                          style={{
                            fontSize: 13,
                            color: mutedIconColor,
                            marginTop: 3,
                            lineHeight: 19,
                          }}
                        >
                          {item.description}
                        </Text>

                        {!item.ok ? (
                          <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                            <TouchableOpacity
                              onPress={() => handleFix(item)}
                              disabled={isBusy}
                              style={{
                                backgroundColor: primaryColor,
                                borderRadius: 10,
                                paddingVertical: 9,
                                paddingHorizontal: 16,
                                opacity: isBusy ? 0.7 : 1,
                              }}
                            >
                              {isBusy ? (
                                <ActivityIndicator color="#fff" size="small" />
                              ) : (
                                <Text
                                  style={{
                                    color: "#fff",
                                    fontWeight: "700",
                                    fontSize: 14,
                                  }}
                                >
                                  {PROMPTS.has(item.id) ? "Allow" : "Open settings"}
                                </Text>
                              )}
                            </TouchableOpacity>
                            {item.manual && opened.has(item.id) ? (
                              <TouchableOpacity
                                onPress={() => handleConfirm(item)}
                                style={{
                                  borderRadius: 10,
                                  borderWidth: 1,
                                  borderColor,
                                  paddingVertical: 9,
                                  paddingHorizontal: 16,
                                }}
                              >
                                <Text
                                  style={{
                                    color: textColor,
                                    fontWeight: "600",
                                    fontSize: 14,
                                  }}
                                >
                                  I&apos;ve turned it on
                                </Text>
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        ) : item.manual ? (
                          <TouchableOpacity
                            onPress={() => handleFix(item)}
                            hitSlop={8}
                            style={{ marginTop: 8, alignSelf: "flex-start" }}
                          >
                            <Text
                              style={{
                                color: primaryColor,
                                fontWeight: "600",
                                fontSize: 13,
                              }}
                            >
                              Open settings again
                            </Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>

            {/* ── Why ───────────────────────────────────────── */}
            <View
              style={{
                backgroundColor: `${primaryColor}08`,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: `${primaryColor}20`,
                padding: 14,
                flexDirection: "row",
                gap: 10,
              }}
            >
              <Ionicons
                name="information-circle-outline"
                size={18}
                color={primaryColor}
                style={{ marginTop: 1 }}
              />
              <Text
                style={{ flex: 1, fontSize: 13, color: mutedIconColor, lineHeight: 19 }}
              >
                Phone makers stop apps in the background to save battery. Apps like
                WhatsApp are allowed out of the box; every other app has to ask you once.
                You only do this one time.
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
