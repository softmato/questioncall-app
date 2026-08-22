import { Text, View } from "react-native";

import { useAppTheme } from "@/hooks/use-app-theme";

type Formula = {
  text: string;
  /** Which edge the line bleeds off, and by how much. */
  side: "left" | "right";
  offset: number;
  /** Distance below the top safe-area inset. */
  top: number;
  rotate: string;
  size: number;
  /** Relative weight within the layer, scaled by theme in `alpha` below. */
  strength: number;
  brand?: boolean;
};

/**
 * Textbook math drifting in from both edges behind the wordmark.
 *
 * Every line is anchored to one screen edge with a negative offset so it runs
 * off the side rather than sitting in a neat column, and the tilts alternate
 * so the eye reads a scattered page instead of a list. Opacity stays low
 * enough that this is texture, not content — if any line is legible enough to
 * distract from the headline, it is too strong.
 */
const FORMULAS: Formula[] = [
  {
    text: "a² + b² = c²",
    side: "left",
    offset: -16,
    top: 4,
    rotate: "-12deg",
    size: 30,
    strength: 1,
  },
  {
    text: "E = mc²",
    side: "right",
    offset: -20,
    top: 52,
    rotate: "9deg",
    size: 27,
    strength: 0.85,
    brand: true,
  },
  {
    text: "∫ x² dx = x³/3 + C",
    side: "left",
    offset: 22,
    top: 104,
    rotate: "-6deg",
    size: 21,
    strength: 0.7,
  },
  {
    text: "sin²θ + cos²θ = 1",
    side: "right",
    offset: -28,
    top: 150,
    rotate: "13deg",
    size: 24,
    strength: 0.9,
  },
  {
    text: "PV = nRT",
    side: "left",
    offset: -22,
    top: 206,
    rotate: "-16deg",
    size: 26,
    strength: 0.75,
    brand: true,
  },
  {
    text: "Δ = b² − 4ac",
    side: "right",
    offset: 26,
    top: 214,
    rotate: "5deg",
    size: 19,
    strength: 0.6,
  },
  // The last two run deep enough to pass behind the mark and the wordmark, so
  // the layer converges on the centre instead of only framing it. They carry
  // the least ink of the set for exactly that reason.
  {
    text: "x = (−b ± √(b² − 4ac)) / 2a",
    side: "left",
    offset: -34,
    top: 264,
    rotate: "-9deg",
    size: 22,
    strength: 0.5,
  },
  {
    text: "∑ n = n(n+1)/2",
    side: "right",
    offset: -16,
    top: 306,
    rotate: "11deg",
    size: 20,
    strength: 0.45,
  },
];

/** Tall enough to contain the lowest tilted line with room to spare. */
const LAYER_HEIGHT = 380;

export function FormulaBackdrop({ topInset }: { topInset: number }) {
  const { isDark } = useAppTheme();

  // Dark surfaces swallow low-alpha ink, so the same layer needs a little more
  // of it to land at the same visual weight.
  const alpha = (strength: number) => (isDark ? 0.11 : 0.075) * strength;

  return (
    // Android clips absolutely-positioned children to the parent's bounds, so
    // the layer needs a real height rather than the zero one a bare
    // top/left/right anchor would give it.
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: topInset + LAYER_HEIGHT,
        overflow: "hidden",
      }}
    >
      {FORMULAS.map((formula) => (
        <Text
          key={formula.text}
          numberOfLines={1}
          style={{
            position: "absolute",
            top: topInset + formula.top,
            [formula.side]: formula.offset,
            fontSize: formula.size,
            fontStyle: "italic",
            fontWeight: "600",
            letterSpacing: 0.3,
            color: formula.brand ? "#0A8A4B" : isDark ? "#FAFAF9" : "#1C1917",
            opacity: alpha(formula.strength),
            transform: [{ rotate: formula.rotate }],
          }}
        >
          {formula.text}
        </Text>
      ))}
    </View>
  );
}
