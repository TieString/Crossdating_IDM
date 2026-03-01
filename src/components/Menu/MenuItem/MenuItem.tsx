// MenuItem.tsx
import style from './MenuItem.module.css'

interface MenuItemProps {
  label: string;
  onClick?: () => void;
  isActive?: boolean;
  children?: React.ReactNode;
}

const MenuItem: React.FC<MenuItemProps> = ({ label, onClick, isActive, children }) => {

  return (
    <div
      className={`${style["menu-item"]} ${isActive ? style["menu-item-active"] : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (onClick) onClick(); // 🔹 确保 `onClick` 被执行
      }}
    >
      <div className={style["menu-item-label"]}>{label}</div>
      {/* 始终在 DOM 中渲染子菜单，通过 CSS 控制显示（hover 或 active） */}
      {children && (
        <div className={`${style["subMenu"]} ${isActive ? style["subMenuVisible"] : ""}`}>
          {children}
        </div>
      )}
    </div>
  );
};

export default MenuItem;
