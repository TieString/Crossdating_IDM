// Menu.tsx
import React, { useState } from 'react';
import MenuItem from './MenuItem';
import './Menu.css'

interface MenuProps {
  items: { label: string; onClick?: () => void; children?: React.ReactNode }[];
}

const Menu: React.FC<MenuProps> = ({ items }) => {
  const [activeMenuItem, setActiveMenuItem] = useState<string | null>(null);
  const handleMenuClick = (label: string, onClick?: () => void) => {
    setActiveMenuItem((prev) => (prev === label ? null : label));
    if (onClick) {
      setActiveMenuItem(null)
      onClick(); // 🔹 这里确保 `onClick` 被调用
    }
  };

  return (
    <div className="subMenu">
      {items.map((item, index) => (
        <MenuItem
          isActive={activeMenuItem === item.label}
          key={index}
          label={item.label}
          onClick={() => handleMenuClick(item.label, item.onClick)} // 🔹 这里传递 `onClick`
        >
          {item.children}
        </MenuItem>
      ))}
    </div>
  );
};

export default Menu;
