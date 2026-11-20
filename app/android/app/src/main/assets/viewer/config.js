// Read by <model-viewer> when it makes its element, so this runs first, as a plain script: the decoders
// for Draco meshes and KTX2 textures come from this folder rather than Google's CDN.
self.ModelViewerElement = {
  dracoDecoderLocation: new URL('draco/', location.href).href,
  ktx2TranscoderLocation: new URL('basis/', location.href).href,
};
