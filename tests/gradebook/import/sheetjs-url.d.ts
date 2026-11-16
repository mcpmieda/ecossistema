// The server test project does not include Vite's ambient types (vite/client). Declare only what
// the SheetJS loader uses: the `?url` import of its file and `import.meta.env.PROD`.
declare module 'xlsx/dist/xlsx.full.min.js?url' {
  const url: string;
  export default url;
}

interface ImportMeta {
  readonly env: { readonly PROD: boolean };
}
