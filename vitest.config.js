// Vitest тохиргоо: `npm test`. Extension-ий цэвэр функцуудыг (DOM, chrome API-гүй) Node дээр тестлэнэ.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
  },
});
