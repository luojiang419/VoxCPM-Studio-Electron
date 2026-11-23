import warmOrangeAvatar from "./assets/role-avatars/warm-orange.webp";
import mossGreenAvatar from "./assets/role-avatars/moss-green.webp";
import ochreGoldAvatar from "./assets/role-avatars/ochre-gold.webp";
import roseAvatar from "./assets/role-avatars/rose.webp";
import terracottaAvatar from "./assets/role-avatars/terracotta.webp";
import oliveAvatar from "./assets/role-avatars/olive.webp";

export const ROLE_APPEARANCES = [
  { key: "warm-orange", color: "#f6a66d", label: "暖橙", avatar: warmOrangeAvatar },
  { key: "moss-green", color: "#a6b880", label: "苔绿", avatar: mossGreenAvatar },
  { key: "ochre-gold", color: "#d6b66b", label: "赭金", avatar: ochreGoldAvatar },
  { key: "rose", color: "#d59683", label: "玫瑰", avatar: roseAvatar },
  { key: "terracotta", color: "#bd8d62", label: "陶土", avatar: terracottaAvatar },
  { key: "olive", color: "#b9ae79", label: "橄榄", avatar: oliveAvatar },
] as const;

export function getRoleAppearance(color: string) {
  const appearance = ROLE_APPEARANCES.find(item => item.color === color.toLowerCase());
  if (appearance) return appearance;
  // 延续旧工程的颜色映射，让历史颜色对应的头像与当前显示颜色一致。
  const hash = Array.from(color).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return ROLE_APPEARANCES[hash % ROLE_APPEARANCES.length];
}
