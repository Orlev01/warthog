// The icon each category uses (docs/adr/life-admin-profile.md): every name in the catalogue's
// fixed set (`CATEGORY_ICONS`) maps to a Lucide icon, and anything else — a category of the
// person's own that names an icon this page doesn't know — falls back to "shapes", so the page
// never renders an icon it doesn't have.

import {
  Anchor,
  BookOpen,
  Briefcase,
  Building,
  Camera,
  Car,
  Dumbbell,
  Gift,
  HandHeart,
  HeartPulse,
  House,
  IdCard,
  Landmark,
  Leaf,
  Music,
  PawPrint,
  Plane,
  Plug,
  Repeat,
  Sailboat,
  Scroll,
  Shapes,
  Shield,
  ShoppingBag,
  Star,
  Store,
  Ticket,
  TrendingUp,
  Trophy,
  Users,
  Utensils,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import type { CategoryIcon } from "@/domain/life-admin/record-types";

export const CATEGORY_ICON_COMPONENTS: Readonly<Record<CategoryIcon, LucideIcon>> = {
  home: House,
  plug: Plug,
  car: Car,
  plane: Plane,
  "heart-pulse": HeartPulse,
  "hand-heart": HandHeart,
  landmark: Landmark,
  "trending-up": TrendingUp,
  building: Building,
  shield: Shield,
  "id-card": IdCard,
  scroll: Scroll,
  briefcase: Briefcase,
  store: Store,
  users: Users,
  "paw-print": PawPrint,
  "shopping-bag": ShoppingBag,
  repeat: Repeat,
  utensils: Utensils,
  shapes: Shapes,
  star: Star,
  ticket: Ticket,
  dumbbell: Dumbbell,
  music: Music,
  anchor: Anchor,
  sailboat: Sailboat,
  trophy: Trophy,
  "book-open": BookOpen,
  camera: Camera,
  leaf: Leaf,
  wrench: Wrench,
  gift: Gift,
};

/** A category's icon by name; an unknown name reads as "shapes". */
export function categoryIcon(name: string | undefined): LucideIcon {
  return (name && Object.hasOwn(CATEGORY_ICON_COMPONENTS, name) ? CATEGORY_ICON_COMPONENTS[name as CategoryIcon] : undefined) ?? Shapes;
}
