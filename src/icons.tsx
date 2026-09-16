type IconProps = {
  size?: number;
};

export function ChevronIcon({ size = 16 }: IconProps) {
  return (
    <svg aria-hidden="true" height={size} viewBox="0 0 24 24" width={size}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function SearchIcon({ size = 15 }: IconProps) {
  return (
    <svg aria-hidden="true" height={size} viewBox="0 0 24 24" width={size}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

export function SidebarSimpleIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-toggle-icon"
      height={size}
      viewBox="0 0 256 256"
      width={size}
    >
      <path d="M216,36H40A20,20,0,0,0,20,56V200a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A20,20,0,0,0,216,36ZM44,60H76V196H44ZM212,196H100V60H212Z" />
    </svg>
  );
}
