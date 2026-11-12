// What a viz may import besides packages: files, as `../files/<name>` or `./files/<name>`.
declare module '*?pixels' {
  /** a PNG or JPEG, decoded at build time */
  const image: import('@gestalts/viz').Pixels;
  export default image;
}
declare module '*.csv' { const text: string; export default text; }
declare module '*.tsv' { const text: string; export default text; }
declare module '*.txt' { const text: string; export default text; }
declare module '*.svg' { const url: string; export default url; }
declare module '*.png' { const url: string; export default url; }
declare module '*.jpg' { const url: string; export default url; }
declare module '*.css';
