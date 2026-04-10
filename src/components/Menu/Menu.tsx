import React, { useState } from 'react';
import MenuItem from './MenuItem/MenuItem';
import styles from './Menu.module.css';

// 顶部菜单容器。
// 这里负责管理菜单项的激活状态，并把点击行为转交给具体的 MenuItem。
// 菜单本身不处理业务逻辑，只负责显示、展开和点击协调。

interface MenuProps {
  items: { label: string; onClick?: () => void; children?: React.ReactNode }[];
}

const Menu: React.FC<MenuProps> = ({ items }) => {
  const [activeMenuItem, setActiveMenuItem] = useState<string | null>(null);
  
  const handleMenuClick = (onClick?: () => void, hasChildren?: boolean) => {
    // 如果有 onClick（没有子菜单的项），执行 onClick 并关闭菜单
    if (onClick && !hasChildren) {
      onClick();
      setActiveMenuItem(null);
    }
  };

  const handleMenuMouseEnter = (label: string, hasChildren?: boolean) => {
    // 只有有子菜单的项才在 hover 时打开
    if (hasChildren) {
      setActiveMenuItem(label);
    }
  };

  return (
    <div className={styles["subMenu"]}>
      {items.map((item, index) => {
        const hasChildren = !!item.children;
        return (
          <MenuItem
            isActive={activeMenuItem === item.label}
            key={index}
            label={item.label}
            onClick={() => handleMenuClick(item.onClick, hasChildren)}
            onMouseEnter={() => handleMenuMouseEnter(item.label, hasChildren)}
            onMouseLeave={() => {
              // 只有当菜单项没有子菜单时，鼠标离开才关闭
              // 有子菜单的项会通过鼠标进入子菜单来保持打开状态
              if (!hasChildren) {
                setActiveMenuItem(null);
              }
            }}
          >
            {item.children}
          </MenuItem>
        );
      })}
    </div>
  );
};

export default Menu;
