import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import type { ComponentProps } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { InlineVideo } from "@/components/media/inline-video";
import { getMediaKind } from "@/lib/media-helpers";
import type { FeedQuestion, ReactionType } from "@/types/question";

import { FEED_COLORS, getSubjectStyle, useFeedColors } from "./tokens";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

export type PeerCommentItem = {
  _id: string;
  content: string;
  createdAt: string;
  updatedAt?: string;
  studentId?: {
    _id?: string;
    name?: string;
    userImage?: string | null;
    username?: string;
  } | null;
};

type ReactionSummary = {
  like: number;
  insightful: number;
  same_doubt: number;
  total: number;
};

const ACTIONS: {
  type: ReactionType;
  icon: IoniconName;
  activeIcon: IoniconName;
  color: string;
  title: string;
}[] = [
  {
    type: "like",
    icon: "heart-outline",
    activeIcon: "heart",
    color: "#E0556B",
    title: "Like",
  },
  {
    type: "insightful",
    icon: "bulb-outline",
    activeIcon: "bulb",
    color: "#E8A317",
    title: "Insightful",
  },
  {
    type: "same_doubt",
    icon: "help-circle-outline",
    activeIcon: "help-circle",
    color: FEED_COLORS.green,
    title: "Same doubt",
  },
];

function Avatar({
  image,
  name,
  size = 42,
}: {
  image?: string | null;
  name: string;
  size?: number;
}) {
  const FEED_COLORS = useFeedColors();
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  const palette: Record<string, [string, string]> = {
    S: ["#E8F3FF", "#2563EB"],
    M: ["#FDE9E9", "#DC2626"],
    R: ["#EAF7EE", "#15A05A"],
    A: ["#F3EEFF", "#7C3AED"],
    D: ["#FFF3E0", "#D97706"],
  };
  const [bg, fg] = palette[initial] ?? [FEED_COLORS.subtle, FEED_COLORS.muted];

  if (image) {
    return (
      <Image
        source={{ uri: image }}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.5,
          borderColor: FEED_COLORS.chipBorder,
        }}
        resizeMode="cover"
      />
    );
  }

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: bg,
        borderWidth: 1.5,
        borderColor: FEED_COLORS.chipBorder,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: fg, fontSize: size * 0.4, fontWeight: "700" }}>
        {initial}
      </Text>
    </View>
  );
}

function isNewQuestion(createdAt: string) {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return false;
  return Date.now() - created < 2 * 60 * 60 * 1000;
}

function formatRating(rating?: number | null) {
  if (typeof rating !== "number") return "4.5";
  return Number(rating).toFixed(1);
}

