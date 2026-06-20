import type { Preview } from "@storybook/react-vite";
import "../src/app/App.css";

const preview: Preview = {
  parameters: {
    controls: {
      expanded: true,
    },
    docs: {
      toc: true,
    },
  },
  tags: ["autodocs"],
};

export default preview;
