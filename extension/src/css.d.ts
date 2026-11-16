// Lets TypeScript accept `import css from "....css"`. esbuild bundles the
// file's contents as a plain string (see the "loader" option in build.mjs).
declare module "*.css" {
  const text: string;
  export default text;
}
