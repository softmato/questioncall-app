import { useEffect, useRef, useState, type ComponentProps } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useIsFocused } from "@react-navigation/native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { LinearGradient } from "expo-linear-gradient";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";

import { openWebCheckout } from "@/lib/web-checkout";

import { BottomSheetSurface } from "@/components/ui/bottom-sheet-surface";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import {
  addMyQuestion,
  markOptimistic,
  normalizeFeedQuestion,
  prependQuestion,
  removeQuestion,
  unmarkOptimistic,
} from "@/store/slices/feedSlice";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useFilterOptions } from "@/hooks/use-filter-options";
import {
  LEVEL_OPTIONS,
  STREAM_OPTIONS,
  SUBJECT_OPTIONS,
  mergeAcademicOptions,
} from "@/constants/academic-options";
import { api } from "@/lib/api";
import { clearAskDraft, getAskDraftImages, setAskDraftImages } from "@/lib/ask-draft";
import {
  buildAnswerFormatFromSelection,
  toggleSelectableAnswerFormat,
  type SelectableAnswerFormat,
} from "@/lib/question-format";

type Visibility = "PUBLIC" | "PRIVATE";
type IoniconName = ComponentProps<typeof Ionicons>["name"];
type CaptureMode = "camera" | "review";

type PendingImage = {
  id: string;
  uri: string;
  fileName: string;
  mimeType: string;
};

const FORMAT_OPTIONS: {
  value: SelectableAnswerFormat;
  label: string;
  icon: IoniconName;
}[] = [
  { value: "ANY", label: "Any", icon: "sparkles-outline" },
  { value: "TEXT", label: "Text", icon: "text-outline" },
  { value: "PHOTO", label: "Photo", icon: "image-outline" },
];

const MAX_IMAGES = 4;
const TITLE_MIN_CHARS = 3;
const TITLE_MAX = 180;

/**
 * The ask flow is a camera surface, so it stays dark in both themes — the way
 * every native camera UI does. Only the sheets layered on top of it pick up
 * the app's green accent.
 */
const CAM = {
  bg: "#0B0B0D",
  surface: "#17171A",
  text: "#F5F5F4",
  muted: "rgba(245,245,244,0.62)",
  faint: "rgba(245,245,244,0.38)",
  line: "rgba(255,255,255,0.14)",
  chip: "rgba(255,255,255,0.08)",
  primary: "#0A8A4B",
  danger: "#ef4444",
};

export default function AskScreen() {
  const user = useAppSelector((s) => s.user.data);
  const isTeacher = user?.role === "TEACHER";

  if (isTeacher) return <TeacherActionsScreen />;
  return <StudentAskScreen />;
}

