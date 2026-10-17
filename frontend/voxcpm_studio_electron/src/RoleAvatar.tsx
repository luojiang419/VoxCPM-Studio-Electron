import { getRoleAppearance } from "./role-appearance";

export default function RoleAvatar({ color, name, className = "ps-avatar-image" }: {
  color: string;
  name: string;
  className?: string;
}) {
  const appearance = getRoleAppearance(color);
  return <img className={className} src={appearance.avatar} alt="" aria-hidden="true"
    title={`${name} · ${appearance.label}`} data-avatar-style={appearance.key} draggable={false} decoding="async" />;
}
