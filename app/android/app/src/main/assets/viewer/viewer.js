// The viewer page's side of ModelView: points <model-viewer> at the model named in the address
// (?src=…) and says how loading goes in the page title, which the app reads ("progress 0.42", "loaded 1
// animation", "error …"). The panel's keys call window.polydance. config.js points it at the decoders.
const viewer = document.getElementById('model');

const START = '30deg 75deg 105%';
const say = text => { document.title = text.slice(0, 200); };

// A last progress event can follow the load or the failure; once either is said, the title keeps it.
let settled = false;
viewer.addEventListener('progress', event => { if (!settled) say(`progress ${event.detail.totalProgress.toFixed(2)}`); });
viewer.addEventListener('load', () => {
  settled = true;
  const n = viewer.availableAnimations.length;
  say(`loaded ${n} animation${n === 1 ? '' : 's'}`);
});
viewer.addEventListener('error', event => { settled = true; say(`error ${event.detail?.type ?? 'the model could not be shown'}`); });

const src = new URLSearchParams(location.search).get('src');
// Only a model the app serves from its own cache, never a link.
if (src && /^model\/[0-9a-f]{64}\.glb$/.test(src)) viewer.src = src;
else say('error no model');

window.polydance = {
  reset() {
    viewer.autoRotate = false;
    viewer.cameraOrbit = START;
    viewer.cameraTarget = 'auto auto auto';
    viewer.fieldOfView = 'auto';
    viewer.resetTurntableRotation(0);
    viewer.jumpCameraToGoal();
  },
  spin(on) { viewer.autoRotate = Boolean(on); },
  zoom(steps) { viewer.zoom(steps); },
  // Turns the model by the given degrees, for keys when a drag is awkward with a controller.
  turn(degrees) {
    const orbit = viewer.getCameraOrbit();
    viewer.cameraOrbit = `${orbit.theta - degrees * Math.PI / 180}rad ${orbit.phi}rad ${orbit.radius}m`;
  },
};
