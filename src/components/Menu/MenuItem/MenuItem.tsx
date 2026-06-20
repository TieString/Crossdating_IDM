import style from './MenuItem.module.css'

// 单个菜单项。
// 负责标签显示、点击态和子菜单展开。
// 这里不决定具体动作，只接受父组件传入的 onClick、onMouseEnter、onMouseLeave 和 children。

/** Props for a single menu row with optional nested submenu content. */
export interface MenuItemProps {
  /** Visible row label. */
  label: string;
  /** Called when the row is clicked and not disabled. */
  onClick?: () => void;
  /** Called when the pointer enters the enabled row. */
  onMouseEnter?: () => void;
  /** Called when the pointer leaves the enabled row. */
  onMouseLeave?: () => void;
  /** Whether the submenu should be shown as active. */
  isActive?: boolean;
  /** Prevents row interaction when true. */
  disabled?: boolean;
  /** When defined, reserves a check gutter; true renders the check mark. */
  checked?: boolean;
  /** Nested submenu rendered beside the row. */
  children?: React.ReactNode;
}

/** Presentational menu item used by the top menu container. */
const MenuItem: React.FC<MenuItemProps> = ({ label, onClick, onMouseEnter, onMouseLeave, isActive, disabled, checked, children }) => {

  return (
    <div
      className={`${style["menu-item"]} ${isActive ? style["menu-item-active"] : ""} ${disabled ? style["menu-item-disabled"] : ""}`}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        if (onClick) onClick();
      }}
      onMouseEnter={disabled ? undefined : onMouseEnter}
      onMouseLeave={disabled ? undefined : onMouseLeave}
    >
      <div className={style["menu-item-label"]}>
        {checked !== undefined && (
          <span className={style["menu-item-check"]}>{checked ? "✓" : ""}</span>
        )}
        <span className={style["menu-item-text"]}>{label}</span>
        {children && <span className={style["menu-item-arrow"]}>&gt;</span>}
      </div>
      {/* 始终在 DOM 中保留子菜单，通过 CSS 控制显示状态。 */}
      {children && (
        <div className={`${style["subMenu"]} ${isActive ? style["subMenuVisible"] : ""}`}>
          {children}
        </div>
      )}
    </div>
  );
};

export default MenuItem;
