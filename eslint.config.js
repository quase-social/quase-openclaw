import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "**/*.mjs"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // Boundary rules (standalone-repo replica of OpenClaw's monorepo import checks):
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "openclaw/plugin-sdk",
              message:
                "Import a specific openclaw/plugin-sdk/* subpath (e.g. channel-core), not the monolithic root barrel.",
            },
          ],
          patterns: [
            {
              group: ["openclaw/plugin-sdk/*test*"],
              message: "openclaw plugin-sdk test subpaths are not published; do not import them.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
