import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "src/lib/bindings", "fixtures-raw"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Extensionless Node ESM script (the hc test double); eslint skips it unless named.
    files: ["scripts/fake-hc"],
    languageOptions: { sourceType: "module", globals: { ...globals.node } },
  },
);
