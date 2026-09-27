import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";

import { OnboardingVideoPlayer } from "@/components/onboarding/onboarding-video-player";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { api } from "@/lib/api";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useCallUi } from "@/lib/call-ui-store";
import {
  markOnboardingSeen,
  setOnboardingDismissing,
  type OnboardingVideo,
} from "@/store/slices/onboardingSlice";
import { updateUser } from "@/store/slices/userSlice";

export function GlobalOnboardingModal() {
  const { shouldShow, video } = useAppSelector((s) => s.onboarding);
  // Own window above the call overlay — see GlobalNoticeModal.
  const inCall = useCallUi().params !== null;

  if (!shouldShow || !video || inCall) return null;

  return <OnboardingModalBody video={video} />;
}

function OnboardingModalBody({ video }: { video: OnboardingVideo }) {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.user.data);
  const role = useAppSelector((s) => s.onboarding.role);
  const isDismissing = useAppSelector((s) => s.onboarding.isDismissing);
  const { primaryColor, mutedIconColor } = useAppTheme();
  const insets = useSafeAreaInsets();

  // Dismissing the modal in any way marks the onboarding video as seen.
  async function handleDismiss() {
    if (isDismissing) return;

    dispatch(setOnboardingDismissing(true));
    try {
      await api.post("/onboarding-video/dismiss");
      if (role) {
        dispatch(
          updateUser({
            seenOnboardingRoles: [...(user?.seenOnboardingRoles ?? []), role],
          }),
        );
      }
      dispatch(markOnboardingSeen());
    } catch (err: any) {
      dispatch(setOnboardingDismissing(false));
      Toast.show({
        type: "error",
        text1:
          err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Unable to mark onboarding complete.",
      });
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={handleDismiss}>
      <View
        className="flex-1 justify-end bg-black/50 px-4"
        style={{ paddingBottom: insets.bottom + 24 }}
      >
        <View className="max-h-[88%] overflow-hidden rounded-[28px] border border-border bg-card">
          <View className="flex-row items-center gap-3 border-b border-border px-5 py-4">
            <Image
              source={require("../../assets/images/logo.png")}
              style={{ width: 34, height: 34 }}
              resizeMode="contain"
            />
            <View className="flex-1">
              <Text className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {role ?? "Onboarding"}
              </Text>
              <Text className="text-lg font-bold text-card-foreground" numberOfLines={1}>
                QuestionCall
              </Text>
            </View>
            <TouchableOpacity
              onPress={handleDismiss}
              disabled={isDismissing}
              className="h-10 w-10 items-center justify-center rounded-full bg-secondary"
              activeOpacity={0.8}
            >
              <Ionicons name="close" size={19} color={mutedIconColor} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            <View className="aspect-video bg-black">
              <OnboardingVideoPlayer videoUrl={video.videoUrl} />
            </View>

            <View className="p-5">
              <Text className="text-xl font-bold text-card-foreground">
                {video.title}
              </Text>
              {video.description ? (
                <Text className="mt-3 text-sm leading-6 text-muted-foreground">
                  {video.description}
                </Text>
              ) : null}
            </View>
          </ScrollView>

          <View className="border-t border-border p-5">
            <TouchableOpacity
              onPress={handleDismiss}
              disabled={isDismissing}
              className="items-center justify-center rounded-full"
              style={{ backgroundColor: primaryColor, height: 54 }}
              activeOpacity={0.85}
            >
              {isDismissing ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text className="text-base font-bold text-white">I watched this</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