function ActionStat({
  active,
  color,
  count,
  icon,
  activeIcon,
  onPress,
}: {
  active?: boolean;
  color: string;
  count: number;
  icon: IoniconName;
  activeIcon: IoniconName;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.72}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}
    >
      <Ionicons
        name={active ? activeIcon : icon}
        size={19}
        color={active ? color : "#7A8590"}
      />
      {count > 0 ? (
        <Text
          style={{
            color: active ? color : "#7A8590",
            fontSize: 13.5,
            fontWeight: "700",
          }}
        >
          {count}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

function QuestionImage({
  images,
  onImagePress,
}: {
  images?: string[];
  onImagePress: (url: string) => void;
}) {
  if (!images?.length) return null;
  const [first, ...rest] = images;

  return (
    <View style={{ marginTop: 13 }}>
      <TouchableOpacity onPress={() => onImagePress(first)} activeOpacity={0.86}>
        <Image
          source={{ uri: first }}
          style={{
            width: "100%",
            height: 132,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: "rgba(0,0,0,0.06)",
          }}
          resizeMode="cover"
        />
      </TouchableOpacity>
      {rest.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingTop: 8 }}
        >
          {rest.map((url) => (
            <TouchableOpacity
              key={url}
              onPress={() => onImagePress(url)}
              activeOpacity={0.86}
            >
              <Image
                source={{ uri: url }}
                style={{ width: 58, height: 58, borderRadius: 10 }}
                resizeMode="cover"
              />
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function AnswerMedia({
  item,
  onImagePress,
}: {
  item: FeedQuestion;
  onImagePress: (url: string) => void;
}) {
  const FEED_COLORS = useFeedColors();
  const mediaUrls = item.answer?.mediaUrls ?? [];
  if (mediaUrls.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingTop: 10 }}
    >
      {mediaUrls.map((url) => {
        const kind = getMediaKind(url);
        if (kind === "video") {
          return (
            <InlineVideo
              key={url}
              uri={url}
              width={200}
              height={130}
              borderColor={FEED_COLORS.greenBorder}
            />
          );
        }
        if (kind === "image") {
          return (
            <TouchableOpacity
              key={url}
              onPress={() => onImagePress(url)}
              activeOpacity={0.86}
            >
              <Image
                source={{ uri: url }}
                style={{ width: 160, height: 108, borderRadius: 12 }}
                resizeMode="cover"
              />
            </TouchableOpacity>
          );
        }

        const filename = url.split("/").pop()?.split("?")[0] ?? "Document";
        return (
          <TouchableOpacity
            key={url}
            onPress={() => Linking.openURL(url).catch(() => {})}
            activeOpacity={0.75}
            style={{
              width: 210,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: FEED_COLORS.greenBorder,
              padding: 12,
              flexDirection: "row",
              alignItems: "center",
              gap: 9,
            }}
          >
            <Ionicons name="document-outline" size={18} color={FEED_COLORS.green} />
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                color: FEED_COLORS.text,
                fontSize: 12.5,
                fontWeight: "700",
              }}
            >
              {filename}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

function AcceptedAnswer({
  item,
  isExpanded,
  onImagePress,
  onToggle,
}: {
  item: FeedQuestion;
  isExpanded: boolean;
  onImagePress: (url: string) => void;
  onToggle: () => void;
}) {
  const FEED_COLORS = useFeedColors();
  const solverId = item.answer?.acceptorId || item.acceptedById;
  const solverName = item.answer?.acceptorName || item.acceptedByName || "Teacher";

  return (
    <View
      style={{
        marginTop: 14,
        borderRadius: 15,
        backgroundColor: FEED_COLORS.greenPanel,
        borderWidth: 1,
        borderColor: FEED_COLORS.greenBorder,
        overflow: "hidden",
      }}
    >
      <TouchableOpacity
        onPress={onToggle}
        activeOpacity={0.82}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          paddingHorizontal: 15,
          paddingVertical: 12,
        }}
      >
        <Ionicons name="checkmark-circle" size={18} color={FEED_COLORS.green} />
        <Text style={{ color: FEED_COLORS.greenDark, fontSize: 13.5, fontWeight: "800" }}>
          Accepted answer
        </Text>
        <View
          style={{
            marginLeft: "auto",
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Ionicons name="star" size={14} color={FEED_COLORS.amber} />
          <Text
            style={{ color: FEED_COLORS.amberText, fontSize: 12.5, fontWeight: "700" }}
          >
            {formatRating(item.answer?.rating)}
          </Text>
        </View>
        <Ionicons
          name={isExpanded ? "chevron-up" : "chevron-down"}
          size={17}
          color="#7FA992"
        />
      </TouchableOpacity>

      {isExpanded ? (
        <View style={{ paddingHorizontal: 15, paddingBottom: 13 }}>
          {item.answer?.content ? (
            <Text style={{ color: FEED_COLORS.muted, fontSize: 14.5, lineHeight: 21.75 }}>
              {item.answer.content}
            </Text>
          ) : null}
          <AnswerMedia item={item} onImagePress={onImagePress} />
          <TouchableOpacity
            activeOpacity={solverId ? 0.72 : 1}
            disabled={!solverId}
            onPress={() => {
              if (solverId) router.push(`/user/${solverId}` as any);
            }}
            style={{
              marginTop: 12,
              paddingTop: 11,
              borderTopWidth: 1,
              borderTopColor: FEED_COLORS.greenBorder,
              flexDirection: "row",
              alignItems: "center",
              gap: 9,
            }}
          >
            <Avatar name={solverName} size={24} />
            <Text
              style={{
                flex: 1,
                color: FEED_COLORS.muted,
                fontSize: 12.5,
                fontWeight: "500",
              }}
            >
              Solved by{" "}
              <Text style={{ color: FEED_COLORS.text, fontWeight: "700" }}>
                {solverName}
              </Text>
            </Text>
            {solverId ? (
              <Ionicons name="chevron-forward" size={14} color={FEED_COLORS.softMuted} />
            ) : null}
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

export function FeedQuestionCard({
  acceptingId,
  canAccept,
  canComment,
  comments,
  commentText,
  deletingId,
  formatTimeAgo,
  isAccepted,
  isAnswerExpanded,
  isCommentsExpanded,
  isOptimistic,
  isOwnQuestion,
  isSolved,
  item,
  onAccept,
  onCommentTextChange,
  onDelete,
  onImagePress,
  onReact,
  onSubmitComment,
  onToggleAnswer,
  onToggleComments,
  questionId,
  reactionSummary,
  submittingCommentId,
  userReactionType,
}: {
  acceptingId: string | null;
  canAccept: boolean;
  canComment: boolean;
  comments: PeerCommentItem[];
  commentText: string;
  deletingId: string | null;
  formatTimeAgo: (value: string) => string;
  isAccepted: boolean;
  isAnswerExpanded: boolean;
  isCommentsExpanded: boolean;
  isOptimistic: boolean;
  isOwnQuestion: boolean;
  isSolved: boolean;
  item: FeedQuestion;
  onAccept: () => void;
  onCommentTextChange: (text: string) => void;
  onDelete: () => void;
  onImagePress: (url: string) => void;
  onReact: (type: ReactionType) => void;
  onSubmitComment: () => void;
  onToggleAnswer: () => void;
  onToggleComments: () => void;
  questionId: string;
  reactionSummary: ReactionSummary;
  submittingCommentId: string | null;
  userReactionType?: ReactionType;
}) {
  const FEED_COLORS = useFeedColors();
  const subjectStyle = getSubjectStyle(item.subject);
  const canDelete =
    isOwnQuestion && (item.status === "OPEN" || item.status === "RESET") && !isOptimistic;

  return (
    <View style={{ backgroundColor: FEED_COLORS.page, opacity: isOptimistic ? 0.72 : 1 }}>
      <View style={{ paddingHorizontal: 18, paddingVertical: 19 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 11 }}>
          <TouchableOpacity
            activeOpacity={0.65}
            disabled={!item.askerId}
            onPress={() => {
              if (item.askerId) router.push(`/user/${item.askerId}` as any);
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: 11, flex: 1 }}
          >
            <View style={{ position: "relative" }}>
              <Avatar image={item.askerImage} name={item.askerName} />
              {item.askerIsOnline ? (
                <View
                  style={{
                    position: "absolute",
                    bottom: 1,
                    right: 1,
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: "#22C55E",
                    borderWidth: 2,
                    borderColor: FEED_COLORS.page,
                  }}
                />
              ) : null}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                <Text
                  numberOfLines={1}
                  style={{ color: FEED_COLORS.text, fontSize: 15, fontWeight: "700" }}
                >
                  {item.askerName}
                </Text>
                {item.askerIsOnline ? (
                  <View
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 3.5,
                      backgroundColor: "#22C55E",
                    }}
                  />
                ) : null}
              </View>
              <View
                style={{
                  marginTop: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 7,
                }}
              >
                <Text
                  style={{
                    color: FEED_COLORS.softMuted,
                    fontSize: 12.5,
                    fontWeight: "500",
                  }}
                >
                  {formatTimeAgo(item.createdAt)}
                </Text>
                <View
                  style={{
                    width: 3,
                    height: 3,
                    borderRadius: 1.5,
                    backgroundColor: "#C7CDD3",
                  }}
                />
                <Text
                  style={{ color: subjectStyle.color, fontSize: 12, fontWeight: "700" }}
                >
                  {item.subject || "General"}
                </Text>
              </View>
            </View>
          </TouchableOpacity>

          {isOptimistic ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                borderRadius: 20,
                backgroundColor: "#FEF3C7",
                paddingHorizontal: 10,
                paddingVertical: 5,
              }}
            >
              <ActivityIndicator size={10} color="#D97706" />
              <Text style={{ color: "#B45309", fontSize: 12, fontWeight: "700" }}>
                Posting
              </Text>
            </View>
          ) : isSolved ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                borderRadius: 20,
                backgroundColor: FEED_COLORS.greenSoft,
                paddingHorizontal: 11,
                paddingVertical: 5,
              }}
            >
              <Ionicons name="checkmark-circle" size={14} color={FEED_COLORS.green} />
              <Text
                style={{
                  color: FEED_COLORS.greenDark,
                  fontSize: 12.5,
                  fontWeight: "700",
                }}
              >
                Solved
              </Text>
            </View>
          ) : isNewQuestion(item.createdAt) ? (
            <View
              style={{
                borderRadius: 20,
                backgroundColor: FEED_COLORS.greenSoft,
                paddingHorizontal: 10,
                paddingVertical: 4,
              }}
            >
              <Text style={{ color: FEED_COLORS.green, fontSize: 12, fontWeight: "700" }}>
                New
              </Text>
            </View>
          ) : null}
        </View>

        {item.title ? (
          <Text
            style={{
              marginTop: 13,
              color: FEED_COLORS.text,
              fontSize: 18,
              fontWeight: "700",
              lineHeight: 23.8,
              letterSpacing: -0.18,
            }}
          >
            {item.title}
          </Text>
        ) : null}
        {item.body ? (
          <Text
            numberOfLines={3}
            style={{
              marginTop: 6,
              color: FEED_COLORS.muted,
              fontSize: 14.5,
              lineHeight: 20.3,
            }}
          >
            {item.body}
          </Text>
        ) : null}

        <QuestionImage images={item.images} onImagePress={onImagePress} />

        {isSolved && item.answer ? (
          <AcceptedAnswer
            item={item}
            isExpanded={isAnswerExpanded}
            onToggle={onToggleAnswer}
            onImagePress={onImagePress}
          />
        ) : isAccepted ? (
          <View
            style={{
              marginTop: 14,
              borderRadius: 15,
              borderWidth: 1,
              borderColor: "#DCEEFF",
              backgroundColor: "#F2F8FF",
              paddingHorizontal: 15,
              paddingVertical: 12,
            }}
          >
            <Text style={{ color: FEED_COLORS.muted, fontSize: 13.5, fontWeight: "600" }}>
              {item.acceptedByName
                ? `${item.acceptedByName} is working on this...`
                : "Being answered..."}
            </Text>
          </View>
        ) : null}

        <View
          style={{
            marginTop: 14,
            flexDirection: "row",
            alignItems: "center",
            gap: 18,
          }}
        >
          {ACTIONS.map((action) => (
            <ActionStat
              key={action.type}
              active={userReactionType === action.type}
              color={action.color}
              count={reactionSummary[action.type]}
              icon={action.icon}
              activeIcon={action.activeIcon}
              onPress={() => onReact(action.type)}
            />
          ))}

          <View
            style={{
              marginLeft: "auto",
              flexDirection: "row",
              alignItems: "center",
              gap: 16,
            }}
          >
            <ActionStat
              active={isCommentsExpanded}
              color={FEED_COLORS.green}
              count={item.commentCount}
              icon="chatbubble-outline"
              activeIcon="chatbubble"
              onPress={onToggleComments}
            />
            {canDelete ? (
              <TouchableOpacity
                disabled={deletingId === questionId}
                onPress={onDelete}
                activeOpacity={0.78}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 11,
                  backgroundColor: "#FEE2E2",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {deletingId === questionId ? (
                  <ActivityIndicator color="#DC2626" size="small" />
                ) : (
                  <Ionicons name="trash-outline" size={15} color="#DC2626" />
                )}
              </TouchableOpacity>
            ) : null}
            {canAccept ? (
              <TouchableOpacity
                disabled={acceptingId === questionId}
                onPress={onAccept}
                activeOpacity={0.84}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  backgroundColor: FEED_COLORS.green,
                  borderRadius: 11,
                  paddingHorizontal: 15,
                  paddingVertical: 8,
                  shadowColor: "#149650",
                  shadowOpacity: 0.28,
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: 3 },
                  elevation: 2,
                }}
              >
                {acceptingId === questionId ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="checkmark-outline" size={15} color="#fff" />
                    <Text style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>
                      Accept
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {isCommentsExpanded ? (
          <View
            style={{
              marginTop: 14,
              borderRadius: 15,
              borderWidth: 1,
              borderColor: FEED_COLORS.divider,
              backgroundColor: FEED_COLORS.subtle,
              padding: 13,
            }}
          >
            {comments.length === 0 ? (
              <Text
                style={{
                  color: FEED_COLORS.softMuted,
                  fontSize: 13.5,
                  fontWeight: "600",
                }}
              >
                No comments yet.
              </Text>
            ) : (
              <View style={{ gap: 12 }}>
                {comments.map((comment) => (
                  <View key={comment._id} style={{ flexDirection: "row", gap: 9 }}>
                    <Avatar
                      image={comment.studentId?.userImage}
                      name={comment.studentId?.name || "Anonymous"}
                      size={28}
                    />
                    <View style={{ flex: 1 }}>
                      <View
                        style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
                      >
                        <Text
                          style={{
                            color: FEED_COLORS.text,
                            fontSize: 13,
                            fontWeight: "700",
                          }}
                        >
                          {comment.studentId?.name || "Anonymous"}
                        </Text>
                        <Text style={{ color: FEED_COLORS.softMuted, fontSize: 11 }}>
                          {formatTimeAgo(comment.createdAt)}
                        </Text>
                      </View>
                      <Text
                        style={{
                          marginTop: 2,
                          color: FEED_COLORS.muted,
                          fontSize: 13.5,
                          lineHeight: 19,
                        }}
                      >
                        {comment.content}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {canComment ? (
              <View
                style={{
                  marginTop: 13,
                  paddingTop: 13,
                  borderTopWidth: 1,
                  borderTopColor: FEED_COLORS.divider,
                  flexDirection: "row",
                  alignItems: "flex-end",
                  gap: 9,
                }}
              >
                <TextInput
                  value={commentText}
                  onChangeText={onCommentTextChange}
                  placeholder="Write a comment..."
                  placeholderTextColor={FEED_COLORS.softMuted}
                  multiline
                  style={{
                    flex: 1,
                    minHeight: 38,
                    maxHeight: 100,
                    borderRadius: 13,
                    borderWidth: 1,
                    borderColor: FEED_COLORS.chipBorder,
                    backgroundColor: FEED_COLORS.page,
                    color: FEED_COLORS.text,
                    fontSize: 13.5,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    textAlignVertical: "top",
                  }}
                />
                <TouchableOpacity
                  disabled={submittingCommentId === questionId || !commentText.trim()}
                  onPress={onSubmitComment}
                  activeOpacity={0.82}
                  style={{
                    height: 38,
                    width: 38,
                    borderRadius: 13,
                    backgroundColor: FEED_COLORS.green,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: !commentText.trim() ? 0.55 : 1,
                  }}
                >
                  {submittingCommentId === questionId ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Ionicons name="send" size={15} color="#fff" />
                  )}
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}
