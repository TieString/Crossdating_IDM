import style from './MenuItem.module.css'

// 单个菜单项。
// 负责标签显示、点击态和子菜单展开。
// 这里不决定具体动作，只接受父组件传入的 onClick、onMouseEnter、onMouseLeave 和 children。

interface MenuItemProps {
  label: string;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  isActive?: boolean;
  disabled?: boolean;
  children?: React.ReactNode;
}

const MenuItem: React.FC<MenuItemProps> = ({ label, onClick, onMouseEnter, onMouseLeave, isActive, disabled, children }) => {

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
        {label}
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
