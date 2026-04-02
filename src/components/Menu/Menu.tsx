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
  const handleMenuClick = (label: string, onClick?: () => void) => {
    setActiveMenuItem((prev) => (prev === label ? null : label));
    if (onClick) {
      setActiveMenuItem(null)
      onClick();
    }
  };

  return (
    <div className={styles["subMenu"]}>
      {items.map((item, index) => (
        <MenuItem
          isActive={activeMenuItem === item.label}
          key={index}
          label={item.label}
          onClick={() => handleMenuClick(item.label, item.onClick)}
        >
          {item.children}
        </MenuItem>
      ))}
    </div>
  );
};

export default Menu;
