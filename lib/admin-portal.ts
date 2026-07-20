import type { ComponentProps } from "react";
import type { Ionicons } from "@expo/vector-icons";

export type IoniconName = ComponentProps<typeof Ionicons>["name"];

/**
 * Mobile mirror of the web admin portal (`web/lib/admin-portal.ts`).
 *
 * Web is the source of truth (project Rule 1) — the section list, labels and
 * grouping here intentionally match the web sidebar
 * (`web/components/admin/admin-sidebar-content.tsx`). The mobile build improves
 * the UI (Rule 2) by presenting these as a grouped card grid instead of a
 * desktop sidebar.
 *
 * `href` is the future mobile route for each section. Until a section ships,
 * `ready: false` keeps it disabled in the dashboard (Phase 1 = shell only).
 */
export type AdminSection = {
  id: string;
  label: string;
  href: string;
  icon: IoniconName;
  ready?: boolean;
};

export type AdminSectionGroup = {
  category: string;
  items: AdminSection[];
};

export const ADMIN_SECTION_GROUPS: AdminSectionGroup[] = [
  {
    category: "Operations",
    items: [
      {
        id: "transactions",
        label: "Transactions",
        href: "/admin/transactions",
        icon: "cash-outline",
        ready: true,
      },
      {
        id: "withdrawals",
        label: "Withdrawals",
        href: "/admin/withdrawals",
        icon: "card-outline",
        ready: true,
      },
      {
        id: "receipts",
        label: "Receipts",
        href: "/admin/receipts",
        icon: "receipt-outline",
        ready: true,
      },
      {
        id: "users",
        label: "Users",
        href: "/admin/users",
        icon: "people-outline",
        ready: true,
      },
      {
        id: "account-deletions",
        label: "Account Deletions",
        href: "/admin/account-deletions",
        icon: "person-remove-outline",
        ready: true,
      },
    ],
  },
  {
    category: "Communication",
    items: [
      {
        id: "notifications",
        label: "Notifications",
        href: "/admin/notifications",
        icon: "notifications-outline",
        ready: true,
      },
      {
        id: "notices",
        label: "Notices",
        href: "/admin/notices",
        icon: "megaphone-outline",
        ready: true,
      },
    ],
  },
  {
    category: "Content",
    items: [
      {
        id: "quiz-management",
        label: "Quiz Management",
        href: "/admin/quiz-management",
        icon: "school-outline",
        ready: true,
      },
      {
        id: "questions",
        label: "Questions",
        href: "/admin/questions",
        icon: "help-circle-outline",
        ready: true,
      },
      {
        id: "notes",
        label: "Notes",
        href: "/admin/notes",
        icon: "document-text-outline",
        ready: true,
      },
      {
        id: "courses",
        label: "Courses",
        href: "/admin/courses",
        icon: "book-outline",
        ready: true,
      },
      {
        id: "chapters",
        label: "Chapters",
        href: "/admin/chapters",
        icon: "layers-outline",
        ready: true,
      },
      {
        id: "coupons",
        label: "Coupons",
        href: "/admin/coupons",
        icon: "pricetag-outline",
        ready: true,
      },
      {
        id: "subscription-coupons",
        label: "Subscription Coupons",
        href: "/admin/subscription-coupons",
        icon: "ticket-outline",
        ready: true,
      },
      {
        id: "live-sessions",
        label: "Live Sessions",
        href: "/admin/live-sessions",
        icon: "videocam-outline",
        ready: true,
      },
      {
        id: "onboarding-videos",
        label: "Onboarding Videos",
        href: "/admin/onboarding-videos",
        icon: "film-outline",
        ready: true,
      },
    ],
  },
  {
    category: "Platform",
    items: [
      {
        id: "services",
        label: "Services",
        href: "/admin/services",
        icon: "flash-outline",
        ready: true,
      },
      {
        id: "developer",
        label: "Developer",
        href: "/admin/developer",
        icon: "code-slash-outline",
        ready: true,
      },
      {
        id: "settings",
        label: "Settings",
        href: "/admin/settings",
        icon: "settings-outline",
        ready: true,
      },
      {
        id: "social",
        label: "Social Media",
        href: "/admin/social",
        icon: "share-social-outline",
        ready: true,
      },
      {
        id: "pricing",
        label: "Subscription",
        href: "/admin/pricing",
        icon: "pricetags-outline",
        ready: true,
      },
      {
        id: "payment-config",
        label: "Payment Config",
        href: "/admin/payment-config",
        icon: "wallet-outline",
        ready: true,
      },
      {
        id: "format-config",
        label: "Format Config",
        href: "/admin/format-config",
        icon: "options-outline",
        ready: true,
      },
      {
        id: "ai-keys",
        label: "AI Keys",
        href: "/admin/ai-keys",
        icon: "key-outline",
        ready: true,
      },
      {
        id: "legal",
        label: "Legal",
        href: "/admin/legal",
        icon: "shield-checkmark-outline",
        ready: true,
      },
      {
        id: "security",
        label: "Security",
        href: "/admin/security",
        icon: "lock-closed-outline",
        ready: true,
      },
    ],
  },
];

export const ADMIN_SECTION_COUNT = ADMIN_SECTION_GROUPS.reduce(
  (total, group) => total + group.items.length,
  0,
);
