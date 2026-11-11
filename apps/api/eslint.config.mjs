import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off", // DTO/raw-SQL boundaries; domain logic is typed
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
