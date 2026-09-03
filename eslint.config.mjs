import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: [
      ".npm-cache/**",
      "node_modules/**",
    ],
  },
  {
    files: ["src/**/*.mjs", "tests/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
]);