function StudentAskScreen() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.user.data);
  const { options: filterOptions } = useFilterOptions();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { width: windowWidth } = useWindowDimensions();

  // The viewfinder is sized from the space it is actually given, measured once
  // on layout. Every row around it renders in both modes and the captured
  // shots are overlaid *inside* the frame, so that space never changes — the
  // frame must never shrink just because a photo was taken.
  const [frameBox, setFrameBox] = useState({ width: 0, height: 0 });
  const frameSize = Math.min(
    frameBox.width || windowWidth - 32,
    frameBox.height || windowWidth - 32,
  );

  const cameraRef = useRef<CameraView | null>(null);
  const autoAskedRef = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();

  const [mode, setMode] = useState<CaptureMode>("camera");
  // The button in the corner is a torch switch, not a capture-flash mode —
  // tapping it lights the scene up straight away, which is what people expect
  // when they are pointing a camera at a page in a dim room.
  const [torchOn, setTorchOn] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);

  // Seeded from the in-memory draft so leaving the tab and coming back keeps
  // whatever was already captured (see lib/ask-draft).
  const [pendingImages, setPendingImages] = useState<PendingImage[]>(() =>
    getAskDraftImages(),
  );
  const [previewIndex, setPreviewIndex] = useState(0);

  const [title, setTitle] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [titleSheetOpen, setTitleSheetOpen] = useState(false);
  const [optionsSheetOpen, setOptionsSheetOpen] = useState(false);

  const [selectedFormats, setSelectedFormats] = useState<SelectableAnswerFormat[]>([
    "ANY",
  ]);
  const [visibility, setVisibility] = useState<Visibility>("PUBLIC");
  const [subject, setSubject] = useState<string>("");
  const [stream, setStream] = useState<string>("");
  const [level, setLevel] = useState<string>("");

  const [isPosting, setIsPosting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  const effectiveLimit = (user?.maxQuestions ?? 0) + (user?.bonusQuestions ?? 0);
  const quotaUsed = user?.questionsAsked ?? 0;
  const quotaLeft = Math.max(0, effectiveLimit - quotaUsed);
  const quotaExhausted = quotaLeft <= 0;

  const titleLen = title.trim().length;
  const hasTitle = titleLen >= TITLE_MIN_CHARS;
  const titleTooLong = titleLen > TITLE_MAX;
  const hasImages = pendingImages.length > 0;
  // A question only needs *something* to answer — a photo or a typed title.
  // Neither is mandatory on its own any more.
  const canSubmit =
    (hasImages || hasTitle) && !titleTooLong && !isPosting && !quotaExhausted;
  const isFull = pendingImages.length >= MAX_IMAGES;

  const subjectOptions = mergeAcademicOptions(filterOptions.subjects, SUBJECT_OPTIONS);
  const streamOptions = mergeAcademicOptions(filterOptions.streams, STREAM_OPTIONS);
  const levelOptions = mergeAcademicOptions(filterOptions.levels, LEVEL_OPTIONS);

  const optionsSummary = [
    subject.trim(),
    stream.trim(),
    level.trim(),
    visibility === "PRIVATE" ? "Private" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // The viewfinder *is* the screen, so ask for access the moment it opens —
  // but only once. Re-asking on every permission change would re-prompt in a
  // loop after the first denial, since `canAskAgain` stays true.
  useEffect(() => {
    if (autoAskedRef.current) return;
    if (permission && !permission.granted && permission.canAskAgain) {
      autoAskedRef.current = true;
      void requestPermission();
    }
  }, [permission, requestPermission]);

  useEffect(() => {
    setPreviewIndex((idx) => Math.min(idx, Math.max(0, pendingImages.length - 1)));
    if (pendingImages.length === 0) setMode("camera");
  }, [pendingImages.length]);

  // Mirror every change into the draft so it survives navigation — but only
  // navigation. Nothing here is written to disk.
  useEffect(() => {
    setAskDraftImages(pendingImages);
  }, [pendingImages]);

  function toggleFormat(next: SelectableAnswerFormat) {
    setSelectedFormats((prev) => toggleSelectableAnswerFormat(prev, next));
  }

  function toggleTorch() {
    setTorchOn((prev) => !prev);
  }

  function addAssets(
    assets: { uri: string; fileName?: string | null; mimeType?: string | null }[],
  ) {
    setPendingImages((prev) => {
      const remaining = MAX_IMAGES - prev.length;
      const next = assets.slice(0, remaining).map<PendingImage>((asset, i) => ({
        id: `${asset.uri}-${Date.now()}-${i}`,
        uri: asset.uri,
        fileName: asset.fileName ?? `question-${Date.now()}-${i}.jpg`,
        mimeType: asset.mimeType ?? "image/jpeg",
      }));
      const merged = [...prev, ...next];
      setPreviewIndex(Math.max(0, merged.length - 1));
      return merged;
    });
  }

  async function capture() {
    if (quotaExhausted || isCapturing || isPosting) return;
    if (isFull) {
      Toast.show({ type: "info", text1: `You can attach up to ${MAX_IMAGES} photos.` });
      setMode("review");
      return;
    }
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        Toast.show({
          type: "error",
          text1: "Camera permission is required to capture your question.",
        });
      }
      return;
    }
    if (!cameraReady) return;

    try {
      setIsCapturing(true);
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.7 });
      if (!photo?.uri) return;
      addAssets([
        {
          uri: photo.uri,
          fileName: `question-${Date.now()}.jpg`,
          mimeType: "image/jpeg",
        },
      ]);
      setMode("review");
    } catch {
      Toast.show({ type: "error", text1: "Couldn't capture that photo. Try again." });
    } finally {
      setIsCapturing(false);
    }
  }

  async function pickFromGallery() {
    if (isFull) {
      Toast.show({ type: "info", text1: `You can attach up to ${MAX_IMAGES} photos.` });
      return;
    }

    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Toast.show({
        type: "error",
        text1: "Photo library permission is required to attach images.",
      });
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: MAX_IMAGES - pendingImages.length,
      quality: 0.85,
    });

    if (result.canceled) return;
    addAssets(result.assets);
    setMode("review");
  }

  function removeImage(id: string) {
    setPendingImages((prev) => prev.filter((img) => img.id !== id));
  }

  function retake() {
    const current = pendingImages[previewIndex];
    if (current) removeImage(current.id);
    setMode("camera");
  }

  async function uploadPendingImages(): Promise<string[]> {
    if (pendingImages.length === 0) return [];

    const uploaded: string[] = [];
    for (let i = 0; i < pendingImages.length; i++) {
      const img = pendingImages[i];
      setUploadStatus(
        pendingImages.length === 1
          ? "Uploading your photo…"
          : `Uploading photo ${i + 1} of ${pendingImages.length}…`,
      );

      const form = new FormData();
      form.append("file", {
        uri: img.uri,
        name: img.fileName,
        type: img.mimeType,
      } as unknown as Blob);

      const res = await api.post("/upload", form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 30000,
      });

      const url = res.data?.secure_url ?? res.data?.url;
      if (typeof url === "string" && url) uploaded.push(url);
    }

    setUploadStatus(null);
    return uploaded;
  }

  async function handlePost() {
    if (quotaExhausted) return;
    if (!hasImages && !hasTitle) {
      Toast.show({ type: "error", text1: "Capture a photo or add a short title first." });
      return;
    }
    if (titleTooLong) {
      Toast.show({
        type: "error",
        text1: `Title is too long (max ${TITLE_MAX} characters).`,
      });
      return;
    }

    setIsPosting(true);
    const tempId = `temp_${Date.now()}`;
    const now = new Date().toISOString();
    const answerFormat = buildAnswerFormatFromSelection(selectedFormats);
    const trimmedTitle = title.trim();
    const trimmedSubject = subject.trim();
    const trimmedStream = stream.trim();
    const trimmedLevel = level.trim();

    const optimistic = normalizeFeedQuestion({
      id: tempId,
      title: trimmedTitle,
      body: "",
      answerFormat,
      answerVisibility: visibility,
      subject: trimmedSubject || undefined,
      stream: trimmedStream || undefined,
      level: trimmedLevel || undefined,
      status: "OPEN",
      resetCount: 0,
      askerId: user?._id ?? "",
      askerName: user?.name ?? "You",
      askerUsername: user?.username,
      askerImage: user?.image,
      images: pendingImages.map((img) => img.uri),
      reactions: [],
      answerCount: 0,
      reactionCount: 0,
      commentCount: 0,
      channelId: null,
      acceptedById: null,
      acceptedAt: null,
      acceptedByName: null,
      createdAt: now,
      updatedAt: now,
    });
    dispatch(prependQuestion(optimistic));
    dispatch(addMyQuestion(optimistic));
    dispatch(markOptimistic(tempId));

    try {
      const imageUrls = await uploadPendingImages();

      const res = await api.post("/questions", {
        title: trimmedTitle || undefined,
        answerFormat,
        answerVisibility: visibility,
        subject: trimmedSubject || undefined,
        stream: trimmedStream || undefined,
        level: trimmedLevel || undefined,
        images: imageUrls.length > 0 ? imageUrls : undefined,
      });

      const created = normalizeFeedQuestion(res.data);
      dispatch(unmarkOptimistic(tempId));
      dispatch(removeQuestion(tempId));
      dispatch(prependQuestion(created));
      dispatch(addMyQuestion(created));

      // Reset
      setTitle("");
      setTitleDraft("");
      setSelectedFormats(["ANY"]);
      setVisibility("PUBLIC");
      setSubject("");
      setStream("");
      setLevel("");
      setPendingImages([]);
      clearAskDraft();
      setMode("camera");
      Toast.show({ type: "success", text1: "Question posted." });
      router.replace("/(tabs)/feed");
    } catch (err: any) {
      dispatch(unmarkOptimistic(tempId));
      dispatch(removeQuestion(tempId));
      const status = err?.response?.status;
      const apiMessage = err?.response?.data?.error ?? err?.response?.data?.message;
      const message =
        status === 401 && pendingImages.length > 0
          ? "Image upload isn't enabled for the mobile app yet. Try posting without images."
          : (apiMessage ?? "Failed to post question.");
      Toast.show({ type: "error", text1: message });
    } finally {
      setIsPosting(false);
      setUploadStatus(null);
    }
  }

  const previewImage =
    pendingImages[previewIndex] ?? pendingImages[pendingImages.length - 1];
  const flashIcon: IoniconName = torchOn ? "flash" : "flash-off";
  const cameraLive = isFocused && mode === "camera" && permission?.granted === true;

  return (
    <View style={{ flex: 1, backgroundColor: CAM.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={CAM.bg} />

      {/* ── Top bar ─────────────────────────────────────────── */}
      <View
        style={{
          paddingTop: insets.top + 6,
          paddingHorizontal: 16,
          paddingBottom: 4,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <TouchableOpacity
          onPress={() => (mode === "review" ? setMode("camera") : router.back())}
          hitSlop={10}
          activeOpacity={0.7}
          style={styles.iconButton}
        >
          <Ionicons name="arrow-back" size={24} color={CAM.text} />
        </TouchableOpacity>

        <View style={styles.quotaPill}>
          <Ionicons
            name={quotaExhausted ? "alert-circle" : "flash-outline"}
            size={12}
            color={quotaExhausted ? CAM.danger : CAM.primary}
          />
          <Text
            style={{
              fontSize: 11.5,
              fontWeight: "600",
              color: quotaExhausted ? CAM.danger : CAM.text,
            }}
          >
            {quotaExhausted ? "Quota used" : `${quotaLeft} of ${effectiveLimit} left`}
          </Text>
        </View>

        {mode === "camera" ? (
          <TouchableOpacity
            onPress={toggleTorch}
            hitSlop={10}
            activeOpacity={0.7}
            style={styles.iconButton}
          >
            <Ionicons
              name={flashIcon}
              size={22}
              color={torchOn ? CAM.primary : CAM.text}
            />
          </TouchableOpacity>
        ) : (
          <View style={styles.iconButton} />
        )}
      </View>

      {/* ── Brand lockup ────────────────────────────────────── */}
      <View style={styles.brand}>
        <Image
          source={require("../assets/images/logo.png")}
          style={{ width: 72, height: 40 }}
          resizeMode="contain"
        />
        <Text style={styles.brandName}>QuestionCall</Text>
      </View>

      {/* ── Prompt ──────────────────────────────────────────── */}
      <View style={styles.promptRow}>
        <Text style={styles.prompt} numberOfLines={2}>
          {mode === "review"
            ? "Looks good? Post it — the rest is optional"
            : "Please align your question within the frame"}
        </Text>
      </View>

      {/* ── Viewfinder / captured preview ───────────────────── */}
      <View
        style={styles.frameWrap}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setFrameBox((prev) =>
            Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
              ? prev
              : { width, height },
          );
        }}
      >
        <View style={[styles.frame, { width: frameSize, height: frameSize }]}>
          {mode === "review" && previewImage ? (
            <Image
              source={{ uri: previewImage.uri }}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
            />
          ) : cameraLive ? (
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              facing="back"
              flash={torchOn ? "on" : "off"}
              enableTorch={torchOn}
              onCameraReady={() => setCameraReady(true)}
            />
          ) : (
            <PermissionPlaceholder
              permission={permission}
              onRequest={() => void requestPermission()}
              onGallery={() => void pickFromGallery()}
            />
          )}

          <ScanSweep
            size={frameSize}
            active={cameraLive && !quotaExhausted && !uploadStatus}
          />

          <FrameCorners />

          {quotaExhausted ? (
            <View style={styles.frameScrim}>
              <Ionicons name="lock-closed-outline" size={30} color={CAM.text} />
              <Text style={styles.scrimTitle}>You&apos;ve used all your questions</Text>
              <TouchableOpacity
                onPress={() => void openWebCheckout("subscription")}
                activeOpacity={0.85}
                style={styles.scrimButton}
              >
                <Ionicons name="open-outline" size={14} color="#fff" />
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>
                  Get more questions
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {uploadStatus ? (
            <View style={styles.frameScrim}>
              <ActivityIndicator color="#fff" />
              <Text style={[styles.scrimTitle, { marginTop: 12 }]}>{uploadStatus}</Text>
            </View>
          ) : null}

          {/* Captured shots ride along the bottom of the frame — overlaid, so
              taking a photo never steals height from the viewfinder. */}
          {hasImages && !uploadStatus ? (
            <View style={styles.shotStrip}>
              <LinearGradient
                colors={["rgba(0,0,0,0)", "rgba(0,0,0,0.75)"]}
                style={StyleSheet.absoluteFill}
              />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8, padding: 10, alignItems: "center" }}
              >
                {pendingImages.map((img, index) => {
                  const active = mode === "review" && index === previewIndex;
                  return (
                    <Pressable
                      key={img.id}
                      onPress={() => {
                        setPreviewIndex(index);
                        setMode("review");
                      }}
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: 10,
                        overflow: "hidden",
                        borderWidth: active ? 2 : 1,
                        borderColor: active ? CAM.primary : "rgba(255,255,255,0.55)",
                      }}
                    >
                      <Image
                        source={{ uri: img.uri }}
                        style={{ width: "100%", height: "100%" }}
                        resizeMode="cover"
                      />
                      <Pressable
                        onPress={() => removeImage(img.id)}
                        hitSlop={6}
                        style={styles.thumbRemove}
                      >
                        <Ionicons name="close" size={11} color="#fff" />
                      </Pressable>
                    </Pressable>
                  );
                })}
                {!isFull && mode === "review" ? (
                  <TouchableOpacity
                    onPress={() => setMode("camera")}
                    activeOpacity={0.8}
                    style={styles.thumbAdd}
                  >
                    <Ionicons name="add" size={20} color={CAM.text} />
                  </TouchableOpacity>
                ) : null}
              </ScrollView>
            </View>
          ) : null}
        </View>
      </View>

      {/* ── Gallery picker (rendered in both modes so nothing reflows) ── */}
      <TouchableOpacity
        onPress={() => void pickFromGallery()}
        disabled={quotaExhausted || isFull}
        activeOpacity={0.8}
        style={[styles.ghostButton, { opacity: quotaExhausted || isFull ? 0.45 : 1 }]}
      >
        <Ionicons name="image-outline" size={21} color={CAM.text} />
        <Text style={styles.ghostButtonLabel}>Upload from Gallery</Text>
      </TouchableOpacity>

      {/* ── Optional extras ─────────────────────────────────── */}
      <View style={styles.extrasRow}>
        <OptionalChip
          icon="create-outline"
          label={title.trim() ? title.trim() : "Add a title"}
          active={Boolean(title.trim())}
          onPress={() => {
            setTitleDraft(title);
            setTitleSheetOpen(true);
          }}
        />
        <OptionalChip
          icon="options-outline"
          label={optionsSummary || "More options"}
          active={Boolean(optionsSummary)}
          onPress={() => setOptionsSheetOpen(true)}
        />
      </View>

      {/* ── Primary action ──────────────────────────────────── */}
      <View style={{ paddingBottom: insets.bottom + 12, paddingTop: 12 }}>
        <TouchableOpacity
          onPress={() => void (mode === "review" ? handlePost() : capture())}
          disabled={
            mode === "review" ? !canSubmit : quotaExhausted || isCapturing || isPosting
          }
          activeOpacity={0.85}
          style={[
            styles.primaryButton,
            {
              opacity:
                mode === "review"
                  ? canSubmit
                    ? 1
                    : 0.45
                  : quotaExhausted || isPosting
                    ? 0.45
                    : 1,
            },
          ]}
        >
          {isPosting || isCapturing ? (
            <ActivityIndicator color={CAM.bg} />
          ) : mode === "review" ? (
            <>
              <Ionicons name="send" size={19} color="#111111" />
              <Text style={styles.primaryButtonLabel}>POST QUESTION</Text>
            </>
          ) : (
            <>
              <Ionicons name="camera" size={20} color="#111111" />
              <Text style={styles.primaryButtonLabel}>CAPTURE PHOTO</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Fixed height: this row appears and disappears with state, and any
            change here would resize the viewfinder above it. */}
        <View style={styles.linkRow}>
          {mode === "review" ? (
            <TouchableOpacity
              onPress={retake}
              disabled={isPosting}
              activeOpacity={0.7}
              hitSlop={8}
            >
              <Text style={styles.linkAction}>Retake photo</Text>
            </TouchableOpacity>
          ) : canSubmit ? (
            <TouchableOpacity
              onPress={() => void handlePost()}
              disabled={isPosting}
              activeOpacity={0.7}
              hitSlop={8}
            >
              <Text style={styles.linkAction}>
                {hasImages
                  ? `Post ${pendingImages.length} photo${pendingImages.length > 1 ? "s" : ""} now`
                  : "Post without a photo"}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* ── Title sheet (optional) ──────────────────────────── */}
      <Sheet
        visible={titleSheetOpen}
        heading="Add a title"
        subheading="Optional — a photo on its own is enough."
        onClose={() => setTitleSheetOpen(false)}
      >
        <TextInput
          value={titleDraft}
          onChangeText={setTitleDraft}
          placeholder="e.g. Stuck on question 4b"
          placeholderTextColor={CAM.faint}
          maxLength={TITLE_MAX}
          multiline
          autoFocus
          style={styles.sheetInput}
        />
        <Text style={{ marginTop: 8, color: CAM.faint, fontSize: 11.5 }}>
          {titleDraft.trim().length}/{TITLE_MAX}
        </Text>
        <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
          <TouchableOpacity
            onPress={() => {
              setTitleDraft("");
              setTitle("");
              setTitleSheetOpen(false);
            }}
            activeOpacity={0.8}
            style={[styles.secondaryAction, { flex: 1 }]}
          >
            <Text style={{ color: CAM.text, fontWeight: "700", fontSize: 14 }}>
              Clear
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              setTitle(titleDraft);
              setTitleSheetOpen(false);
            }}
            activeOpacity={0.85}
            style={[styles.primaryAction, { backgroundColor: CAM.primary }]}
          >
            <Text style={{ color: "#fff", fontWeight: "800", fontSize: 15 }}>Done</Text>
          </TouchableOpacity>
        </View>
      </Sheet>

      {/* ── More options sheet (optional) ───────────────────── */}
      <Sheet
        visible={optionsSheetOpen}
        heading="More options"
        subheading="All optional — skip it and just post."
        onClose={() => setOptionsSheetOpen(false)}
      >
        <ScrollView
          style={{ maxHeight: 420 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.sheetLabel}>Preferred answer format</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {FORMAT_OPTIONS.map((opt) => {
              const active = selectedFormats.includes(opt.value);
              return (
                <TouchableOpacity
                  key={opt.value}
                  onPress={() => toggleFormat(opt.value)}
                  activeOpacity={0.85}
                  style={[styles.pillOption, active ? styles.pillOptionActive : null]}
                >
                  <Ionicons
                    name={opt.icon}
                    size={14}
                    color={active ? CAM.primary : CAM.muted}
                  />
                  <Text
                    style={{
                      fontSize: 12.5,
                      fontWeight: "700",
                      color: active ? CAM.primary : CAM.muted,
                    }}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.sheetLabel}>Who can see the answer</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <VisibilityButton
              label="Public"
              description="Anyone in the feed"
              icon="globe-outline"
              active={visibility === "PUBLIC"}
              onPress={() => setVisibility("PUBLIC")}
            />
            <VisibilityButton
              label="Private"
              description="Only you & teacher"
              icon="lock-closed-outline"
              active={visibility === "PRIVATE"}
              onPress={() => setVisibility("PRIVATE")}
            />
          </View>

          <ChipGroup
            label="Subject"
            options={subjectOptions}
            value={subject}
            onChange={setSubject}
          />
          <ChipGroup
            label="Stream"
            options={streamOptions}
            value={stream}
            onChange={setStream}
          />
          <ChipGroup
            label="Level"
            options={levelOptions}
            value={level}
            onChange={setLevel}
          />
        </ScrollView>

        <TouchableOpacity
          onPress={() => setOptionsSheetOpen(false)}
          activeOpacity={0.85}
          style={[styles.primaryAction, { backgroundColor: CAM.primary, marginTop: 16 }]}
        >
          <Text style={{ color: "#fff", fontWeight: "800", fontSize: 15 }}>Done</Text>
        </TouchableOpacity>
      </Sheet>
    </View>
  );
}

// ─── Capture-screen pieces ─────────────────────────────────────────────

/**
 * The scanner sweep. It is decoration, not detection — but it tells you at a
 * glance that the frame is live, which a still viewfinder never does.
 */
function ScanSweep({ size, active }: { size: number; active: boolean }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active || size <= 0) return;

    progress.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, size, progress]);

  if (!active || size <= 0) return null;

  const bandHeight = Math.round(size * 0.28);
  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-bandHeight, size - bandHeight],
  });

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          height: bandHeight,
          transform: [{ translateY }],
        }}
      >
        <LinearGradient
          colors={["rgba(10,138,75,0)", "rgba(10,138,75,0.38)"]}
          style={{ flex: 1 }}
        />
        <View style={styles.scanLine} />
      </Animated.View>
    </View>
  );
}

