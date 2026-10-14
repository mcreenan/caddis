// electron-builder hooks (referenced from electron-builder.yml).

/**
 * electron-builder drops every package's top-level examples/ folder, but the canvas serves Three.js add-ons
 * (`three/addons/...`) from three/examples/jsm. Returning true bypasses that default filter for those files.
 */
export function onNodeModuleFile(file) {
  return /[\\/]node_modules[\\/]three[\\/]examples(?:[\\/]|$)/.test(file);
}
