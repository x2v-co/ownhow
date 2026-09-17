# Vendored YAML parser

`yaml.js` bundles the browser ESM distribution of `yaml@2.8.3` (https://github.com/eemeli/yaml), built with `esbuild@0.25.12` using `--bundle --format=esm --platform=node`. It has no runtime dependencies. The ISC license is included in `YAML-LICENSE` and shipped in the npm package.

To regenerate in an isolated temporary directory, install those exact versions and bundle `node_modules/yaml/browser/dist/index.js`. Normalize generated source comments to `yaml/...` (remove machine-specific temporary directory prefixes) and retain the attribution header. Run the frontmatter regression suite after replacing the bundle. Do not install build dependencies into the product package.