function FrameCorners() {
  const size = 62;
  const thickness = 4.5;
  const radius = 8;
  const common = { position: "absolute" as const, width: size, height: size };

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View
        style={[
          common,
          {
            top: 0,
            left: 0,
            borderTopWidth: thickness,
            borderLeftWidth: thickness,
            borderColor: CAM.text,
            borderTopLeftRadius: radius,
          },
        ]}
      />
      <View
        style={[
          common,
          {
            top: 0,
            right: 0,
            borderTopWidth: thickness,
            borderRightWidth: thickness,
            borderColor: CAM.text,
            borderTopRightRadius: radius,
          },
        ]}
      />
      <View
        style={[
          common,
          {
            bottom: 0,
            left: 0,
            borderBottomWidth: thickness,
            borderLeftWidth: thickness,
            borderColor: CAM.text,
            borderBottomLeftRadius: radius,
          },
        ]}
      />
      <View
        style={[
          common,
          {
            bottom: 0,
            right: 0,
            borderBottomWidth: thickness,
            borderRightWidth: thickness,
            borderColor: CAM.text,
            borderBottomRightRadius: radius,
          },
        ]}
      />
    </View>
  );
}

function PermissionPlaceholder({
  permission,
  onRequest,
  onGallery,
}: {
  permission: ReturnType<typeof useCameraPermissions>[0];
  onRequest: () => void;
  onGallery: () => void;
}) {
  if (!permission) {
    return (
      <View style={styles.placeholder}>
        <ActivityIndicator color={CAM.muted} />
      </View>
    );
  }

  return (
    <View style={styles.placeholder}>
      <Ionicons name="camera-outline" size={34} color={CAM.muted} />
      <Text style={styles.placeholderTitle}>Camera access needed</Text>
      <Text style={styles.placeholderBody}>
        Allow the camera to snap your question, or pick a photo you already have.
      </Text>
      <TouchableOpacity
        onPress={permission.canAskAgain ? onRequest : onGallery}
        activeOpacity={0.85}
        style={{
          marginTop: 16,
          paddingHorizontal: 18,
          paddingVertical: 10,
          borderRadius: 999,
          backgroundColor: CAM.primary,
        }}
      >
        <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>
          {permission.canAskAgain ? "Allow camera" : "Choose from gallery"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * The quiet, optional half of the screen. These sit where the reference layout
 * puts its partner logos — present, but never in the way of capture-and-post.
 */
function OptionalChip({
  icon,
  label,
  active,
  onPress,
}: {
  icon: IoniconName;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={{
        flexShrink: 1,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? `${CAM.primary}88` : "transparent",
        backgroundColor: active ? "rgba(10,138,75,0.14)" : CAM.chip,
      }}
    >
      <Ionicons name={icon} size={14} color={active ? CAM.primary : CAM.faint} />
      <Text
        numberOfLines={1}
        style={{
          maxWidth: 150,
          fontSize: 12.5,
          fontWeight: "600",
          color: active ? CAM.text : CAM.muted,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function Sheet({
  visible,
  heading,
  subheading,
  onClose,
  children,
}: {
  visible: boolean;
  heading: string;
  subheading?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.55)",
            justifyContent: "flex-end",
          }}
          onPress={onClose}
        >
          <Pressable onPress={() => {}}>
            <BottomSheetSurface
              style={{
                backgroundColor: CAM.surface,
                borderTopLeftRadius: 26,
                borderTopRightRadius: 26,
                paddingHorizontal: 20,
                paddingTop: 14,
              }}
              basePadding={18}
            >
              <View style={{ alignItems: "center", marginBottom: 16 }}>
                <View
                  style={{
                    height: 4,
                    width: 40,
                    borderRadius: 99,
                    backgroundColor: CAM.line,
                  }}
                />
              </View>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  marginBottom: 14,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 17, fontWeight: "800", color: CAM.text }}>
                    {heading}
                  </Text>
                  {subheading ? (
                    <Text style={{ marginTop: 2, fontSize: 12, color: CAM.faint }}>
                      {subheading}
                    </Text>
                  ) : null}
                </View>
                <TouchableOpacity onPress={onClose} hitSlop={10} activeOpacity={0.7}>
                  <Ionicons name="close" size={22} color={CAM.muted} />
                </TouchableOpacity>
              </View>
              {children}
            </BottomSheetSurface>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function VisibilityButton({
  label,
  description,
  icon,
  active,
  onPress,
}: {
  label: string;
  description: string;
  icon: IoniconName;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        flex: 1,
        borderRadius: 14,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 11,
        borderColor: active ? CAM.primary : CAM.line,
        backgroundColor: active ? "rgba(10,138,75,0.14)" : "rgba(255,255,255,0.04)",
      }}
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 3 }}
      >
        <Ionicons name={icon} size={15} color={active ? CAM.primary : CAM.muted} />
        <Text
          style={{
            fontSize: 13,
            fontWeight: "700",
            color: active ? CAM.primary : CAM.muted,
          }}
        >
          {label}
        </Text>
      </View>
      <Text style={{ fontSize: 11, color: CAM.faint }}>{description}</Text>
    </TouchableOpacity>
  );
}

function ChipGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <View>
      <Text style={styles.sheetLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={`Type ${label.toLowerCase()}`}
        placeholderTextColor={CAM.faint}
        autoCapitalize="words"
        style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: CAM.line,
          backgroundColor: "rgba(255,255,255,0.04)",
          paddingHorizontal: 12,
          paddingVertical: 10,
          fontSize: 13,
          color: CAM.text,
          marginBottom: 8,
        }}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {options.map((opt) => {
          const active = value.trim().toLowerCase() === opt.toLowerCase();
          return (
            <TouchableOpacity
              key={opt}
              onPress={() => onChange(active ? "" : opt)}
              activeOpacity={0.85}
              style={[
                styles.pillOption,
                { paddingVertical: 6 },
                active ? styles.pillOptionActive : null,
              ]}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: "600",
                  color: active ? CAM.primary : CAM.muted,
                }}
              >
                {opt}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  iconButton: {
    height: 38,
    width: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  quotaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: CAM.chip,
  },
  brand: {
    alignItems: "center",
    marginTop: 6,
  },
  brandName: {
    marginTop: 1,
    color: CAM.text,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  promptRow: {
    height: 40,
    marginTop: 8,
    marginBottom: 8,
    justifyContent: "center",
  },
  prompt: {
    textAlign: "center",
    color: CAM.text,
    fontSize: 15,
    fontWeight: "500",
    paddingHorizontal: 24,
  },
  // Square viewfinder, centred in whatever vertical room is left — the same
  // proportions as the reference scanner frame.
  frameWrap: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  frame: {
    alignSelf: "center",
    borderRadius: 6,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  scanLine: {
    height: 2,
    backgroundColor: "#34D399",
    shadowColor: "#34D399",
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  frameScrim: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    backgroundColor: "rgba(0,0,0,0.72)",
  },
  scrimTitle: {
    marginTop: 10,
    color: CAM.text,
    fontSize: 14.5,
    fontWeight: "700",
    textAlign: "center",
  },
  scrimButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: CAM.primary,
  },
  placeholder: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 30,
    backgroundColor: "#121214",
  },
  placeholderTitle: {
    marginTop: 12,
    color: CAM.text,
    fontSize: 15,
    fontWeight: "700",
  },
  placeholderBody: {
    marginTop: 6,
    color: CAM.faint,
    fontSize: 12.5,
    lineHeight: 18,
    textAlign: "center",
  },
  ghostButton: {
    alignSelf: "center",
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 28,
    paddingVertical: 13,
    borderRadius: 8,
    borderWidth: 1.2,
    borderColor: "rgba(255,255,255,0.55)",
  },
  ghostButtonLabel: {
    color: CAM.text,
    fontSize: 16.5,
    fontWeight: "600",
  },
  extrasRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 22,
  },
  primaryButton: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    minWidth: 258,
    paddingHorizontal: 30,
    paddingVertical: 16,
    borderRadius: 8,
    backgroundColor: "#F3F3F1",
  },
  primaryButtonLabel: {
    color: "#111111",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  linkRow: {
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  linkAction: {
    color: CAM.muted,
    fontSize: 13.5,
    fontWeight: "600",
  },
  thumbRemove: {
    position: "absolute",
    top: 2,
    right: 2,
    height: 18,
    width: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  shotStrip: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
  },
  thumbAdd: {
    width: 52,
    height: 52,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "rgba(255,255,255,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryAction: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    height: 52,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: CAM.line,
    backgroundColor: CAM.chip,
  },
  primaryAction: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    borderRadius: 16,
  },
  sheetInput: {
    minHeight: 64,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: CAM.line,
    backgroundColor: "rgba(255,255,255,0.04)",
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: CAM.text,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: "top",
  },
  sheetLabel: {
    marginTop: 16,
    marginBottom: 8,
    fontSize: 12.5,
    fontWeight: "700",
    color: CAM.muted,
  },
  pillOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: CAM.line,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  pillOptionActive: {
    borderColor: CAM.primary,
    backgroundColor: "rgba(10,138,75,0.16)",
  },
});

