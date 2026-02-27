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
      {isActive && children && <div className={style["subMenu"]}>{children}</div>}
    </div>
  );
};

export default MenuItem;
