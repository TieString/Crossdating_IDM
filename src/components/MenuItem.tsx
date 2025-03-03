// MenuItem.tsx
import './MenuItem.css'

interface MenuItemProps {
  label: string;
  onClick?: () => void;
  isActive?: boolean;
  children?: React.ReactNode;
}

const MenuItem: React.FC<MenuItemProps> = ({ label, onClick, isActive, children }) => {

  return (
    <div
      className={`menu-item ${isActive ? "menu-item-active" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (onClick) onClick(); // 🔹 确保 `onClick` 被执行
      }}
    >
      <div className="menu-item-label">{label}</div>
      {isActive && children && <div className="subMenu">{children}</div>}
    </div>
  );
};

export default MenuItem;
