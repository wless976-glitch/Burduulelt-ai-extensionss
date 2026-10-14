// ESLint тохиргоо: `npm run lint`
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "worker/node_modules/", "worker/.wrangler/", "coverage/"] },
  js.configs.recommended,
  {
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  // Side panel, background (ES module)
  {
    files: ["extension/**/*.js"],
    languageOptions: { sourceType: "module", globals: { ...globals.browser, ...globals.webextensions } },
  },
  // e-Mongolia таб дээр executeScript-ээр ачаалагддаг энгийн script-үүд (import/export ашиглахгүй)
  {
    files: ["extension/content.js", "extension/collector.js"],
    languageOptions: { sourceType: "script" },
  },
  // AI сервис (Cloudflare Worker)
  {
    files: ["worker/**/*.js"],
    languageOptions: { sourceType: "module", globals: { ...globals.serviceworker } },
  },
  // Тохиргооны файлууд, тестүүд (Node)
  {
    files: ["*.config.js", "test/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
  },
];