// ─── Teacher Actions ───────────────────────────────────────────────────

function TeacherActionsScreen() {
  const { statusBarStyle, backgroundColor, mutedIconColor } = useAppTheme();

  return (
    <View className="flex-1 bg-background px-6 pt-14">
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />
      <TouchableOpacity
        onPress={() => router.back()}
        hitSlop={8}
        className="mb-3 h-9 w-9 items-center justify-center"
        activeOpacity={0.7}
      >
        <Ionicons name="close" size={24} color={mutedIconColor} />
      </TouchableOpacity>
      <Text className="mb-1 text-[28px] font-bold tracking-tight text-foreground">
        Actions
      </Text>
      <Text className="mb-8 text-sm leading-6 text-muted-foreground">
        Quick teacher actions
      </Text>

      <View className="gap-3">
        <ActionCard
          iconName="list-outline"
          title="View Question Feed"
          subtitle="See all open questions"
          onPress={() => router.push("/(tabs)/feed" as any)}
        />
        <ActionCard
          iconName="book-outline"
          title="Course Studio"
          subtitle="Manage your courses"
          onPress={() => router.push("/studio" as any)}
        />
        <ActionCard
          iconName="trophy-outline"
          title="Leaderboard"
          subtitle="See top rated teachers"
          onPress={() => router.push("/leaderboard" as any)}
        />
      </View>
    </View>
  );
}

function ActionCard({
  iconName,
  title,
  subtitle,
  onPress,
}: {
  iconName: IoniconName;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  const { primaryColor, primarySoftColor, mutedIconColor } = useAppTheme();

  return (
    <TouchableOpacity
      onPress={onPress}
      className="flex-row items-center rounded-2xl border border-border bg-card p-4"
      activeOpacity={0.8}
    >
      <View
        className="mr-4 h-11 w-11 items-center justify-center rounded-2xl"
        style={{ backgroundColor: primarySoftColor }}
      >
        <Ionicons name={iconName} size={22} color={primaryColor} />
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-card-foreground">{title}</Text>
        <Text className="text-sm text-muted-foreground">{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={mutedIconColor} />
    </TouchableOpacity>
  );
}
