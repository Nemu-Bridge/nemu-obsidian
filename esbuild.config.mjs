import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  platform: "browser",
  outfile: "main.js",
  minify: true,
  legalComments: "inline",
  logLevel: "info",
});
